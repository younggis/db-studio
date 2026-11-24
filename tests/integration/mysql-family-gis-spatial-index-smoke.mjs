import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  assert.ok(Number.isSafeInteger(result), "database returned an invalid count");
  return result;
}

const report = {
  date: new Date().toISOString(),
  purpose: "Opt-in MySQL/MariaDB GIS spatial-index create/append/overwrite, metadata verification, and CLI/Core acceptance.",
  sourceModified: false,
  externalDataSent: false,
  results: [],
  cleanupErrors: [],
};
const acceptanceId = randomBytes(4).toString("hex");
const evidencePath = path.join(repositoryRoot, `.cache/gis-roundtrip/mysql-family-gis-spatial-index-append-20261122-${acceptanceId}.json`);
const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, ".cache/gis-roundtrip/mysql-family-spatial-index-"));
const sourcePath = path.join(temporaryDirectory, "two-points.geojson");
const nullGeometryPath = path.join(temporaryDirectory, "null-geometry.geojson");
await writeFile(sourcePath, JSON.stringify({
  type: "FeatureCollection",
  name: "dbstudio_spatial_index_acceptance",
  features: [
    { type: "Feature", id: 1, properties: { label: "成都", score: 1.25 }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
    { type: "Feature", id: 2, properties: { label: "上海", score: 2.5 }, geometry: { type: "Point", coordinates: [121.4737, 31.2304] } },
  ],
}), "utf8");
await writeFile(nullGeometryPath, JSON.stringify({
  type: "FeatureCollection",
  name: "dbstudio_spatial_index_null_rejection",
  features: [
    { type: "Feature", properties: { label: "has geometry", score: 1 }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
    { type: "Feature", properties: { label: "null geometry", score: 2 }, geometry: null },
  ],
}), "utf8");

const countSpatialIndexRows = async (core, schema, table) => {
  const result = await core.query(
    "SELECT COUNT(*) AS count FROM information_schema.STATISTICS "
      + "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_TYPE IN ('RTREE', 'SPATIAL')",
    [schema, table],
  );
  return countValue(result.rows[0].count);
};
const countTableRows = async (core, schema, table) => {
  const result = await core.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
  return countValue(result.rows[0].count);
};

try {
  const dockerEnv = parseEnvFile(await readFile(path.join(repositoryRoot, "docker/.env"), "utf8"));
  const targets = [
    { engine: "mysql", envPrefix: "MYSQL", config: mysqlConfigFromEnvironment(dockerEnv), createCore: (config) => CoreService.fromMySqlConfig(config) },
    { engine: "mariadb", envPrefix: "MARIADB", config: mariaDbConfigFromEnvironment(dockerEnv), createCore: (config) => CoreService.fromMariaDbConfig(config) },
  ];

  for (const target of targets) {
    assert.ok(target.config.database, `${target.engine} acceptance config must select a database`);
    const core = target.createCore(target.config);
    const suffix = Date.now().toString(36);
    const coreTable = `gis_idx_${target.engine}_${suffix}`;
    const cliTable = `gis_cli_idx_${target.engine}_${suffix}`;
    const nullTable = `gis_null_idx_${target.engine}_${suffix}`;
    const tableNames = [coreTable, cliTable, nullTable];
    try {
      await core.testConnection();
      const imported = await core.importGisToMysqlFamily(sourcePath, coreTable, target.config.database, {
        mode: "create",
        sourceEncoding: "UTF-8",
        createSpatialIndex: true,
      });
      assert.equal(imported.successfulFeatures, 2);
      assert.equal(imported.srid, 4326);
      assert.ok(imported.warnings?.some((warning) => warning.includes("spatial index") && warning.includes("created")));

      const indexes = await core.query(
        "SELECT INDEX_NAME AS index_name, INDEX_TYPE AS index_type, NON_UNIQUE AS non_unique, "
          + "COLUMN_NAME AS column_name FROM information_schema.STATISTICS "
          + "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_TYPE IN ('RTREE', 'SPATIAL')",
        [target.config.database, coreTable],
      );
      assert.equal(indexes.rows.length, 1);
      assert.equal(indexes.rows[0].column_name, "geom");
      assert.equal(Number(indexes.rows[0].non_unique), 1);
      assert.ok(["RTREE", "SPATIAL"].includes(String(indexes.rows[0].index_type).toUpperCase()));

      const geometryColumn = await core.query(
        "SELECT IS_NULLABLE AS is_nullable FROM information_schema.COLUMNS "
          + "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'geom'",
        [target.config.database, coreTable],
      );
      assert.equal(String(geometryColumn.rows[0]?.is_nullable).toUpperCase(), "NO");
      let mariaDbCheckConstraintVerified = null;
      if (target.engine === "mariadb") {
        const constraints = await core.query(
          "SELECT CHECK_CLAUSE AS check_clause FROM information_schema.CHECK_CONSTRAINTS "
            + "WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
          [target.config.database, coreTable],
        );
        assert.ok(
          constraints.rows.some((row) => /\b(?:ST_)?SRID\b/i.test(String(row.check_clause)) && /4326/.test(String(row.check_clause))),
          `MariaDB Core SRID check constraint metadata was not found: ${JSON.stringify(constraints.rows)}`,
        );
        mariaDbCheckConstraintVerified = true;
      }
      const rows = await core.query(
        `SELECT label, score, ST_SRID(geom) AS srid FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)} ORDER BY score`,
      );
      assert.equal(rows.rows.length, 2);
      assert.deepEqual(rows.rows.map((row) => row.label), ["成都", "上海"]);
      assert.ok(rows.rows.every((row) => Number(row.srid) === 4326));
      await assert.rejects(core.query(
        `INSERT INTO ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)} (label, score, geom) VALUES (?, ?, NULL)`,
        ["null geometry", 3],
      ));
      let mismatchedSridRejected = false;
      try {
        await core.query(
          `INSERT INTO ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)} (label, score, geom) `
            + "VALUES (?, ?, ST_GeomFromText(?, ?))",
          ["wrong SRID", 4, "POINT(1 2)", 3857],
        );
      } catch {
        mismatchedSridRejected = true;
      }
      if (!mismatchedSridRejected) {
        const mismatchedRow = await core.query(
          `SELECT ST_SRID(geom) AS srid FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)} WHERE label = ?`,
          ["wrong SRID"],
        );
        throw new Error(`${target.engine} accepted an SRID 3857 write into its SRID 4326 spatial column (stored SRID ${mismatchedRow.rows[0]?.srid ?? "no row"}).`);
      }
      const countAfterConstraintChecks = await core.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)}`,
      );
      assert.equal(countValue(countAfterConstraintChecks.rows[0].count), 2);

      const countBeforeCoreAppend = await countTableRows(core, target.config.database, coreTable);
      const coreAppend = await core.importGisToMysqlFamily(sourcePath, coreTable, target.config.database, {
        mode: "append",
        sourceEncoding: "UTF-8",
        createSpatialIndex: true,
      });
      assert.equal(coreAppend.successfulFeatures, 2);
      assert.ok(coreAppend.warnings?.some((warning) => warning.includes("spatial index") && warning.includes("retained")));
      assert.equal(await countTableRows(core, target.config.database, coreTable), countBeforeCoreAppend + 2);
      assert.equal(await countSpatialIndexRows(core, target.config.database, coreTable), 1);
      await assert.rejects(
        core.importGisToMysqlFamily(nullGeometryPath, coreTable, target.config.database, {
          mode: "append",
          sourceEncoding: "UTF-8",
          createSpatialIndex: true,
        }),
        /every feature to have a non-NULL geometry/,
      );
      assert.equal(await countTableRows(core, target.config.database, coreTable), countBeforeCoreAppend + 2);
      await core.query(
        `INSERT INTO ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)} (label, score, geom) `
          + "VALUES (?, ?, ST_GeomFromText(?, ?))",
        ["覆盖前的旧记录", 9.5, "POINT(0 0)", 4326],
      );
      const coreOverwrite = await core.importGisToMysqlFamily(sourcePath, coreTable, target.config.database, {
        mode: "overwrite",
        sourceEncoding: "UTF-8",
        createSpatialIndex: true,
      });
      assert.equal(coreOverwrite.successfulFeatures, 2);
      assert.equal(await countSpatialIndexRows(core, target.config.database, coreTable), 1);
      assert.ok(!coreOverwrite.warnings?.some((warning) => warning.includes("previous table contents remain")));
      const coreRowsAfterOverwrite = await core.query(
        `SELECT label, score, ST_SRID(geom) AS srid FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(coreTable)} ORDER BY score`,
      );
      assert.deepEqual(coreRowsAfterOverwrite.rows.map((row) => row.label), ["成都", "上海"]);
      assert.ok(coreRowsAfterOverwrite.rows.every((row) => Number(row.srid) === 4326));
      let coreOverwriteCheckConstraintVerified = null;
      if (target.engine === "mariadb") {
        const constraints = await core.query(
          "SELECT CHECK_CLAUSE AS check_clause FROM information_schema.CHECK_CONSTRAINTS "
            + "WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
          [target.config.database, coreTable],
        );
        assert.ok(constraints.rows.some((row) => /\b(?:ST_)?SRID\b/i.test(String(row.check_clause)) && /4326/.test(String(row.check_clause))));
        coreOverwriteCheckConstraintVerified = true;
      }

      await assert.rejects(
        core.importGisToMysqlFamily(nullGeometryPath, nullTable, target.config.database, {
          mode: "create",
          sourceEncoding: "UTF-8",
          createSpatialIndex: true,
        }),
        /every feature to have a non-NULL geometry/,
      );
      const nullTableCount = await core.query(
        "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        [target.config.database, nullTable],
      );
      assert.equal(countValue(nullTableCount.rows[0].count), 0);

      const cliEnvironment = {
        ...process.env,
        DBSTUDIO_DATABASE_TYPE: target.engine,
        DBSTUDIO_GDAL_BIN: runtimeDirectory,
      };
      cliEnvironment[`${target.envPrefix}_HOST`] = target.config.host;
      cliEnvironment[`${target.envPrefix}_PORT`] = String(target.config.port);
      cliEnvironment[`${target.envPrefix}_USER`] = target.config.user;
      cliEnvironment[`${target.envPrefix}_PASSWORD`] = target.config.password ?? "";
      cliEnvironment[`${target.envPrefix}_DATABASE`] = target.config.database;
      const cliRun = await execFileAsync(process.execPath, [
        path.join(repositoryRoot, "apps/cli/dist/index.js"),
        "gis", "import", "--connection", "environment", "--file", sourcePath,
        "--target", `${target.config.database}.${cliTable}`, "--mode", "create", "--source-encoding", "UTF-8",
        "--create-spatial-index",
      ], { cwd: repositoryRoot, env: cliEnvironment, windowsHide: true });
      const cliReport = JSON.parse(cliRun.stdout);
      assert.equal(cliReport.engine, target.engine);
      assert.equal(cliReport.successfulFeatures, 2);
      assert.equal(await countSpatialIndexRows(core, target.config.database, cliTable), 1);
      let cliMariaDbCheckConstraintVerified = null;
      if (target.engine === "mariadb") {
        const constraints = await core.query(
          "SELECT CHECK_CLAUSE AS check_clause FROM information_schema.CHECK_CONSTRAINTS "
            + "WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
          [target.config.database, cliTable],
        );
        assert.ok(
          constraints.rows.some((row) => /\b(?:ST_)?SRID\b/i.test(String(row.check_clause)) && /4326/.test(String(row.check_clause))),
          `MariaDB CLI SRID check constraint metadata was not found: ${JSON.stringify(constraints.rows)}`,
        );
        cliMariaDbCheckConstraintVerified = true;
      }

      const cliAppendRun = await execFileAsync(process.execPath, [
        path.join(repositoryRoot, "apps/cli/dist/index.js"),
        "gis", "import", "--connection", "environment", "--file", sourcePath,
        "--target", `${target.config.database}.${cliTable}`, "--mode", "append", "--source-encoding", "UTF-8",
        "--create-spatial-index",
      ], { cwd: repositoryRoot, env: cliEnvironment, windowsHide: true });
      const cliAppendReport = JSON.parse(cliAppendRun.stdout);
      assert.equal(cliAppendReport.engine, target.engine);
      assert.equal(cliAppendReport.successfulFeatures, 2);
      assert.equal(await countTableRows(core, target.config.database, cliTable), 4);
      assert.equal(await countSpatialIndexRows(core, target.config.database, cliTable), 1);

      await core.query(
        `INSERT INTO ${quoteIdentifier(target.config.database)}.${quoteIdentifier(cliTable)} (label, score, geom) `
          + "VALUES (?, ?, ST_GeomFromText(?, ?))",
        ["CLI 覆盖前的旧记录", 9.5, "POINT(0 0)", 4326],
      );
      const cliOverwriteRun = await execFileAsync(process.execPath, [
        path.join(repositoryRoot, "apps/cli/dist/index.js"),
        "gis", "import", "--connection", "environment", "--file", sourcePath,
        "--target", `${target.config.database}.${cliTable}`, "--mode", "overwrite", "--source-encoding", "UTF-8",
        "--create-spatial-index",
      ], { cwd: repositoryRoot, env: cliEnvironment, windowsHide: true });
      const cliOverwriteReport = JSON.parse(cliOverwriteRun.stdout);
      assert.equal(cliOverwriteReport.engine, target.engine);
      assert.equal(cliOverwriteReport.successfulFeatures, 2);
      assert.equal(await countSpatialIndexRows(core, target.config.database, cliTable), 1);
      const cliRowsAfterOverwrite = await core.query(
        `SELECT label, score, ST_SRID(geom) AS srid FROM ${quoteIdentifier(target.config.database)}.${quoteIdentifier(cliTable)} ORDER BY score`,
      );
      assert.deepEqual(cliRowsAfterOverwrite.rows.map((row) => row.label), ["成都", "上海"]);
      assert.ok(cliRowsAfterOverwrite.rows.every((row) => Number(row.srid) === 4326));
      let cliOverwriteCheckConstraintVerified = null;
      if (target.engine === "mariadb") {
        const constraints = await core.query(
          "SELECT CHECK_CLAUSE AS check_clause FROM information_schema.CHECK_CONSTRAINTS "
            + "WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
          [target.config.database, cliTable],
        );
        assert.ok(constraints.rows.some((row) => /\b(?:ST_)?SRID\b/i.test(String(row.check_clause)) && /4326/.test(String(row.check_clause))));
        cliOverwriteCheckConstraintVerified = true;
      }

      report.results.push({
        engine: target.engine,
        coreImported: imported.successfulFeatures,
        coreIndexedAppendImported: coreAppend.successfulFeatures,
        coreIndexedAppendRetainedIndex: await countSpatialIndexRows(core, target.config.database, coreTable) === 1,
        coreVerifiedIndex: indexes.rows[0].index_type,
        geometryNotNull: true,
        mariaDbCheckConstraintVerified,
        nullAndMismatchedSridWritesRejected: true,
        coreSrid: 4326,
        nullGeometryRejectedBeforeTableCreation: true,
        cliImported: cliReport.successfulFeatures,
        cliIndexedAppendImported: cliAppendReport.successfulFeatures,
        cliIndexedAppendRetainedIndex: await countSpatialIndexRows(core, target.config.database, cliTable) === 1,
        cliSpatialIndexVerified: true,
        cliMariaDbCheckConstraintVerified,
        coreSpatialIndexOverwriteVerified: true,
        coreOverwriteCheckConstraintVerified,
        cliSpatialIndexOverwriteVerified: true,
        cliOverwriteCheckConstraintVerified,
        status: "passed",
      });
    } finally {
      for (const table of tableNames) {
        try {
          await core.query(`DROP TABLE IF EXISTS ${quoteIdentifier(target.config.database)}.${quoteIdentifier(table)}`);
          const remaining = await core.query(
            "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            [target.config.database, table],
          );
          if (countValue(remaining.rows[0].count) !== 0) throw new Error(`${table} remains after cleanup`);
        } catch (error) {
          report.cleanupErrors.push(`${target.engine}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  report.temporaryFilesRemoved = true;
  report.cleanupStatus = report.cleanupErrors.length === 0 ? "all test tables and temporary source removed" : "cleanup failed";
  await writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
  if (report.status === "passed") console.log(JSON.stringify({ ...report, evidencePath }));
}
