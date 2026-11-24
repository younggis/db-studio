import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CoreService } from "../../packages/core/dist/index.js";
import { sqlServerConfigFromEnvironment } from "../../packages/database/dist/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
process.env.DBSTUDIO_GDAL_BIN = path.join(repositoryRoot, "apps/desktop/resources/gdal/bin");

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
  return "[" + value.replaceAll("]", "]]" ) + "]";
}

function countValue(value) {
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result), "database returned an invalid count");
  return result;
}

function rowValue(row, key) {
  if (!row) return undefined;
  if (Object.hasOwn(row, key)) return row[key];
  const actual = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actual === undefined ? undefined : row[actual];
}

const report = {
  date: new Date().toISOString(),
  purpose: "Opt-in SQL Server geometry/geography GIS spatial-index create/append/overwrite, bounds, clustered key and CLI/Core acceptance.",
  sourceModified: false,
  externalDataSent: false,
  results: [],
  cleanupErrors: [],
};
const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, ".cache/gis-roundtrip/sqlserver-spatial-index-"));
const suffix = randomBytes(4).toString("hex");
const evidencePath = path.join(repositoryRoot, `.cache/gis-roundtrip/sqlserver-gis-spatial-index-append-20261122-${suffix}.json`);
const tables = [
  `dbsi_core_geometry_${suffix}`,
  `dbsi_core_geography_${suffix}`,
  `dbsi_cli_geometry_${suffix}`,
];
const sourcePath = path.join(repositoryRoot, "tests/fixtures/points.geojson");
const appendSourcePath = path.join(temporaryDirectory, "indexed-append.geojson");
const outsideBoundsSourcePath = path.join(temporaryDirectory, "outside-index-bounds.geojson");

try {
  const dockerEnv = parseEnvFile(await readFile(path.join(repositoryRoot, "docker/.env"), "utf8"));
  assert.ok(dockerEnv.SQLSERVER_SA_PASSWORD, "SQLSERVER_SA_PASSWORD must be available in docker/.env");
  const environment = {
    ...process.env,
    DBSTUDIO_DATABASE_TYPE: "sqlserver",
    DBSTUDIO_GDAL_BIN: path.join(repositoryRoot, "apps/desktop/resources/gdal/bin"),
    SQLSERVER_HOST: dockerEnv.SQLSERVER_HOST || "127.0.0.1",
    SQLSERVER_PORT: dockerEnv.SQLSERVER_PORT || "21433",
    SQLSERVER_DATABASE: "dbstudio_test",
    SQLSERVER_USER: dockerEnv.SQLSERVER_USER || "sa",
    SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD,
    SQLSERVER_ENCRYPT: "true",
    SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
    SQLSERVER_CONNECT_TIMEOUT: "15000",
    SQLSERVER_REQUEST_TIMEOUT: "30000",
  };
  for (const key of ["DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLSERVER_URL", "SQLSERVER_URL"]) delete environment[key];
  const core = CoreService.fromSqlServerConfig(sqlServerConfigFromEnvironment(environment));
  const sourceDocument = JSON.parse(await readFile(sourcePath, "utf8"));
  const appendDocument = structuredClone(sourceDocument);
  appendDocument.features.forEach((feature, index) => { feature.properties.id = index + 3; });
  await writeFile(appendSourcePath, JSON.stringify(appendDocument), "utf8");
  const outsideBoundsDocument = structuredClone(sourceDocument);
  outsideBoundsDocument.features = [structuredClone(sourceDocument.features[0])];
  outsideBoundsDocument.features[0].properties.id = 9;
  outsideBoundsDocument.features[0].geometry.coordinates = [100, 100];
  await writeFile(outsideBoundsSourcePath, JSON.stringify(outsideBoundsDocument), "utf8");

  const indexRows = async (table) => core.query(
    "SELECT i.name AS index_name, i.type_desc AS type_desc, i.is_disabled AS is_disabled, c.name AS column_name "
      + "FROM sys.indexes AS i "
      + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
      + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
      + "WHERE i.object_id = OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2)) AND i.type = 4",
    ["dbo", table],
  );
  const primaryKeyRows = async (table) => core.query(
    "SELECT i.name AS index_name, i.type_desc AS type_desc, c.name AS column_name "
      + "FROM sys.indexes AS i "
      + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
      + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
      + "WHERE i.object_id = OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2)) AND i.is_primary_key = 1 AND i.type = 1",
    ["dbo", table],
  );
  const verify = async (table, expectedColumnType, expectedCount = 2) => {
    const indexes = await indexRows(table);
    assert.equal(indexes.rows.length, 1);
    assert.equal(String(rowValue(indexes.rows[0], "type_desc")).toUpperCase(), "SPATIAL");
    assert.equal(String(rowValue(indexes.rows[0], "column_name")), "geom");
    assert.equal(Number(rowValue(indexes.rows[0], "is_disabled")), 0);
    const primaryKeys = await primaryKeyRows(table);
    assert.equal(primaryKeys.rows.length, 1);
    assert.equal(String(rowValue(primaryKeys.rows[0], "type_desc")).toUpperCase(), "CLUSTERED");
    const tableRows = await core.query(
      `SELECT COUNT(*) AS count, MIN([geom].STSrid) AS min_srid, MAX([geom].STSrid) AS max_srid FROM [dbo].${quoteIdentifier(table)}`,
    );
    assert.equal(countValue(rowValue(tableRows.rows[0], "count")), expectedCount);
    assert.equal(Number(rowValue(tableRows.rows[0], "min_srid")), 4326);
    assert.equal(Number(rowValue(tableRows.rows[0], "max_srid")), 4326);
    const types = await core.query(
      "SELECT DATA_TYPE AS data_type FROM INFORMATION_SCHEMA.COLUMNS "
        + "WHERE TABLE_SCHEMA = N'dbo' AND TABLE_NAME = @p1 AND COLUMN_NAME = N'geom'",
      [table],
    );
    assert.equal(String(rowValue(types.rows[0], "data_type")).toLowerCase(), expectedColumnType);
    return { spatialIndex: indexes.rows[0], clusteredPrimaryKey: primaryKeys.rows[0] };
  };

  for (const [table, spatialColumnType] of [[tables[0], "geometry"], [tables[1], "geography"]]) {
    const imported = await core.importGisToSqlServer(sourcePath, table, "dbo", {
      mode: "create",
      sourceEncoding: "UTF-8",
      spatialColumnType,
      createSpatialIndex: true,
    });
    assert.equal(imported.successfulFeatures, 2);
    assert.equal(imported.srid, 4326);
    assert.ok(imported.warnings?.some((warning) => warning.includes("clustered primary key")));
    const metadata = await verify(table, spatialColumnType);
    const appended = await core.importGisToSqlServer(appendSourcePath, table, "dbo", {
      mode: "append",
      sourceEncoding: "UTF-8",
      spatialColumnType,
      createSpatialIndex: true,
    });
    assert.equal(appended.successfulFeatures, 2);
    assert.ok(appended.warnings?.some((warning) => warning.includes("retained during append")));
    const metadataAfterAppend = await verify(table, spatialColumnType, 4);
    let outsideExtentRejected = null;
    if (spatialColumnType === "geometry") {
      await assert.rejects(
        core.importGisToSqlServer(outsideBoundsSourcePath, table, "dbo", {
          mode: "append",
          sourceEncoding: "UTF-8",
          spatialColumnType,
          createSpatialIndex: true,
        }),
        /outside the existing geometry index .* bounding box/,
      );
      await verify(table, spatialColumnType, 4);
      outsideExtentRejected = true;
    }
    const typeConstructor = spatialColumnType === "geometry" ? "geometry" : "geography";
    await core.query(
      `UPDATE [dbo].${quoteIdentifier(table)} SET [geom] = ${typeConstructor}::STGeomFromText('POINT (0 0)', 4326) WHERE [id] = 1`,
    );
    const overwritten = await core.importGisToSqlServer(sourcePath, table, "dbo", {
      mode: "overwrite",
      sourceEncoding: "UTF-8",
      spatialColumnType,
      createSpatialIndex: true,
    });
    assert.equal(overwritten.successfulFeatures, 2);
    assert.ok(!overwritten.warnings?.some((warning) => warning.includes("previous table contents remain")));
    const metadataAfterOverwrite = await verify(table, spatialColumnType, 2);
    const oldSentinel = await core.query(
      `SELECT COUNT(*) AS count FROM [dbo].${quoteIdentifier(table)} WHERE [geom].STAsText() = N'POINT (0 0)'`,
    );
    assert.equal(countValue(rowValue(oldSentinel.rows[0], "count")), 0, "overwrite retained the pre-existing sentinel geometry");
    report.results.push({
      engine: "sqlserver",
      path: `Core ${spatialColumnType} create/overwrite`,
      imported: imported.successfulFeatures,
      indexedAppendImported: appended.successfulFeatures,
      indexedAppendRetainedIndex: rowValue(metadataAfterAppend.spatialIndex, "index_name") === rowValue(metadata.spatialIndex, "index_name"),
      outsideExtentRejected,
      spatialIndex: rowValue(metadataAfterOverwrite.spatialIndex, "type_desc"),
      indexedColumn: rowValue(metadataAfterOverwrite.spatialIndex, "column_name"),
      clusteredPrimaryKey: rowValue(metadataAfterOverwrite.clusteredPrimaryKey, "column_name"),
      overwriteReplacedOldGeometry: true,
      status: "passed",
    });
  }

  const cliRun = await execFileAsync(process.execPath, [
    path.join(repositoryRoot, "apps/cli/dist/index.js"),
    "gis", "import", "--connection", "environment", "--file", sourcePath,
    "--target", `dbo.${tables[2]}`, "--mode", "create", "--source-encoding", "UTF-8", "--create-spatial-index",
    "--spatial-column-type", "geometry",
  ], { cwd: repositoryRoot, env: environment, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const cliReport = JSON.parse(cliRun.stdout);
  assert.equal(cliReport.engine, "sqlserver");
  assert.equal(cliReport.successfulFeatures, 2);
  const cliMetadataBeforeAppend = await verify(tables[2], "geometry", 2);
  const cliAppendRun = await execFileAsync(process.execPath, [
    path.join(repositoryRoot, "apps/cli/dist/index.js"),
    "gis", "import", "--connection", "environment", "--file", appendSourcePath,
    "--target", `dbo.${tables[2]}`, "--mode", "append", "--source-encoding", "UTF-8", "--create-spatial-index",
    "--spatial-column-type", "geometry",
  ], { cwd: repositoryRoot, env: environment, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const cliAppendReport = JSON.parse(cliAppendRun.stdout);
  assert.equal(cliAppendReport.engine, "sqlserver");
  assert.equal(cliAppendReport.successfulFeatures, 2);
  const cliMetadataAfterAppend = await verify(tables[2], "geometry", 4);
  await core.query(
    `UPDATE [dbo].${quoteIdentifier(tables[2])} SET [geom] = geometry::STGeomFromText('POINT (0 0)', 4326) WHERE [id] = 1`,
  );
  const cliOverwriteRun = await execFileAsync(process.execPath, [
    path.join(repositoryRoot, "apps/cli/dist/index.js"),
    "gis", "import", "--connection", "environment", "--file", sourcePath,
    "--target", `dbo.${tables[2]}`, "--mode", "overwrite", "--source-encoding", "UTF-8", "--create-spatial-index",
    "--spatial-column-type", "geometry",
  ], { cwd: repositoryRoot, env: environment, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const cliOverwriteReport = JSON.parse(cliOverwriteRun.stdout);
  assert.equal(cliOverwriteReport.engine, "sqlserver");
  assert.equal(cliOverwriteReport.successfulFeatures, 2);
  const cliMetadata = await verify(tables[2], "geometry", 2);
  const cliOldSentinel = await core.query(
    `SELECT COUNT(*) AS count FROM [dbo].${quoteIdentifier(tables[2])} WHERE [geom].STAsText() = N'POINT (0 0)'`,
  );
  assert.equal(countValue(rowValue(cliOldSentinel.rows[0], "count")), 0, "CLI overwrite retained the pre-existing sentinel geometry");
  report.results.push({
    engine: "sqlserver",
    path: "CLI geometry create/overwrite",
    imported: cliReport.successfulFeatures,
    indexedAppendImported: cliAppendReport.successfulFeatures,
    indexedAppendRetainedIndex: rowValue(cliMetadataAfterAppend.spatialIndex, "index_name") === rowValue(cliMetadataBeforeAppend.spatialIndex, "index_name"),
    spatialIndex: rowValue(cliMetadata.spatialIndex, "type_desc"),
    indexedColumn: rowValue(cliMetadata.spatialIndex, "column_name"),
    clusteredPrimaryKey: rowValue(cliMetadata.clusteredPrimaryKey, "column_name"),
    overwriteReplacedOldGeometry: true,
    status: "passed",
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
    const dockerEnv = parseEnvFile(await readFile(path.join(repositoryRoot, "docker/.env"), "utf8"));
    const environment = {
      ...process.env,
      DBSTUDIO_DATABASE_TYPE: "sqlserver",
      SQLSERVER_HOST: dockerEnv.SQLSERVER_HOST || "127.0.0.1",
      SQLSERVER_PORT: dockerEnv.SQLSERVER_PORT || "21433",
      SQLSERVER_DATABASE: "dbstudio_test",
      SQLSERVER_USER: dockerEnv.SQLSERVER_USER || "sa",
      SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD,
      SQLSERVER_ENCRYPT: "true",
      SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
    };
    for (const key of ["DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLSERVER_URL", "SQLSERVER_URL"]) delete environment[key];
    const cleanupCore = CoreService.fromSqlServerConfig(sqlServerConfigFromEnvironment(environment));
    for (const table of tables) {
      try {
        await cleanupCore.query(`DROP TABLE IF EXISTS [dbo].${quoteIdentifier(table)}`);
        const remaining = await cleanupCore.query(
          "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = N'dbo' AND TABLE_NAME = @p1",
          [table],
        );
        if (countValue(rowValue(remaining.rows[0], "count")) !== 0) throw new Error(`${table} remains after cleanup`);
      } catch (error) {
        report.cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    report.cleanupErrors.push(`could not verify SQL Server cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  report.cleanupStatus = report.cleanupErrors.length === 0 ? "all test tables removed" : "cleanup failed";
  await rm(temporaryDirectory, { recursive: true, force: true });
  report.temporaryFilesRemoved = true;
  await writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
  if (report.status === "passed") console.log(JSON.stringify({ ...report, evidencePath }));
}
