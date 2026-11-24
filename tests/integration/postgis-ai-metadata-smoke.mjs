import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const envPath = path.join(root, "docker", ".env");
const dockerEnv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]))
  : {};
const environment = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? dockerEnv.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? dockerEnv.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? dockerEnv.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? dockerEnv.DBSTUDIO_PG_PASSWORD,
};
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Configure the authorized project PostGIS test service first.");
assert.ok(existsSync(cli), "Build the CLI first with `pnpm build`.");

const table = "dbsa_" + Date.now().toString(36) + "_" + randomBytes(3).toString("hex");
function query(sql) {
  return JSON.parse(execFileSync(process.execPath, [cli, "query", "run", "--sql", sql, "--format", "json"], {
    cwd: root, env: environment, encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  }));
}

let primaryError;
try {
  const health = query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(health.rowCount, 1, "The project test database must have PostGIS installed.");
  const version = String(health.rows[0].version);
  query(`CREATE TABLE public."${table}" (id integer PRIMARY KEY, geom geometry(Point, 4326), geog geography(Point, 4326))`);
  query(`COMMENT ON TABLE public."${table}" IS 'AI metadata smoke table'`);
  query(`COMMENT ON COLUMN public."${table}".geom IS 'Spatial point'`);
  const spatial = query(
    "SELECT spatial.kind, spatial.schema, spatial.table_name, spatial.column_name, " +
      "spatial.geometry_type, spatial.srid, spatial.coordinate_dimension, srs.proj4text " +
      "FROM ( " +
      "SELECT 'geometry' AS kind, f_table_schema AS schema, f_table_name AS table_name, " +
      "f_geometry_column AS column_name, type AS geometry_type, srid, coord_dimension AS coordinate_dimension " +
      "FROM geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '" + table + "' " +
      "UNION ALL " +
      "SELECT 'geography' AS kind, f_table_schema AS schema, f_table_name AS table_name, " +
      "f_geography_column AS column_name, type AS geometry_type, srid, coord_dimension AS coordinate_dimension " +
      "FROM geography_columns WHERE f_table_schema = 'public' AND f_table_name = '" + table + "' " +
      ") AS spatial LEFT JOIN spatial_ref_sys AS srs ON srs.srid = spatial.srid",
  );
  assert.deepEqual(spatial.rows.map((row) => [row.kind, row.column_name, String(row.geometry_type).toUpperCase(), Number(row.srid)]).sort(), [
    ["geography", "geog", "POINT", 4326], ["geometry", "geom", "POINT", 4326],
  ]);
  const geometrySrs = spatial.rows.find((row) => row.kind === "geometry");
  assert.match(String(geometrySrs?.proj4text), /\+proj=longlat\b/, "EPSG:4326 geometry metadata must expose angular coordinate units.");
  const functions = query(
      `SELECT name,
              to_regprocedure(name) IS NOT NULL
                OR (fallback_signature IS NOT NULL AND to_regprocedure(fallback_signature) IS NOT NULL) AS supported
       FROM (VALUES ('st_intersects(geometry,geometry)', NULL::text),
                    ('st_intersects(geography,geography)', NULL::text),
                    ('st_contains(geometry,geometry)', NULL::text),
                    ('st_within(geometry,geometry)', NULL::text),
                    ('st_dwithin(geometry,geometry,double precision)', NULL::text),
                    ('st_dwithin(geography,geography,double precision,boolean)', NULL::text),
                    ('st_distance(geometry,geometry)', NULL::text),
                    ('st_distance(geography,geography,boolean)', NULL::text),
                    ('st_buffer(geometry,double precision)', NULL::text),
                    ('st_buffer(geography,double precision)', NULL::text),
                    ('st_makepoint(double precision,double precision)', NULL::text),
                    ('st_setsrid(geometry,integer)', NULL::text),
                    ('st_geomfromtext(text,integer)', NULL::text),
                    ('st_geogfromtext(text)', NULL::text),
                    ('st_transform(geometry,integer)', NULL::text),
                    ('st_area(geometry)', NULL::text), ('st_area(geography)', NULL::text),
                    ('st_length(geometry)', NULL::text), ('st_length(geography)', NULL::text),
                    ('st_asgeojson(geometry)', 'st_asgeojson(geometry,integer,integer)'),
                    ('st_asmvt(anyelement,text,integer,text)', 'st_asmvt(anyelement,text,integer,text,text)'),
                    ('st_asmvt(anyelement,text,integer,text,text)', NULL::text)) AS requested(name, fallback_signature)` ,
  );
  assert.ok(functions.rows.some((row) => row.name.startsWith("st_intersects") && row.supported));
  assert.ok(functions.rows.some((row) => row.name.startsWith("st_dwithin(geography") && row.supported));
  assert.ok(functions.rows.some((row) => row.name === "st_makepoint(double precision,double precision)" && row.supported));
  assert.ok(functions.rows.some((row) => row.name === "st_setsrid(geometry,integer)" && row.supported));
  assert.ok(functions.rows.some((row) => row.name === "st_asgeojson(geometry)" && row.supported));
  assert.ok(functions.rows.some((row) => row.name === "st_asmvt(anyelement,text,integer,text)" && row.supported));
  const comments = query(
    `SELECT obj_description(c.oid, 'pg_class') AS table_comment,
            col_description(c.oid, a.attnum) AS column_comment
       FROM pg_catalog.pg_class AS c
       JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attname = 'geom' AND a.attnum > 0
      WHERE n.nspname = 'public' AND c.relname = '${table}'`,
  );
  assert.equal(comments.rows[0]?.table_comment, "AI metadata smoke table");
  assert.equal(comments.rows[0]?.column_comment, "Spatial point");
  process.stdout.write(JSON.stringify({ postgisVersion: version, spatialColumns: spatial.rows.length, supportedFunctions: functions.rows.filter((row) => row.supported).length }) + "\n");
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try { query(`DROP TABLE IF EXISTS public."${table}"`); }
  catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    process.stderr.write("PostGIS metadata smoke cleanup also failed.\n");
  }
  const cleanup = query(`SELECT to_regclass('public.${table}') IS NULL AS removed`);
  if (!primaryError) assert.equal(cleanup.rows[0]?.removed, true, "The temporary metadata fixture must be removed.");
}
