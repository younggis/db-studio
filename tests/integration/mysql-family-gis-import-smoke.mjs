import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CoreService } from "../../packages/core/dist/index.js";
import { mariaDbConfigFromEnvironment, mysqlConfigFromEnvironment } from "../../packages/database/dist/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeDirectory = path.join(repositoryRoot, "apps/desktop/resources/gdal/bin");
process.env.DBSTUDIO_GDAL_BIN = runtimeDirectory;
const gisInspectionCore = CoreService.fromEnvironment({ ...process.env, DBSTUDIO_GDAL_BIN: runtimeDirectory });
const execFileAsync = promisify(execFile);

function parseEnvFile(contents) {
  const env = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    env[match[1]] = value;
  }
  return env;
}

function quoteIdentifier(value) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function countValue(value) {
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result), "database returned an invalid feature count");
  return result;
}

async function readFeatureRows(core, schema, table) {
  const result = await core.query(
    `SELECT label, score, ST_SRID(geom) AS srid, ST_AsText(geom) AS wkt `
      + `FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ORDER BY score`,
  );
  return result.rows;
}

const report = {
  date: new Date().toISOString(),
  purpose: "Direct GeoPackage-staged GIS vector import and export to isolated MySQL and MariaDB test services.",
  sourceModified: false,
  externalDataSent: false,
  results: [],
};
const cleanupErrors = [];
const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, ".cache/gis-roundtrip/mysql-family-import-"));
const sourcePath = path.join(temporaryDirectory, "synthetic-two-points.geojson");
const invalidFieldPath = path.join(temporaryDirectory, "synthetic-invalid-field.geojson");
const featureCollection = {
  type: "FeatureCollection",
  name: "dbstudio_synthetic_gis_import",
  features: [
    { type: "Feature", id: 1, properties: { label: "成都", score: 1.25 }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
    { type: "Feature", id: 2, properties: { label: "上海", score: 2.5 }, geometry: { type: "Point", coordinates: [121.4737, 31.2304] } },
  ],
};
await writeFile(sourcePath, JSON.stringify(featureCollection), "utf8");
await writeFile(invalidFieldPath, JSON.stringify({
  type: "FeatureCollection",
  name: "dbstudio_synthetic_invalid_field",
  features: [{
    type: "Feature",
    properties: { ["f".repeat(80)]: "fails MySQL/MariaDB identifier validation" },
    geometry: { type: "Point", coordinates: [104.0665, 30.5723] },
  }],
}), "utf8");

try {
  const dockerEnv = parseEnvFile(await readFile(path.join(repositoryRoot, "docker/.env"), "utf8"));
  const targets = [
    { engine: "mysql", config: mysqlConfigFromEnvironment(dockerEnv), core: (config) => CoreService.fromMySqlConfig(config) },
    { engine: "mariadb", config: mariaDbConfigFromEnvironment(dockerEnv), core: (config) => CoreService.fromMariaDbConfig(config) },
  ];

  for (const target of targets) {
    assert.ok(target.config.database, `${target.engine} integration configuration must select a database`);
    const core = target.core(target.config);
    const table = `gis_import_${target.engine}_${Date.now().toString(36)}`;
    try {
      await core.testConnection();
      const created = await core.importGisToMysqlFamily(sourcePath, table, target.config.database, {
        mode: "create",
        sourceEncoding: "UTF-8",
      });
      assert.equal(created.successfulFeatures, 2);
      assert.equal(created.srid, 4326);

      const initialCount = await core.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(table)}`,
      );
      assert.equal(countValue(initialCount.rows[0].count), 2);

      const appended = await core.importGisToMysqlFamily(sourcePath, table, target.config.database, {
        mode: "append",
        sourceEncoding: "UTF-8",
      });
      assert.equal(appended.successfulFeatures, 2);
      const rowsAfterAppend = await core.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(table)}`,
      );
      assert.equal(countValue(rowsAfterAppend.rows[0].count), 4);

      await assert.rejects(
        core.importGisToMysqlFamily(invalidFieldPath, table, target.config.database, {
          mode: "overwrite",
          sourceEncoding: "UTF-8",
        }),
      );
      const preservedCount = await core.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(table)}`,
      );
      assert.equal(countValue(preservedCount.rows[0].count), 4);

      await assert.rejects(
        core.importGisToMysqlFamily(sourcePath, table, target.config.database, { sourceEncoding: "UTF-8" }),
        /already exists/,
      );

      const overwritten = await core.importGisToMysqlFamily(sourcePath, table, target.config.database, {
        mode: "overwrite",
        sourceEncoding: "UTF-8",
      });
      assert.equal(overwritten.successfulFeatures, 2);
      const featureRows = await readFeatureRows(core, target.config.database, table);
      assert.equal(featureRows.length, 2);
      assert.deepEqual(featureRows.map((row) => row.label), ["成都", "上海"]);
      assert.ok(featureRows.every((row) => Number(row.srid) === 4326));
      assert.match(featureRows[0].wkt, /^POINT\s*\(/i);

      const exportPath = path.join(temporaryDirectory, `${target.engine}-core-export.gpkg`);
      if (target.engine === "mariadb") {
        await assert.rejects(
          core.exportGisFromMysqlFamily(table, target.config.database, exportPath),
          /specify --source-crs/,
        );
      }
      const exported = await core.exportGisFromMysqlFamily(table, target.config.database, exportPath, {
        targetLayerName: `${target.engine}_exported`,
        sourceCrs: target.engine === "mariadb" ? "EPSG:4326" : undefined,
        fieldMappings: target.engine === "mysql"
          ? [{ source: "label", target: "label_cn" }, { source: "score", target: "score_text", targetType: "string" }]
          : [],
      });
      assert.equal(exported.operationReport?.status, "completed");
      assert.equal(exported.operationReport?.successfulFeatures, 2);
      const exportedInfo = await gisInspectionCore.inspectGisFile(exportPath);
      assert.equal(exportedInfo.layers[0]?.name, `${target.engine}_exported`);
      assert.equal(exportedInfo.layers[0]?.featureCount, 2);
      const exportedPreview = await gisInspectionCore.previewGisAttributes(exportPath, {
        sourceLayer: `${target.engine}_exported`,
        limit: 5,
      });
      if (target.engine === "mysql") {
        assert.deepEqual(exportedPreview.rows.map((row) => row.label_cn), ["成都", "上海"]);
        assert.deepEqual(exportedPreview.rows.map((row) => row.score_text), ["1.25", "2.5"]);
      } else {
        assert.deepEqual(exportedPreview.rows.map((row) => row.label), ["成都", "上海"]);
      }

      report.results.push({
        engine: target.engine,
        schema: target.config.database,
        created: created.successfulFeatures,
        appended: appended.successfulFeatures,
        overwriteFailurePreservedOriginal: true,
        overwritten: overwritten.successfulFeatures,
        finalCount: featureRows.length,
        srid: 4326,
        unicodeAttributesPreserved: featureRows.map((row) => row.label).join(",") === "成都,上海",
        exportedFeatures: exported.operationReport?.successfulFeatures,
        exportedLayer: exportedInfo.layers[0]?.name,
        exportCrs: exportedInfo.layers[0]?.crs,
        sourceCrsOverride: target.engine === "mariadb" ? "EPSG:4326" : null,
        status: "passed",
      });
    } finally {
      try {
        await core.query(`DROP TABLE IF EXISTS ${quoteIdentifier(target.config.database)}.${quoteIdentifier(table)}`);
        const remaining = await core.query(
          "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
          [target.config.database, table],
        );
        if (countValue(remaining.rows[0].count) !== 0) throw new Error("test table remains after cleanup");
      } catch {
        cleanupErrors.push(`${target.engine}: isolated GIS test table cleanup failed`);
      }
    }
  }

  const cliTargets = [
    {
      engine: "mysql",
      config: mysqlConfigFromEnvironment(dockerEnv),
      envPrefix: "MYSQL",
      createCore: (config) => CoreService.fromMySqlConfig(config),
    },
    {
      engine: "mariadb",
      config: mariaDbConfigFromEnvironment(dockerEnv),
      envPrefix: "MARIADB",
      createCore: (config) => CoreService.fromMariaDbConfig(config),
    },
  ];
  const cliResults = [];
  for (const target of cliTargets) {
    assert.ok(target.config.database, target.engine + " CLI integration configuration must select a database");
    const cliTable = "gis_import_cli_" + target.engine + "_" + Date.now().toString(36);
    const cliEnvironment = {
      ...process.env,
      DBSTUDIO_DATABASE_TYPE: target.engine,
      DBSTUDIO_GDAL_BIN: runtimeDirectory,
    };
    cliEnvironment[target.envPrefix + "_HOST"] = target.config.host;
    cliEnvironment[target.envPrefix + "_PORT"] = String(target.config.port);
    cliEnvironment[target.envPrefix + "_USER"] = target.config.user;
    cliEnvironment[target.envPrefix + "_PASSWORD"] = target.config.password ?? "";
    cliEnvironment[target.envPrefix + "_DATABASE"] = target.config.database;
    const cliCore = target.createCore(target.config);
    try {
      const cliRun = await execFileAsync(process.execPath, [
        path.join(repositoryRoot, "apps/cli/dist/index.js"),
        "gis", "import", "--connection", "environment", "--file", sourcePath,
        "--target", target.config.database + "." + cliTable, "--mode", "create", "--source-encoding", "UTF-8",
      ], { cwd: repositoryRoot, env: cliEnvironment, windowsHide: true });
      const cliReport = JSON.parse(cliRun.stdout);
      assert.equal(cliReport.engine, target.engine);
      assert.equal(cliReport.successfulFeatures, 2);
      const cliCount = await cliCore.query(
        "SELECT COUNT(*) AS count FROM " + quoteIdentifier(target.config.database) + "." + quoteIdentifier(cliTable),
      );
      assert.equal(countValue(cliCount.rows[0].count), 2);
      const cliExportPath = path.join(temporaryDirectory, target.engine + "-cli-export.gpkg");
      const cliExportArgs = [
        path.join(repositoryRoot, "apps/cli/dist/index.js"),
        "gis", "export", "--connection", "environment", "--table", target.config.database + "." + cliTable,
        "--output", cliExportPath, "--target-layer", target.engine + "_cli_export",
      ];
      if (target.engine === "mariadb") cliExportArgs.push("--source-crs", "EPSG:4326");
      const cliExportRun = await execFileAsync(process.execPath, cliExportArgs, {
        cwd: repositoryRoot,
        env: cliEnvironment,
        windowsHide: true,
      });
      const cliExport = JSON.parse(cliExportRun.stdout);
      assert.equal(cliExport.operationReport?.status, "completed");
      assert.equal(cliExport.operationReport?.successfulFeatures, 2);
      const cliExportInfo = await gisInspectionCore.inspectGisFile(cliExportPath);
      assert.equal(cliExportInfo.layers[0]?.name, target.engine + "_cli_export");
      assert.equal(cliExportInfo.layers[0]?.featureCount, 2);
      const cliExportPreview = await gisInspectionCore.previewGisAttributes(cliExportPath, {
        sourceLayer: target.engine + "_cli_export",
        limit: 5,
      });
      assert.deepEqual(cliExportPreview.rows.map((row) => row.label), ["成都", "上海"]);
      cliResults.push({
        engine: target.engine,
        imported: 2,
        verifiedRows: 2,
        exportedFeatures: 2,
        sourceCrsOverride: target.engine === "mariadb" ? "EPSG:4326" : null,
        status: "passed",
      });
    } finally {
      try {
        await cliCore.query("DROP TABLE IF EXISTS " + quoteIdentifier(target.config.database) + "." + quoteIdentifier(cliTable));
        const remaining = await cliCore.query(
          "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
          [target.config.database, cliTable],
        );
        if (countValue(remaining.rows[0].count) !== 0) throw new Error("CLI test table remains after cleanup");
      } catch {
        cleanupErrors.push(target.engine + ": CLI test table cleanup failed");
      }
    }
  }
  report.cli = cliResults;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  report.cleanupStatus = cleanupErrors.length === 0 ? "all test tables and temporary source removed" : "cleanup failed";
  if (cleanupErrors.length > 0) report.cleanupErrors = cleanupErrors;
  const evidencePath = path.join(repositoryRoot, ".cache/gis-roundtrip/mysql-family-gis-import-20261121.json");
  await writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
  if (report.status === "passed") console.log(JSON.stringify({ ...report, evidencePath }));
}
