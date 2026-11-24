import assert from "node:assert/strict";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselineBin = path.resolve(process.env.DBSTUDIO_GDAL_BENCH_BASELINE ?? path.join(root, "apps/desktop/resources/gdal/bin"));
const candidateBin = path.resolve(process.env.DBSTUDIO_GDAL_BENCH_CANDIDATE ?? path.join(root, ".cache/gdal-static-candidate-20261101/bin"));
const featureCount = Number.parseInt(process.env.DBSTUDIO_GDAL_BENCH_FEATURES ?? "100000", 10);
const repetitions = Number.parseInt(process.env.DBSTUDIO_GDAL_BENCH_REPETITIONS ?? "3", 10);
const artifactRoot = path.resolve(root, ".cache/gdal-runtime-benchmark");

assert(Number.isInteger(featureCount) && featureCount > 0, "DBSTUDIO_GDAL_BENCH_FEATURES must be a positive integer.");
assert(Number.isInteger(repetitions) && repetitions >= 3, "DBSTUDIO_GDAL_BENCH_REPETITIONS must be at least 3.");

function runtime(name, bin) {
  const files = Object.fromEntries(["ogr2ogr", "ogrinfo", "gdalinfo"].map((tool) => [
    tool,
    path.join(bin, `${tool}.exe`),
  ]));
  for (const [tool, file] of Object.entries(files)) {
    assert(requireFile(file), `${name}: missing ${tool}.exe under ${bin}`);
  }

  const runtimeRoot = path.dirname(bin);
  const projData = path.join(runtimeRoot, "proj");
  return {
    name,
    bin,
    files,
    version: run(files.gdalinfo, ["--version"], runtimeEnvironment(bin, runtimeRoot, projData)).stdout.trim(),
    environment: runtimeEnvironment(bin, runtimeRoot, projData),
  };
}

function requireFile(file) {
  try {
    return Boolean(existsSync(file) && statSync(file).isFile());
  } catch {
    return false;
  }
}

function runtimeEnvironment(bin, runtimeRoot, projData) {
  const environment = {
    ...process.env,
    DBSTUDIO_GDAL_BIN: bin,
    PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
    GDAL_DATA: path.join(runtimeRoot, "data"),
    PROJ_DATA: projData,
    PROJ_LIB: projData,
  };
  return environment;
}

function run(executable, args, env) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(-6000);
    throw new Error(`${path.basename(executable)} exited ${result.status}${detail ? `:\n${detail}` : "."}`);
  }
  return result;
}

async function writeInput(file) {
  const stream = createWriteStream(file, { encoding: "utf8" });
  const write = async (value) => {
    if (!stream.write(value)) await once(stream, "drain");
  };

  await write('{"type":"FeatureCollection","name":"runtime_benchmark","features":[');
  for (let index = 0; index < featureCount; index += 1) {
    const feature = {
      type: "Feature",
      id: index,
      geometry: { type: "Point", coordinates: [-120 + (index % 60000) / 1000, 25 + Math.floor(index / 60000) / 1000] },
      properties: { id: index, label: `样本-${index}`, score: index / 10 },
    };
    await write(`${index ? "," : ""}${JSON.stringify(feature)}`);
  }
  await write("]}");
  stream.end();
  await once(stream, "close");
}

function assertFeatureCount(runtimeInfo, file) {
  const output = run(runtimeInfo.files.ogrinfo, ["-ro", "-so", "-al", file], runtimeInfo.environment);
  assert((output.stdout + output.stderr).includes(`Feature Count: ${featureCount}`), `${runtimeInfo.name} output feature count mismatch.`);
}

const runtimes = [runtime("packaged-qgis", baselineBin), runtime("static-vcpkg", candidateBin)];
await mkdir(artifactRoot, { recursive: true });
const resolvedArtifactRoot = path.resolve(artifactRoot) + path.sep;
const workDir = await mkdtemp(path.join(artifactRoot, "run-"));
const resolvedWorkDir = path.resolve(workDir);
assert(resolvedWorkDir.startsWith(resolvedArtifactRoot), "Benchmark cleanup target must remain inside .cache/gdal-runtime-benchmark.");

try {
  const input = path.join(workDir, "points.geojson");
  await writeInput(input);

  const measurements = Object.fromEntries(runtimes.map((item) => [item.name, { importMs: [], exportMs: [] }]));
  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    const ordered = iteration % 2 === 0 ? runtimes : [...runtimes].reverse();
    for (const item of ordered) {
      const stem = `${item.name}-${iteration}`;
      const gpkg = path.join(workDir, `${stem}.gpkg`);
      const geojson = path.join(workDir, `${stem}-export.geojson`);

      let started = performance.now();
      run(item.files.ogr2ogr, ["-f", "GPKG", gpkg, input, "-nln", "benchmark", "-t_srs", "EPSG:3857", "-overwrite", "-lco", "SPATIAL_INDEX=NO"], item.environment);
      measurements[item.name].importMs.push(performance.now() - started);

      assertFeatureCount(item, gpkg);
      started = performance.now();
      run(item.files.ogr2ogr, ["-f", "GeoJSON", geojson, gpkg, "benchmark", "-t_srs", "EPSG:4326", "-lco", "RFC7946=YES"], item.environment);
      measurements[item.name].exportMs.push(performance.now() - started);
      assertFeatureCount(item, geojson);
    }
  }

  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(runtimes.map((item) => {
    const values = measurements[item.name];
    return [item.name, {
      version: item.version,
      bin: item.bin,
      importMedianMs: Math.round(median(values.importMs)),
      importRunsMs: values.importMs.map(Math.round),
      exportMedianMs: Math.round(median(values.exportMs)),
      exportRunsMs: values.exportMs.map(Math.round),
    }];
  }));

  const baseline = summary["packaged-qgis"];
  const candidate = summary["static-vcpkg"];
  console.log(JSON.stringify({
    featureCount,
    repetitions,
    inputBytes: (await stat(input)).size,
    operations: "GeoJSON EPSG:4326 -> GeoPackage EPSG:3857 -> RFC 7946 GeoJSON EPSG:4326",
    runtimes: summary,
    candidateToBaselineRatio: {
      import: Number((candidate.importMedianMs / baseline.importMedianMs).toFixed(3)),
      export: Number((candidate.exportMedianMs / baseline.exportMedianMs).toFixed(3)),
    },
  }, null, 2));
} finally {
  if (!resolvedWorkDir.startsWith(resolvedArtifactRoot)) throw new Error("Refusing to clean a benchmark directory outside the designated .cache path.");
  await rm(resolvedWorkDir, { recursive: true, force: true });
}
