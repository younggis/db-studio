import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceReportPath = process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_REPORT
  || path.join(root, ".cache", "local-gis-7z-rar-audit-latest.json");
const reportPath = process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_REPORT
  || path.join(root, ".cache", "local-gis-7z-rar-roundtrip-latest.json");
const sourceReport = JSON.parse(readFileSync(sourceReportPath, "utf8"));
const envPath = path.join(root, "docker", ".env");
const sevenZip = process.env.DBSTUDIO_7Z || "C:\\Program Files\\7-Zip\\7z.exe";
const maxBytes = positiveInteger(process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_MAX_BYTES, 20 * 1024 * 1024);
const maxFeatures = positiveInteger(process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_MAX_FEATURES, 10_000);
const perFormatQuota = positiveInteger(process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_PER_FORMAT, 1);
const targetFormats = [".shp", ".geojson", ".tab", ".kml", ".gpkg", ".csv"];
const requestedFormats = [...new Set((process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_FORMAT_FILTER ?? "")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
assert.ok(requestedFormats.every((extension) => targetFormats.includes(extension)), "The archive roundtrip format filter contains an unsupported extension.");
const formatFilter = new Set(requestedFormats);
const requestedMemberFilters = [...new Set((process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_MEMBER_FILTER ?? "")
  .split(",").map((value) => value.trim().toLocaleLowerCase("en-US")).filter(Boolean))];
const csvSourceEncodingOverride = process.env.DBSTUDIO_LOCAL_GIS_7Z_RAR_ROUNDTRIP_CSV_SOURCE_ENCODING?.trim() || undefined;
const processOptions = { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 };

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, "Roundtrip limits must be positive safe integers.");
  return parsed;
}

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

function safeMemberPath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return undefined;
  return parts.join("/");
}

function hasUnsafeLinkValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized !== "" && !["-", "0", "false", "none"].includes(normalized);
}

function parseTechnicalList(text, archivePath) {
  const entries = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const properties = {};
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (match) properties[match[1].trim()] = match[2].trim();
    }
    if (!properties.Path || properties.Path === archivePath || properties.Type || properties["Physical Size"]) continue;
    const member = safeMemberPath(properties.Path);
    if (!member) throw new Error("Unsafe archive path; extraction refused.");
    if (["Symbolic Link", "Hard Link", "Alternate Stream", "Reparse Point"].some((key) => hasUnsafeLinkValue(properties[key]))) {
      throw new Error("Archive contains a link or alternate stream; extraction refused.");
    }
    const size = Number(properties.Size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Archive member size is invalid.");
    entries.push({ path: member, lowerPath: member.toLowerCase(), size, folder: properties.Folder === "+" });
  }
  return entries;
}

function entriesForDataset(entries, member) {
  const lower = member.toLowerCase();
  const extension = path.posix.extname(lower);
  const parent = path.posix.dirname(lower);
  const base = path.posix.basename(lower);
  const stem = base.slice(0, -extension.length);
  const sidecars = extension === ".shp"
    ? new Set([".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix", ".sbn", ".sbx"])
    : extension === ".tab"
      ? new Set([".tab", ".dat", ".map", ".id", ".ind", ".dbf", ".prj", ".cpg"])
      : extension === ".mif"
        ? new Set([".mif", ".mid", ".prj", ".cpg"])
        : undefined;
  return entries.filter((entry) => {
    if (entry.folder) return false;
    if (entry.lowerPath === lower) return true;
    if (!sidecars || path.posix.dirname(entry.lowerPath) !== parent) return false;
    const sidecarName = path.posix.basename(entry.lowerPath);
    if (extension === ".shp" && sidecarName === `${stem}.shp.xml`) return true;
    return sidecarName.startsWith(stem) && sidecars.has(sidecarName.slice(stem.length));
  });
}

function archivePathFor(archive) {
  const matches = [...new Set((sourceReport.roots ?? []).map((sourceRoot) => path.resolve(sourceRoot, archive.relativePath)))].filter((candidate) => {
    try { return existsSync(candidate) && !lstatSync(candidate).isSymbolicLink(); }
    catch { return false; }
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function run(executable, args, options = {}) {
  return execFileAsync(executable, args, { ...processOptions, ...options });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sourceIdFor(filePath) {
  return createHash("sha256").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 12);
}

function safeError(error) {
  const details = [error?.stderr, error?.stdout, error?.message]
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "").trim())
    .filter(Boolean).join(" ").replaceAll(root, "<workspace>");
  return details.replace(/\s+/g, " ").slice(-500);
}

function removeOwnedChild(tempRoot, directory) {
  const parent = path.resolve(tempRoot);
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase(), "Refusing to remove a path outside the owned temporary root.");
  assert.match(path.basename(resolved), /^source-\d{3}$/i, "Refusing to remove an unexpected extraction directory.");
  rmSync(resolved, { recursive: true, force: true });
}

function removeOwnedRoot(tempRoot) {
  const resolved = path.resolve(tempRoot);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), "Refusing to remove outside the OS temp directory.");
  assert.match(path.basename(resolved), /^dbstudio-local-gis-7z-rar-roundtrip-[a-f0-9]{8}$/i, "Refusing to remove an unexpected temp root.");
  rmSync(resolved, { recursive: true, force: true });
}

const envConfig = parseEnvFile(envPath);
const gdalBin = process.env.DBSTUDIO_GDAL_BIN
  || path.join(root, "apps", "desktop", "release-static-gdal", "win-unpacked", "resources", "gdal", "bin");
const environment = {
  ...process.env,
  DBSTUDIO_GDAL_BIN: gdalBin,
  PGHOST: "127.0.0.1",
  PGPORT: envConfig.DBSTUDIO_POSTGIS_PORT || "25432",
  PGDATABASE: envConfig.DBSTUDIO_PG_DATABASE,
  PGUSER: envConfig.DBSTUDIO_PG_USER,
  PGPASSWORD: envConfig.DBSTUDIO_PG_PASSWORD,
};
environment.PATH = `${gdalBin}${path.delimiter}${environment.PATH ?? ""}`;
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Project PostGIS test settings are unavailable.");
assert.ok(existsSync(path.join(gdalBin, process.platform === "win32" ? "ogrinfo.exe" : "ogrinfo")), "The authorized GDAL runtime is unavailable.");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const batchRunner = path.join(root, "tests", "integration", "local-gis-roundtrip-batch.mjs");
assert.ok(existsSync(cli), "Build the CLI before this integration test.");
const core = CoreService.fromEnvironment(environment);

const candidatesByFormat = new Map(targetFormats.map((extension) => [extension, []]));
const skipped = { missingOrAmbiguousArchive: 0, oversized: 0, unsafeMember: 0, noEncodingMetadata: 0, layerMismatch: 0, extractOrInspectFailed: 0 };
for (const archive of sourceReport.archives ?? []) {
  if (archive.status !== "members-inspected") continue;
  const archivePath = archivePathFor(archive);
  if (!archivePath) { skipped.missingOrAmbiguousArchive += 1; continue; }
  for (const member of archive.members ?? []) {
    if (member.status !== "inspected") continue;
    const normalized = safeMemberPath(member.member);
    if (!normalized || normalized.split("/").some((part) => part.toLowerCase() === "__macosx" || part.startsWith("._"))) { skipped.unsafeMember += 1; continue; }
    const extension = path.posix.extname(normalized).toLowerCase();
    if (!candidatesByFormat.has(extension)) continue;
    if (formatFilter.size > 0 && !formatFilter.has(extension)) continue;
    if (requestedMemberFilters.length > 0
      && !requestedMemberFilters.some((filter) => `${archive.relativePath}::${member.member}`.toLocaleLowerCase("en-US").includes(filter))) continue;
    const bundleBytes = Number(member.selectedBytes);
    if (!Number.isSafeInteger(bundleBytes) || bundleBytes > maxBytes) { skipped.oversized += 1; continue; }
    for (let layerIndex = 0; layerIndex < (member.layers ?? []).length; layerIndex += 1) {
      const layer = member.layers[layerIndex];
      const featureCount = Number(layer.featureCount);
      if (layer.status !== "decoded" || !Number.isSafeInteger(featureCount) || featureCount < 1 || featureCount > maxFeatures) continue;
      candidatesByFormat.get(extension).push({ archive, archivePath, member, normalized, layer, layerIndex, extension, featureCount, bundleBytes });
    }
  }
}
for (const candidates of candidatesByFormat.values()) {
  candidates.sort((a, b) => a.featureCount - b.featureCount || a.bundleBytes - b.bundleBytes || a.normalized.localeCompare(b.normalized, "en"));
}
const candidateCountsByFormat = Object.fromEntries([...candidatesByFormat].map(([extension, candidates]) => [extension, candidates.length]));
const eligibleFormats = targetFormats.filter((extension) => candidateCountsByFormat[extension] > 0);
const unavailableFormats = targetFormats.filter((extension) => candidateCountsByFormat[extension] === 0);
assert.ok(eligibleFormats.length > 0, "No archive layers matched the current format, size, and feature limits.");

const runId = randomBytes(4).toString("hex");
const tempRoot = path.join(os.tmpdir(), `dbstudio-local-gis-7z-rar-roundtrip-${runId}`);
mkdirSync(tempRoot, { recursive: false });
const manifestPath = path.join(tempRoot, "source-manifest.json");
const batchReportPath = path.join(tempRoot, "batch-report.json");
const outputCandidates = [];
const sourceMetadata = new Map();
const entryCache = new Map();
const archiveHashCache = new Map();
const selectedByFormat = Object.fromEntries(targetFormats.map((extension) => [extension, 0]));
const encodingChoiceRequiredByFormat = Object.fromEntries(targetFormats.map((extension) => [extension, 0]));
const reports = [];
let sourceIndex = 0;

try {
  for (const extension of targetFormats) {
    for (const candidate of candidatesByFormat.get(extension)) {
      if (selectedByFormat[extension] >= perFormatQuota) break;
      let sourceDirectory;
      try {
        const archiveKey = candidate.archivePath.toLowerCase();
        let entries = entryCache.get(archiveKey);
        if (!entries) {
          const listing = await run(sevenZip, ["l", "-slt", "-sccUTF-8", candidate.archivePath]);
          entries = parseTechnicalList(listing.stdout, candidate.archivePath);
          entryCache.set(archiveKey, entries);
          archiveHashCache.set(archiveKey, await sha256(candidate.archivePath));
        }
        const family = entriesForDataset(entries, candidate.normalized);
        const familyBytes = family.reduce((sum, entry) => sum + entry.size, 0);
        if (!family.length || !family.some((entry) => entry.lowerPath === candidate.normalized.toLowerCase())) { skipped.unsafeMember += 1; continue; }
        if (familyBytes > maxBytes || family.length > 20_000) { skipped.oversized += 1; continue; }

        sourceIndex += 1;
        sourceDirectory = path.join(tempRoot, `source-${String(sourceIndex).padStart(3, "0")}`);
        mkdirSync(sourceDirectory, { recursive: false });
        await run(sevenZip, ["x", "-y", "-spd", `-o${sourceDirectory}`, candidate.archivePath, ...family.map((entry) => entry.path)]);
        if (await sha256(candidate.archivePath) !== archiveHashCache.get(archiveKey)) throw new Error("Source archive changed during extraction.");

        const sourcePath = path.resolve(sourceDirectory, ...candidate.normalized.split("/"));
        const relativeSource = path.relative(path.resolve(sourceDirectory), sourcePath);
        if (relativeSource.startsWith("..") || path.isAbsolute(relativeSource) || !existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink()) {
          throw new Error("Extracted member was missing or unsafe.");
        }
        const sourceEncodingOverride = extension === ".csv" ? csvSourceEncodingOverride : undefined;
        const inspectOptions = sourceEncodingOverride ? { sourceEncoding: sourceEncodingOverride } : {};
        const inspected = await core.inspectGisFile(sourcePath, inspectOptions);
        const liveLayer = inspected.layers[candidate.layerIndex];
        const liveIndex = liveLayer
          && Number(liveLayer.featureCount) === candidate.featureCount
          && liveLayer.fields.length === candidate.layer.fieldCount
          ? candidate.layerIndex
          : -1;
        if (!liveLayer || liveIndex < 0 || inspected.layers.length !== candidate.member.layers.length) {
          skipped.layerMismatch += 1;
          reports.push({
            extension,
            status: "layer-mismatch",
            archive: candidate.archive.relativePath,
            member: candidate.member.member,
            expectedLayerIndex: candidate.layerIndex,
            expectedFeatureCount: candidate.featureCount,
            expectedFieldCount: candidate.layer.fieldCount,
            expectedLayerCount: candidate.member.layers.length,
            actualLayerCount: inspected.layers.length,
            actualLayers: inspected.layers.slice(0, 8).map((layer) => ({
              name: layer.name,
              featureCount: layer.featureCount,
              fieldCount: layer.fields.length,
            })),
          });
          removeOwnedChild(tempRoot, sourceDirectory); sourceDirectory = undefined; continue;
        }
        if (!sourceEncodingOverride && !["metadata", "format"].includes(inspected.encoding?.source)) {
          skipped.noEncodingMetadata += 1;
          encodingChoiceRequiredByFormat[extension] += 1;
          reports.push({ extension, status: "encoding-choice-required", encodingSource: inspected.encoding?.source ?? null });
          removeOwnedChild(tempRoot, sourceDirectory); sourceDirectory = undefined; continue;
        }
        const preview = await core.previewGisAttributes(sourcePath, {
          sourceLayer: liveLayer.name, limit: 3, ...inspectOptions,
        });
        if (preview.requiresUserChoice || Number(preview.featureCount) !== candidate.featureCount) {
          skipped.noEncodingMetadata += 1;
          if (preview.requiresUserChoice) encodingChoiceRequiredByFormat[extension] += 1;
          reports.push({ extension, status: preview.requiresUserChoice ? "encoding-choice-required" : "feature-count-mismatch" });
          removeOwnedChild(tempRoot, sourceDirectory); sourceDirectory = undefined; continue;
        }

        const sourceId = sourceIdFor(sourcePath);
        const layers = inspected.layers.map((layer, index) => ({
          name: layer.name, featureCount: layer.featureCount, fieldCount: layer.fields.length,
          status: index === liveIndex ? "decoded" : "not-selected", selected: index === liveIndex,
        }));
        outputCandidates.push({
          relativePath: candidate.normalized, sourceRoot: sourceDirectory, extension,
          status: "inspected", encoding: inspected.encoding, layers,
          ...(sourceEncodingOverride ? { sourceEncodingOverride } : {}),
        });
        sourceMetadata.set(sourceId, {
          sourceId, archive: candidate.archive.relativePath, member: candidate.member.member,
          layer: liveLayer.name, sourceGeometryType: liveLayer.geometryType, sourceExtent: liveLayer.extent,
          extension, featureCount: candidate.featureCount,
          selectedBytes: familyBytes, archiveSha256: archiveHashCache.get(archiveKey),
          encodingSource: inspected.encoding.source,
          ...(sourceEncodingOverride ? { sourceEncodingOverride } : {}),
        });
        selectedByFormat[extension] += 1;
      } catch (error) {
        skipped.extractOrInspectFailed += 1;
        reports.push({ extension, status: "candidate-skipped", diagnostic: safeError(error) });
        if (sourceDirectory && existsSync(sourceDirectory)) removeOwnedChild(tempRoot, sourceDirectory);
      }
    }
  }

  if (outputCandidates.length === 0) {
    const diagnostic = {
      createdAt: new Date().toISOString(), sourceReport: path.relative(root, sourceReportPath),
      formatFilter: requestedFormats, memberFilter: requestedMemberFilters,
      csvSourceEncodingOverride: csvSourceEncodingOverride ?? null,
      candidateCountsByFormat, selectedByFormat, encodingChoiceRequiredByFormat, skipped, candidateSkips: reports,
      extractionRootCleaned: false,
    };
    removeOwnedRoot(tempRoot);
    diagnostic.extractionRootCleaned = !existsSync(tempRoot);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    throw new Error("No small archive layers with confirmed encoding were eligible for PostGIS roundtrip; inspect the diagnostic report.");
  }
  const manifest = {
    createdAt: new Date().toISOString(), candidateCount: outputCandidates.length,
    roots: [...new Set(outputCandidates.map((item) => item.sourceRoot))], gdalBin, datasets: outputCandidates,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const batchEnvironment = {
    ...environment,
    DBSTUDIO_LOCAL_GIS_AUDIT_REPORT: manifestPath,
    DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT: batchReportPath,
    DBSTUDIO_LOCAL_GIS_MAX_FEATURES: String(maxFeatures),
    DBSTUDIO_LOCAL_GIS_MAX_BUNDLE_BYTES: String(maxBytes),
    DBSTUDIO_LOCAL_GIS_ROUNDTRIP_CONCURRENCY: "2",
    DBSTUDIO_LOCAL_GIS_PREFLIGHT_CONCURRENCY: "2",
    DBSTUDIO_LOCAL_GIS_VERIFY_TEXT_PREVIEW: "true",
    DBSTUDIO_LOCAL_GIS_VERIFY_GEOMETRY: "true",
      DBSTUDIO_LOCAL_GIS_ENCODING_OVERRIDES_JSON: JSON.stringify(outputCandidates
        .filter((item) => item.sourceEncodingOverride)
        .map((item) => ({
          filePath: path.resolve(item.sourceRoot, ...item.relativePath.split("/")),
          encoding: item.sourceEncodingOverride,
        }))),
  };
  const batchResult = await execFileAsync(process.execPath, [batchRunner], {
    cwd: root, env: batchEnvironment, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 45 * 60 * 1000,
  }).catch((error) => error);
  if (!existsSync(batchReportPath)) {
    const diagnostic = {
      createdAt: new Date().toISOString(), sourceReport: path.relative(root, sourceReportPath),
      formatFilter: requestedFormats, memberFilter: requestedMemberFilters,
      csvSourceEncodingOverride: csvSourceEncodingOverride ?? null,
      candidateCountsByFormat, selectedByFormat, encodingChoiceRequiredByFormat,
      skipped, candidateSkips: reports,
      batchExitCode: Number.isInteger(batchResult?.code) ? batchResult.code : null,
      batchDiagnostic: safeError(batchResult),
    };
    removeOwnedRoot(tempRoot);
    diagnostic.archiveExtractionCleaned = !existsSync(tempRoot);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ reportPath, formatFilter: requestedFormats, csvSourceEncodingOverride: csvSourceEncodingOverride ?? null, selectedByFormat, batchExitCode: diagnostic.batchExitCode, batchDiagnostic: diagnostic.batchDiagnostic, archiveExtractionCleaned: diagnostic.archiveExtractionCleaned }, null, 2)}\n`);
    throw new Error("PostGIS batch runner did not write its report.");
  }
  const batchReport = JSON.parse(readFileSync(batchReportPath, "utf8"));
  const successfulLayers = (batchReport.successfulLayers ?? []).map(({ sourceRoot, relativePath, ...entry }) => ({
    ...entry,
    ...sourceMetadata.get(entry.sourceId),
  }));
  const failuresByFormatAndPhase = (batchReport.failuresByFormatAndPhase ?? []).map((failure) => ({
    ...failure,
    sources: (failure.sources ?? []).map((source) => ({ ...source, ...sourceMetadata.get(source.sourceId) })),
  }));
  const awaitingEncodingChoiceFormats = eligibleFormats.filter((extension) =>
    selectedByFormat[extension] === 0 && encodingChoiceRequiredByFormat[extension] > 0);
  const missingFormats = eligibleFormats.filter((extension) =>
    selectedByFormat[extension] === 0 && encodingChoiceRequiredByFormat[extension] === 0);
  const report = {
    createdAt: new Date().toISOString(), sourceReport: path.relative(root, sourceReportPath),
    archiveCount: sourceReport.archiveCount, maxBytes, maxFeatures, perFormatQuota,
    formatFilter: requestedFormats, memberFilter: requestedMemberFilters,
    csvSourceEncodingOverride: csvSourceEncodingOverride ?? null,
    candidateCountsByFormat, eligibleFormats, unavailableFormats, selectedByFormat,
    encodingChoiceRequiredByFormat, awaitingEncodingChoiceFormats, sources: [...sourceMetadata.values()],
    passedLayerCount: batchReport.passedLayerCount, failureCount: batchReport.failureCount,
    successfulLayers, failuresByFormatAndPhase, missingFormats,
    skipped, candidateSkips: reports,
    postgisTemporaryTablesCleaned: batchReport.postgisTemporaryTablesCleaned === true,
    exportDirectoryCleaned: batchReport.exportDirectoryCleaned === true,
    externalDataSent: false,
  };
  removeOwnedRoot(tempRoot);
  report.archiveExtractionCleaned = !existsSync(tempRoot);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath, formatFilter: requestedFormats, memberFilter: requestedMemberFilters, csvSourceEncodingOverride: csvSourceEncodingOverride ?? null, candidateCountsByFormat, eligibleFormats, unavailableFormats, selectedByFormat, awaitingEncodingChoiceFormats, passedLayerCount: report.passedLayerCount, failureCount: report.failureCount, postgisTemporaryTablesCleaned: report.postgisTemporaryTablesCleaned, exportDirectoryCleaned: report.exportDirectoryCleaned, archiveExtractionCleaned: report.archiveExtractionCleaned }, null, 2)}\n`);
  assert.ok(!batchResult.code, "PostGIS roundtrip batch failed; inspect the saved report.");
  assert.equal(report.failureCount, 0, "One or more compressed-archive layers failed PostGIS roundtrip.");
  assert.deepEqual(missingFormats, [], "An available archive format did not produce a confirmed-encoding sample.");
  assert.equal(report.archiveExtractionCleaned, true, "Compressed-archive extraction was not cleaned.");
} finally {
  if (existsSync(tempRoot)) removeOwnedRoot(tempRoot);
}
