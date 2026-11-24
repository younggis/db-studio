import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const features = Number(process.env.DBSTUDIO_GDAL_IMPORT_BENCH_FEATURES ?? 100_000);
const repetitions = Number(process.env.DBSTUDIO_GDAL_IMPORT_BENCH_REPETITIONS ?? 3);
assert.ok(Number.isSafeInteger(features) && features >= 1 && features <= 1_000_000,
  "DBSTUDIO_GDAL_IMPORT_BENCH_FEATURES must be from 1 to 1,000,000.");
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10,
  "DBSTUDIO_GDAL_IMPORT_BENCH_REPETITIONS must be from 1 to 10.");

function runtime(label, envName, fallback) {
  const value = process.env[envName] ?? path.join(root, fallback);
  const bin = path.resolve(value);
  return { label, bin };
}

const runtimes = [
  runtime("packaged-qgis", "DBSTUDIO_GDAL_BENCH_BASELINE", "apps/desktop/resources/gdal/bin"),
  runtime("static-vcpkg", "DBSTUDIO_GDAL_BENCH_CANDIDATE", ".cache/gdal-static-candidate-20261103-liblzma-5.8.4/bin"),
];
const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  assert.ok(value, `Set ${name} before running this benchmark.`);
  return value;
};
const connection = {
  host: required("DBSTUDIO_TRANSFER_PG_HOST", "127.0.0.1"),
  port: Number(required("DBSTUDIO_TRANSFER_PG_PORT", "25432")),
  database: required("DBSTUDIO_TRANSFER_PG_DATABASE"),
  user: required("DBSTUDIO_TRANSFER_PG_USER"),
  password: required("DBSTUDIO_TRANSFER_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
};
assert.ok(Number.isSafeInteger(connection.port) && connection.port > 0 && connection.port <= 65_535,
  "DBSTUDIO_TRANSFER_PG_PORT must be a valid TCP port.");

async function write(stream, text) {
  if (!stream.write(text)) await once(stream, "drain");
}

async function createGeoJson(outputPath) {
  const stream = createWriteStream(outputPath, { encoding: "utf8", flags: "wx" });
  const finished = once(stream, "finish");
  await write(stream, '{"type":"FeatureCollection","name":"synthetic_import_benchmark","features":[\n');
  for (let id = 1; id <= features; id += 1) {
    if (id > 1) await write(stream, ",\n");
    const longitude = 110 + ((id * 37) % 12_000_000) / 1_000_000;
    const latitude = 20 + ((id * 71) % 20_000_000) / 1_000_000;
    await write(stream, JSON.stringify({
      type: "Feature",
      properties: { id, label: `feature-${id}`, score: (id % 100_000) / 100 },
      geometry: { type: "Point", coordinates: [longitude, latitude] },
    }));
  }
  await write(stream, "]}\n");
  stream.end();
  await finished;
}

const workDirectory = await mkdtemp(path.join(root, ".cache", "gdal-postgis-import-benchmark-"));
const input = path.join(workDirectory, "synthetic.geojson");
const reportPath = path.resolve(process.env.DBSTUDIO_GDAL_IMPORT_BENCH_REPORT
  ?? path.join(root, ".cache", `gdal-postgis-import-benchmark-${features}-${new Date().toISOString().slice(0, 10)}.json`));
const report = {
  featureCount: features,
  repetitions,
  inputBytes: 0,
  operation: "CoreService.inspect + GDAL GeoJSON EPSG:4326 -> PostGIS EPSG:4326 import",
  results: runtimes.map(({ label, bin }) => ({ runtime: label, gdalBin: bin, runsMs: [] })),
};

try {
  await mkdir(path.dirname(input), { recursive: true });
  await createGeoJson(input);
  report.inputBytes = (await stat(input)).size;

  const resultsByRuntime = new Map(report.results.map((result) => [result.runtime, result]));
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const orderedRuntimes = repetition % 2 === 0 ? runtimes : [...runtimes].reverse();
    for (const runtimeConfig of orderedRuntimes) {
      const table = `gis_perf_${randomBytes(5).toString("hex")}`;
      process.env.DBSTUDIO_GDAL_BIN = runtimeConfig.bin;
      const service = CoreService.fromPostgresConfig(connection);
      const started = performance.now();
      let failure;
      try {
        const operation = await service.importGisToPostgres(input, `public.${table}`, {
          mode: "create",
          sourceEncoding: "UTF-8",
        });
        const durationMs = Math.round(performance.now() - started);
        const check = await service.query(`SELECT count(*)::bigint AS count FROM public."${table}"`);
        const sample = await service.query(`SELECT id, label, score, ST_SRID(wkb_geometry) AS srid FROM public."${table}" ORDER BY id LIMIT 1`);
        assert.equal(Number(check.rows[0]?.count), features, `${runtimeConfig.label}: imported count`);
        assert.deepEqual(sample.rows[0], { id: 1, label: "feature-1", score: 0.01, srid: 4326 },
          `${runtimeConfig.label}: imported sample`);
        const result = resultsByRuntime.get(runtimeConfig.label);
        result.runsMs.push(durationMs);
        result.reportedFeatures = operation.successfulFeatures;
        result.verifiedRows = Number(check.rows[0].count);
        result.sampleValuesVerified = true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          await service.query(`DROP TABLE IF EXISTS public."${table}"`);
        } catch (cleanupError) {
          if (!failure) throw cleanupError;
        }
      }
    }
  }

  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  for (const result of report.results) {
    result.medianMs = median(result.runsMs);
    result.rangeMs = [Math.min(...result.runsMs), Math.max(...result.runsMs)];
  }
  const [baseline, candidate] = report.results;
  if (baseline && candidate) report.candidateToBaselineMedianRatio = Number((candidate.medianMs / baseline.medianMs).toFixed(3));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
