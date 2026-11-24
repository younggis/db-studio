import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const archiveReportPath = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_AUDIT_REPORT
  || path.join(root, ".cache", "local-gis-archive-audit-latest.json");
const outputReportPath = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_REPORT
  || path.join(root, ".cache", "local-gis-archive-roundtrip-latest.json");
const sourceReport = JSON.parse(readFileSync(archiveReportPath, "utf8"));
const envPath = path.join(root, "docker", ".env");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer.`);
  return value;
}

function safeArchiveMember(value, isDirectory = false) {
  let normalized = value.replaceAll("\\", "/");
  if (isDirectory && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) return undefined;
  return segments.join("/");
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

function uniqueMembers(records) {
  const unique = new Map();
  for (const record of records) unique.set(record.normalized.toLocaleLowerCase("en-US"), record);
  return [...unique.values()];
}

function archiveFamily(member, records) {
  const normalized = safeArchiveMember(member);
  if (!normalized) return [];
  const extension = path.posix.extname(normalized).toLowerCase();
  const companionExtensions = extension === ".tab"
    ? new Set([".tab", ".dat", ".map", ".id", ".ind"])
    : extension === ".mif"
      ? new Set([".mif", ".mid"])
      : extension === ".shp"
        ? new Set([".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix", ".sbn", ".sbx"])
        : undefined;
  if (!companionExtensions) {
    return uniqueMembers(records.filter((record) => !record.isDirectory && record.normalized.toLocaleLowerCase("en-US") === normalized.toLocaleLowerCase("en-US")).slice(0, 1));
  }
  const directory = path.posix.dirname(normalized).toLocaleLowerCase("en-US");
  const stem = path.posix.basename(normalized).slice(0, -extension.length).toLocaleLowerCase("en-US");
  return uniqueMembers(records.filter((record) => {
    if (record.isDirectory || path.posix.dirname(record.normalized).toLocaleLowerCase("en-US") !== directory) return false;
    const candidateExtension = path.posix.extname(record.normalized).toLowerCase();
    const candidateStem = path.posix.basename(record.normalized).slice(0, -candidateExtension.length).toLocaleLowerCase("en-US");
    return candidateStem === stem && companionExtensions.has(candidateExtension)
      || extension === ".shp" && record.normalized.toLocaleLowerCase("en-US") === `${normalized}.xml`.toLocaleLowerCase("en-US");
  }));
}

async function listZipMembers(zipPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$stream = [IO.File]::OpenRead($env:DBSTUDIO_ARCHIVE_PATH)",
    // Most older Chinese GIS archives store member names as GBK without the ZIP UTF-8 flag.
    // Supplying the legacy encoding preserves the exact names and still honors UTF-8 flagged entries.
    "$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false, [Text.Encoding]::GetEncoding(936))",
    "try {",
    "  $members = [System.Collections.Generic.List[object]]::new()",
    "  for ($i = 0; $i -lt $archive.Entries.Count; $i++) { $entry = $archive.Entries[$i]; $members.Add([pscustomobject]@{ index = [int]$i; fullName = $entry.FullName; length = [int64]$entry.Length; isDirectory = $entry.FullName.EndsWith('/') }) }",
    "  ConvertTo-Json -InputObject @($members.ToArray()) -Compress -Depth 3",
    "} finally { $archive.Dispose(); $stream.Dispose() }",
  ].join("\n");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
    env: { ...process.env, DBSTUDIO_ARCHIVE_PATH: zipPath },
  });
  const value = JSON.parse(stdout);
  const values = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return values.filter((item) => item && typeof item.fullName === "string").map((item) => ({
    name: item.fullName,
    normalized: safeArchiveMember(item.fullName, Boolean(item.isDirectory)),
    index: Number(item.index),
    size: Number(item.length ?? 0),
    isDirectory: Boolean(item.isDirectory),
  })).filter((item) => item.normalized);
}

async function extractArchiveFamily(zipPath, destination, records) {
  const payload = Buffer.from(JSON.stringify(records.map(({ index, size, outputName }) => ({ index, size, outputName })), "utf8")).toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($env:DBSTUDIO_ARCHIVE_PATH)",
    "try {",
    "  $items = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DBSTUDIO_ARCHIVE_ITEMS_B64)) | ConvertFrom-Json",
    "  $base = [IO.Path]::GetFullPath($env:DBSTUDIO_ARCHIVE_DEST).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "  foreach ($item in @($items)) {",
    "    if ([string]$item.outputName -notmatch '^[a-z0-9_.-]{1,80}$') { throw 'Unsafe extracted archive name.' }",
    "    $entry = $archive.Entries[[int]$item.index]",
    "    if ($null -eq $entry -or $entry.Length -ne [int64]$item.size) { throw 'ZIP member missing or size changed.' }",
    "    $target = [IO.Path]::GetFullPath((Join-Path $base ([string]$item.outputName)))",
    "    if (!$target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP member escaped extraction root.' }",
    "    $inputStream = $entry.Open()",
    "    try {",
    "      $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)",
    "      try {",
    "        [byte[]]$buffer = New-Object byte[] 65536",
    "        [int64]$actualLength = 0",
    "        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {",
    "          $actualLength += $read",
    "          if ($actualLength -gt [int64]$item.size) { throw 'ZIP member expanded beyond declared size.' }",
    "          $outputStream.Write($buffer, 0, $read)",
    "        }",
    "        if ($actualLength -ne [int64]$item.size) { throw 'ZIP member size differed from declared size.' }",
    "      } finally { $outputStream.Dispose() }",
    "    } finally { $inputStream.Dispose() }",
    "  }",
    "} finally { $archive.Dispose() }",
  ].join("\n");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
    encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 300_000,
    env: { ...process.env, DBSTUDIO_ARCHIVE_PATH: zipPath, DBSTUDIO_ARCHIVE_DEST: destination, DBSTUDIO_ARCHIVE_ITEMS_B64: payload },
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function archivePathFor(dataset) {
  const matches = [...new Set((sourceReport.roots ?? []).map((sourceRoot) => path.resolve(sourceRoot, dataset.relativePath)))]
    .filter((candidate) => existsSync(candidate));
  return matches.length === 1 ? matches[0] : undefined;
}

function sourceIdFor(sourcePath) {
  return createHash("sha256").update(path.resolve(sourcePath).toLowerCase()).digest("hex").slice(0, 12);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function removeOwnedTempChild(tempRoot, candidateDirectory) {
  const parent = path.resolve(tempRoot);
  const resolved = path.resolve(candidateDirectory);
  assert.ok(samePath(path.dirname(resolved), parent), "Refusing to remove a path outside the owned temporary directory.");
  assert.match(path.basename(resolved), /^source-\d{3}$/i, "Refusing to remove an unexpected temporary source directory.");
  rmSync(resolved, { recursive: true, force: true });
}

function removeOwnedTempRoot(tempRoot) {
  const tempBase = path.resolve(os.tmpdir());
  const resolved = path.resolve(tempRoot);
  assert.ok(samePath(path.dirname(resolved), tempBase), "Refusing to remove a path outside the OS temporary directory.");
  assert.match(path.basename(resolved), /^dbstudio-local-gis-archive-roundtrip-[a-f0-9]{8}$/i, "Refusing to remove an unexpected temporary directory.");
  rmSync(resolved, { recursive: true, force: true });
}

const maxFeatures = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_MAX_FEATURES", 10_000);
const minBundleBytes = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_MIN_BUNDLE_BYTES", 1);
const maxBundleBytes = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_MAX_BUNDLE_BYTES", 20 * 1024 * 1024);
const maxLayers = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_MAX_LAYERS", 18);
const roundtripConcurrency = positiveIntegerEnv("DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_CONCURRENCY", 3);
const memberFilter = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_MEMBER_FILTER?.toLocaleLowerCase("en-US");
const archiveSourceEncodingOverride = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_SOURCE_ENCODING?.trim() || undefined;
const allTargetFormats = [".shp", ".geojson", ".tab", ".csv"];
const formatFilterInput = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_FORMAT_FILTER
  ?.split(",").map((extension) => extension.trim().toLowerCase()).filter(Boolean);
if (formatFilterInput) {
  assert.ok(formatFilterInput.length > 0 && new Set(formatFilterInput).size === formatFilterInput.length
    && formatFilterInput.every((extension) => allTargetFormats.includes(extension)),
  "DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_FORMAT_FILTER must contain unique supported extensions such as .csv.");
}
const targetFormats = formatFilterInput
  ? allTargetFormats.filter((extension) => formatFilterInput.includes(extension))
  : allTargetFormats;
const perFormatQuota = Math.ceil(maxLayers / targetFormats.length);
const candidatesByFormat = new Map(targetFormats.map((extension) => [extension, []]));
const skipped = { missingOrAmbiguousArchive: 0, memberNotFound: 0, unsafeMember: 0, belowMinBundleBytes: 0, tooLarge: 0, emptyOrUnknownFeatureCount: 0, featureLimit: 0, inspectFailed: 0, layerMismatch: 0, encodingChoice: 0 };

for (const dataset of sourceReport.datasets ?? []) {
  if (dataset.status !== "members-inspected") continue;
  const archivePath = archivePathFor(dataset);
  if (!archivePath) { skipped.missingOrAmbiguousArchive += 1; continue; }
  for (const member of dataset.members ?? []) {
    if (member.status !== "inspected") continue;
    const memberPath = safeArchiveMember(member.member);
    if (!memberPath || memberPath.split("/").some((segment) => segment.toLocaleLowerCase("en-US") === "__macosx" || segment.startsWith("._"))) { skipped.unsafeMember += 1; continue; }
    if (memberFilter && !`${dataset.relativePath}::${memberPath}`.toLocaleLowerCase("en-US").includes(memberFilter)) continue;
    const extension = path.posix.extname(memberPath).toLowerCase();
    if (!candidatesByFormat.has(extension)) continue;
    // A user-selected source encoding applies to every supported text-bearing
    // vector format, including Shapefile and MapInfo TAB. Restricting this to
    // JSON silently skipped the explicit encoding choice for archived TABs.
    const sourceEncodingOverride = archiveSourceEncodingOverride;
    for (let layerIndex = 0; layerIndex < (member.layers ?? []).length; layerIndex += 1) {
      const layer = member.layers[layerIndex];
      if (layer.status !== "decoded") continue;
      const featureCount = Number(layer.featureCount);
      const sampleCount = Number(layer.sampleCount);
      if (!Number.isSafeInteger(featureCount) || featureCount < 1 || !Number.isSafeInteger(sampleCount) || sampleCount < 1) {
        skipped.emptyOrUnknownFeatureCount += 1;
        continue;
      }
      if (featureCount > maxFeatures) { skipped.featureLimit += 1; continue; }
      candidatesByFormat.get(extension).push({ dataset, archivePath, member, memberPath, layer, layerIndex, extension, featureCount, sampleCount, sourceEncodingOverride });
    }
  }
}

for (const candidates of candidatesByFormat.values()) {
  candidates.sort((left, right) => left.featureCount - right.featureCount
    || left.dataset.relativePath.localeCompare(right.dataset.relativePath, "en")
    || left.memberPath.localeCompare(right.memberPath, "en"));
}

const envConfig = parseEnvFile(envPath);
const gdalBin = process.env.DBSTUDIO_GDAL_BIN
  || path.join(root, "apps", "desktop", "release-static-gdal-liblzma-5.8.4-mvt-20261104", "win-unpacked", "resources", "gdal", "bin");
assert.ok(existsSync(path.join(gdalBin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr")), "Set DBSTUDIO_GDAL_BIN to the authorized GDAL runtime bin directory.");
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
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Configure the authorized project PostGIS test service first.");
const core = CoreService.fromEnvironment(environment);
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const batchRunner = path.join(root, "tests", "integration", "local-gis-roundtrip-batch.mjs");
assert.ok(existsSync(cli), "Build the CLI before running this integration check.");
assert.ok(existsSync(batchRunner), "The local GIS roundtrip batch runner is missing.");

const runId = randomBytes(4).toString("hex");
const tempRoot = path.join(os.tmpdir(), `dbstudio-local-gis-archive-roundtrip-${runId}`);
mkdirSync(tempRoot, { recursive: false });
const batchReportPath = path.join(tempRoot, "batch-report.json");
const sourceManifestPath = path.join(tempRoot, "source-manifest.json");
const outputCandidates = [];
const sourceMetadata = new Map();
const entriesCache = new Map();
const archiveHashCache = new Map();
const candidateInspectionFailures = [];
const encodingChoiceDetails = [];
const acceptedByFormat = Object.fromEntries(targetFormats.map((extension) => [extension, 0]));
let extractionCount = 0;

try {
  for (const extension of targetFormats) {
    for (const candidate of candidatesByFormat.get(extension)) {
      if (acceptedByFormat[extension] >= perFormatQuota || outputCandidates.length >= maxLayers) break;
      const archiveId = path.resolve(candidate.archivePath).toLowerCase();
      let candidateDirectory;
      let candidatePhase = "archive-members";
      let records = entriesCache.get(archiveId);
      try {
        if (!records) {
          records = await listZipMembers(candidate.archivePath);
          entriesCache.set(archiveId, records);
          archiveHashCache.set(archiveId, await sha256(candidate.archivePath));
        }
        const normalizedMember = candidate.memberPath.toLocaleLowerCase("en-US");
        const matching = records.filter((record) => !record.isDirectory && record.normalized.toLocaleLowerCase("en-US") === normalizedMember);
        const primary = matching.at(-1);
        if (!primary) { skipped.memberNotFound += 1; continue; }
        const family = archiveFamily(primary.normalized, records);
        if (!family.length || !family.some((record) => record.index === primary.index)) { skipped.unsafeMember += 1; continue; }
        const familyBytes = family.reduce((sum, record) => sum + record.size, 0);
        if (familyBytes < minBundleBytes) { skipped.belowMinBundleBytes += 1; continue; }
        if (familyBytes > maxBundleBytes) { skipped.tooLarge += 1; continue; }

        const itemIndex = extractionCount + 1;
        const directory = path.join(tempRoot, `source-${String(itemIndex).padStart(3, "0")}`);
        candidateDirectory = directory;
        mkdirSync(directory, { recursive: false });
        const outputStem = `source-${String(itemIndex).padStart(3, "0")}`;
        const extractionItems = family.map((record) => ({
          index: record.index,
          size: record.size,
          outputName: `${outputStem}${path.posix.extname(record.normalized).toLowerCase()}`,
        }));
        if (new Set(extractionItems.map((item) => item.outputName)).size !== extractionItems.length) { skipped.unsafeMember += 1; rmSync(directory, { recursive: true, force: true }); continue; }
        candidatePhase = "archive-extraction";
        await extractArchiveFamily(candidate.archivePath, directory, extractionItems);
        const expectedArchiveHash = archiveHashCache.get(archiveId);
        if (await sha256(candidate.archivePath) !== expectedArchiveHash) throw new Error("Source archive changed while the test copy was being extracted.");
        extractionCount += 1;

        const sourcePath = path.join(directory, `${outputStem}${extension}`);
        candidatePhase = "source-inspection";
        const inspectOptions = candidate.sourceEncodingOverride
          ? { sourceEncoding: candidate.sourceEncodingOverride }
          : {};
        const inspected = await core.inspectGisFile(sourcePath, inspectOptions);
        if (inspected.layers.length !== candidate.member.layers.length || !inspected.layers[candidate.layerIndex]) {
          skipped.layerMismatch += 1;
          removeOwnedTempChild(tempRoot, directory);
          continue;
        }
        if (!["metadata", "format", "heuristic", "user"].includes(inspected.encoding.source)) {
          skipped.encodingChoice += 1;
          encodingChoiceDetails.push({
            archive: candidate.dataset.relativePath,
            archiveMember: candidate.member.member,
            layerIndex: candidate.layerIndex,
            featureCount: candidate.featureCount,
            bytes: familyBytes,
            encoding: {
              source: inspected.encoding.source,
              declaredEncoding: inspected.encoding.declaredEncoding ?? null,
              detectedEncoding: inspected.encoding.detectedEncoding ?? null,
              confidence: inspected.encoding.confidence ?? null,
              warnings: inspected.encoding.warnings ?? [],
            },
          });
          removeOwnedTempChild(tempRoot, directory);
          continue;
        }
        const liveLayer = inspected.layers[candidate.layerIndex];
        if (Number(liveLayer.featureCount) !== candidate.featureCount) {
          skipped.layerMismatch += 1;
          removeOwnedTempChild(tempRoot, directory);
          continue;
        }
        candidatePhase = "attribute-preview";
        const preview = await core.previewGisAttributes(sourcePath, {
          sourceLayer: liveLayer.name,
          sourceEncoding: candidate.sourceEncodingOverride,
          limit: 3,
        });
        if (preview.requiresUserChoice) {
          skipped.encodingChoice += 1;
          removeOwnedTempChild(tempRoot, directory);
          continue;
        }
        const sourceId = sourceIdFor(sourcePath);
        outputCandidates.push({
          relativePath: path.basename(sourcePath),
          sourceRoot: directory,
          extension,
          status: "inspected",
          encoding: inspected.encoding,
          sourceEncodingOverride: candidate.sourceEncodingOverride,
          layers: inspected.layers.map((layer, index) => ({
            name: layer.name,
            featureCount: layer.featureCount,
            fieldCount: layer.fields.length,
          extentSummary: extentSummary(layer.extent),
            status: index === candidate.layerIndex ? "decoded" : "not-selected",
            selected: index === candidate.layerIndex,
          })),
        });
        sourceMetadata.set(sourceId, {
          sourceId,
          archive: candidate.dataset.relativePath,
          member: candidate.member.member,
          archiveLayer: candidate.layer.name,
          importedLayer: liveLayer.name,
          extension,
          featureCount: candidate.featureCount,
          sampleCount: candidate.sampleCount,
          sourceEncoding: inspected.encoding,
          sourceEncodingOverride: candidate.sourceEncodingOverride,
          extractedBytes: familyBytes,
          archiveSha256: expectedArchiveHash,
        });
        acceptedByFormat[extension] += 1;
      } catch (error) {
        skipped.inspectFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        const category = /invalid .*byte|encoding|decode|transcod/i.test(message)
          ? "encoding"
          : /GDAL|OGR|ogrinfo|supported dataset/i.test(message)
            ? "gdal"
            : /feature|preview/i.test(message)
              ? "attribute-preview"
              : error instanceof Error ? error.name : "unknown";
        const errorObject = error && typeof error === "object" ? error : undefined;
        const code = typeof errorObject?.code === "string" || typeof errorObject?.code === "number"
          ? errorObject.code
          : undefined;
        const stderr = typeof errorObject?.stderr === "string"
          ? errorObject.stderr.split(/\r?\n/, 1)[0]
            .replaceAll(root, "<workspace>")
            .replaceAll(candidate.archivePath, "<archive>")
            .replace(/[^\x20-\x7e]/g, "?")
            .slice(0, 180)
          : undefined;
        const safeMessage = candidatePhase.startsWith("archive-") || candidatePhase === "source-inspection"
          ? (candidateDirectory ? message.replaceAll(candidateDirectory, "<extracted>") : message)
            .replaceAll(root, "<workspace>")
            .replaceAll(candidate.archivePath, "<archive>")
            .replace(/[^\x20-\x7e]/g, "?")
            .replace(/\s+/g, " ")
            .slice(0, 240)
          : undefined;
        candidateInspectionFailures.push({ extension: candidate.extension, phase: candidatePhase, category, code, stderr, safeMessage });
        if (candidateDirectory && existsSync(candidateDirectory)) removeOwnedTempChild(tempRoot, candidateDirectory);
        if (error instanceof Error && /Source archive changed/.test(error.message)) throw error;
      }
    }
  }

  assert.ok(
    outputCandidates.length > 0,
    "No archive vector layers with bounded sizes and confirmed encodings were eligible for PostGIS roundtrip: "
      + JSON.stringify({
        candidates: Object.fromEntries([...candidatesByFormat].map(([format, items]) => [format, items.length])),
        acceptedByFormat,
        skipped,
        encodingChoiceDetails,
        candidateInspectionFailures,
      }),
  );
  const sourceManifest = {
    createdAt: new Date().toISOString(),
    candidateCount: outputCandidates.length,
    roots: [...new Set(outputCandidates.map((item) => item.sourceRoot))],
    gdalBin,
    datasets: outputCandidates,
  };
  writeFileSync(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8");
  const batchEnvironment = {
    ...environment,
    DBSTUDIO_LOCAL_GIS_AUDIT_REPORT: sourceManifestPath,
    DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT: batchReportPath,
    DBSTUDIO_LOCAL_GIS_MAX_FEATURES: String(maxFeatures),
    DBSTUDIO_LOCAL_GIS_MAX_BUNDLE_BYTES: String(maxBundleBytes),
    DBSTUDIO_LOCAL_GIS_ROUNDTRIP_CONCURRENCY: String(roundtripConcurrency),
    DBSTUDIO_LOCAL_GIS_PREFLIGHT_CONCURRENCY: "2",
    DBSTUDIO_LOCAL_GIS_VERIFY_TEXT_PREVIEW: "true",
    DBSTUDIO_LOCAL_GIS_VERIFY_GEOMETRY: "true",
    DBSTUDIO_LOCAL_GIS_ENCODING_OVERRIDES_JSON: JSON.stringify(outputCandidates
      .filter((item) => item.sourceEncodingOverride)
      .map((item) => ({
        filePath: path.resolve(item.sourceRoot, item.relativePath),
        encoding: item.sourceEncodingOverride,
      }))),
  };
  const batchResult = await execFileAsync(process.execPath, [batchRunner], {
    cwd: root, env: batchEnvironment, encoding: "utf8", windowsHide: true,
    maxBuffer: 16 * 1024 * 1024, timeout: 45 * 60 * 1000,
  }).catch((error) => error);
  const safeBatchFailure = batchResult instanceof Error ? {
    code: batchResult.code ?? null,
    stderr: typeof batchResult.stderr === "string"
      ? batchResult.stderr.replaceAll(environment.PGPASSWORD, "<redacted>").replaceAll(root, "<workspace>").replaceAll(tempRoot, "<temporary>").slice(0, 1600)
      : null,
    stdout: typeof batchResult.stdout === "string"
      ? batchResult.stdout.replaceAll(environment.PGPASSWORD, "<redacted>").replaceAll(root, "<workspace>").replaceAll(tempRoot, "<temporary>").slice(0, 1600)
      : null,
  } : null;
  assert.ok(existsSync(batchReportPath), `The PostGIS batch runner did not write its report: ${JSON.stringify(safeBatchFailure)}`);
  const report = JSON.parse(readFileSync(batchReportPath, "utf8"));
  for (const entry of report.successfulLayers ?? []) {
    const source = sourceMetadata.get(entry.sourceId);
    if (source) Object.assign(entry, { archive: source.archive, archiveMember: source.member, archiveLayer: source.archiveLayer, importedLayer: source.importedLayer, sampleCount: source.sampleCount, sourceEncoding: source.sourceEncoding, archiveSha256: source.archiveSha256 });
    delete entry.sourceRoot;
    delete entry.relativePath;
  }
  for (const failure of report.failuresByFormatAndPhase ?? []) {
    for (const sourceEntry of failure.sources ?? []) {
      const source = sourceMetadata.get(sourceEntry.sourceId);
      if (source) Object.assign(sourceEntry, { archive: source.archive, archiveMember: source.member, archiveLayer: source.archiveLayer, importedLayer: source.importedLayer, sampleCount: source.sampleCount, archiveSha256: source.archiveSha256 });
    }
  }
  report.archiveSource = {
    reportPath: path.relative(root, archiveReportPath),
    createdAt: sourceReport.createdAt,
    auditedArchiveCount: sourceReport.candidateCount,
    vectorMemberCount: sourceReport.vectorMemberCount,
    decodedLayerCount: sourceReport.decodedLayerCount,
    selectionLimits: {
      maxFeatures, minBundleBytes, maxBundleBytes, maxLayers, perFormatQuota,
      formatFilter: formatFilterInput ?? null,
      memberFilter: memberFilter ?? null,
      sourceEncodingOverride: archiveSourceEncodingOverride ?? null,
    },
    selectedByFormat: acceptedByFormat,
    sources: [...sourceMetadata.values()],
    encodingChoiceDetails,
    skipped,
  };
  report.archiveExtractionCleaned = false;
  removeOwnedTempRoot(tempRoot);
  report.archiveExtractionCleaned = !existsSync(tempRoot);
  report.postgisTemporaryTablesCleaned = report.postgisTemporaryTablesCleaned === true;
  report.exportDirectoryCleaned = report.exportDirectoryCleaned === true;
  report.externalDataSent = false;
  mkdirSync(path.dirname(outputReportPath), { recursive: true });
  writeFileSync(outputReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath: outputReportPath, selectedByFormat: acceptedByFormat, passedLayerCount: report.passedLayerCount, failureCount: report.failureCount, skipped, archiveExtractionCleaned: report.archiveExtractionCleaned, postgisTemporaryTablesCleaned: report.postgisTemporaryTablesCleaned }, null, 2)}\n`);
  assert.ok(!batchResult || !batchResult.code, "PostGIS batch runner failed; inspect the saved report.");
  assert.equal(report.failureCount, 0, "One or more archived GIS layers failed the PostGIS roundtrip; inspect the saved report.");
  assert.equal(report.archiveExtractionCleaned, true, "Temporary archive extraction was not removed.");
} finally {
  if (existsSync(tempRoot)) removeOwnedTempRoot(tempRoot);
}
