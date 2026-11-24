import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const sourceReportPath = process.env.DBSTUDIO_LOCAL_GIS_AUDIT_REPORT
  || path.join(root, ".cache", "local-gis-data-audit-20261103-static584.json");
const outputReportPath = process.env.DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT
  || path.join(root, ".cache", "local-gis-roundtrip-batch-20261103.json");
const encodingOverrides = new Map(JSON.parse(process.env.DBSTUDIO_LOCAL_GIS_ENCODING_OVERRIDES_JSON || "[]")
  .filter((item) => item && typeof item.filePath === "string" && typeof item.encoding === "string")
  .map((item) => [path.resolve(item.filePath), item.encoding]));
const includeSourceIdsInput = JSON.parse(process.env.DBSTUDIO_LOCAL_GIS_INCLUDE_SOURCE_IDS_JSON || "[]");
assert.ok(Array.isArray(includeSourceIdsInput) && includeSourceIdsInput.every((sourceId) => typeof sourceId === "string" && /^[a-f0-9]{12}$/i.test(sourceId)), "DBSTUDIO_LOCAL_GIS_INCLUDE_SOURCE_IDS_JSON must be an array of 12-digit source IDs.");
const includeSourceIds = new Set(includeSourceIdsInput.map((sourceId) => sourceId.toLowerCase()));
const includeLayerNamePrefixesInput = JSON.parse(process.env.DBSTUDIO_LOCAL_GIS_INCLUDE_LAYER_NAME_PREFIXES_JSON || "[]");
assert.ok(Array.isArray(includeLayerNamePrefixesInput) && includeLayerNamePrefixesInput.every((name) => typeof name === "string" && name.length > 0), "DBSTUDIO_LOCAL_GIS_INCLUDE_LAYER_NAME_PREFIXES_JSON must be an array of non-empty layer-name prefixes.");
const includeLayerNamePrefixes = includeLayerNamePrefixesInput;
const fieldTypeOverridesInput = JSON.parse(process.env.DBSTUDIO_LOCAL_GIS_FIELD_TYPE_OVERRIDES_JSON || "[]");
assert.ok(Array.isArray(fieldTypeOverridesInput) && fieldTypeOverridesInput.every((entry) =>
  entry && typeof entry.sourceId === "string" && /^[a-f0-9]{12}$/i.test(entry.sourceId) && Array.isArray(entry.fieldTypes)
  && entry.fieldTypes.every((field) => field && typeof field.source === "string" && field.source && ["string", "integer", "integer64", "real", "date", "time", "datetime"].includes(field.targetType)),
), "DBSTUDIO_LOCAL_GIS_FIELD_TYPE_OVERRIDES_JSON must contain source IDs and supported field type mappings.");
const fieldTypeOverridesBySourceId = new Map(fieldTypeOverridesInput.map((entry) => [entry.sourceId.toLowerCase(), entry.fieldTypes]));
const fieldMapOverridesInput = JSON.parse(process.env.DBSTUDIO_LOCAL_GIS_FIELD_MAP_OVERRIDES_JSON || "[]");
assert.ok(Array.isArray(fieldMapOverridesInput) && fieldMapOverridesInput.every((entry) =>
  entry && typeof entry.sourceId === "string" && /^[a-f0-9]{12}$/i.test(entry.sourceId)
  && (entry.layerIndex === undefined || Number.isSafeInteger(entry.layerIndex) && entry.layerIndex >= 0)
  && Array.isArray(entry.fieldMappings)
  && entry.fieldMappings.every((field) => field && typeof field.source === "string" && field.source && typeof field.target === "string" && field.target),
), "DBSTUDIO_LOCAL_GIS_FIELD_MAP_OVERRIDES_JSON must contain source IDs and source/target field mappings.");
const fieldMapOverridesBySourceId = new Map(fieldMapOverridesInput.map((entry) => [
  `${entry.sourceId.toLowerCase()}:${entry.layerIndex ?? "*"}`,
  entry.fieldMappings,
]));
const envPath = path.join(root, "docker", ".env");
const sourceReport = JSON.parse(readFileSync(sourceReportPath, "utf8"));
function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const config = parseEnvFile(envPath);
const gdalBin = process.env.DBSTUDIO_GDAL_BIN || sourceReport.gdalBin;
const environment = {
  ...process.env,
  DBSTUDIO_GDAL_BIN: gdalBin,
  PGHOST: "127.0.0.1",
  PGPORT: config.DBSTUDIO_POSTGIS_PORT || "25432",
  PGDATABASE: config.DBSTUDIO_PG_DATABASE,
  PGUSER: config.DBSTUDIO_PG_USER,
  PGPASSWORD: config.DBSTUDIO_PG_PASSWORD,
};
environment.PATH = `${gdalBin}${path.delimiter}${environment.PATH ?? ""}`;
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Configure the authorized project PostGIS test service first.");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
assert.ok(existsSync(cli), "Build the CLI before running this integration check.");

const runId = randomBytes(4).toString("hex");
const tempRoot = path.join(os.tmpdir(), `dbstudio-local-gis-batch-${runId}`);
mkdirSync(tempRoot, { recursive: false });
const core = CoreService.fromEnvironment(environment);
const allowedExtensions = new Set([
  ".shp", ".geojson", ".geojsonl", ".json", ".kml", ".kmz", ".tab", ".mif", ".gpkg",
  ".gml", ".gpx", ".fgb", ".sqlite", ".db", ".dxf", ".csv", ".osm", ".pbf", ".parquet",
]);
const bundleExtensionsByFormat = {
  ".shp": new Set([
    ".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix", ".sbn", ".sbx",
    ".fbn", ".fbx", ".ain", ".aih", ".ixs", ".mxs", ".atx", ".shp.xml",
  ]),
  ".tab": new Set([".tab", ".dat", ".map", ".id", ".ind", ".dbf", ".prj", ".cpg"]),
  ".mif": new Set([".mif", ".mid", ".prj", ".cpg"]),
  ".csv": new Set([".csv", ".csvt", ".prj", ".cpg"]),
};
function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer.`);
  return value;
}

const maxBundleBytes = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_MAX_BUNDLE_BYTES", 20 * 1024 * 1024);
const maxFeatures = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_MAX_FEATURES", 10_000);
const cliTimeoutMs = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_CLI_TIMEOUT_MS", 120_000);
const verifyTextAttributePreview = process.env.DBSTUDIO_LOCAL_GIS_VERIFY_TEXT_PREVIEW === "true";
const verifyGeometrySample = process.env.DBSTUDIO_LOCAL_GIS_VERIFY_GEOMETRY === "true";
const geometrySampleLimit = 20;
const geometryCoordinateTolerance = 1e-8;
const candidates = [];
const skipped = { missingSource: 0, unsupportedExtension: 0, sourceInspectFailed: 0, layerIndexMismatch: 0, encodingChoice: 0, previewFailed: 0, invalidCount: 0, tooManyFeatures: 0, tooLarge: 0 };

function sourcePathFor(dataset) {
  const candidateRoots = typeof dataset.sourceRoot === "string" ? [dataset.sourceRoot] : sourceReport.roots;
  return candidateRoots.map((candidateRoot) => path.resolve(candidateRoot, dataset.relativePath)).find((candidate) => existsSync(candidate));
}

function sourceIdFor(sourcePath) {
  return createHash("sha256").update(path.resolve(sourcePath).toLowerCase()).digest("hex").slice(0, 12);
}

function dataBundleSize(sourcePath) {
  const directory = path.dirname(sourcePath);
  const extension = path.extname(sourcePath).toLowerCase();
  const companionExtensions = bundleExtensionsByFormat[extension];
  if (!companionExtensions) return statSync(sourcePath).size;
  const stem = path.basename(sourcePath, extension).toLowerCase();
  return readdirSync(directory).reduce((sum, entry) => {
    const lowerName = entry.toLowerCase();
    if (!lowerName.startsWith(`${stem}.`) || !companionExtensions.has(lowerName.slice(stem.length))) return sum;
    try { return sum + statSync(path.join(directory, entry)).size; } catch { return sum; }
  }, 0);
}

function extentSummary(extent) {
  if (!extent || ![extent.minX, extent.minY, extent.maxX, extent.maxY].every(Number.isFinite)) return null;
  return {
    xSpan: Number((extent.maxX - extent.minX).toPrecision(6)),
    ySpan: Number((extent.maxY - extent.minY).toPrecision(6)),
    maxAbsCoordinate: Number(Math.max(
      Math.abs(extent.minX), Math.abs(extent.minY), Math.abs(extent.maxX), Math.abs(extent.maxY),
    ).toPrecision(6)),
  };
}

function geometryToleranceForOutput(extension, extent) {
  if ([".geojson", ".json"].includes(extension)) {
    // RFC 7946 output is WGS 84 longitude/latitude. Allow up to 1e-7 degrees
    // (~1.1 cm in latitude) for a roundtrip through OGR and PostGIS while
    // keeping altitude/measure comparisons and vertex topology strict.
    return { xy: 1e-7, otherOrdinates: geometryCoordinateTolerance };
  }
  if (extension !== ".tab" || !extent || ![extent.minX, extent.minY, extent.maxX, extent.maxY].every(Number.isFinite)) {
    return geometryCoordinateTolerance;
  }
  const span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
  if (!Number.isFinite(span) || span < 0) return geometryCoordinateTolerance;
  // TAB stores map coordinates in signed 32-bit coordinate blocks. Allow two
  // grid units for independently encoding the source and target TAB bounds,
  // rather than applying a fixed coordinate-units threshold to every layer.
  return {
    xy: Math.max(geometryCoordinateTolerance, 2 * span / (2 ** 31)),
    otherOrdinates: geometryCoordinateTolerance,
  };
}

function readdirSyncSafe(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: root, env: environment, encoding: "utf8", windowsHide: true,
    maxBuffer: 8 * 1024 * 1024, timeout: cliTimeoutMs,
  });
  return stdout.trim();
}

async function readGeometrySample(filePath, layerName, { rfc7946 = false } = {}) {
  const ogr2ogr = path.join(gdalBin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr");
  const args = ["-f", "GeoJSON", "/vsistdout/"];
  if (rfc7946) args.push("-lco", "RFC7946=YES", "-lco", "COORDINATE_PRECISION=17");
  args.push("-limit", String(geometrySampleLimit), filePath, layerName);
  const { stdout } = await execFileAsync(ogr2ogr, args, {
    cwd: root, env: environment, encoding: "utf8", windowsHide: true,
    maxBuffer: 32 * 1024 * 1024, timeout: cliTimeoutMs,
  });
  const value = JSON.parse(stdout);
  return Array.isArray(value.features) ? value.features.map((feature) => feature?.geometry ?? null) : [];
}

function toleranceForOrdinate(tolerance, index) {
  return typeof tolerance === "number"
    ? tolerance
    : index < 2 ? tolerance.xy : tolerance.otherOrdinates;
}

function coordinatesMatch(left, right, tolerance, allowZeroAltitudePadding = false) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.every((value) => typeof value === "number") && right.every((value) => typeof value === "number")) {
      const addedZeroAltitude = allowZeroAltitudePadding
        && left.length === 2 && right.length === 3 && right[2] === 0;
      if (left.length !== right.length && !addedZeroAltitude) return false;
      const ordinateCount = addedZeroAltitude ? left.length : right.length;
      return left.slice(0, ordinateCount).every((value, index) =>
        Math.abs(value - right[index]) <= toleranceForOrdinate(tolerance, index));
    }
    if (left.length !== right.length) return false;
    return left.every((value, index) => coordinatesMatch(value, right[index], tolerance, allowZeroAltitudePadding));
  }
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= tolerance;
  return left === right;
}

function geometryMatches(left, right, tolerance, allowZeroAltitudePadding = false) {
  if (left === null || right === null) return left === right;
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === "GeometryCollection") {
    if (!Array.isArray(left.geometries) || !Array.isArray(right.geometries) || left.geometries.length !== right.geometries.length) return false;
    const unmatched = [...right.geometries];
    for (const geometry of left.geometries) {
      const index = unmatched.findIndex((candidate) => geometryMatches(geometry, candidate, tolerance, allowZeroAltitudePadding));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  if (left.type === "Polygon") return polygonMatches(left.coordinates, right.coordinates, tolerance, allowZeroAltitudePadding);
  if (left.type === "MultiPolygon") {
    if (!Array.isArray(left.coordinates) || !Array.isArray(right.coordinates) || left.coordinates.length !== right.coordinates.length) return false;
    const unmatched = [...right.coordinates];
    for (const polygon of left.coordinates) {
      const index = unmatched.findIndex((candidate) => polygonMatches(polygon, candidate, tolerance, allowZeroAltitudePadding));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  return coordinatesMatch(left.coordinates, right.coordinates, tolerance, allowZeroAltitudePadding);
}

function positionsMatch(left, right, tolerance, allowZeroAltitudePadding = false) {
  return Array.isArray(left) && Array.isArray(right)
    && coordinatesMatch(left, right, tolerance, allowZeroAltitudePadding);
}

function linearRingMatches(left, right, tolerance, allowZeroAltitudePadding = false) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 4 || right.length < 4) return false;
  const leftRing = positionsMatch(left[0], left.at(-1), tolerance, allowZeroAltitudePadding) ? left.slice(0, -1) : left;
  const rightRing = positionsMatch(right[0], right.at(-1), tolerance, allowZeroAltitudePadding) ? right.slice(0, -1) : right;
  if (leftRing.length !== rightRing.length) return false;
  const vertexCount = leftRing.length;
  for (let start = 0; start < vertexCount; start += 1) {
    if (!positionsMatch(leftRing[0], rightRing[start], tolerance, allowZeroAltitudePadding)) continue;
    for (const direction of [1, -1]) {
      let matches = true;
      for (let offset = 1; offset < vertexCount; offset += 1) {
        const candidateIndex = (start + direction * offset + vertexCount) % vertexCount;
        if (!positionsMatch(leftRing[offset], rightRing[candidateIndex], tolerance, allowZeroAltitudePadding)) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

function polygonMatches(left, right, tolerance, allowZeroAltitudePadding = false) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return false;
  if (!linearRingMatches(left[0], right[0], tolerance, allowZeroAltitudePadding)) return false;
  const unmatched = right.slice(1);
  for (const ring of left.slice(1)) {
    const index = unmatched.findIndex((candidate) => linearRingMatches(ring, candidate, tolerance, allowZeroAltitudePadding));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

function geometryProfile(geometry) {
  let positionCount = 0;
  let zeroAltitudePositionCount = 0;
  const positionDimensions = new Set();
  function visitCoordinates(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
      positionCount += 1;
      positionDimensions.add(value.length);
      if (value.length === 3 && value[2] === 0) zeroAltitudePositionCount += 1;
      return;
    }
    for (const child of value) visitCoordinates(child);
  }
  if (geometry?.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) {
      const profile = geometryProfile(child);
      positionCount += profile.positionCount;
      zeroAltitudePositionCount += profile.zeroAltitudePositionCount;
      for (const dimension of profile.positionDimensions) positionDimensions.add(dimension);
    }
  } else {
    visitCoordinates(geometry?.coordinates);
  }
  return { type: geometry?.type ?? null, positionCount, zeroAltitudePositionCount, positionDimensions: [...positionDimensions].sort() };
}

function maximumCoordinateDelta(left, right) {
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right);
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, maximumCoordinateDelta(left[index], right[index]));
  }
  return maximum;
}

function linearRingCoordinateDelta(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 4 || right.length < 4) return Number.POSITIVE_INFINITY;
  const leftClosed = maximumCoordinateDelta(left[0], left.at(-1)) <= 1e-14;
  const rightClosed = maximumCoordinateDelta(right[0], right.at(-1)) <= 1e-14;
  const leftRing = leftClosed ? left.slice(0, -1) : left;
  const rightRing = rightClosed ? right.slice(0, -1) : right;
  if (leftRing.length !== rightRing.length) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let start = 0; start < rightRing.length; start += 1) {
    for (const direction of [1, -1]) {
      let maximum = 0;
      for (let offset = 0; offset < leftRing.length; offset += 1) {
        const candidateIndex = (start + direction * offset + rightRing.length) % rightRing.length;
        maximum = Math.max(maximum, maximumCoordinateDelta(leftRing[offset], rightRing[candidateIndex]));
      }
      best = Math.min(best, maximum);
    }
  }
  return best;
}

function polygonCoordinateDelta(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return Number.POSITIVE_INFINITY;
  let maximum = linearRingCoordinateDelta(left[0], right[0]);
  if (!Number.isFinite(maximum)) return maximum;
  const unmatched = right.slice(1);
  for (const ring of left.slice(1)) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index < unmatched.length; index += 1) {
      const delta = linearRingCoordinateDelta(ring, unmatched[index]);
      if (delta < bestDelta) { bestDelta = delta; bestIndex = index; }
    }
    if (bestIndex < 0) return Number.POSITIVE_INFINITY;
    maximum = Math.max(maximum, bestDelta);
    unmatched.splice(bestIndex, 1);
  }
  return maximum;
}

function geometryCoordinateDelta(left, right) {
  if (!left || !right || left.type !== right.type) return Number.POSITIVE_INFINITY;
  if (left.type === "Polygon") return polygonCoordinateDelta(left.coordinates, right.coordinates);
  if (left.type === "MultiPolygon") {
    if (!Array.isArray(left.coordinates) || !Array.isArray(right.coordinates) || left.coordinates.length !== right.coordinates.length) return Number.POSITIVE_INFINITY;
    const unmatched = [...right.coordinates];
    let maximum = 0;
    for (const polygon of left.coordinates) {
      let bestIndex = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let index = 0; index < unmatched.length; index += 1) {
        const delta = polygonCoordinateDelta(polygon, unmatched[index]);
        if (delta < bestDelta) { bestDelta = delta; bestIndex = index; }
      }
      if (bestIndex < 0) return Number.POSITIVE_INFINITY;
      maximum = Math.max(maximum, bestDelta);
      unmatched.splice(bestIndex, 1);
    }
    return maximum;
  }
  return maximumCoordinateDelta(left.coordinates, right.coordinates);
}

function compareGeometrySamples(source, exported, tolerance = geometryCoordinateTolerance, options = {}) {
  assert.equal(exported.length, source.length, "Source and exported geometry sample counts differ.");
  const unmatched = [...exported];
  let zeroAltitudePaddedFeatureCount = 0;
  for (const geometry of source) {
    const index = unmatched.findIndex((candidate) => geometryMatches(
      geometry, candidate, tolerance, options.allowZeroAltitudePadding === true,
    ));
    if (index < 0) {
      const closestDelta = Math.min(...unmatched.map((candidate) => geometryCoordinateDelta(geometry, candidate)));
      const delta = Number.isFinite(closestDelta) ? closestDelta.toExponential(4) : null;
      const toleranceDescription = typeof tolerance === "number"
        ? tolerance.toExponential(4)
        : `XY=${tolerance.xy.toExponential(4)}, Z/M=${tolerance.otherOrdinates.toExponential(4)}`;
      assert.ok(false, `PostGIS export geometry sample differs from the source at coordinate tolerance ${toleranceDescription}: source=${JSON.stringify(geometryProfile(geometry))}, remainingExports=${JSON.stringify(unmatched.slice(0, 3).map(geometryProfile))}, closestGeometryMaxCoordinateDelta=${delta}.`);
    }
    if (options.allowZeroAltitudePadding === true) {
      const sourceProfile = geometryProfile(geometry);
      const outputProfile = geometryProfile(unmatched[index]);
      if (sourceProfile.positionDimensions.length === 1 && sourceProfile.positionDimensions[0] === 2
        && outputProfile.positionDimensions.length === 1 && outputProfile.positionDimensions[0] === 3
        && outputProfile.zeroAltitudePositionCount === outputProfile.positionCount) {
        zeroAltitudePaddedFeatureCount += 1;
      }
    }
    unmatched.splice(index, 1);
  }
  return {
    comparedFeatures: source.length,
    matchedFeatures: source.length,
    ...(options.allowZeroAltitudePadding === true ? {
      zeroAltitudePadding: {
        policy: "KML export may add an all-zero altitude ordinate to 2D positions; XY coordinates must still match.",
        affectedFeatureCount: zeroAltitudePaddedFeatureCount,
      },
    } : {}),
    nullGeometryCount: source.filter((geometry) => geometry === null).length,
    tolerance,
    orderIndependent: true,
  };
}

function tableRef(name) { return `public."${name.replaceAll('"', '""')}"`; }

async function forEachConcurrent(items, concurrency, handler) {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await handler(items[index], index);
    }
  }));
}

const preflightConcurrency = Math.max(1, Number(process.env.DBSTUDIO_LOCAL_GIS_PREFLIGHT_CONCURRENCY || 4));
await forEachConcurrent(sourceReport.datasets, preflightConcurrency, async (dataset) => {
  if (!dataset.layers?.length || dataset.status !== "inspected") return;
  const layerCount = dataset.layers.length;
  const sourcePath = sourcePathFor(dataset);
  if (!sourcePath) { skipped.missingSource += layerCount; return; }
  const sourceId = sourceIdFor(sourcePath);
  if (includeSourceIds.size && !includeSourceIds.has(sourceId)) return;
  if (!allowedExtensions.has(dataset.extension)) { skipped.unsupportedExtension += layerCount; return; }
  const sourceEncodingOverride = encodingOverrides.get(path.resolve(sourcePath));
  const encodingIsConfirmed = ["metadata", "format"].includes(dataset.encoding?.source)
    || dataset.encoding?.source === "ascii-compatible"
    || (dataset.encoding?.source === "heuristic" && Number(dataset.encoding.confidence) >= 0.9);
  if (!encodingIsConfirmed && !sourceEncodingOverride) { skipped.encodingChoice += layerCount; return; }
  const bytes = dataBundleSize(sourcePath);
  const candidateLayers = [];
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
    const layer = dataset.layers[layerIndex];
    if (layer.selected === false) continue;
    if (layer.status !== "decoded" && !(layer.status === "encoding-choice-required" && sourceEncodingOverride)) {
      if (layer.status === "encoding-choice-required") skipped.encodingChoice += 1;
      else skipped.previewFailed += 1;
      continue;
    }
    const featureCount = Number(layer.featureCount);
    if (!Number.isFinite(featureCount) || featureCount < 0) { skipped.invalidCount += 1; continue; }
    if (featureCount > maxFeatures) { skipped.tooManyFeatures += 1; continue; }
    if (bytes > maxBundleBytes) { skipped.tooLarge += 1; continue; }
    const fieldTypeOverrides = fieldTypeOverridesBySourceId.get(sourceId) ?? [];
    const fieldMapOverrides = fieldMapOverridesBySourceId.get(`${sourceId}:${layerIndex}`)
      ?? fieldMapOverridesBySourceId.get(`${sourceId}:*`)
      ?? [];
    candidateLayers.push({ layerIndex, layer, featureCount, fieldTypeOverrides, fieldMapOverrides });
  }
  if (candidateLayers.length === 0) return;
  let liveLayers;
  try { liveLayers = (await core.inspectGisFile(sourcePath)).layers; }
  catch { skipped.sourceInspectFailed += candidateLayers.length; return; }
  if (liveLayers.length !== layerCount) { skipped.layerIndexMismatch += candidateLayers.length; return; }
  for (const candidateLayer of candidateLayers) {
    const liveLayer = liveLayers[candidateLayer.layerIndex];
    const sourceLayerName = liveLayer?.name;
    if (!sourceLayerName) { skipped.layerIndexMismatch += 1; continue; }
    if (includeLayerNamePrefixes.length && !includeLayerNamePrefixes.some((prefix) => sourceLayerName.startsWith(prefix))) continue;
    if (candidateLayer.fieldTypeOverrides.some(({ source }) => !liveLayer.fields.some((field) => field.name === source))) {
      throw new Error(`Configured field-type override names a field missing from source ${sourceId}.`);
    }
    if (candidateLayer.fieldMapOverrides.some(({ source }) => !liveLayer.fields.some((field) => field.name === source))) {
      throw new Error(`Configured field-map override names a field missing from source ${sourceId}.`);
    }
    candidates.push({ dataset, layer: candidateLayer.layer, layerIndex: candidateLayer.layerIndex, sourcePath, sourceId, sourceLayerName, sourceExtent: liveLayer.extent, bytes, featureCount: candidateLayer.featureCount, sourceEncodingOverride, fieldTypeOverrides: candidateLayer.fieldTypeOverrides, fieldMapOverrides: candidateLayer.fieldMapOverrides });
  }
});
assert.ok(candidates.length > 0, "No bounded datasets with confirmed or explicitly overridden source encodings were eligible for PostGIS roundtrip.");

const createdTables = [];
const successful = [];
const failures = [];
function recordPhaseCount(sourceExtension, phase, error, sourcePath, sourceId, layerIndex, featureCount, diagnostics = {}) {
  const current = failures.find((item) => item.extension === sourceExtension && item.phase === phase);
  const details = error && typeof error === "object" ? (error.stderr || error.stdout) : undefined;
  let message = details || (error instanceof Error ? error.message : error ? String(error) : "cleanup failed");
  const invalidDbfUtf8 = message.match(/DBF record\s+(\d+),\s*field\s+([A-Za-z0-9 _-]{1,80}),\s*contains bytes that are invalid UTF-8/i);
  if (invalidDbfUtf8) {
    message = `DBF record ${invalidDbfUtf8[1]}, field ${invalidDbfUtf8[2]}, contains invalid UTF-8 bytes; changing the whole-file encoding may corrupt other attributes.`;
  } else if (/non[\s-]*utf-?8 content found|unable to write feature/i.test(message)) {
    message = "GDAL rejected a source feature while writing text attributes; raw feature values are omitted from the audit report.";
  } else if (/ERROR \d+:.*\t/.test(message)) {
    message = "GDAL returned a feature-specific error; raw feature values are omitted from the audit report.";
  }
  if (/COPY statement failed|\bCOPY\b.*\bline\s+\d+\s*,\s*column\b/i.test(message)) {
    const safeCause = message.match(/ERROR:\s*invalid input syntax for type (?:json|boolean|smallint|integer|bigint|numeric|real|double precision|date|time(?: with time zone)?|timestamp(?: with time zone)?|uuid)\b/i)?.[0]
      ?.replace(/^ERROR:\s*/i, "");
    message = safeCause
      ? `PostGIS COPY failed (${safeCause}); row, column, and raw values omitted from the audit report.`
      : "PostGIS COPY failed; row, column, and raw values omitted from the audit report.";
  }
  if (/geometry sample differs from the source|geometry sample mismatch/i.test(message)) {
    const sourceProfileJson = message.match(/source=(\{[^}]*\})/i)?.[1];
    const exportedProfilesJson = message.match(/remainingExports=(\[.*?\]),\s*closestGeometryMaxCoordinateDelta=/i)?.[1];
    const compactProfile = (profile) => profile
      ? `${profile.type}:${profile.positionCount}:d${(profile.positionDimensions ?? []).join("/") || "?"}`
      : "unknown";
    let sourceProfile = "unknown";
    let exportedProfiles = "unknown";
    try { if (sourceProfileJson) sourceProfile = compactProfile(JSON.parse(sourceProfileJson)); } catch { /* keep diagnostic generic */ }
    try { if (exportedProfilesJson) exportedProfiles = JSON.parse(exportedProfilesJson).slice(0, 3).map(compactProfile).join(","); } catch { /* keep diagnostic generic */ }
    const delta = message.match(/closestGeometryMaxCoordinateDelta=([0-9.e+-]+)/i)?.[1];
    message = `PostGIS geometry sample mismatch; source=${sourceProfile}; exports=${exportedProfiles}; closest delta=${delta ?? "unavailable"}; raw coordinates omitted.`;
  }
  message = message.replaceAll(root, "<workspace>").replaceAll(tempRoot, "<temporary-output>");
  if (sourcePath) message = message.replaceAll(sourcePath, "<source-file>");
  if (environment.PGPASSWORD) message = message.replaceAll(environment.PGPASSWORD, "[redacted]");
  message = message.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]").replace(/\s+/g, " ").slice(0, 500);
  const source = { sourceId, layerIndex, featureCount, ...diagnostics };
  if (current) {
    current.count += 1;
    current.sources.push(source);
    if (current.samples.length < 3 && message !== "cleanup failed") current.samples.push(message);
  } else failures.push({ extension: sourceExtension, phase, count: 1, sources: [source], samples: message === "cleanup failed" ? [] : [message] });
}

try {
  let processedCount = 0;
  const roundtripConcurrency = Math.max(1, Number(process.env.DBSTUDIO_LOCAL_GIS_ROUNDTRIP_CONCURRENCY || 4));
  await forEachConcurrent(candidates, roundtripConcurrency, async (item, index) => {
    const table = `dbsa_batch_${runId}_${String(index + 1).padStart(4, "0")}`;
    createdTables.push(table);
    const sourceArgs = ["gis", "import", "--connection", "environment", "--file", item.sourcePath, "--target", `public.${table}`, "--layer", item.sourceLayerName];
    const sourceEncoding = item.sourceEncodingOverride
      ?? (item.dataset.encoding?.source === "format" ? undefined : item.dataset.encoding?.declaredEncoding);
    const targetEncoding = process.env.DBSTUDIO_LOCAL_GIS_TARGET_ENCODING || sourceEncoding;
    if (sourceEncoding) sourceArgs.push("--source-encoding", sourceEncoding);
    for (const mapping of item.fieldMapOverrides) sourceArgs.push("--field-map", `${mapping.source}=${mapping.target}`);
    for (const mapping of item.fieldTypeOverrides) sourceArgs.push("--field-type", `${mapping.source}=${mapping.targetType}`);
    let phase = "import";
    let exportWarnings;
    let exportExtentSummary;
    let geometryVerification;
    let textPreviewVerification;
    let textPreviewDiagnostics;
    try {
      await runCli(sourceArgs);
      phase = "database-count";
      const imported = await core.query(`SELECT count(*)::bigint AS feature_count FROM ${tableRef(table)}`);
      assert.equal(Number(imported.rows[0]?.feature_count), item.featureCount, "PostGIS import feature count differs from the source audit.");
      const exportExtension = (process.env.DBSTUDIO_LOCAL_GIS_EXPORT_EXTENSION || item.dataset.extension).toLowerCase();
      assert.match(exportExtension, /^\.[a-z0-9]+$/, "DBSTUDIO_LOCAL_GIS_EXPORT_EXTENSION must be a file extension such as .gpkg.");
      const output = path.join(tempRoot, `${table}${exportExtension}`);
      phase = "export";
      const exportArgs = ["gis", "export", "--connection", "environment", "--table", `public.${table}`, "--output", output];
      if ([".shp", ".tab"].includes(exportExtension) && targetEncoding) {
        exportArgs.push("--target-encoding", targetEncoding);
      }
      const exportOutput = await runCli(exportArgs);
      const exportReport = JSON.parse(exportOutput);
      exportWarnings = exportReport.operationReport?.warnings ?? exportReport.warnings;
      assert.ok(existsSync(output), "The export file was not created.");
      phase = "decode-export";
      // CSV output is emitted as UTF-8 by the GIS exporter. Tell the scanner
      // that known encoding explicitly instead of asking its source-file
      // heuristic to rediscover the encoding of our own output.
      const exportedSourceEncoding = exportExtension === ".csv" ? "UTF-8" : undefined;
      const exported = await core.inspectGisFile(output, exportedSourceEncoding
        ? { sourceEncoding: exportedSourceEncoding }
        : {});
      assert.ok(exported.layers.length, "The exported dataset has no vector layer.");
      const outputLayer = exported.layers.find((candidate) => candidate.name === item.sourceLayerName) ?? exported.layers[0];
      exportExtentSummary = extentSummary(outputLayer.extent);
      const preview = await core.previewGisAttributes(output, {
        sourceLayer: outputLayer.name,
        ...(exportedSourceEncoding ? { sourceEncoding: exportedSourceEncoding } : {}),
        ...([".shp", ".tab"].includes(exportExtension) && targetEncoding ? { sourceEncoding: targetEncoding } : {}),
        limit: 1,
      });
      assert.equal(preview.requiresUserChoice, false, "The exported dataset needs an unresolved text-encoding choice.");
      assert.equal(Number(preview.featureCount), item.featureCount, "Export feature count differs from the source audit.");
      const rfc7946GeometrySamples = [".geojson", ".json"].includes(exportExtension);
      geometryVerification = verifyGeometrySample
        ? compareGeometrySamples(
          await readGeometrySample(item.sourcePath, item.sourceLayerName, { rfc7946: rfc7946GeometrySamples }),
          await readGeometrySample(output, outputLayer.name, { rfc7946: rfc7946GeometrySamples }),
          geometryToleranceForOutput(exportExtension, item.sourceExtent),
          { allowZeroAltitudePadding: exportExtension === ".kml" },
        )
        : undefined;
      if (verifyTextAttributePreview) {
        const sourcePreview = await core.previewGisAttributes(item.sourcePath, {
          sourceLayer: item.sourceLayerName,
          sourceEncoding,
          limit: 20,
        });
        const exportedEncodingOptions = exportedSourceEncoding
          ? { sourceEncoding: exportedSourceEncoding }
          : [".shp", ".tab"].includes(exportExtension) && targetEncoding
            ? { sourceEncoding: targetEncoding }
            : {};
        const exportedPreview = await core.previewGisAttributes(output, {
          sourceLayer: outputLayer.name,
          ...exportedEncodingOptions,
          limit: 20,
        });
        assert.equal(sourcePreview.requiresUserChoice, false, "The source needs an unresolved text-encoding choice.");
        assert.equal(exportedPreview.requiresUserChoice, false, "The exported sample needs an unresolved text-encoding choice.");
        assert.equal(sourcePreview.rows.length, exportedPreview.rows.length, "Source and exported text samples have different row counts.");

        const textValuesForRow = (row, name) => {
          const key = Object.keys(row).find((candidate) => candidate.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
          return key ? row[key] : null;
        };
        const ignoredGeneratedIdFields = [];
        const textFields = sourcePreview.fields.filter((candidate) => /string/i.test(candidate.type));
        const kmlIdField = exportExtension === ".kml"
          ? textFields.find((field) => field.name.toLocaleLowerCase("en-US") === "id")
          : undefined;
        let kmlIdOutputName;
        if (kmlIdField) {
          const usedNames = new Set([
            ...sourcePreview.fields.map((field) => field.name.toLocaleLowerCase("en-US")),
            ...item.fieldMapOverrides.map((mapping) => mapping.target.toLocaleLowerCase("en-US")),
          ]);
          kmlIdOutputName = "source_id";
          let suffix = 2;
          while (usedNames.has(kmlIdOutputName.toLocaleLowerCase("en-US"))) {
            kmlIdOutputName = "source_id_" + suffix;
            suffix += 1;
          }
        }
        const mappedTextFields = textFields.flatMap((field) => {
          const sourceHasIdValues = sourcePreview.rows.some((row) => {
            const value = textValuesForRow(row, field.name);
            return value !== null && value !== undefined && value !== "";
          });
          if (item.dataset.extension === ".kml" && field.name.toLocaleLowerCase("en-US") === "id" && !sourceHasIdValues) {
            ignoredGeneratedIdFields.push(field.name);
            return [];
          }
          const mappedTarget = item.fieldMapOverrides.find((mapping) => mapping.source === field.name)?.target
            ?? (field.name === kmlIdField?.name ? kmlIdOutputName : field.name);
          const outputField = exportedPreview.fields.find((candidate) => candidate.name.toLocaleLowerCase("en-US") === mappedTarget.toLocaleLowerCase("en-US"));
          assert.ok(outputField, `Exported dataset is missing text field ${field.name}.`);
          return { sourceName: field.name, outputName: outputField.name };
        });
        const stringTargetFields = new Set(item.fieldTypeOverrides
          .filter((mapping) => mapping.targetType === "string")
          .map((mapping) => mapping.source));
        const sourceTextRows = sourcePreview.rows.map((row) => mappedTextFields.map((field) => {
          const value = textValuesForRow(row, field.sourceName);
          if (!stringTargetFields.has(field.sourceName) || value === null || value === undefined) return value;
          return typeof value === "object" ? JSON.stringify(value) : String(value);
        }));
        const exportedTextRows = exportedPreview.rows.map((row) => mappedTextFields.map((field) => textValuesForRow(row, field.outputName)));
        const canonicalTextRows = (rows) => rows.map((values) => JSON.stringify(values)).sort();
        const rowsMatch = JSON.stringify(canonicalTextRows(exportedTextRows)) === JSON.stringify(canonicalTextRows(sourceTextRows));
        if (!rowsMatch) {
          const valuesForColumn = (rows, columnIndex, normalizeEmpty = false) => rows
            .map((row) => row[columnIndex])
            .map((value) => normalizeEmpty && (value === null || value === undefined || value === "") ? null : value)
            .map((value) => JSON.stringify(value))
            .sort();
          const normalizeTextValue = (value, mode) => {
            if (typeof value !== "string") return value;
            if (mode === "trim") return value.trim();
            if (mode === "nfc") return value.normalize("NFC");
            if (mode === "trimNfc") return value.trim().normalize("NFC");
            if (mode === "collapseWhitespace") return value.trim().replace(/\s+/gu, " ").normalize("NFC");
            if (mode === "caseFold") return value.trim().normalize("NFC").toLocaleLowerCase("en-US");
            return value;
          };
          const columnSummary = (rows, columnIndex) => {
            const values = rows.map((row) => row[columnIndex]);
            const strings = values.filter((value) => typeof value === "string");
            return {
              valueCount: values.length,
              nullCount: values.filter((value) => value === null || value === undefined).length,
              emptyStringCount: strings.filter((value) => value === "").length,
              uniqueValueCount: new Set(values.map((value) => JSON.stringify(value))).size,
              stringLengthRange: strings.length
                ? [Math.min(...strings.map((value) => value.length)), Math.max(...strings.map((value) => value.length))]
                : null,
            };
          };
          const mismatchedColumnIndexes = mappedTextFields.flatMap((field, columnIndex) =>
            JSON.stringify(valuesForColumn(sourceTextRows, columnIndex)) === JSON.stringify(valuesForColumn(exportedTextRows, columnIndex))
              ? [] : [columnIndex + 1]);
          const emptyNormalizedMatchColumnIndexes = mappedTextFields.flatMap((field, columnIndex) =>
            JSON.stringify(valuesForColumn(sourceTextRows, columnIndex, true)) === JSON.stringify(valuesForColumn(exportedTextRows, columnIndex, true))
              ? [columnIndex + 1] : []);
          const importedRows = await core.query(`SELECT * FROM ${tableRef(table)} LIMIT ${sourcePreview.rows.length}`);
          const importedTextRows = importedRows.rows.map((row) => mappedTextFields
            .map((field) => textValuesForRow(row, field.sourceName)));
          const databaseTextRowsMatch = JSON.stringify(canonicalTextRows(importedTextRows))
            === JSON.stringify(canonicalTextRows(sourceTextRows));
          textPreviewDiagnostics = {
            checkedRows: sourcePreview.rows.length,
            checkedTextFieldCount: mappedTextFields.length,
            mismatchedColumnIndexes,
            emptyNormalizedMatchColumnIndexes,
            valueAssociationMayDiffer: mismatchedColumnIndexes.length === 0,
            databaseTextRowsMatch,
            mismatchedColumns: mismatchedColumnIndexes.map((index) => {
              const columnIndex = index - 1;
              const transformMatches = (mode) => {
                const normalized = (rows) => rows
                  .map((row) => JSON.stringify(normalizeTextValue(row[columnIndex], mode)))
                  .sort();
                return JSON.stringify(normalized(sourceTextRows)) === JSON.stringify(normalized(exportedTextRows));
              };
              return {
                index,
                sourceName: mappedTextFields[columnIndex].sourceName,
                outputName: mappedTextFields[columnIndex].outputName,
                source: columnSummary(sourceTextRows, columnIndex),
                exported: columnSummary(exportedTextRows, columnIndex),
                matchesAfterTrim: transformMatches("trim"),
                matchesAfterNfc: transformMatches("nfc"),
                matchesAfterTrimNfc: transformMatches("trimNfc"),
                matchesAfterWhitespaceCollapse: transformMatches("collapseWhitespace"),
                matchesAfterCaseFold: transformMatches("caseFold"),
              };
            }),
          };
        }
        assert.ok(rowsMatch, "Text attribute rows differ after roundtrip (feature order ignored). Raw values are omitted from the report.");
        textPreviewVerification = {
          checkedRows: sourcePreview.rows.length,
          checkedTextValueCount: sourcePreview.rows.length * mappedTextFields.length,
          featureOrderIndependent: true,
          ...(ignoredGeneratedIdFields.length ? { ignoredGeneratedIdFields } : {}),
        };
      }
      successful.push({
        sourceId: item.sourceId,
        sourceRoot: item.dataset.sourceRoot ?? path.dirname(item.sourcePath),
        relativePath: item.dataset.relativePath ?? path.basename(item.sourcePath),
        layerIndex: item.layerIndex,
        extension: item.dataset.extension,
        exportExtension,
        featureCount: item.featureCount,
        ...(geometryVerification ? { geometryVerification } : {}),
        ...(textPreviewVerification ? { textPreviewVerification } : {}),
      });
    } catch (error) {
      recordPhaseCount(
        item.dataset.extension,
        phase,
        error,
        item.sourcePath,
        item.sourceId,
        item.layerIndex,
        item.featureCount,
        phase === "decode-export"
          ? {
              ...(Array.isArray(exportWarnings) ? { exportWarnings } : {}),
              sourceExtentSummary: item.dataset.layers?.[item.layerIndex]?.extentSummary ?? null,
              outputExtentSummary: exportExtentSummary ?? null,
              ...(geometryVerification ? { geometryVerification } : {}),
              ...(textPreviewDiagnostics ? { textPreviewDiagnostics } : {}),
            }
          : undefined,
      );
    } finally {
      await core.query(`DROP TABLE IF EXISTS ${tableRef(table)}`).catch(() => undefined);
      for (const entry of readdirSyncSafe(tempRoot)) {
        if (entry.toLowerCase().startsWith(table.toLowerCase())) {
          try { rmSync(path.join(tempRoot, entry), { recursive: true, force: true }); } catch (error) { recordPhaseCount(item.dataset.extension, "output-cleanup", error, item.sourcePath, item.sourceId, item.layerIndex, item.featureCount); }
        }
      }
    }
    processedCount += 1;
    if (processedCount % 25 === 0) process.stdout.write(`GIS roundtrip batch: ${processedCount}/${candidates.length} layers processed.\n`);
  });
} finally {
  for (const table of createdTables) await core.query(`DROP TABLE IF EXISTS ${tableRef(table)}`).catch(() => undefined);
  rmSync(tempRoot, { recursive: true, force: true });
}

if (createdTables.length) {
  const cleanup = await core.query(createdTables.map((table) =>
    `SELECT to_regclass('public.${table}') IS NULL AS removed`,
  ).join(" UNION ALL "));
  assert.ok(cleanup.rows.every((row) => row.removed === true), "A PostGIS batch fixture table was not removed.");
}
assert.equal(existsSync(tempRoot), false, "Temporary batch export directory was not removed.");
const byFormat = Object.fromEntries([...new Set(candidates.map((item) => item.dataset.extension))].sort().map((extension) => [
  extension,
  { eligible: candidates.filter((item) => item.dataset.extension === extension).length, passed: successful.filter((item) => item.extension === extension).length },
]));
const report = {
  gdalBin,
  limits: { maxFeatures, maxBundleBytes, cliTimeoutMs },
  verifyTextAttributePreview,
  verifyGeometrySample,
  geometrySampleLimit,
  geometryCoordinateTolerance,
  geometryToleranceModel: "RFC 7946 GeoJSON/JSON output: XY=1e-7 degrees (~1.1 cm latitude), Z/M=1e-8; MapInfo TAB output: XY=max(1e-8, 2*max(source extent span)/2^31), Z/M=1e-8; other formats: 1e-8",
  geometrySampleNormalization: "GeoJSON and JSON sample comparisons use RFC 7946 WGS 84 longitude/latitude; other formats compare in the source/export CRS.",
  sourceIdFilter: includeSourceIds.size ? [...includeSourceIds] : null,
  sourceLayerNamePrefixFilterCount: includeLayerNamePrefixes.length,
  exportExtension: process.env.DBSTUDIO_LOCAL_GIS_EXPORT_EXTENSION?.toLowerCase() ?? null,
  targetEncodingOverride: process.env.DBSTUDIO_LOCAL_GIS_TARGET_ENCODING ?? null,
  inputCandidateCount: sourceReport.candidateCount,
  eligibleLayerCount: candidates.length,
  preflightConcurrency,
  roundtripConcurrency: Math.max(1, Number(process.env.DBSTUDIO_LOCAL_GIS_ROUNDTRIP_CONCURRENCY || 4)),
  encodingOverridesUsed: [...new Map(candidates
    .filter((item) => item.sourceEncodingOverride)
    .map((item) => [path.resolve(item.sourcePath), item.sourceEncodingOverride]))]
    .map(([filePath, encoding]) => ({ sourceId: sourceIdFor(filePath), encoding })),
  fieldTypeOverridesUsed: [...new Map(candidates
    .filter((item) => item.fieldTypeOverrides.length > 0)
    .map((item) => [item.sourceId, item.fieldTypeOverrides]))]
    .map(([sourceId, fieldTypes]) => ({ sourceId, fieldTypes })),
  fieldMapOverridesUsed: candidates
    .filter((item) => item.fieldMapOverrides.length > 0)
    .map((item) => ({ sourceId: item.sourceId, layerIndex: item.layerIndex, fieldMappings: item.fieldMapOverrides })),
  passedLayerCount: successful.length,
  successfulLayers: successful,
  failureCount: failures.reduce((sum, item) => sum + item.count, 0),
  failuresByFormatAndPhase: failures,
  skipped,
  formats: byFormat,
  postgisTemporaryTablesCleaned: true,
  exportDirectoryCleaned: !existsSync(tempRoot),
  externalDataSent: false,
};
mkdirSync(path.dirname(outputReportPath), { recursive: true });
writeFileSync(outputReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.failureCount, 0, "One or more eligible local GIS layers failed the PostGIS import/export roundtrip.");
