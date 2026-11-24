import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const envFile = path.join(root, "docker", ".env");
const gdalBin = path.join(root, "apps", "desktop", "resources", "gdal", "bin");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(envFile);
assert.ok(existsSync(cli), "Build the CLI first with `pnpm --filter @db-studio/cli build`.");
assert.ok(dockerEnv.SQLSERVER_SA_PASSWORD, "Set SQLSERVER_SA_PASSWORD in docker/.env.");

const database = "dbstudio_test";
const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "sqlserver",
  SQLSERVER_HOST: "127.0.0.1",
  SQLSERVER_PORT: dockerEnv.SQLSERVER_PORT || "21433",
  SQLSERVER_DATABASE: database,
  SQLSERVER_USER: "sa",
  SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD,
  SQLSERVER_ENCRYPT: "true",
  SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
  SQLSERVER_CONNECT_TIMEOUT: "15000",
  SQLSERVER_REQUEST_TIMEOUT: "30000",
  DBSTUDIO_GDAL_BIN: gdalBin,
};
for (const key of ["DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLSERVER_URL", "SQLSERVER_URL"]) delete environment[key];

const artifactDirectory = path.join(root, ".cache", "sqlserver-gis-import");
mkdirSync(artifactDirectory, { recursive: true });
const runId = randomBytes(4).toString("hex");
const table = `dbsi_gis_import_${runId}`;
const geographyTable = `${table}_geography`;
const rejectedGeographyTable = `${table}_projected`;
const target = `dbo.${table}`;
const tableSql = `[dbo].[${table}]`;
const geographyTableSql = `[dbo].[${geographyTable}]`;
const inputFile = path.join(root, "tests", "fixtures", "points.geojson");
const appendFile = path.join(artifactDirectory, `${table}-append.geojson`);
const projectedFile = path.join(artifactDirectory, `${table}-projected.geojson`);
const temporaryFiles = [appendFile, projectedFile];
assert.ok(temporaryFiles.every((file) => !existsSync(file)), "Refusing to overwrite a pre-existing SQL Server GIS import artifact.");
const evidenceDirectory = path.join(root, ".cache", "gis-roundtrip");
mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = path.join(evidenceDirectory, `sqlserver-gis-import-20261121-${runId}.json`);
assert.ok(!existsSync(evidencePath), "Refusing to overwrite an existing SQL Server GIS import record.");

function invoke(args, parseJson = false) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    return parseJson ? JSON.parse(output) : output;
  } catch (error) {
    const details = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`dbstudio ${args.slice(0, 2).join(" ")} failed${details ? `:\n${details}` : "."}`);
  }
}

function countRows() {
  const result = invoke(["query", "run", "--sql", `SELECT COUNT(*) AS [count] FROM ${tableSql}`, "--format", "json"], true);
  return Number(result.rows[0].count);
}

let completed = false;
let acceptance;
try {
  const created = invoke(["gis", "import", "--file", inputFile, "--target", target, "--mode", "create"], true);
  assert.equal(created.status, "completed");
  assert.equal(created.engine, "sqlserver");
  assert.equal(created.geometryColumn, "geom");
  assert.equal(created.srid, 4326);
  assert.equal(created.successfulFeatures, 2);
  assert.equal(countRows(), 2);
  const idColumn = invoke(["query", "run", "--sql",
    `SELECT [DATA_TYPE] AS [type] FROM INFORMATION_SCHEMA.COLUMNS WHERE [TABLE_SCHEMA] = N'dbo' AND [TABLE_NAME] = N'${table}' AND [COLUMN_NAME] = N'id'`,
    "--format", "json"], true);
  assert.deepEqual(idColumn.rows, [{ type: "bigint" }], "Numeric GeoPackage attributes should retain an integer SQL Server type.");
  const firstRows = invoke(["query", "run", "--sql",
    `SELECT [id], [名称] AS [label], [geom].STSrid AS [srid], [geom].STAsText() AS [wkt] FROM ${tableSql} ORDER BY [id]`,
    "--format", "json"], true);
  assert.deepEqual(firstRows.rows, [
    { id: "1", label: "甲", srid: 4326, wkt: "POINT (1.25 2.5)" },
    { id: "2", label: "乙", srid: null, wkt: null },
  ]);

  const appended = invoke(["gis", "import", "--file", inputFile, "--target", target, "--mode", "append"], true);
  assert.equal(appended.successfulFeatures, 2);
  assert.equal(countRows(), 4);

  const overwritten = invoke(["gis", "import", "--file", inputFile, "--target", target, "--mode", "overwrite"], true);
  assert.equal(overwritten.successfulFeatures, 2);
  assert.equal(countRows(), 2);

  let duplicateCreateRejected = false;
  try { invoke(["gis", "import", "--file", inputFile, "--target", target, "--mode", "create"], true); }
  catch { duplicateCreateRejected = true; }
  assert.equal(duplicateCreateRejected, true, "Create mode should reject an existing SQL Server target table.");
  assert.equal(countRows(), 2, "A duplicate create attempt must preserve existing target rows.");

  invoke(["query", "run", "--sql", `ALTER TABLE ${tableSql} ALTER COLUMN [名称] nvarchar(1) NOT NULL`, "--format", "json"], true);
  writeFileSync(appendFile, JSON.stringify({
    type: "FeatureCollection",
    name: "append_failure",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
    features: [
      { type: "Feature", properties: { id: 3, 名称: "丙" }, geometry: { type: "Point", coordinates: [5, 6] } },
      { type: "Feature", properties: { id: 4, 名称: "超长文本" }, geometry: { type: "Point", coordinates: [7, 8] } },
    ],
  }), "utf8");
  let appendRejected = false;
  try { invoke(["gis", "import", "--file", appendFile, "--target", target, "--mode", "append"], true); }
  catch { appendRejected = true; }
  assert.equal(appendRejected, true, "SQL Server should reject an overlength append value.");
  assert.equal(countRows(), 2, "A failed SQL Server insert batch must roll back without changing the existing rows.");
  const afterFailure = invoke(["query", "run", "--sql", `SELECT [id], [名称] AS [label] FROM ${tableSql} ORDER BY [id]`, "--format", "json"], true);
  assert.deepEqual(afterFailure.rows, [{ id: "1", label: "甲" }, { id: "2", label: "乙" }]);

  const projectedSource = JSON.parse(readFileSync(inputFile, "utf8"));
  projectedSource.crs.properties.name = "urn:ogc:def:crs:EPSG::3857";
  writeFileSync(projectedFile, JSON.stringify(projectedSource), "utf8");
  let projectedGeographyRejected = false;
  try {
    invoke(["gis", "import", "--file", projectedFile, "--target", `dbo.${rejectedGeographyTable}`, "--mode", "create", "--spatial-column-type", "geography"], true);
  } catch (error) {
    projectedGeographyRejected = /geographic CRS/.test(error.message);
  }
  assert.equal(projectedGeographyRejected, true, "A projected CRS must not be stored as SQL Server geography.");

  const geographyCreated = invoke(["gis", "import", "--file", inputFile, "--target", `dbo.${geographyTable}`, "--mode", "create", "--spatial-column-type", "geography"], true);
  assert.equal(geographyCreated.spatialColumnType, "geography");
  assert.equal(geographyCreated.srid, 4326);
  assert.equal(geographyCreated.successfulFeatures, 2);
  const geographyRows = invoke(["query", "run", "--sql",
    `SELECT [id], [geom].STSrid AS [srid], [geom].STAsText() AS [wkt] FROM ${geographyTableSql} ORDER BY [id]`,
    "--format", "json"], true);
  assert.deepEqual(geographyRows.rows, [
    { id: "1", srid: 4326, wkt: "POINT (1.25 2.5)" },
    { id: "2", srid: null, wkt: null },
  ]);
  const geographyAppended = invoke(["gis", "import", "--file", inputFile, "--target", `dbo.${geographyTable}`, "--mode", "append", "--spatial-column-type", "geography"], true);
  assert.equal(geographyAppended.successfulFeatures, 2);
  const geographyCountAfterAppend = invoke(["query", "run", "--sql", `SELECT COUNT(*) AS [count] FROM ${geographyTableSql}`, "--format", "json"], true);
  assert.equal(Number(geographyCountAfterAppend.rows[0].count), 4);
  const geographyOverwritten = invoke(["gis", "import", "--file", inputFile, "--target", `dbo.${geographyTable}`, "--mode", "overwrite", "--spatial-column-type", "geography"], true);
  assert.equal(geographyOverwritten.successfulFeatures, 2);
  const geographyCountAfterOverwrite = invoke(["query", "run", "--sql", `SELECT COUNT(*) AS [count] FROM ${geographyTableSql}`, "--format", "json"], true);
  assert.equal(Number(geographyCountAfterOverwrite.rows[0].count), 2);

  acceptance = {
    ok: true,
    scenario: "sqlserver-gis-file-import",
    engine: "sqlserver",
    database,
    modes: { geometry: { create: 2, append: 4, overwrite: 2 }, geography: { create: 2, append: 4, overwrite: 2 } },
    spatial: { geometry: "geometry", geography: "geography", crs: "EPSG:4326", nullGeometryPreserved: true, unicodeAttributesPreserved: true },
    safety: { duplicateCreatePreservedTarget: true, failedAppendBatchRolledBack: true, projectedCrsRejectedForGeography: true },
  };
  completed = true;
} finally {
  for (const targetSql of [tableSql, geographyTableSql, `[dbo].[${rejectedGeographyTable}]`]) {
    try { invoke(["query", "run", "--sql", `DROP TABLE IF EXISTS ${targetSql}`, "--format", "json"], true); }
    catch { /* Preserve the original failure when the local SQL Server cannot clean up. */ }
  }
  for (const file of temporaryFiles) {
    if (existsSync(file)) unlinkSync(file);
  }
  if (!completed) process.stderr.write("SQL Server GIS import smoke did not complete; temporary table and input files were cleaned up where possible.\n");
}

const remainingTables = invoke(["query", "run", "--sql",
  `SELECT COUNT(*) AS [count] FROM sys.tables WHERE [name] IN (N'${table}', N'${geographyTable}', N'${rejectedGeographyTable}')`, "--format", "json"], true);
assert.equal(Number(remainingTables.rows[0].count), 0, "The SQL Server GIS import smoke left a temporary table behind.");
assert.ok(temporaryFiles.every((file) => !existsSync(file)), "The SQL Server GIS import smoke left a temporary file behind.");
const evidence = { ...acceptance, cleanupVerified: true };
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath: path.relative(root, evidencePath) }, null, 2)}\n`);
