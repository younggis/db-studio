import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { CoreService } from "../../packages/core/dist/index.js";
import { runSqlAssistant } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

function readDockerEnv() {
  const text = readFileSync(new URL("../../docker/.env", import.meta.url), "utf8");
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith("#")) return [];
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    return [[match[1], value]];
  }));
}

const dockerEnv = readDockerEnv();
function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

const host = process.env.DBSTUDIO_REPAIR_HOST || "127.0.0.1";
const database = required("DBSTUDIO_PG_DATABASE", "dbstudio_test");
const port = Number(process.env.DBSTUDIO_POSTGIS_PORT || dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432");
assert.equal(host, "127.0.0.1", "Only the authorized local PostgreSQL test service is allowed.");
assert.equal(database, "dbstudio_test", "Only the project test database is allowed.");
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535);

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const suffix = randomBytes(5).toString("hex");
const tableName = `ai_geom_type_${suffix}`;
const table = `public."${tableName}"`;
const service = CoreService.fromPostgresConfig({
  host,
  port,
  database,
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: required("DBSTUDIO_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 8_000,
});

let tableCreated = false;
let stage = "fixture-create";
let outcome;
let failure;
let guardDiagnostics;
let observedDatabaseErrorCode;
let observedDatabaseErrorIsTypeMismatch;
let observedSpatialMetadataRows;
let observedGeometryTypeMatches;
let observedSridMatches;
let observedGeoJsonFunctionSupported;
try {
  const versionResult = await service.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(versionResult.rows.length, 1, "PostGIS must be installed in the isolated test database.");
  const postgisVersion = String(versionResult.rows[0].version);
  await service.query(`CREATE TABLE ${table} (
    id integer PRIMARY KEY,
    properties jsonb NOT NULL,
    geom geometry(Polygon, 4326) NOT NULL
  )`);
  tableCreated = true;
  await service.query(`INSERT INTO ${table} (id, properties, geom) VALUES (
    1, '{"kind":"synthetic"}'::jsonb, ST_GeomFromText('POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))', 4326)
  )`);

  const selectedSql = `SELECT id, ST_AsGeoJSON(properties) AS geojson FROM ${table}`;
  stage = "database-error";
  let databaseError;
  try { await service.query(selectedSql); } catch (error) { databaseError = error; }
  observedDatabaseErrorCode = databaseError?.code;
  observedDatabaseErrorIsTypeMismatch = /function .* does not exist|no function matches|cannot cast|argument.*type/i.test(String(databaseError?.message ?? ""));
  assert.ok(databaseError, "Passing jsonb to ST_AsGeoJSON must fail in PostGIS.");
  assert.equal(databaseError.code, "42883", "Expected undefined_function for the incompatible text argument.");

  stage = "metadata";
  const spatialResult = await service.query(
    `SELECT f_table_schema AS schema, f_table_name AS table_name, f_geometry_column AS column_name,
            type AS geometry_type, srid, coord_dimension AS coordinate_dimension
       FROM geometry_columns WHERE f_table_schema = 'public' AND f_table_name = $1`,
    [tableName],
  );
  observedSpatialMetadataRows = spatialResult.rows.length;
  assert.equal(spatialResult.rows.length, 1);
  const spatial = spatialResult.rows[0];
  observedGeometryTypeMatches = String(spatial.geometry_type).toUpperCase() === "POLYGON";
  observedSridMatches = Number(spatial.srid) === 4326;
  assert.equal(String(spatial.geometry_type).toUpperCase(), "POLYGON");
  assert.equal(Number(spatial.srid), 4326);
  const functionResult = await service.query(
    `SELECT to_regprocedure('st_asgeojson(geometry)') IS NOT NULL
              OR to_regprocedure('st_asgeojson(geometry,integer,integer)') IS NOT NULL AS supported`,
  );
  observedGeoJsonFunctionSupported = functionResult.rows[0]?.supported === true;
  assert.equal(functionResult.rows[0]?.supported, true, "The corrected PostGIS function must be confirmed by this server.");
  const postgis = {
    version: postgisVersion,
    spatialColumns: [{
      schema: String(spatial.schema),
      table: String(spatial.table_name),
      column: String(spatial.column_name),
      kind: "geometry",
      geometryType: String(spatial.geometry_type),
      srid: Number(spatial.srid),
      coordinateDimension: Number(spatial.coordinate_dimension),
    }],
    supportedFunctions: ["ST_ASGEOJSON"],
  };

  stage = "model-repair";
  const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
    task: "repair",
    request: `修复真实 PostGIS 几何函数参数类型错误。${tableName}.properties 是普通 jsonb 元数据，${tableName}.geom 是 geometry(Polygon, SRID 4326)。必须读取实际几何列并保留 id 与 geojson 输出列；不要把 properties 伪造转换为 geometry，也不要更改 SRID。`,
    context: {
      engine: "postgres",
      serverVersion: postgisVersion,
      database,
      schema: "public",
      tables: [{
        schema: "public", name: tableName, type: "table",
        columns: [
          { name: "id", dataType: "integer", nullable: false, primaryKey: true },
          { name: "properties", dataType: "jsonb", nullable: false, primaryKey: false },
          { name: "geom", dataType: "geometry(Polygon,4326)", nullable: false, primaryKey: false },
        ],
      }],
      postgis,
      selectedSql,
      error: { code: databaseError.code, message: String(databaseError.message).slice(0, 1_000) },
    },
  });

  stage = "repair-guard";
  const sql = response.result.sql ?? "";
  const normalized = sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
  const references = response.validation?.referencedTables ?? [];
  const reference = references[0];
  const functions = [...normalized.matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => name !== "as");
  guardDiagnostics = {
    taskCorrect: response.result.task === "repair",
    returnedSql: Boolean(sql),
    valid: response.validation?.valid === true,
    readOnly: response.validation?.readOnly === true,
    oneSourceTable: references.length === 1,
    exactRandomTable: reference?.name?.toLowerCase() === tableName.toLowerCase() && reference?.schema?.toLowerCase() === "public",
    idProjectionPreserved: /^\s*select\s+id\s*,/.test(normalized),
    geojsonProjectionPreserved: /\bst_asgeojson\s*\(\s*(?:[a-z_][a-z0-9_$]*\s*\.\s*)?geom\s*\)\s+as\s+geojson/.test(normalized),
    wrongJsonbColumnRemoved: !/\bst_asgeojson\s*\(\s*(?:[a-z_][a-z0-9_$]*\s*\.\s*)?properties\s*\)/.test(normalized),
    noWriteKeywords: !/\b(?:insert|update|delete|merge|create|alter|drop|truncate|copy)\b/.test(normalized),
    onlyConfirmedFunction: functions.length === 1 && functions[0] === "st_asgeojson",
  };
  for (const [check, passed] of Object.entries(guardDiagnostics)) assert.equal(passed, true, `Repair guard failed: ${check}`);

  stage = "repair-execute";
  const repaired = await service.query(sql);
  assert.equal(repaired.rows.length, 1);
  assert.equal(Number(repaired.rows[0].id), 1);
  const geojson = JSON.parse(String(repaired.rows[0].geojson));
  assert.equal(geojson.type, "Polygon");
  outcome = {
    ok: true,
    scenario: "postgis-live-geometry-argument-type-repair",
    databaseErrorCode: databaseError.code,
    geometryMetadataMatched: true,
    wrongColumnReplaced: true,
    validatedReadOnly: true,
    targetTableMatched: true,
    repairExecuted: true,
    resultRows: repaired.rows.length,
  };
} catch (error) {
  failure = {
    scenario: "postgis-live-geometry-argument-type-repair",
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    failureCode: error?.code,
    databaseErrorCode: observedDatabaseErrorCode,
    databaseErrorIsTypeMismatch: observedDatabaseErrorIsTypeMismatch,
    spatialMetadataRows: observedSpatialMetadataRows,
    geometryTypeMatches: observedGeometryTypeMatches,
    sridMatches: observedSridMatches,
    geoJsonFunctionSupported: observedGeoJsonFunctionSupported,
    providerStatus: error?.status,
    providerCode: error?.providerCode,
    guardDiagnostics,
    responseContentLogged: false,
  };
  process.exitCode = 1;
} finally {
  let fixturesRemoved = true;
  if (tableCreated) {
    try { await service.query(`DROP TABLE IF EXISTS ${table}`); }
    catch (error) { fixturesRemoved = false; failure ??= { scenario: "postgis-live-geometry-argument-type-repair", stage: "fixture-cleanup", databaseErrorCode: error?.code }; process.exitCode = 1; }
  }
  if (failure) failure.fixturesRemoved = fixturesRemoved;
  if (outcome) outcome.fixturesRemoved = fixturesRemoved;
}

if (failure) process.stderr.write(`${JSON.stringify({ ok: false, ...failure })}\n`);
else process.stdout.write(`${JSON.stringify({
  ...outcome,
  schemaSent: "random synthetic PostGIS geometry schema and metadata only",
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
