import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gdalBin = process.env.DBSTUDIO_GDAL_BIN
  || path.join(root, ".cache", "gdal-static-candidate-20261103-liblzma-5.8.4", "bin");
const ogrinfo = path.join(gdalBin, process.platform === "win32" ? "ogrinfo.exe" : "ogrinfo");
const ogr2ogr = path.join(gdalBin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr");
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["F:\\GeoData", "F:\\temp"];
const reportPath = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_REPORT
  || path.join(root, ".cache", "local-gis-archive-audit-latest.json");
const archiveFilter = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_FILTER?.trim().toLocaleLowerCase();
const archiveOffset = Number(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_OFFSET ?? 0);
const archiveLimitValue = process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_LIMIT;
const archiveLimit = archiveLimitValue === undefined ? undefined : Number(archiveLimitValue);
const maxFallbackBytes = Number(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_MAX_EXTRACT_BYTES ?? (1024 * 1024 * 1024));
const toolTimeoutMs = Number(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_TOOL_TIMEOUT_MS ?? 120_000);
const fallbackExtractTimeoutMs = Number(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_FALLBACK_EXTRACT_TIMEOUT_MS ?? 300_000);
const archiveListTimeoutMs = Number(process.env.DBSTUDIO_LOCAL_GIS_ARCHIVE_LIST_TIMEOUT_MS ?? 120_000);
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const vectorExtensions = new Set([
  ".shp", ".geojson", ".geojsonl", ".json", ".kml", ".kmz", ".tab", ".mif", ".gpkg", ".gml", ".gpx",
  ".fgb", ".sqlite", ".db", ".dxf", ".csv", ".vrt", ".osm", ".pbf", ".parquet",
]);
assert.ok(gdalBin && (await readdir(gdalBin)).length, "GDAL/OGR binaries are unavailable.");
assert.ok(Number.isSafeInteger(maxFallbackBytes) && maxFallbackBytes > 0, "DBSTUDIO_LOCAL_GIS_ARCHIVE_MAX_EXTRACT_BYTES must be a positive safe integer.");
assert.ok(Number.isSafeInteger(archiveOffset) && archiveOffset >= 0, "DBSTUDIO_LOCAL_GIS_ARCHIVE_OFFSET must be a non-negative safe integer.");
assert.ok(archiveLimit === undefined || Number.isSafeInteger(archiveLimit) && archiveLimit > 0, "DBSTUDIO_LOCAL_GIS_ARCHIVE_LIMIT must be a positive safe integer when set.");
assert.ok(Number.isSafeInteger(toolTimeoutMs) && toolTimeoutMs >= 1_000 && toolTimeoutMs <= 120_000, "DBSTUDIO_LOCAL_GIS_ARCHIVE_TOOL_TIMEOUT_MS must be between 1000 and 120000.");
assert.ok(Number.isSafeInteger(fallbackExtractTimeoutMs) && fallbackExtractTimeoutMs >= 1_000 && fallbackExtractTimeoutMs <= 300_000, "DBSTUDIO_LOCAL_GIS_ARCHIVE_FALLBACK_EXTRACT_TIMEOUT_MS must be between 1000 and 300000.");
assert.ok(Number.isSafeInteger(archiveListTimeoutMs) && archiveListTimeoutMs >= 1_000 && archiveListTimeoutMs <= 120_000, "DBSTUDIO_LOCAL_GIS_ARCHIVE_LIST_TIMEOUT_MS must be between 1000 and 120000.");

async function listArchives(directory, output = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return output; }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase().endsWith(".gdb")) output.push({ absolutePath, kind: "directory", extension: ".gdb" });
      else await listArchives(absolutePath, output);
    } else if (path.extname(entry.name).toLowerCase() === ".zip") {
      output.push({ absolutePath, kind: "archive", extension: ".zip" });
    }
  }
  return output;
}

async function run(executable, args) {
  return execFileAsync(executable, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: toolTimeoutMs });
}

async function listZipMembers(zipPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($env:DBSTUDIO_ARCHIVE_PATH)",
    "try {",
    "  $members = [System.Collections.Generic.List[object]]::new()",
    "  for ($i = 0; $i -lt $archive.Entries.Count; $i++) { $entry = $archive.Entries[$i]; $members.Add([pscustomobject]@{ index = [int]$i; fullName = $entry.FullName; length = [int64]$entry.Length; isDirectory = $entry.FullName.EndsWith('/') }) }",
    "  ConvertTo-Json -InputObject @($members.ToArray()) -Compress -Depth 3",
    "} finally { $archive.Dispose() }",
  ].join("\n");
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: archiveListTimeoutMs,
    env: { ...process.env, DBSTUDIO_ARCHIVE_PATH: zipPath },
  });
  const value = JSON.parse(stdout);
  const values = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return values.filter((item) => item && typeof item.fullName === "string").map((item) => ({
    name: item.fullName,
    index: Number(item.index),
    size: Number(item.length ?? 0),
    isDirectory: Boolean(item.isDirectory),
  }));
}

function safeArchiveMember(value, isDirectory = false) {
  let normalized = value.replaceAll("\\", "/");
  if (isDirectory && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) return undefined;
  return segments.join("/");
}

function processError(error, limit = 800) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim().slice(0, limit);
  }
  if (error && typeof error === "object" && error instanceof Error) {
    const details = [
      error.message,
      `properties=${Object.getOwnPropertyNames(error).join(",")}`,
      "code" in error ? `code=${String(error.code)}` : undefined,
      "errno" in error ? `errno=${String(error.errno)}` : undefined,
      "syscall" in error ? `syscall=${String(error.syscall)}` : undefined,
      "path" in error ? `path=${String(error.path)}` : undefined,
      "spawnfile" in error ? `spawnfile=${String(error.spawnfile)}` : undefined,
      "spawnargs" in error && Array.isArray(error.spawnargs)
        ? `spawnargs=${JSON.stringify({ count: error.spawnargs.length, prefix: error.spawnargs.slice(0, 3), finalArgumentLength: String(error.spawnargs.at(-1) ?? "").length })}`
        : undefined,
    ].filter(Boolean).join("; ");
    return details.slice(0, limit);
  }
  return String(error).slice(0, limit);
}

function fallbackFamily(member, records) {
  const normalized = safeArchiveMember(member);
  if (!normalized) return [];
  const lower = normalized.toLocaleLowerCase();
  if (lower.endsWith(".gdb")) {
    const prefix = lower + "/";
    return uniqueFallbackMembers(records.filter((record) => !record.isDirectory && record.normalized.toLocaleLowerCase().startsWith(prefix)));
  }

  const extension = path.posix.extname(normalized).toLowerCase();
  const sidecars = extension === ".tab"
    ? new Set([".tab", ".dat", ".map", ".id", ".ind"])
    : extension === ".mif"
      ? new Set([".mif", ".mid"])
      : extension === ".shp"
        ? new Set([".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix", ".sbn", ".sbx"])
        : undefined;
  if (!sidecars) return uniqueFallbackMembers(records.filter((record) => record.normalized.toLocaleLowerCase() === normalized.toLocaleLowerCase() && !record.isDirectory).slice(0, 1));

  const directory = path.posix.dirname(normalized);
  const stem = path.posix.basename(normalized).slice(0, -extension.length).toLocaleLowerCase();
  return uniqueFallbackMembers(records.filter((record) => {
    if (record.isDirectory) return false;
    const candidate = record.normalized;
    if (path.posix.dirname(candidate).toLocaleLowerCase() !== directory.toLocaleLowerCase()) return false;
    const candidateExtension = path.posix.extname(candidate).toLowerCase();
    const candidateStem = path.posix.basename(candidate).slice(0, -candidateExtension.length).toLocaleLowerCase();
    return candidateStem === stem && sidecars.has(candidateExtension)
      || extension === ".shp" && candidate.toLocaleLowerCase() === (normalized + ".xml").toLocaleLowerCase();
  }));
}

function uniqueFallbackMembers(records) {
  const unique = new Map();
  for (const record of records) unique.set(record.normalized.toLocaleLowerCase(), record);
  return [...unique.values()];
}

async function looksLikeVectorJson(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    if (/"type"\s*:\s*"(?:FeatureCollection|Feature)"/i.test(prefix)) return true;
    return /"features"\s*:\s*\[/i.test(prefix) && /"(?:geometryType|spatialReference)"\s*:/i.test(prefix);
  } finally {
    await handle.close();
  }
}

async function extractZipMembers(zipPath, destination, records) {
  const manifestPath = path.join(destination, `.dbstudio-zip-members-${randomUUID()}.json`);
  await writeFile(manifestPath, JSON.stringify(records.map((record) => ({ index: record.index, relativePath: record.normalized, size: record.size }))), "utf8");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($env:DBSTUDIO_ARCHIVE_PATH)",
    "try {",
    "  $items = [IO.File]::ReadAllText($env:DBSTUDIO_ARCHIVE_MANIFEST, [Text.Encoding]::UTF8) | ConvertFrom-Json",
    "  $root = [IO.Path]::GetFullPath($env:DBSTUDIO_ARCHIVE_DEST).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "  foreach ($item in @($items)) {",
    "    $relative = [string]$item.relativePath",
    "    if ([string]::IsNullOrEmpty($relative)) { throw 'Unsafe ZIP member path.' }",
    "    $entry = $archive.Entries[[int]$item.index]",
    "    if ($null -eq $entry -or $entry.Length -ne [int64]$item.size) { throw 'ZIP member missing or size changed.' }",
    "    $target = [IO.Path]::GetFullPath((Join-Path $root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))",
    "    if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP member escaped extraction root.' }",
    "    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null",
    "    $inputStream = $entry.Open()",
    "    try { $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() } } finally { $inputStream.Dispose() }",
    "  }",
    "} finally { $archive.Dispose() }",
  ].join("\n");
  try {
    await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: fallbackExtractTimeoutMs,
      env: { ...process.env, DBSTUDIO_ARCHIVE_PATH: zipPath, DBSTUDIO_ARCHIVE_DEST: destination, DBSTUDIO_ARCHIVE_MANIFEST: manifestPath },
    });
  } finally {
    await rm(manifestPath, { force: true });
  }
}

async function inspectVectorSource(source) {
  const inspected = await run(ogrinfo, ["-json", "-ro", "-so", "-al", source]);
  const info = JSON.parse(inspected.stdout);
  const layers = [];
  for (const layer of Array.isArray(info.layers) ? info.layers : []) {
    try {
      const preview = await run(ogr2ogr, ["-f", "GeoJSON", "/vsistdout/", "-limit", "3", source, String(layer.name)]);
      const value = JSON.parse(preview.stdout);
      layers.push({
        name: String(layer.name),
        featureCount: Number(layer.featureCount ?? 0),
        fieldCount: Array.isArray(layer.fields) ? layer.fields.length : 0,
        sampleCount: Array.isArray(value.features) ? value.features.length : 0,
        status: "decoded",
      });
    } catch (error) {
      layers.push({ name: String(layer.name), status: "preview-failed", error: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400) });
    }
  }
  return { driver: info.driverShortName ?? "Unknown", layers };
}

async function mapLimit(items, limit, callback, onComplete = () => {}) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
      onComplete(index + 1);
    }
  }));
  return results;
}

const candidates = [];
for (const rootPath of roots) {
  const resolvedRoot = path.resolve(rootPath);
  for (const candidate of await listArchives(resolvedRoot)) {
    candidates.push({ ...candidate, root: resolvedRoot });
  }
}
const selectedCandidates = archiveFilter
  ? candidates.filter((candidate) => candidate.absolutePath.toLocaleLowerCase().includes(archiveFilter))
  : candidates;
const auditCandidates = archiveLimit === undefined
  ? selectedCandidates.slice(archiveOffset)
  : selectedCandidates.slice(archiveOffset, archiveOffset + archiveLimit);
assert.ok(selectedCandidates.length > 0, archiveFilter ? "No ZIP archives matched DBSTUDIO_LOCAL_GIS_ARCHIVE_FILTER." : "No ZIP or FileGDB candidates were found.");
assert.ok(auditCandidates.length > 0, "No archives matched the requested DBSTUDIO_LOCAL_GIS_ARCHIVE_OFFSET/LIMIT batch.");

let completedArchives = 0;
const datasets = await mapLimit(auditCandidates, 3, async (candidate, batchIndex) => {
  const relativePath = path.relative(candidate.root, candidate.absolutePath);
  process.stderr.write(`Local GIS ZIP audit: inspecting ${archiveOffset + batchIndex + 1}/${selectedCandidates.length} ${relativePath}\n`);
  let members = [];
  try { members = await listZipMembers(candidate.absolutePath); }
  catch (error) {
    return { relativePath, extension: candidate.extension, status: "archive-list-failed", error: error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600) };
  }
  const records = [];
  const sources = new Set();
  for (const item of members) {
    const normalized = safeArchiveMember(item.name, item.isDirectory);
    if (!normalized) continue;
    records.push({ ...item, normalized });
    if (item.isDirectory) continue;
    if (/^__MACOSX\//i.test(normalized) || path.posix.basename(normalized).startsWith("._")) continue;
    const extension = path.posix.extname(normalized).toLowerCase();
    if (vectorExtensions.has(extension)) sources.add(normalized);
    const gdb = normalized.match(/(?:^|\/)([^/]+\.gdb)(?:\/|$)/i);
    if (gdb) sources.add(normalized.slice(0, normalized.toLowerCase().indexOf(".gdb") + 4));
  }
  if (!sources.size) return { relativePath, extension: candidate.extension, status: "no-vector-members", memberCount: members.length, layers: [] };
  const inspectedSources = [];
  const extracted = new Set();
  let tempDirectory;
  try {
    for (const member of sources) {
      const source = "/vsizip/" + candidate.absolutePath.replaceAll("\\", "/") + "/" + member;
      try {
        const inspected = await inspectVectorSource(source);
        inspectedSources.push({ member, accessMethod: "vsizip", status: inspected.layers.length ? "inspected" : "opened-no-vector-layers", driver: inspected.driver, layers: inspected.layers });
      } catch (directError) {
        const family = fallbackFamily(member, records);
        if (!family.length) {
          inspectedSources.push({ member, accessMethod: "extracted-fallback", status: "fallback-extract-failed", directError: directError instanceof Error ? directError.message.slice(0, 600) : String(directError).slice(0, 600), error: "No safe archive members were selected for fallback extraction." });
          continue;
        }
        const uncompressedBytes = family.reduce((sum, item) => sum + item.size, 0);
        if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > maxFallbackBytes) {
          inspectedSources.push({ member, accessMethod: "extracted-fallback", status: "fallback-size-limit", uncompressedBytes, maxFallbackBytes, directError: directError instanceof Error ? directError.message.slice(0, 600) : String(directError).slice(0, 600) });
          continue;
        }

        if (!tempDirectory) {
          const cacheDirectory = path.join(root, ".cache");
          await mkdir(cacheDirectory, { recursive: true });
          tempDirectory = await mkdtemp(path.join(cacheDirectory, "local-gis-zip-fallback-"));
        }
        try {
          const missing = family.filter((item) => !extracted.has(item.normalized.toLocaleLowerCase()));
          if (missing.length) {
            await extractZipMembers(candidate.absolutePath, tempDirectory, missing);
            for (const item of missing) extracted.add(item.normalized.toLocaleLowerCase());
          }
        } catch (error) {
          inspectedSources.push({ member, accessMethod: "extracted-fallback", status: "fallback-extract-failed", directError: processError(directError, 600), error: processError(error) });
          continue;
        }

        try {
          const extractedSource = path.join(tempDirectory, ...member.split("/"));
          if (path.posix.extname(member).toLowerCase() === ".json" && !(await looksLikeVectorJson(extractedSource))) {
            inspectedSources.push({ member, accessMethod: "extracted-fallback", status: "non-vector-json", directError: processError(directError, 600) });
            continue;
          }
          const inspected = await inspectVectorSource(extractedSource);
          inspectedSources.push({ member, accessMethod: "extracted-fallback", status: inspected.layers.length ? "inspected" : "opened-no-vector-layers", driver: inspected.driver, layers: inspected.layers, directError: directError instanceof Error ? directError.message.slice(0, 600) : String(directError).slice(0, 600), extractedBytes: family.reduce((sum, item) => sum + item.size, 0) });
        } catch (error) {
          inspectedSources.push({ member, accessMethod: "extracted-fallback", status: "fallback-inspect-failed", directError: directError instanceof Error ? directError.message.slice(0, 600) : String(directError).slice(0, 600), error: error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600) });
        }
      }
    }
  } finally {
    if (tempDirectory) {
      const cacheRoot = path.resolve(root, ".cache") + path.sep;
      const resolvedTempDirectory = path.resolve(tempDirectory);
      if (!resolvedTempDirectory.startsWith(cacheRoot)) throw new Error("Refusing to clean a ZIP fallback path outside the project cache.");
      await rm(resolvedTempDirectory, { recursive: true, force: true });
    }
  }
  return { relativePath, extension: candidate.extension, status: "members-inspected", memberCount: members.length, vectorMemberCount: inspectedSources.length, members: inspectedSources };
}, () => {
  completedArchives += 1;
  if (completedArchives % 5 === 0 || completedArchives === auditCandidates.length) {
    process.stderr.write("Local GIS ZIP audit: " + completedArchives + "/" + auditCandidates.length + " archives completed.\n");
  }
});

const statusCounts = {};
const memberStatusCounts = {};
let vectorMemberCount = 0;
let nonVectorJsonCount = 0;
let decodedLayerCount = 0;
for (const item of datasets) {
  statusCounts[item.extension + " " + item.status] = (statusCounts[item.extension + " " + item.status] ?? 0) + 1;
  for (const member of item.members ?? []) {
    vectorMemberCount += 1;
    memberStatusCounts[member.status] = (memberStatusCounts[member.status] ?? 0) + 1;
    if (member.status === "non-vector-json") nonVectorJsonCount += 1;
    decodedLayerCount += (member.layers ?? []).filter((layer) => layer.status === "decoded").length;
  }
}
const spatialCandidateCount = vectorMemberCount - nonVectorJsonCount;
const report = {
  createdAt: new Date().toISOString(),
  candidateCount: auditCandidates.length,
  candidateTotal: selectedCandidates.length,
  archiveFilter: archiveFilter ?? null,
  archiveOffset,
  archiveLimit: archiveLimit ?? null,
  maxFallbackBytes,
  toolTimeoutMs,
  fallbackExtractTimeoutMs,
  archiveListTimeoutMs,
  vectorMemberCount,
  nonVectorJsonCount,
  spatialCandidateCount,
  decodedLayerCount,
  memberStatusCounts,
  roots: roots.map((item) => path.resolve(item)),
  statusCounts,
  datasets,
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ candidateCount: report.candidateCount, vectorMemberCount, nonVectorJsonCount, spatialCandidateCount, decodedLayerCount, memberStatusCounts, statusCounts, reportPath }, null, 2) + "\n");
