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
const tableName = `ai_srid_${suffix}`;
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
try {
  const versionResult = await service.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(versionResult.rows.length, 1, "PostGIS must be installed in the isolated test database.");
  const postgisVersion = String(versionResult.rows[0].version);
  await service.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, geom geometry(Point, 4326) NOT NULL)`);
  tableCreated = true;
  await service.query(`INSERT INTO ${table} (id, geom) VALUES (1, ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326))`);

  const selectedSql = `SELECT id FROM ${table} WHERE ST_Intersects(geom, ST_SetSRID(ST_MakePoint(-122.4, 37.8), 3857))`;
  stage = "database-error";
  let databaseError;
  try { await service.query(selectedSql); } catch (error) { databaseError = error; }
  assert.ok(databaseError, "The deliberately mismatched SRID query must fail in PostGIS.");
  assert.match(String(databaseError.message), /mixed\s+SRID|SRID.*mismatch|Operation on mixed SRID/i);

  stage = "metadata";
  const spatialResult = await service.query(
    `SELECT f_table_schema AS schema, f_table_name AS table_name, f_geometry_column AS column_name,
            type AS geometry_type, srid, coord_dimension AS coordinate_dimension
       FROM geometry_columns WHERE f_table_schema = 'public' AND f_table_name = $1`,
    [tableName],
  );
  assert.equal(spatialResult.rows.length, 1);
  const spatial = spatialResult.rows[0];
  assert.equal(Number(spatial.srid), 4326);
  const functionResult = await service.query(
    `SELECT name, to_regprocedure(name) IS NOT NULL AS supported
       FROM (VALUES ('st_intersects(geometry,geometry)'), ('st_setsrid(geometry,integer)'),
                    ('st_makepoint(double precision,double precision)')) AS requested(name)`,
  );
  assert.equal(functionResult.rows.length, 3);
  assert.ok(functionResult.rows.every((row) => row.supported === true), "Every function supplied to the model must be confirmed by this server.");
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
    supportedFunctions: [...new Set(functionResult.rows.map((row) => String(row.name).split("(")[0].toUpperCase()))],
  };

  stage = "model-repair";
  const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
    task: "repair",
    request: `修复这个真实 PostGIS mixed SRID 错误。表 ${tableName}.geom 的实际元数据是 geometry(Point, SRID 4326)。查询中的测试点坐标 -122.4, 37.8 原本就是经纬度，必须保留坐标并把这个点标记为 SRID 4326；不要改变表列 SRID，也不要把 3857 坐标误当作经纬度。只返回与原意相同的只读查询。`,
    context: {
      engine: "postgres",
      serverVersion: postgisVersion,
      database,
      schema: "public",
      tables: [{
        schema: "public", name: tableName, type: "table",
        columns: [
          { name: "id", dataType: "integer", nullable: false, primaryKey: true },
          { name: "geom", dataType: "geometry(Point,4326)", nullable: false, primaryKey: false },
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
    projectionPreserved: /^\s*select\s+id\s+from\b/.test(normalized),
    spatialPredicatePreserved: /\bst_intersects\s*\(/.test(normalized),
    correctedSrid: /\bst_setsrid\s*\(\s*st_makepoint\s*\(\s*-122\.4\s*,\s*37\.8\s*\)\s*,\s*4326\s*\)/.test(normalized),
    badSridRemoved: !/\b3857\b/.test(normalized),
    onlyConfirmedFunctions: functions.every((name) => postgis.supportedFunctions.some((supported) => supported.toLowerCase() === name)),
    noWriteKeywords: !/\b(?:insert|update|delete|merge|create|alter|drop|truncate|copy)\b/.test(normalized),
  };
  for (const [check, passed] of Object.entries(guardDiagnostics)) assert.equal(passed, true, `Repair guard failed: ${check}`);

  stage = "repair-execute";
  const repaired = await service.query(sql);
  assert.equal(repaired.rows.length, 1);
  assert.equal(Number(repaired.rows[0].id), 1);
  outcome = {
    ok: true,
    scenario: "postgis-live-mixed-srid-repair",
    databaseErrorCode: databaseError.code,
    sridMetadataMatched: true,
    correctSridPreserved: true,
    validatedReadOnly: true,
    targetTableMatched: true,
    repairExecuted: true,
    resultRows: repaired.rows.length,
  };
} catch (error) {
  failure = {
    scenario: "postgis-live-mixed-srid-repair",
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    failureCode: error?.code,
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
    catch (error) { fixturesRemoved = false; failure ??= { scenario: "postgis-live-mixed-srid-repair", stage: "fixture-cleanup", databaseErrorCode: error?.code }; process.exitCode = 1; }
  }
  if (failure) failure.fixturesRemoved = fixturesRemoved;
  if (outcome) outcome.fixturesRemoved = fixturesRemoved;
}

if (failure) process.stderr.write(`${JSON.stringify({ ok: false, ...failure })}\n`);
else process.stdout.write(`${JSON.stringify({
  ...outcome,
  schemaSent: "random synthetic PostGIS geometry schema and SRID metadata only",
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
