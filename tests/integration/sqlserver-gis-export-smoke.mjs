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
const host = "127.0.0.1";
const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "sqlserver",
  SQLSERVER_HOST: host,
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

const artifactDirectory = path.join(root, ".cache", "sqlserver-gis-export");
mkdirSync(artifactDirectory, { recursive: true });
const runId = randomBytes(4).toString("hex");
const geometryTable = `dbsi_gis_${runId}_geometry`;
const geographyTable = `dbsi_gis_${runId}_geography`;
const geometryFile = path.join(artifactDirectory, `${geometryTable}.gpkg`);
const geographyFile = path.join(artifactDirectory, `${geographyTable}.gpkg`);
const artifactPaths = [geometryFile, geographyFile];
assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "Refusing to overwrite a pre-existing SQL Server GIS artifact.");
const evidenceDirectory = path.join(root, ".cache", "gis-roundtrip");
mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = path.join(evidenceDirectory, `sqlserver-gis-export-20261121-${runId}.json`);
assert.ok(!existsSync(evidencePath), "Refusing to overwrite an existing SQL Server GIS acceptance record.");

const quote = (identifier) => `[${identifier.replaceAll("]", "]]" )}]`;
const geometrySql = `${quote("dbo")}.${quote(geometryTable)}`;
const geographySql = `${quote("dbo")}.${quote(geographyTable)}`;

function invoke(args, parseJson = false, env = environment) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
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

function inspect(file) {
  return invoke(["gis", "inspect", "--file", file], true);
}

function queryGeoPackage(file, layer, sql) {
  const sqliteEnvironment = {
    ...environment,
    DBSTUDIO_DATABASE_TYPE: "sqlite",
    DBSTUDIO_SQLITE_PATH: file,
  };
  for (const key of ["DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLSERVER_URL", "SQLSERVER_URL"]) delete sqliteEnvironment[key];
  const statement = sql.replaceAll("$LAYER", `[${layer.replaceAll("]", "]]" )}]`);
  return invoke(["query", "run", "--sql", statement, "--format", "json"], true, sqliteEnvironment);
}

let completed = false;
let acceptance;
try {
  invoke(["query", "run", "--sql",
    `CREATE TABLE ${geometrySql} ([id] int NOT NULL PRIMARY KEY, [label] nvarchar(80) NOT NULL, [amount] decimal(20,4) NULL, [geom] geometry NULL)`,
    "--format", "json"], true);
  invoke(["query", "run", "--sql",
    `INSERT INTO ${geometrySql} ([id], [label], [amount], [geom]) VALUES `
    + `(1, N'空间点', 123456789012345.6789, geometry::STGeomFromText('POINT(1 2)', 4326)), `
    + `(2, N'ZM点', -0.1000, geometry::STGeomFromText('POINT(3 4 5 6)', 4326)), `
    + `(3, N'空几何', NULL, NULL)`,
    "--format", "json"], true);
  const sourceZm = invoke(["query", "run", "--sql", `SELECT [geom].Z AS z, [geom].M AS m FROM ${geometrySql} WHERE [id] = 2`, "--format", "json"], true);
  assert.equal(Number(sourceZm.rows[0].z), 5);
  assert.equal(Number(sourceZm.rows[0].m), 6);

  invoke(["query", "run", "--sql",
    `CREATE TABLE ${geographySql} ([id] int NOT NULL PRIMARY KEY, [label] nvarchar(80) NOT NULL, [geom] geography NULL)`,
    "--format", "json"], true);
  invoke(["query", "run", "--sql",
    `INSERT INTO ${geographySql} ([id], [label], [geom]) VALUES `
    + `(1, N'西雅图', geography::STGeomFromText('POINT(-122.360 47.656)', 4326)), `
    + `(2, N'奥克兰', geography::STGeomFromText('POINT(-122.343 37.804)', 4326)), `
    + `(3, N'空值', NULL)`,
    "--format", "json"], true);

  const exportedGeometry = invoke(["gis", "export", "--table", `dbo.${geometryTable}`, "--output", geometryFile,
    "--field-map", "amount=exact_amount", "--target-layer", "sqlserver_geometry"], true);
  assert.equal(exportedGeometry.operationReport?.status, "completed");
  assert.equal(exportedGeometry.operationReport?.successfulFeatures, 3);
  assert.equal(exportedGeometry.operationReport?.failedFeatures, 0);
  const geometryInspection = inspect(geometryFile);
  assert.equal(geometryInspection.layers.length, 1);
  assert.equal(geometryInspection.layers[0].name, "sqlserver_geometry");
  assert.equal(geometryInspection.layers[0].featureCount, 3);
  assert.ok(geometryInspection.layers[0].crs, "SQL Server geometry export did not preserve its CRS.");
  assert.ok(geometryInspection.layers[0].fields.some((field) => field.name === "exact_amount"), "SQL Server field mapping was not applied.");
  const exportedZm = queryGeoPackage(geometryFile, "sqlserver_geometry",
    "SELECT hex(substr(geom, 14, 32)) AS coordinates FROM $LAYER WHERE id = 2");
  const exportedCoordinates = Buffer.from(exportedZm.rows[0].coordinates, "hex");
  assert.deepEqual([0, 8, 16, 24].map((offset) => exportedCoordinates.readDoubleLE(offset)), [3, 4, 5, 6],
    "SQL Server geometry export did not preserve XY/Z/M coordinates.");
  const exactDecimal = queryGeoPackage(geometryFile, "sqlserver_geometry", "SELECT exact_amount FROM $LAYER WHERE id = 1");
  assert.equal(String(exactDecimal.rows[0].exact_amount), "123456789012345.6789");
  const nullGeometryCount = queryGeoPackage(geometryFile, "sqlserver_geometry", "SELECT COUNT(*) AS count FROM $LAYER WHERE geom IS NULL");
  assert.equal(Number(nullGeometryCount.rows[0].count), 1);

  const exportedGeography = invoke(["gis", "export", "--table", `dbo.${geographyTable}`, "--output", geographyFile,
    "--target-layer", "sqlserver_geography"], true);
  assert.equal(exportedGeography.operationReport?.status, "completed");
  assert.equal(exportedGeography.operationReport?.successfulFeatures, 3);
  assert.equal(exportedGeography.operationReport?.failedFeatures, 0);
  const geographyInspection = inspect(geographyFile);
  assert.equal(geographyInspection.layers[0].featureCount, 3);
  assert.ok(geographyInspection.layers[0].crs, "SQL Server geography export did not preserve its CRS.");
  assert.ok(geographyInspection.layers[0].extent, "SQL Server geography export did not preserve geometry coordinates.");

  acceptance = {
    ok: true,
    scenario: "sqlserver-gis-file-export",
    engine: "sqlserver",
    database,
    geometry: {
      featureCount: geometryInspection.layers[0].featureCount,
      crs: geometryInspection.layers[0].crs,
      zmCoordinatesPreserved: true,
      exactDecimalPreserved: true,
      nullGeometryPreserved: true,
      fieldMappingApplied: true,
    },
    geography: {
      featureCount: geographyInspection.layers[0].featureCount,
      crs: geographyInspection.layers[0].crs,
      extent: geographyInspection.layers[0].extent,
    },
  };
  completed = true;
} finally {
  for (const table of [geographySql, geometrySql]) {
    try { invoke(["query", "run", "--sql", `DROP TABLE IF EXISTS ${table}`, "--format", "json"], true); }
    catch { /* Preserve the original failure when the local SQL Server cannot clean up. */ }
  }
  for (const artifact of artifactPaths) {
    if (existsSync(artifact)) unlinkSync(artifact);
  }
  if (!completed) process.stderr.write("SQL Server GIS export smoke did not complete; temporary database tables and output files were cleaned up where possible.\n");
}

const remainingTables = invoke(["query", "run", "--sql",
  `SELECT COUNT(*) AS [count] FROM sys.tables WHERE [name] IN (N'${geometryTable}', N'${geographyTable}')`,
  "--format", "json"], true);
assert.equal(Number(remainingTables.rows[0].count), 0, "The SQL Server GIS smoke left a temporary table behind.");
assert.ok(artifactPaths.every((artifact) => !existsSync(artifact)), "The SQL Server GIS smoke left an output file behind.");
const evidence = { ...acceptance, cleanupVerified: true };
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath: path.relative(root, evidencePath) }, null, 2)}\n`);
