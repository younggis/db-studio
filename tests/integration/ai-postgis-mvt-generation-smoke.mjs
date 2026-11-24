import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import { loadPostgisSchemaMetadata, runSqlAssistant } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = path.join(root, "docker", ".env");
const dockerEnv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]))
  : {};
const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "postgres",
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? dockerEnv.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? dockerEnv.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? dockerEnv.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? dockerEnv.DBSTUDIO_PG_PASSWORD,
};
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD,
  "Configure the authorized project PostGIS test service first.");
assert.equal(environment.PGDATABASE, "dbstudio_test", "This smoke test is restricted to the project test database.");
assert.ok(["localhost", "127.0.0.1", "::1"].includes(environment.PGHOST), "The PostGIS test host must be loopback.");
assert.equal(String(environment.PGPORT), "25432", "This smoke test is restricted to the authorized project PostGIS port.");

const modelSettings = await readDesktopAiModelSettings();
const chatConfig = modelSettings?.chatModels.find((model) => model.id === modelSettings.defaultChatModelId && model.enabled)
  ?? modelSettings?.chatModels.find((model) => model.enabled);
assert.ok(modelSettings?.enabled && chatConfig?.apiKey, "Enable the encrypted desktop Chat settings first.");
const modelUrl = new URL(chatConfig.baseURL);
assert.equal(modelUrl.protocol, "https:", "This test sends synthetic Schema metadata only over HTTPS.");
assert.equal(modelUrl.hostname, "dashscope.aliyuncs.com", "Only the previously authorized DashScope endpoint is allowed.");

const token = `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const schema = `ai_mvt_${token}`;
const tableName = "synthetic_roads";
const tableSql = `"${schema}"."${tableName}"`;
const core = CoreService.fromEnvironment(environment);
let created = false;
let primaryError;
let stage = "verify-isolated-postgis";

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

try {
  const connection = await core.testConnection();
  assert.equal(connection.database, "dbstudio_test");
  const extension = await core.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(extension.rows.length, 1, "The project test database must have PostGIS installed.");

  stage = "create-synthetic-schema";
  await core.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  created = true;
  await core.query(`CREATE TABLE ${tableSql} (
    id bigint PRIMARY KEY,
    name text NOT NULL,
    geom geometry(MultiLineString, 3857) NOT NULL
  )`);
  await core.query(`COMMENT ON TABLE ${tableSql} IS 'Synthetic MVT road metadata'`);

  stage = "load-live-postgis-metadata";
  const listed = await core.listTables(schema);
  assert.equal(listed.length, 1);
  const listedTable = listed[0];
  const columns = await core.getTableColumns(listedTable.name, schema);
  assert.deepEqual(new Set(columns.map((column) => column.name)), new Set(["id", "name", "geom"]));
  const table = {
    schema: listedTable.schema,
    name: listedTable.name,
    type: listedTable.type,
    comment: listedTable.comment ?? undefined,
    columns: columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      primaryKey: column.primaryKey,
      comment: column.comment ?? undefined,
    })),
  };
  const loaded = await loadPostgisSchemaMetadata((sql, parameters) => core.query(sql, parameters), schema, [table]);
  assert.equal(loaded.metadata.version, extension.rows[0].version);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.metadata.spatialColumns.map((column) => [column.table, column.column, column.srid]), [
    [tableName, "geom", 3857],
  ]);
  const supported = new Set(loaded.metadata.supportedFunctions ?? []);
  for (const name of ["ST_ASMVT", "ST_ASMVTGEOM", "ST_TILEENVELOPE"]) {
    assert.ok(supported.has(name), `The test server must confirm ${name} support.`);
  }
  table.columns = table.columns.map((column) => column.name === "geom"
    ? { ...column, dataType: "geometry", spatial: { kind: "geometry", geometryType: "MULTILINESTRING", srid: 3857 } }
    : column);

  stage = "dashscope-mvt-generation";
  const generated = await runSqlAssistant({ ...chatConfig, timeoutMs: 60_000 }, {
    task: "gis",
    request: `Create one read-only PostGIS query that returns a Mapbox Vector Tile for z=8, x=66, y=98 from only ${schema}.${tableName}. Use the supplied id, name, and geom columns. The geometry is already EPSG:3857. Use the confirmed ST_TileEnvelope, ST_AsMVTGeom, and ST_AsMVT functions; pass the exact XYZ values to ST_TileEnvelope, clip/filter geometries to that tile, use extent 4096 and buffer 64, and return one MVT result column. Do not transform coordinates or invent columns.`,
    context: {
      engine: "postgres",
      serverVersion: connection.serverVersion,
      database: connection.database,
      schema,
      tables: [table],
      postgis: loaded.metadata,
      metadataWarnings: loaded.warnings,
    },
  });
  assert.equal(generated.result.task, "gis");
  assert.ok(generated.result.sql, "DashScope should return a GIS SQL draft for the synthetic MVT request.");
  assert.equal(generated.validation?.valid, true,
    `The generated MVT draft must pass local read-only and Schema validation: ${(generated.validation?.errors ?? []).join("; ")}`);
  assert.deepEqual(generated.validation.referencedTables.map((item) => [item.schema, item.name]), [[schema, tableName]]);
  const sql = generated.result.sql;
  assert.match(sql, /\bst_tileenvelope\s*\(\s*8\s*,\s*66\s*,\s*98\b/i, "The draft must preserve the requested XYZ tile.");
  assert.match(sql, /\bst_asmvtgeom\s*\(/i, "The draft must clip geometry for vector-tile encoding.");
  assert.match(sql, /\bst_asmvt\s*\(/i, "The draft must encode a Mapbox Vector Tile.");
  assert.match(sql, /\b4096\b/, "The draft must use the requested tile extent.");
  assert.match(sql, /\b64\b/, "The draft must use the requested tile buffer.");

  process.stdout.write(`${JSON.stringify({
    database: "dbstudio_test",
    postgisVersion: loaded.metadata.version,
    syntheticTablesLoaded: 1,
    spatialColumnsLoaded: loaded.metadata.spatialColumns.length,
    confirmedMvtFunctions: ["ST_AsMVT", "ST_AsMVTGeom", "ST_TileEnvelope"],
    requestedTilePreserved: "8/66/98",
    readOnlyAndSchemaValidationPassed: generated.validation.valid,
    generatedSqlExecuted: false,
    businessRowsRead: false,
    externalPayload: "synthetic Schema metadata and synthetic MVT intent only",
  })}\n`);
} catch (error) {
  primaryError = error;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ stage, error: message.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]").slice(0, 500) })}\n`);
  process.exitCode = 1;
} finally {
  if (created) {
    let cleanupError;
    await core.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch((error) => { cleanupError = error; });
    const remaining = await core.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
      [schema],
    ).catch(() => ({ rows: [{ schema_name: schema }] }));
    if (remaining.rows.length) cleanupError ??= new Error("Synthetic Schema cleanup verification failed.");
    if (cleanupError) {
      if (!primaryError) throw cleanupError;
      process.stderr.write("Synthetic PostGIS Schema cleanup failed.\n");
      process.exitCode = 1;
    }
  }
}
