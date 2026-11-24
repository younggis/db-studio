import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const sourceAuditPath = process.env.DBSTUDIO_LOCAL_GIS_AUDIT_REPORT
  || path.join(root, ".cache", "local-gis-data-audit-20261104-root-aware.json");
const sourceAudit = JSON.parse(readFileSync(sourceAuditPath, "utf8"));
const gdalBin = process.env.DBSTUDIO_GDAL_BIN || sourceAudit.gdalBin;
assert.ok(gdalBin, "Set DBSTUDIO_GDAL_BIN or use an audit report that records it.");

const environment = { ...process.env, DBSTUDIO_GDAL_BIN: gdalBin };
const core = CoreService.fromEnvironment(environment);
const pbfCandidates = (sourceAudit.datasets ?? []).filter((dataset) => dataset.extension === ".pbf" && dataset.status === "inspected");
let mvtSource;
for (const dataset of pbfCandidates) {
  const roots = typeof dataset.sourceRoot === "string" ? [dataset.sourceRoot] : sourceAudit.roots ?? [];
  const sourcePath = roots.map((sourceRoot) => path.resolve(sourceRoot, dataset.relativePath)).find(existsSync);
  if (!sourcePath) continue;
  const info = await core.inspectGisFile(sourcePath);
  if (info.driver === "MVT") {
    mvtSource = { dataset, sourcePath, info };
    break;
  }
}
assert.ok(mvtSource, "No inspected PBF source in the audit was identified by GDAL as MVT.");
assert.equal(mvtSource.info.encoding.source, "format", "MVT encoding must be established by the driver and format, not a filename guess.");
assert.equal(mvtSource.info.encoding.declaredEncoding, "UTF-8");
assert.ok(mvtSource.info.layers.length > 0, "The MVT source contains no vector layers.");

const layerPreviewEvidence = [];
for (const layer of mvtSource.info.layers) {
  const preview = await core.previewGisAttributes(mvtSource.sourcePath, { sourceLayer: layer.name, limit: 1 });
  assert.equal(preview.requiresUserChoice, false, `MVT layer ${layer.name} incorrectly requires an encoding choice.`);
  layerPreviewEvidence.push({ requiresUserChoice: preview.requiresUserChoice, sampleCount: preview.rows.length, warningCount: preview.warnings.length });
}

const cacheDirectory = path.join(root, ".cache");
mkdirSync(cacheDirectory, { recursive: true });
const auditPath = path.join(cacheDirectory, "mvt-postgis-source-audit-20261104.json");
const reportPath = path.join(cacheDirectory, "mvt-postgis-roundtrip-20261104.json");
const augmentedAuditPath = path.join(cacheDirectory, "local-gis-data-audit-20261104-mvt-format-utf8.json");
const augmentedAudit = structuredClone(sourceAudit);
const augmentedDataset = augmentedAudit.datasets.find((dataset) =>
  dataset.sourceRoot === mvtSource.dataset.sourceRoot && dataset.relativePath === mvtSource.dataset.relativePath,
);
assert.ok(augmentedDataset, "The MVT source was missing from the root-aware audit snapshot.");
Object.assign(augmentedDataset, {
  format: mvtSource.info.format,
  driver: mvtSource.info.driver,
  encoding: mvtSource.info.encoding,
  warningCount: mvtSource.info.warnings?.length ?? 0,
  layers: mvtSource.info.layers.map((layer, layerIndex) => ({
    ...(mvtSource.dataset.layers?.[layerIndex] ?? {}),
    status: layerPreviewEvidence[layerIndex].requiresUserChoice ? "encoding-choice-required" : "decoded",
    featureCount: layer.featureCount,
    fieldCount: layer.fields.length,
    sampleCount: layerPreviewEvidence[layerIndex].sampleCount,
    warningCount: layerPreviewEvidence[layerIndex].warningCount,
  })),
});
const layerStatusCounts = {};
for (const dataset of augmentedAudit.datasets) {
  for (const layer of dataset.layers ?? []) layerStatusCounts[layer.status] = (layerStatusCounts[layer.status] ?? 0) + 1;
}
augmentedAudit.formatEvidenceUpdate = {
  baseAudit: path.basename(sourceAuditPath),
  updatedAt: new Date().toISOString(),
  updatedDriver: mvtSource.info.driver,
  updatedRelativePath: mvtSource.dataset.relativePath,
  updatedLayerCount: mvtSource.info.layers.length,
  basis: "GDAL identified the MVT driver; preview confirmed UTF-8 format encoding; all layers passed PostGIS import and GeoPackage export.",
  layerStatusCounts,
};
writeFileSync(augmentedAuditPath, `${JSON.stringify(augmentedAudit, null, 2)}\n`, "utf8");
const mvtAudit = {
  roots: [mvtSource.dataset.sourceRoot ?? path.dirname(mvtSource.sourcePath)],
  candidateCount: 1,
  gdalBin,
  datasets: [{
    sourceRoot: mvtSource.dataset.sourceRoot ?? path.dirname(mvtSource.sourcePath),
    relativePath: mvtSource.dataset.relativePath ?? path.basename(mvtSource.sourcePath),
    extension: ".pbf",
    status: "inspected",
    encoding: mvtSource.info.encoding,
    layers: mvtSource.info.layers.map((layer) => ({
      status: "decoded",
      featureCount: layer.featureCount,
      fieldCount: layer.fields.length,
      sampleCount: 0,
    })),
  }],
};
writeFileSync(auditPath, `${JSON.stringify(mvtAudit, null, 2)}\n`, "utf8");
const sourceId = createHash("sha256").update(path.resolve(mvtSource.sourcePath).toLowerCase()).digest("hex").slice(0, 12);
const fieldMapOverrides = mvtSource.info.layers.flatMap((layer, layerIndex) => layer.fields.some((field) => field.name === "name_zh-Hans")
  ? [{ sourceId, layerIndex, fieldMappings: [{ source: "name_zh-Hans", target: "name_zh_hans" }] }]
  : []);

const batchEnvironment = {
  ...environment,
  DBSTUDIO_LOCAL_GIS_AUDIT_REPORT: auditPath,
  DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT: reportPath,
  DBSTUDIO_LOCAL_GIS_EXPORT_EXTENSION: ".gpkg",
  DBSTUDIO_LOCAL_GIS_ENCODING_OVERRIDES_JSON: "[]",
  DBSTUDIO_LOCAL_GIS_FIELD_MAP_OVERRIDES_JSON: JSON.stringify(fieldMapOverrides),
  DBSTUDIO_LOCAL_GIS_INCLUDE_SOURCE_IDS_JSON: "[]",
  DBSTUDIO_LOCAL_GIS_INCLUDE_LAYER_NAME_PREFIXES_JSON: "[]",
  DBSTUDIO_LOCAL_GIS_MAX_BUNDLE_BYTES: String(100 * 1024 * 1024),
  DBSTUDIO_LOCAL_GIS_MAX_FEATURES: "10000",
  DBSTUDIO_LOCAL_GIS_PREFLIGHT_CONCURRENCY: "1",
  DBSTUDIO_LOCAL_GIS_ROUNDTRIP_CONCURRENCY: "1",
  DBSTUDIO_LOCAL_GIS_VERIFY_TEXT_PREVIEW: "true",
};
const batchScript = path.join(root, "tests", "integration", "local-gis-roundtrip-batch.mjs");
const { stdout } = await execFileAsync(process.execPath, [batchScript], {
  cwd: root,
  env: batchEnvironment,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
  timeout: 10 * 60 * 1000,
});
const report = JSON.parse(readFileSync(reportPath, "utf8"));
assert.equal(report.eligibleLayerCount, mvtSource.info.layers.length);
assert.equal(report.passedLayerCount, mvtSource.info.layers.length);
assert.equal(report.failureCount, 0);
assert.equal(report.skipped.encodingChoice, 0);
assert.ok(report.successfulLayers.every((layer) => layer.exportExtension === ".gpkg"));
assert.equal(report.postgisTemporaryTablesCleaned, true);
assert.equal(report.exportDirectoryCleaned, true);
assert.equal(report.externalDataSent, false);

const totalFeatures = report.successfulLayers.reduce((sum, layer) => sum + layer.featureCount, 0);
const checkedRows = report.successfulLayers.reduce((sum, layer) => sum + (layer.textPreviewVerification?.checkedRows ?? 0), 0);
const checkedTextValues = report.successfulLayers.reduce((sum, layer) => sum + (layer.textPreviewVerification?.checkedTextValueCount ?? 0), 0);
process.stdout.write(`${JSON.stringify({
  driver: mvtSource.info.driver,
  encodingSource: mvtSource.info.encoding.source,
  declaredEncoding: mvtSource.info.encoding.declaredEncoding,
  layerCount: report.passedLayerCount,
  totalFeatures,
  checkedRows,
  checkedTextValues,
  explicitFieldMappings: fieldMapOverrides.length,
  exportedFormat: ".gpkg",
  failureCount: report.failureCount,
  postgisTemporaryTablesCleaned: report.postgisTemporaryTablesCleaned,
  exportDirectoryCleaned: report.exportDirectoryCleaned,
  externalDataSent: report.externalDataSent,
  updatedAuditPath: augmentedAuditPath,
  layerStatusCounts,
  batchOutput: stdout.trim().length > 0,
}, null, 2)}\n`);
