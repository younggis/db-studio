// Self-contained MVT round-trip: the .pbf fixture is generated at test time
// from PostGIS ST_AsMVT, so the test no longer depends on F:\GeoData / F:\temp.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const envPath = path.join(root, "docker", ".env");
const config = parseEnvFile(envPath);
function resolveGdalBin() {
  if (process.env.DBSTUDIO_GDAL_BIN) return process.env.DBSTUDIO_GDAL_BIN;
  for (const audit of ["local-gis-data-audit-current.json", "local-gis-data-audit-20261104-root-aware.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(root, ".cache", audit), "utf8"));
      if (parsed.gdalBin && existsSync(parsed.gdalBin)) return parsed.gdalBin;
    } catch { /* ignore */ }
  }
  return path.join(root, "apps", "desktop", "resources", "gdal", "bin");
}
const gdalBin = resolveGdalBin();
assert.ok(existsSync(gdalBin), `GDAL runtime not found: ${gdalBin}`);
const environment = {
  ...process.env,
  DBSTUDIO_GDAL_BIN: gdalBin,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? config.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? config.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? config.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? config.DBSTUDIO_PG_PASSWORD,
};
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD,
  "Configure the authorized project PostGIS test service first.");
assert.equal(environment.PGDATABASE, "dbstudio_test", "This test is restricted to the project test database.");
assert.ok(["localhost", "127.0.0.1", "::1"].includes(environment.PGHOST), "The PostGIS test host must be loopback.");

const core = CoreService.fromEnvironment(environment);
const token = `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const schema = `mvt_roundtrip_${token}`;
const fixtureDir = path.join(os.tmpdir(), `dbstudio-mvt-fixture-${token}`);
const pbfPath = path.join(fixtureDir, "synthetic.mvt.pbf");
const reportPath = path.join(root, ".cache", `mvt-postgis-roundtrip-${token}.json`);
const auditPath = path.join(fixtureDir, "audit.json");
let schemaCreated = false;

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function cleanup() {
  if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  if (existsSync(reportPath)) rmSync(reportPath, { force: true });
}

try {
  const connection = await core.testConnection();
  assert.equal(connection.database, "dbstudio_test");
  const postgis = await core.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(postgis.rows.length, 1, "The project test database must have PostGIS installed.");

  // 1) Create synthetic features inside and outside the target tile.
  await core.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  schemaCreated = true;
  await core.query(`CREATE TABLE ${quoteIdentifier(schema)}.roads (
    id bigint PRIMARY KEY,
    name text NOT NULL,
    kind text NOT NULL,
    geom geometry(MultiLineString, 3857) NOT NULL
  )`);
  await core.query(`WITH bounds AS (SELECT ST_TileEnvelope(8, 66, 98) AS geom)
    INSERT INTO ${quoteIdentifier(schema)}.roads (id, name, kind, geom)
    SELECT 1, 'inside road', 'paved', ST_SetSRID(ST_Multi(ST_MakeLine(
      ST_Point(ST_XMin(bounds.geom) + 1000, ST_YMin(bounds.geom) + 1000),
      ST_Point(ST_XMin(bounds.geom) + 2000, ST_YMin(bounds.geom) + 2000)
    )), 3857) FROM bounds
    UNION ALL
    SELECT 2, 'outside road', 'dirt', ST_SetSRID(ST_Multi(ST_MakeLine(
      ST_Point(ST_XMax(bounds.geom) + 1000, ST_YMin(bounds.geom) + 1000),
      ST_Point(ST_XMax(bounds.geom) + 2000, ST_YMin(bounds.geom) + 2000)
    )), 3857) FROM bounds`);

  // 2) Encode an MVT PBF from PostGIS and write it to disk.
  const tile = await core.query(`WITH tile_bounds AS (SELECT ST_TileEnvelope(8, 66, 98) AS geom),
    tile_features AS (
      SELECT roads.id, roads.name, roads.kind,
             ST_AsMVTGeom(roads.geom, tile_bounds.geom, 4096, 64, true) AS geom
      FROM ${quoteIdentifier(schema)}.roads AS roads
      CROSS JOIN tile_bounds
      WHERE roads.geom && tile_bounds.geom AND ST_Intersects(roads.geom, tile_bounds.geom)
    )
    SELECT encode(ST_AsMVT(tile_features.*, 'roads', 4096, 'geom'), 'hex') AS pbf_hex,
           count(*)::int AS feature_count
    FROM tile_features`);
  assert.equal(tile.rows.length, 1);
  assert.equal(Number(tile.rows[0].feature_count), 1, "Only the inside feature should be in the tile.");
  const pbf = Buffer.from(String(tile.rows[0].pbf_hex), "hex");
  assert.ok(pbf.length > 0, "PostGIS returned an empty MVT payload.");
  mkdirSync(fixtureDir, { recursive: false });
  writeFileSync(pbfPath, pbf);

  // 3) Inspect with GDAL; MVT encoding is established by the driver + format.
  const info = await core.inspectGisFile(pbfPath);
  assert.equal(info.driver, "MVT", `GDAL did not identify the synthetic fixture as MVT (got ${info.driver}).`);
  assert.equal(info.encoding.source, "format");
  assert.equal(info.encoding.declaredEncoding, "UTF-8");
  assert.ok(info.layers.length > 0, "The MVT source contains no vector layers.");

  const layerPreviewEvidence = [];
  for (const layer of info.layers) {
    const preview = await core.previewGisAttributes(pbfPath, { sourceLayer: layer.name, limit: 1 });
    assert.equal(preview.requiresUserChoice, false, `MVT layer ${layer.name} incorrectly requires an encoding choice.`);
    layerPreviewEvidence.push(preview);
  }

  // 4) Build a minimal audit that the batch round-trip script consumes.
  const audit = {
    roots: [fixtureDir],
    candidateCount: 1,
    gdalBin,
    datasets: [{
      sourceRoot: fixtureDir,
      relativePath: path.basename(pbfPath),
      extension: ".pbf",
      status: "inspected",
      format: info.format,
      driver: info.driver,
      encoding: info.encoding,
      layers: info.layers.map((layer, index) => ({
        status: "decoded",
        featureCount: layer.featureCount,
        fieldCount: layer.fields.length,
        sampleCount: layerPreviewEvidence[index]?.rows.length ?? 0,
        warningCount: layerPreviewEvidence[index]?.warnings.length ?? 0,
      })),
    }],
  };
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");

  const sourceId = createHash("sha256").update(path.resolve(pbfPath).toLowerCase()).digest("hex").slice(0, 12);
  const batchEnvironment = {
    ...environment,
    DBSTUDIO_LOCAL_GIS_AUDIT_REPORT: auditPath,
    DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT: reportPath,
    DBSTUDIO_LOCAL_GIS_EXPORT_EXTENSION: ".gpkg",
    DBSTUDIO_LOCAL_GIS_ENCODING_OVERRIDES_JSON: "[]",
    DBSTUDIO_LOCAL_GIS_FIELD_MAP_OVERRIDES_JSON: "[]",
    DBSTUDIO_LOCAL_GIS_INCLUDE_SOURCE_IDS_JSON: JSON.stringify([sourceId]),
    DBSTUDIO_LOCAL_GIS_INCLUDE_LAYER_NAME_PREFIXES_JSON: "[]",
    DBSTUDIO_LOCAL_GIS_MAX_BUNDLE_BYTES: String(10 * 1024 * 1024),
    DBSTUDIO_LOCAL_GIS_MAX_FEATURES: "10000",
    DBSTUDIO_LOCAL_GIS_PREFLIGHT_CONCURRENCY: "1",
    DBSTUDIO_LOCAL_GIS_ROUNDTRIP_CONCURRENCY: "1",
    DBSTUDIO_LOCAL_GIS_VERIFY_TEXT_PREVIEW: "true",
  };
  const batchScript = path.join(root, "tests", "integration", "local-gis-roundtrip-batch.mjs");
  await execFileAsync(process.execPath, [batchScript], {
    cwd: root, env: batchEnvironment, encoding: "utf8", windowsHide: true,
    maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.eligibleLayerCount, info.layers.length);
  assert.equal(report.passedLayerCount, info.layers.length);
  assert.equal(report.failureCount, 0);
  assert.equal(report.skipped.encodingChoice, 0);
  assert.ok(report.successfulLayers.every((layer) => layer.exportExtension === ".gpkg"));
  assert.equal(report.postgisTemporaryTablesCleaned, true);
  assert.equal(report.exportDirectoryCleaned, true);
  assert.equal(report.externalDataSent, false);

  process.stdout.write(`${JSON.stringify({
    fixture: "synthetic PostGIS ST_AsMVT PBF generated at test time",
    postgisVersion: postgis.rows[0].version,
    layerCount: report.passedLayerCount,
    pbfBytes: pbf.length,
    exportedFormat: ".gpkg",
    failureCount: report.failureCount,
    dependsOnLocalFiles: false,
    postgisTemporaryTablesCleaned: report.postgisTemporaryTablesCleaned,
    exportDirectoryCleaned: report.exportDirectoryCleaned,
    externalDataSent: report.externalDataSent,
  }, null, 2)}\n`);
} finally {
  if (schemaCreated) {
    try { await core.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`); } catch { /* best effort */ }
  }
  cleanup();
}
