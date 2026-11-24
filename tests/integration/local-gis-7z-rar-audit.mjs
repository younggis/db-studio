import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gdalBin = process.env.DBSTUDIO_GDAL_BIN
  || path.join(root, ".cache", "gdal-static-candidate-20261101", "bin");
const sevenZip = process.env.DBSTUDIO_7Z
  || ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"].find((item) => item && process.platform === "win32")
  || "7z";
const ogrinfo = path.join(gdalBin, process.platform === "win32" ? "ogrinfo.exe" : "ogrinfo");
const ogr2ogr = path.join(gdalBin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr");
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["F:\\GeoData", "F:\\temp"];
const reportPath = process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_REPORT
  || path.join(root, ".cache", "local-gis-7z-rar-audit-latest.json");
const extractionRoot = process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_EXTRACT_ROOT
  || path.join(root, ".cache", "local-gis-7z-rar-extract-20261105");
const maxExtractBytes = positiveInteger(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_MAX_BYTES, 1024 * 1024 * 1024);
const maxExtractEntries = positiveInteger(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_MAX_ENTRIES, 20_000);
const vectorExtensions = new Set([
  ".shp", ".geojson", ".geojsonl", ".json", ".kml", ".kmz", ".tab", ".mif", ".gpkg", ".gml", ".gpx",
  ".fgb", ".sqlite", ".db", ".dxf", ".csv", ".vrt", ".osm", ".pbf", ".parquet",
]);
const processOptions = { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 };
const archiveNameFilter = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_NAME?.trim().toLowerCase();
assert.ok((await readdir(gdalBin)).length, "GDAL/OGR binaries are unavailable.");

async function run(executable, args, options = {}) {
  return execFileAsync(executable, args, { ...processOptions, ...options });
}

async function listArchives(directory, output = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return output; }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase().endsWith(".gdb")) continue;
      await listArchives(absolutePath, output);
    } else if ([".7z", ".rar"].includes(path.extname(entry.name).toLowerCase())) {
      output.push({ absolutePath, extension: path.extname(entry.name).toLowerCase() });
    }
  }
  return output;
}

function parseTechnicalList(text, archivePath) {
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const entries = [];
  for (const block of blocks) {
    const properties = {};
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (match) properties[match[1].trim()] = match[2].trim();
    }
    if (!properties.Path || properties.Path === archivePath || properties.Type || properties["Physical Size"]) continue;
    const memberPath = safeMemberPath(properties.Path);
    if (!memberPath) throw new Error("Archive contains an absolute or traversal path; extraction skipped.");
    const hasLinkValue = ["Symbolic Link", "Hard Link", "Alternate Stream", "Reparse Point"]
      .some((key) => hasUnsafePropertyValue(properties[key]));
    if (hasLinkValue) {
      throw new Error("Archive contains a link or alternate stream; extraction skipped.");
    }
    const size = Number(properties.Size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Archive member size is invalid; extraction skipped.");
    entries.push({
      path: memberPath,
      folder: properties.Folder === "+",
      size,
    });
  }
  return entries;
}

function safeMemberPath(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return undefined;
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === ".." || segment.includes(":"))) return undefined;
  return segments.join("/");
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Archive audit limits must be positive safe integers.");
  return parsed;
}

function hasUnsafePropertyValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized !== "" && !["-", "0", "false", "none"].includes(normalized);
}

function entriesForDataset(entries, dataset) {
  const normalized = dataset.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (lower.endsWith(".gdb")) {
    const prefix = lower + "/";
    return entries.filter((entry) => !entry.folder && entry.path.toLowerCase().startsWith(prefix));
  }

  const directory = path.posix.dirname(lower);
  const basename = path.posix.basename(lower);
  const extension = path.posix.extname(basename);
  const stem = basename.slice(0, basename.length - extension.length);
  const companionExtensions = extension === ".shp"
    ? new Set([".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix", ".sbn", ".sbx"])
    : extension === ".tab"
      ? new Set([".tab", ".dat", ".map", ".id", ".ind", ".dbf", ".prj", ".cpg"])
      : extension === ".mif"
        ? new Set([".mif", ".mid", ".prj", ".cpg"])
        : undefined;

  return entries.filter((entry) => {
    if (entry.folder) return false;
    const member = entry.path.toLowerCase();
    if (member === lower) return true;
    if (!companionExtensions || path.posix.dirname(member) !== directory) return false;
    const memberBasename = path.posix.basename(member);
    if (memberBasename === stem + ".shp.xml" && extension === ".shp") return true;
    if (!memberBasename.startsWith(stem)) return false;
    return companionExtensions.has(memberBasename.slice(stem.length));
  });
}

function datasetsFromEntries(entries) {
  const datasets = new Set();
  const gdbRoots = new Set();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const gdbIndex = segments.findIndex((segment) => segment.toLowerCase().endsWith(".gdb"));
    if (gdbIndex >= 0) {
      gdbRoots.add(segments.slice(0, gdbIndex + 1).join("/"));
      continue;
    }
    if (!entry.folder && vectorExtensions.has(path.posix.extname(entry.path).toLowerCase())) datasets.add(entry.path);
  }
  for (const gdb of gdbRoots) datasets.add(gdb);
  return [...datasets].sort((left, right) => left.localeCompare(right, "en"));
}

async function inspectDataset(source) {
  const jsonStatus = await classifyJsonDataset(source);
  if (jsonStatus) return { driver: "JSON", layers: [], status: jsonStatus };
  const inspected = await run(ogrinfo, ["-json", "-ro", "-so", "-al", source], { timeout: 120_000 });
  const info = JSON.parse(inspected.stdout);
  const layers = [];
  for (const layer of Array.isArray(info.layers) ? info.layers : []) {
    try {
      const preview = await run(ogr2ogr, ["-f", "GeoJSON", "/vsistdout/", "-limit", "3", source, String(layer.name)], { timeout: 120_000 });
      const value = JSON.parse(preview.stdout);
      layers.push({
        status: "decoded",
        featureCount: Number(layer.featureCount ?? 0),
        fieldCount: Array.isArray(layer.fields) ? layer.fields.length : 0,
        sampleCount: Array.isArray(value.features) ? value.features.length : 0,
      });
    } catch (error) {
      layers.push({ status: "preview-failed", error: safeError(error) });
    }
  }
  return { driver: info.driverShortName ?? "Unknown", layers };
}

async function classifyJsonDataset(source) {
  if (path.extname(source).toLowerCase() !== ".json") return undefined;
  const details = await stat(source);
  if (details.size > 2 * 1024 * 1024) return undefined;
  let value;
  try { value = JSON.parse(await readFile(source, "utf8")); }
  catch { return "invalid-json"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "non-spatial-json";
  const type = value.type;
  if (type === "FeatureCollection" && Array.isArray(value.features)) return undefined;
  if (type === "Feature" && Object.hasOwn(value, "geometry")) return undefined;
  if (type === "GeometryCollection" && Array.isArray(value.geometries)) return undefined;
  if (["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(type) && Array.isArray(value.coordinates)) return undefined;
  return "non-spatial-json";
}

function safeError(error) {
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  const details = [error.stderr, error.stdout, error.message]
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "").trim())
    .filter(Boolean);
  return details.join("\n").slice(-1_000);
}

async function inspectArchive(archive, rootPath) {
  const relativePath = path.relative(rootPath, archive.absolutePath);
  let entries;
  try {
    const listing = await run(sevenZip, ["l", "-slt", "-sccUTF-8", archive.absolutePath]);
    entries = parseTechnicalList(listing.stdout, archive.absolutePath);
  } catch (error) {
    return { relativePath, extension: archive.extension, status: "archive-list-failed", error: safeError(error) };
  }

  const datasets = datasetsFromEntries(entries);
  const datasetCandidateCount = datasets.length;
  if (!datasetCandidateCount) return { relativePath, extension: archive.extension, status: "no-vector-members", memberCount: entries.length, datasetCandidateCount };

  const tempDirectory = await mkdtemp(path.join(extractionRoot, "run-"));
  try {
    const inspected = [];
    for (let index = 0; index < datasets.length; index += 1) {
      const member = datasets[index];
      const selectedEntries = entriesForDataset(entries, member);
      const selectedBytes = selectedEntries.reduce((sum, entry) => sum + (Number.isFinite(entry.size) ? entry.size : 0), 0);
      if (!selectedEntries.length) {
        inspected.push({ member, status: "no-extractable-members" });
        continue;
      }
      if (selectedBytes > maxExtractBytes || selectedEntries.length > maxExtractEntries) {
        inspected.push({
          member, status: "extraction-limit-exceeded", selectedBytes,
          selectedMemberCount: selectedEntries.length, maxExtractBytes, maxExtractEntries,
        });
        continue;
      }

      const datasetDirectory = path.join(tempDirectory, `dataset-${index}`);
      try {
        await mkdir(datasetDirectory, { recursive: true });
        await run(sevenZip, [
          "x", "-y", "-spd", `-o${datasetDirectory}`, archive.absolutePath,
          ...selectedEntries.map((entry) => entry.path),
        ]);
        const source = path.resolve(datasetDirectory, ...member.split("/"));
        const relativeSource = path.relative(path.resolve(datasetDirectory), source);
        if (!relativeSource || relativeSource.startsWith("..") || path.isAbsolute(relativeSource) || !(await stat(source).catch(() => undefined))) {
          inspected.push({ member, status: "extract-missing", selectedBytes, selectedMemberCount: selectedEntries.length });
          continue;
        }
        const result = await inspectDataset(source);
        const memberStatus = result.status ?? (result.layers.length ? "inspected" : "opened-no-vector-layers");
        inspected.push({
          member, status: memberStatus,
          driver: result.driver, layers: result.layers, selectedBytes, selectedMemberCount: selectedEntries.length,
        });
      } catch (error) {
        const diagnostic = safeError(error);
        const status = /enter password|password required/i.test(diagnostic) ? "password-required" : "inspect-failed";
        inspected.push({ member, status, selectedBytes, selectedMemberCount: selectedEntries.length, error: diagnostic });
      } finally {
        await rm(datasetDirectory, { recursive: true, force: true });
      }
    }
    return {
      relativePath, extension: archive.extension, status: "members-inspected", memberCount: entries.length,
      datasetCandidateCount, members: inspected,
    };
  } catch (error) {
    return { relativePath, extension: archive.extension, status: "extract-failed", memberCount: entries.length, datasetCandidateCount, error: safeError(error) };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const candidates = [];
for (const rootPath of roots) {
  const resolvedRoot = path.resolve(rootPath);
  for (const archive of await listArchives(resolvedRoot)) candidates.push({ ...archive, root: resolvedRoot });
}
candidates.sort((left, right) => left.extension.localeCompare(right.extension) || left.absolutePath.localeCompare(right.absolutePath, "en"));
assert.ok(candidates.length, "No 7z or RAR archives were found.");
const requestedLimit = Number(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_LIMIT ?? "0");
const filteredCandidates = archiveNameFilter
  ? candidates.filter((archive) => path.basename(archive.absolutePath).toLowerCase().includes(archiveNameFilter))
  : candidates;
assert.ok(filteredCandidates.length, "No archives matched DBSTUDIO_LOCAL_GIS_ARCHIVE_NAME.");
const selected = Number.isInteger(requestedLimit) && requestedLimit > 0 ? filteredCandidates.slice(0, requestedLimit) : filteredCandidates;
await mkdir(extractionRoot, { recursive: true });
let cursor = 0;
let completed = 0;
const results = new Array(selected.length);
await Promise.all(Array.from({ length: Math.min(2, selected.length) }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= selected.length) return;
    results[index] = await inspectArchive(selected[index], selected[index].root);
    completed += 1;
    if (completed % 2 === 0 || completed === selected.length) process.stderr.write(`GIS 7z/RAR audit: ${completed}/${selected.length} archives completed.\n`);
  }
}));

const statusCounts = {};
const memberStatusCounts = {};
let datasetCandidateCount = 0;
let vectorMemberCount = 0;
let decodedLayerCount = 0;
const nonSpatialStatuses = new Set(["non-spatial-json", "invalid-json"]);
for (const archive of results) {
  statusCounts[archive.extension + " " + archive.status] = (statusCounts[archive.extension + " " + archive.status] ?? 0) + 1;
  datasetCandidateCount += archive.datasetCandidateCount ?? 0;
  for (const member of archive.members ?? []) {
    if (!nonSpatialStatuses.has(member.status)) vectorMemberCount += 1;
    memberStatusCounts[member.status] = (memberStatusCounts[member.status] ?? 0) + 1;
    decodedLayerCount += (member.layers ?? []).filter((layer) => layer.status === "decoded").length;
  }
}
const report = {
  createdAt: new Date().toISOString(), archiveCount: candidates.length, auditedArchiveCount: results.length,
  datasetCandidateCount, vectorMemberCount, decodedLayerCount, statusCounts, memberStatusCounts,
  extractionLimits: { maxExtractBytesPerDataset: maxExtractBytes, maxExtractEntriesPerDataset: maxExtractEntries },
  roots: roots.map((item) => path.resolve(item)), archiveNameFilter: archiveNameFilter ?? null,
  archives: results,
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  archiveCount: report.archiveCount, auditedArchiveCount: report.auditedArchiveCount,
  datasetCandidateCount, vectorMemberCount,
  decodedLayerCount, statusCounts, memberStatusCounts, reportPath,
}, null, 2) + "\n");
