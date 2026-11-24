import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

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

const token = `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const schema = `mvt_smoke_${token}`;
const table = "synthetic_roads";
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

  stage = "create-synthetic-features";
  await core.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  created = true;
  await core.query(`CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (
    id bigint PRIMARY KEY,
    name text NOT NULL,
    geom geometry(MultiLineString, 3857) NOT NULL
  )`);
  await core.query(`WITH bounds AS (
    SELECT ST_TileEnvelope(8, 66, 98) AS geom
  )
  INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (id, name, geom)
  SELECT 1, 'inside', ST_SetSRID(ST_Multi(ST_MakeLine(
    ST_Point(ST_XMin(Box2D(geom)) + 1000, ST_YMin(Box2D(geom)) + 1000),
    ST_Point(ST_XMin(Box2D(geom)) + 2000, ST_YMin(Box2D(geom)) + 2000)
  )), 3857)
  FROM bounds
  UNION ALL
  SELECT 2, 'outside', ST_SetSRID(ST_Multi(ST_MakeLine(
    ST_Point(ST_XMax(Box2D(geom)) + 1000, ST_YMin(Box2D(geom)) + 1000),
    ST_Point(ST_XMax(Box2D(geom)) + 2000, ST_YMin(Box2D(geom)) + 2000)
  )), 3857)
  FROM bounds`);

  stage = "execute-deterministic-mvt-reference-query";
  const result = await core.query(`WITH tile_bounds AS (
    SELECT ST_TileEnvelope(8, 66, 98) AS geom
  ), tile_features AS (
    SELECT roads.id,
           roads.name,
           ST_AsMVTGeom(roads.geom, tile_bounds.geom, 4096, 64, true) AS geom
    FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} AS roads
    CROSS JOIN tile_bounds
    WHERE roads.geom && tile_bounds.geom
      AND ST_Intersects(roads.geom, tile_bounds.geom)
  )
  SELECT octet_length(ST_AsMVT(tile_features.*, 'roads', 4096, 'geom'))::int AS mvt_bytes,
         count(*)::int AS feature_count
  FROM tile_features`);
  assert.equal(result.rows.length, 1);
  assert.equal(Number(result.rows[0].feature_count), 1, "Only the synthetic feature inside the requested tile should be encoded.");
  assert.ok(Number(result.rows[0].mvt_bytes) > 0, "PostGIS should return a non-empty MVT PBF payload.");

  process.stdout.write(`${JSON.stringify({
    database: "dbstudio_test",
    postgisVersion: extension.rows[0].version,
    requestedTile: "8/66/98",
    syntheticFeaturesInserted: 2,
    encodedFeatures: Number(result.rows[0].feature_count),
    mvtPbfBytes: Number(result.rows[0].mvt_bytes),
    outsideFeatureExcluded: true,
    querySource: "deterministic integration fixture, not model-generated SQL",
    businessRowsRead: false,
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
