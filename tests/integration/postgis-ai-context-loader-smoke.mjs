import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import { loadPostgisSchemaMetadata } from "../../packages/ai/dist/index.js";

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
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Configure the authorized project PostGIS test service first.");

const table = "dbsa_" + Date.now().toString(36) + "_" + randomBytes(3).toString("hex");
const core = CoreService.fromEnvironment(environment);
let primaryError;
try {
  const health = await core.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(health.rows.length, 1, "The project test database must have PostGIS installed.");
  const version = String(health.rows[0].version);
  await core.query(`CREATE TABLE public."${table}" (
    id integer PRIMARY KEY,
    geom geometry(Point, 4326),
    geog geography(Point, 4326)
  )`);

  const tables = [{ schema: "public", name: table, type: "table", columns: [] }];
  const { metadata, warnings } = await loadPostgisSchemaMetadata(
    (sql, parameters) => core.query(sql, parameters),
    "public",
    tables,
  );
  assert.equal(metadata.version, version);
  assert.deepEqual(metadata.spatialColumns.map((column) => [
    column.kind, column.column, column.geometryType.toUpperCase(), column.srid,
  ]).sort(), [
    ["geography", "geog", "POINT", 4326],
    ["geometry", "geom", "POINT", 4326],
  ]);
  assert.ok(metadata.supportedFunctions?.includes("ST_DWITHIN"));
  assert.ok(metadata.supportedFunctions?.includes("ST_INTERSECTS"));
  assert.ok(metadata.supportedFunctions?.includes("ST_ASGEOJSON"));
  assert.ok(metadata.supportedFunctions?.includes("ST_ASMVT"));
  assert.ok(metadata.supportedFunctions?.includes("ST_ASMVTGEOM"));
  assert.ok(metadata.supportedFunctions?.includes("ST_TILEENVELOPE"));
  assert.ok(metadata.supportedFunctions?.includes("ST_MAKEENVELOPE"));
  assert.deepEqual(warnings, []);

  process.stdout.write(`${JSON.stringify({
    postgisVersion: metadata.version,
    spatialColumns: metadata.spatialColumns.length,
    supportedFunctions: metadata.supportedFunctions?.length ?? 0,
    vectorTileFunctions: ["ST_ASMVT", "ST_ASMVTGEOM", "ST_TILEENVELOPE"]
      .filter((name) => metadata.supportedFunctions?.includes(name)),
    geometrySrid: metadata.spatialColumns.find((column) => column.column === "geom")?.srid,
    geographySrid: metadata.spatialColumns.find((column) => column.column === "geog")?.srid,
    syntheticFixtureOnly: true,
  })}\n`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await core.query(`DROP TABLE IF EXISTS public."${table}"`);
    const cleanup = await core.query("SELECT to_regclass($1) IS NULL AS removed", [`public.${table}`]);
    if (!primaryError) assert.equal(cleanup.rows[0]?.removed, true, "The temporary metadata fixture must be removed.");
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    process.stderr.write("PostGIS context-loader cleanup also failed.\n");
  }
}
