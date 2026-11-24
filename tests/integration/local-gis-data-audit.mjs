import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configuredGdalBin = process.env.DBSTUDIO_GDAL_BIN
  || path.join(root, ".cache", "gdal-static-candidate-20261101", "bin");
const reportPath = process.env.DBSTUDIO_LOCAL_GIS_AUDIT_REPORT
  || path.join(root, ".cache", "local-gis-data-audit-current.json");
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["F:\\GeoData", "F:\\temp"];
const candidateExtensions = new Set([
  ".shp", ".geojson", ".geojsonl", ".json", ".kml", ".kmz", ".tab", ".mif", ".gpkg",
  ".gml", ".gpx", ".fgb", ".sqlite", ".db", ".dxf", ".csv", ".zip", ".vrt", ".osm",
  ".pbf", ".parquet",
]);
const env = { ...process.env, DBSTUDIO_GDAL_BIN: configuredGdalBin };
const core = CoreService.fromEnvironment(env);

async function listCandidates(directory, output = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return output; }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.toLocaleLowerCase("en-US") === "__macosx") continue;
      if (entry.name.toLowerCase().endsWith(".gdb")) {
        output.push({ absolutePath, kind: "directory-dataset", extension: ".gdb" });
        continue;
      }
      await listCandidates(absolutePath, output);
      continue;
    }
    if (entry.name.startsWith("._")) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (candidateExtensions.has(extension)) output.push({ absolutePath, kind: "file", extension });
  }
  return output;
}

async function mapLimit(items, limit, callback) {
  const output = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      output[index] = await callback(items[index], index);
    }
  }));
  return output;
}

const candidates = [];
for (const rootPath of roots) {
  const resolvedRoot = path.resolve(rootPath);
  const found = await listCandidates(resolvedRoot);
  for (const candidate of found) candidates.push({ ...candidate, root: resolvedRoot });
}
assert.ok(candidates.length > 0, "No vector-format candidates were found in the requested directories.");

let completed = 0;
const rows = await mapLimit(candidates, 3, async (candidate, index) => {
  const relativePath = path.relative(candidate.root, candidate.absolutePath);
  if (candidate.kind === "directory-dataset") {
    return { sourceRoot: candidate.root, relativePath, extension: candidate.extension, status: "directory-container-needs-driver-inspection" };
  }
  if (candidate.extension === ".zip") {
    return { sourceRoot: candidate.root, relativePath, extension: candidate.extension, status: "archive-needs-member-inspection" };
  }
  try {
    const dataset = await core.inspectGisFile(candidate.absolutePath);
    if (!dataset.layers.length) {
      return {
        sourceRoot: candidate.root, relativePath, extension: candidate.extension, status: "opened-no-vector-layers",
        format: dataset.format, driver: dataset.driver, encoding: dataset.encoding,
        warningCount: dataset.warnings?.length ?? 0,
      };
    }
    const layerResults = [];
    for (const layer of dataset.layers) {
      try {
        const preview = await core.previewGisAttributes(candidate.absolutePath, { sourceLayer: layer.name, limit: 3 });
        layerResults.push({
          status: preview.requiresUserChoice ? "encoding-choice-required" : "decoded",
          featureCount: preview.featureCount,
          fieldCount: preview.fields.length,
          sampleCount: preview.rows.length,
          warningCount: preview.warnings.length,
        });
      } catch (error) {
        layerResults.push({
          status: "preview-failed",
          error: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
        });
      }
    }
    return {
      sourceRoot: candidate.root, relativePath, extension: candidate.extension, status: "inspected", format: dataset.format,
      driver: dataset.driver, encoding: dataset.encoding, warningCount: dataset.warnings?.length ?? 0,
      layers: layerResults,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (candidate.extension === ".json" && /not recognized as (?:being in a|a) supported file format/i.test(message)) {
      return {
        sourceRoot: candidate.root, relativePath, extension: candidate.extension,
        status: "json-not-recognized-as-vector",
      };
    }
    return {
      sourceRoot: candidate.root, relativePath, extension: candidate.extension, status: "inspect-failed",
      error: message.slice(0, 600),
    };
  } finally {
    completed += 1;
    if (completed % 50 === 0 || completed === candidates.length) process.stderr.write(`GIS local audit: ${completed}/${candidates.length} candidates completed.\n`);
  }
});

const counts = new Map();
for (const row of rows) {
  const key = `${row.extension} ${row.status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const report = {
  createdAt: new Date().toISOString(),
  gdalBin: configuredGdalBin,
  roots: roots.map((rootPath) => path.resolve(rootPath)),
  candidateCount: candidates.length,
  statusCounts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  datasets: rows,
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  candidateCount: report.candidateCount,
  statusCounts: report.statusCounts,
  reportPath,
}, null, 2) + "\n");
