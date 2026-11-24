import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheRoot = path.join(repoRoot, ".cache");
const probeId = process.env.DBSTUDIO_GIS_PROBE_ID || "lanzhou-20261118";
const layerName = process.env.DBSTUDIO_GIS_LAYER_NAME || "兰渝支线";
const expectedFeatureCount = Number(process.env.DBSTUDIO_GIS_EXPECTED_FEATURE_COUNT || "21");
const expectedFieldCount = Number(process.env.DBSTUDIO_GIS_EXPECTED_FIELD_COUNT || "9");
const previewLimit = Math.min(expectedFeatureCount, 100);
const targetLayerName = process.env.DBSTUDIO_GIS_TARGET_LAYER_NAME || "lanzhou_roundtrip";
const testDate = process.env.DBSTUDIO_GIS_TEST_DATE || "2026-11-18";
const archiveMember = process.env.DBSTUDIO_GIS_ARCHIVE_MEMBER
  || "高铁线路车站图及工参/兰渝支线/兰渝支线.TAB";
const evidenceFileName = process.env.DBSTUDIO_GIS_EVIDENCE_FILE || "local-gis-archive-tab-roundtrip-20261118.json";
assert.match(probeId, /^[a-z0-9-]+$/u, "DBSTUDIO_GIS_PROBE_ID must be a lowercase safe slug.");
assert.ok(!/[\\/]/u.test(layerName), "DBSTUDIO_GIS_LAYER_NAME must be a single layer name.");
assert.ok(Number.isSafeInteger(expectedFeatureCount) && expectedFeatureCount > 0, "Expected feature count must be a positive integer.");
assert.ok(Number.isSafeInteger(expectedFieldCount) && expectedFieldCount > 0, "Expected field count must be a positive integer.");
assert.match(targetLayerName, /^[A-Za-z0-9_]+$/u, "DBSTUDIO_GIS_TARGET_LAYER_NAME must be a safe layer name.");
assert.match(testDate, /^\d{4}-\d{2}-\d{2}$/u, "DBSTUDIO_GIS_TEST_DATE must be YYYY-MM-DD.");
assert.match(evidenceFileName, /^[A-Za-z0-9._-]+\.json$/u, "DBSTUDIO_GIS_EVIDENCE_FILE must be a JSON filename.");
const inputRoot = path.join(cacheRoot, `local-gis-archive-probe-${probeId}`);
const input = path.join(inputRoot, layerName, `${layerName}.TAB`);
const sourceArchive = path.join(
  process.env.DBSTUDIO_GIS_ARCHIVE_ROOT || "F:\\temp",
  process.env.DBSTUDIO_GIS_ARCHIVE_FILE || "高铁线路车站图及工参.zip",
);
const evidencePath = path.join(cacheRoot, evidenceFileName);
const runtimeBin = process.env.DBSTUDIO_GDAL_BIN
  || path.join(os.homedir(), "AppData", "Local", "Programs", "@db-studiodesktop", "resources", "gdal", "bin");

assert.ok(path.relative(cacheRoot, inputRoot) && !path.relative(cacheRoot, inputRoot).startsWith(".."),
  "The extracted GIS input must stay below the project cache directory.");
assert.equal(path.dirname(evidencePath), cacheRoot, "Evidence must stay directly below the project cache directory.");
await access(input);
await access(path.join(inputRoot, layerName, `${layerName}.MAP`));
await access(path.join(inputRoot, layerName, `${layerName}.ID`));
await access(path.join(inputRoot, layerName, `${layerName}.DAT`));
await assert.rejects(access(evidencePath), { code: "ENOENT" }, "Refusing to overwrite existing GIS round-trip evidence.");

const dockerEnv = Object.fromEntries(readFileSync(path.join(repoRoot, "docker", ".env"), "utf8")
  .split(/\r?\n/)
  .flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith("#")) return [];
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return [[match[1], value]];
  }));

function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function stableRows(rows, fieldNames) {
  return rows.map((row) => fieldNames.map((field) => row[field] ?? null))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function assertRowsIncluded(sampleRows, allRows, description) {
  const available = new Map();
  for (const row of allRows) {
    const key = JSON.stringify(row);
    const rows = available.get(key) ?? [];
    rows.push(row);
    available.set(key, rows);
  }
  const matched = [];
  for (const row of sampleRows) {
    const key = JSON.stringify(row);
    const rows = available.get(key);
    assert.ok(rows?.length, `${description}: a sampled row is missing from the full dataset`);
    matched.push(rows.pop());
  }
  return matched;
}

function normalizeGeometry(value) {
  if (typeof value === "number") return Math.round(value * 1_000_000_000) / 1_000_000_000;
  if (Array.isArray(value)) return value.map(normalizeGeometry);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeGeometry(value[key])]));
  }
  return value ?? null;
}

function stableFeatures(preview, fieldNames) {
  return preview.rows.map((row, index) => ({
    attributes: fieldNames.map((field) => row[field] ?? null),
    geometry: normalizeGeometry(preview.features[index]?.geometry),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

const port = Number(required("DBSTUDIO_POSTGIS_PORT", "25432"));
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "DBSTUDIO_POSTGIS_PORT must be a valid port.");
process.env.DBSTUDIO_GDAL_BIN = runtimeBin;
const core = CoreService.fromPostgresConfig({
  host: "127.0.0.1",
  port,
  database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: required("DBSTUDIO_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
});
const tableName = `db_gis_${probeId.replaceAll("-", "_")}_${randomBytes(5).toString("hex")}`;
const table = `public.${tableName}`;
const qualifiedTable = `${quoteIdentifier("public")}.${quoteIdentifier(tableName)}`;
const output = path.join(inputRoot, `${probeId.replaceAll("-", "_")}-roundtrip.gpkg`);
let primaryError;

try {
  const sourceInfo = await core.inspectGisFile(input);
  assert.equal(sourceInfo.format, "MapInfo TAB", "source format");
  assert.equal(sourceInfo.encoding?.declaredEncoding, "CP936", "declared MapInfo charset mapping");
  assert.equal(sourceInfo.encoding?.source, "metadata", "source encoding must come from the TAB header");
  const sourceLayer = sourceInfo.layers.find((layer) => layer.name === layerName);
  assert.ok(sourceLayer, "MapInfo layer");
  assert.equal(sourceLayer.featureCount, expectedFeatureCount, "source feature count");

  const sourcePreview = await core.previewGisAttributes(input, { sourceLayer: sourceLayer.name, limit: previewLimit });
  assert.equal(sourcePreview.requiresUserChoice, false, "declared source charset does not require a manual choice");
  assert.equal(sourcePreview.rows.length, previewLimit, "source preview sample rows");
  const fieldNames = sourcePreview.fields.map((field) => field.name);
  assert.equal(fieldNames.length, expectedFieldCount, "source field count");
  assert.ok(fieldNames.includes("线路名称"), "Chinese field name is decoded");
  assert.ok(sourcePreview.rows.some((row) => Object.values(row).some((value) =>
    typeof value === "string" && /[^\x00-\x7f]/u.test(value))), "Chinese attribute values are decoded");
  const sourceRows = stableRows(sourcePreview.rows, fieldNames);

  const importReport = await core.importGisToPostgres(input, table, { sourceLayer: sourceLayer.name });
  assert.equal(importReport.status, "completed", "PostGIS import status");
  assert.equal(importReport.featureCount, expectedFeatureCount, "PostGIS import feature count");
  const importedRows = await core.query(`SELECT ${fieldNames.map(quoteIdentifier).join(", ")} FROM ${qualifiedTable}`);
  assert.equal(importedRows.rowCount, expectedFeatureCount, "PostGIS stored row count");
  const importedCanonical = stableRows(importedRows.rows, fieldNames);
  const postgisSampleRows = assertRowsIncluded(sourceRows, importedCanonical, "PostGIS import");

  const geometryColumns = await core.query(
    "SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2",
    ["public", tableName],
  );
  assert.equal(geometryColumns.rowCount, 1, "one PostGIS geometry column");
  const geometryColumn = quoteIdentifier(String(geometryColumns.rows[0].f_geometry_column));
  const geometryStats = await core.query(
    `SELECT count(*)::int AS total, count(${geometryColumn})::int AS non_null, ` +
      `count(*) FILTER (WHERE ST_IsValid(${geometryColumn}))::int AS valid FROM ${qualifiedTable}`,
  );
  assert.equal(geometryStats.rowCount, 1, "one PostGIS geometry statistics row");
  assert.equal(geometryStats.rows[0].total, expectedFeatureCount, "PostGIS geometry row count");
  assert.ok(geometryStats.rows[0].valid >= 0
    && geometryStats.rows[0].valid <= geometryStats.rows[0].non_null
    && geometryStats.rows[0].non_null <= geometryStats.rows[0].total, "PostGIS geometry validity counts are consistent");

  const exported = await core.exportGisFromPostgres(table, output, { targetLayerName });
  const exportedLayer = exported.layers.find((layer) => layer.name === targetLayerName);
  assert.ok(exportedLayer, "GeoPackage output layer");
  assert.equal(exportedLayer.featureCount, expectedFeatureCount, "GeoPackage feature count");
  const outputPreview = await core.previewGisAttributes(output, { sourceLayer: exportedLayer.name, limit: previewLimit });
  assert.equal(outputPreview.rows.length, previewLimit, "GeoPackage preview sample rows");
  assert.deepEqual(outputPreview.fields.map((field) => field.name), fieldNames, "exported field names");
  const outputRows = stableRows(outputPreview.rows, fieldNames);
  assert.deepEqual(outputRows, sourceRows, "all decoded source attributes must survive the GeoPackage round trip");
  const sourceFeatures = stableFeatures(sourcePreview, fieldNames);
  const outputFeatures = stableFeatures(outputPreview, fieldNames);
  assert.deepEqual(outputFeatures, sourceFeatures, "source geometries must survive PostGIS and GeoPackage round trip");

  await writeFile(evidencePath, `${JSON.stringify({
    testDate,
    probeId,
    source: `${sourceArchive}::${archiveMember}`,
    format: sourceInfo.format,
    driver: sourceInfo.driver,
    declaredEncoding: sourceInfo.encoding.declaredEncoding,
    encodingSource: sourceInfo.encoding.source,
    sourceFeatures: sourceLayer.featureCount,
    fieldCount: fieldNames.length,
    chineseFieldNameVerified: true,
    chineseAttributeValuesVerified: true,
    postgisRows: importedRows.rowCount,
    validGeometries: geometryStats.rows[0].valid,
    invalidGeometriesPreserved: geometryStats.rows[0].total - geometryStats.rows[0].valid,
    exportedFeatures: exportedLayer.featureCount,
    previewRowsCompared: previewLimit,
    sourceAttributeSampleSha256: digest(sourceRows),
    postgisAttributeSampleSha256: digest(postgisSampleRows),
    exportedAttributeSampleSha256: digest(outputRows),
    sourceGeometrySampleSha256: digest(sourceFeatures),
    exportedGeometrySampleSha256: digest(outputFeatures),
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    ok: true,
    probeId,
    layerName,
    format: sourceInfo.format,
    declaredEncoding: sourceInfo.encoding.declaredEncoding,
    features: sourceLayer.featureCount,
    fields: fieldNames.length,
    postgisRows: importedRows.rowCount,
    validGeometries: geometryStats.rows[0].valid,
    invalidGeometriesPreserved: geometryStats.rows[0].total - geometryStats.rows[0].valid,
    exportedFeatures: exportedLayer.featureCount,
    previewRowsCompared: previewLimit,
    sourceAttributeSampleSha256: digest(sourceRows),
    postgisAttributeSampleSha256: digest(postgisSampleRows),
    exportedAttributeSampleSha256: digest(outputRows),
    sourceGeometrySampleSha256: digest(sourceFeatures),
    exportedGeometrySampleSha256: digest(outputFeatures),
  }, null, 2));
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  try { await core.query(`DROP TABLE IF EXISTS ${qualifiedTable}`); } catch (error) { cleanupErrors.push(error); }
  try { await rm(output, { force: true }); } catch (error) { cleanupErrors.push(error); }
  try { await rm(inputRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (!primaryError && cleanupErrors.length) throw cleanupErrors[0];
}
