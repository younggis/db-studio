import assert from "node:assert/strict";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDirectory = path.join(root, ".cache");
const outputPath = path.resolve(root, process.argv[2] ?? ".cache/local-gis-archive-audit-aggregate-latest.json");
const outputRelative = path.relative(cacheDirectory, outputPath);
assert.ok(outputRelative && !outputRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(outputRelative), "Output must remain under the project .cache directory.");

const filenames = (await readdir(cacheDirectory))
  .filter((name) => /^local-gis-archive-audit-batch-.+\.json$/i.test(name))
  .sort((left, right) => left.localeCompare(right, "en"));
assert.ok(filenames.length, "No local-gis-archive-audit-batch-*.json reports were found.");

const reports = [];
for (const filename of filenames) {
  const reportPath = path.join(cacheDirectory, filename);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (!Number.isSafeInteger(report.archiveOffset)
    || !Number.isSafeInteger(report.candidateTotal)
    || !Array.isArray(report.datasets)
    || !Number.isSafeInteger(report.candidateCount)) continue;
  assert.equal(report.datasets.length, report.candidateCount, `${filename}: dataset count does not match candidateCount.`);
  reports.push({ filename, report, createdAtMs: Date.parse(report.createdAt) });
}
assert.ok(reports.length, "No valid batched archive reports were found.");
assert.ok(reports.every((item) => Number.isFinite(item.createdAtMs)), "Each batch report must have a valid createdAt timestamp.");

const candidateTotals = new Set(reports.map(({ report }) => report.candidateTotal));
assert.equal(candidateTotals.size, 1, "Batch reports do not refer to the same archive inventory size.");
const candidateTotal = [...candidateTotals][0];
const versionsByIndex = new Map();
for (const item of reports) {
  for (let index = 0; index < item.report.datasets.length; index += 1) {
    const archiveIndex = item.report.archiveOffset + index;
    assert.ok(archiveIndex < candidateTotal, `${item.filename}: archive index exceeds candidateTotal.`);
    const versions = versionsByIndex.get(archiveIndex) ?? [];
    versions.push({ ...item, dataset: item.report.datasets[index] });
    versionsByIndex.set(archiveIndex, versions);
  }
}

const missingIndices = Array.from({ length: candidateTotal }, (_, index) => index)
  .filter((index) => !versionsByIndex.has(index));
assert.deepEqual(missingIndices, [], "Batched reports do not cover every archive candidate.");

const overlaps = [];
const selectedDatasets = [];
for (const archiveIndex of Array.from({ length: candidateTotal }, (_, index) => index)) {
  const versions = versionsByIndex.get(archiveIndex).sort((left, right) =>
    left.createdAtMs - right.createdAtMs || left.filename.localeCompare(right.filename, "en"));
  const selected = versions.at(-1);
  const relativePaths = new Set(versions.map(({ dataset }) => dataset.relativePath));
  assert.equal(relativePaths.size, 1, `Archive index ${archiveIndex} maps to conflicting relative paths.`);
  if (versions.length > 1) {
    const signatures = new Set(versions.map(({ dataset }) => JSON.stringify(dataset)));
    overlaps.push({
      archiveIndex,
      relativePath: selected.dataset.relativePath,
      selectedReport: selected.filename,
      supersededReports: versions.slice(0, -1).map(({ filename }) => filename),
      resultsDiffer: signatures.size > 1,
    });
  }
  selectedDatasets.push({
    ...selected.dataset,
    archiveIndex,
    auditSourceReport: selected.filename,
  });
}

const statusCounts = {};
const memberStatusCounts = {};
let vectorMemberCount = 0;
let nonVectorJsonCount = 0;
let unclassifiedMemberCount = 0;
let decodedLayerCount = 0;
let decodeFailureCount = 0;
for (const dataset of selectedDatasets) {
  statusCounts[`${dataset.extension} ${dataset.status}`] = (statusCounts[`${dataset.extension} ${dataset.status}`] ?? 0) + 1;
  for (const member of dataset.members ?? []) {
    vectorMemberCount += 1;
    memberStatusCounts[member.status] = (memberStatusCounts[member.status] ?? 0) + 1;
    if (member.status === "non-vector-json") nonVectorJsonCount += 1;
    else if (member.status === "opened-no-vector-layers") unclassifiedMemberCount += 1;
    else if (member.status !== "inspected") decodeFailureCount += 1;
    for (const layer of member.layers ?? []) {
      if (layer.status === "decoded") decodedLayerCount += 1;
      else decodeFailureCount += 1;
    }
  }
}

const latestReport = [...reports].sort((left, right) => left.createdAtMs - right.createdAtMs).at(-1);
const output = {
  createdAt: new Date().toISOString(),
  candidateCount: candidateTotal,
  candidateTotal,
  archiveOffset: 0,
  archiveLimit: null,
  maxFallbackBytes: latestReport.report.maxFallbackBytes,
  vectorMemberCount,
  nonVectorJsonCount,
  spatialCandidateCount: vectorMemberCount - nonVectorJsonCount,
  decodedLayerCount,
  decodeFailureCount,
  unclassifiedMemberCount,
  completeSpatialDecode: decodeFailureCount === 0 && unclassifiedMemberCount === 0,
  memberStatusCounts,
  roots: latestReport.report.roots,
  statusCounts,
  sourceReports: reports.map(({ filename, report }) => ({
    filename,
    createdAt: report.createdAt,
    archiveOffset: report.archiveOffset,
    archiveLimit: report.archiveLimit,
    candidateCount: report.candidateCount,
  })),
  overlaps,
  datasets: selectedDatasets,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  completeSpatialDecode: output.completeSpatialDecode,
  candidateCount: output.candidateCount,
  vectorMemberCount,
  nonVectorJsonCount,
  spatialCandidateCount: output.spatialCandidateCount,
  decodedLayerCount,
  decodeFailureCount,
  memberStatusCounts,
  overlappingCandidates: overlaps.length,
  changedOverlappingResults: overlaps.filter((item) => item.resultsDiffer).length,
  reportPath: outputPath,
}, null, 2)}\n`);
