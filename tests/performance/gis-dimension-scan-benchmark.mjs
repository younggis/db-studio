import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { GdalService } from "../../packages/gis/dist/index.js";
import { prepareGisInput } from "../../packages/gis/dist/encoding.js";

const featureCount = Number(process.env.GIS_DIMENSION_BENCH_FEATURES ?? 500_000);
const repetitions = Number(process.env.GIS_DIMENSION_BENCH_RUNS ?? 3);
const mode = process.env.GIS_DIMENSION_BENCH_MODE ?? "mixed-features";
const polygonVertexCount = Number(process.env.GIS_DIMENSION_BENCH_VERTICES ?? 250_000);
const gdalBin = process.env.DBSTUDIO_GDAL_BIN;

if (!gdalBin) {
  throw new Error("Set DBSTUDIO_GDAL_BIN to the directory containing ogr2ogr.exe.");
}
if (!Number.isSafeInteger(featureCount) || featureCount < 1) {
  throw new Error("GIS_DIMENSION_BENCH_FEATURES must be a positive safe integer.");
}
if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("GIS_DIMENSION_BENCH_RUNS must be a positive safe integer.");
}
if (!["mixed-features", "single-large-polygon"].includes(mode)) {
  throw new Error("GIS_DIMENSION_BENCH_MODE must be mixed-features or single-large-polygon.");
}
if (!Number.isSafeInteger(polygonVertexCount) || polygonVertexCount < 4) {
  throw new Error("GIS_DIMENSION_BENCH_VERTICES must be an integer of at least 4.");
}

const runtimeEnvironment = {
  ...process.env,
  DBSTUDIO_GDAL_BIN: path.resolve(gdalBin),
  PATH: `${path.resolve(gdalBin)}${path.delimiter}${process.env.PATH ?? ""}`,
};
const service = new GdalService(runtimeEnvironment);
if (typeof service.scanFeatureDimensions !== "function") {
  throw new Error("The built GdalService does not expose its runtime dimension scanner.");
}

async function writeFeatureCollection(filePath, count) {
  const output = createWriteStream(filePath, { encoding: "utf8", flags: "wx" });
  const write = async (chunk) => {
    if (!output.write(chunk)) await once(output, "drain");
  };

  try {
    await write('{"type":"FeatureCollection","name":"dimension_scan_benchmark","features":[\n');
    let featureBatch = [];
    for (let index = 0; index < count; index += 1) {
      const x = (index % 100_000) / 100;
      const y = Math.floor(index / 100_000) / 100;
      const isThreeDimensional = index % 2 === 1;
      const isLine = Math.floor(index / 2) % 2 === 1;
      const coordinates = isLine
        ? isThreeDimensional
          ? `[[${x},${y},10],[${x + 0.01},${y + 0.01},20]]`
          : `[[${x},${y}],[${x + 0.01},${y + 0.01}]]`
        : isThreeDimensional
          ? `[${x},${y},10]`
          : `[${x},${y}]`;
      const geometryType = isLine ? "LineString" : "Point";
      featureBatch.push(`${index === 0 ? "" : ",\n"}{"type":"Feature","properties":{},"geometry":{"type":"${geometryType}","coordinates":${coordinates}}}`);
      if (featureBatch.length === 1_000 || index === count - 1) {
        await write(featureBatch.join(""));
        featureBatch = [];
      }
    }
    await write("\n]}\n");
    output.end();
    await once(output, "close");
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function writeSingleLargePolygon(filePath, vertexCount) {
  const output = createWriteStream(filePath, { encoding: "utf8", flags: "wx" });
  const write = async (chunk) => {
    if (!output.write(chunk)) await once(output, "drain");
  };

  try {
    await write('{"type":"FeatureCollection","name":"dimension_scan_benchmark","features":[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[');
    let coordinateBatch = [];
    for (let index = 0; index < vertexCount; index += 1) {
      const angle = (index / vertexCount) * Math.PI * 2;
      const x = Math.cos(angle) * 10;
      const y = Math.sin(angle) * 10;
      coordinateBatch.push(`${index === 0 ? "" : ","}[${x.toFixed(8)},${y.toFixed(8)},${(index % 1000) / 10}]`);
      if (coordinateBatch.length === 1_000 || index === vertexCount - 1) {
        await write(coordinateBatch.join(""));
        coordinateBatch = [];
      }
    }
    await write(",[10,0,0]]]} }] }\n");
    output.end();
    await once(output, "close");
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-dimension-bench-"));
const inputPath = path.join(temporaryDirectory, `${mode}.geojson`);

try {
  const expectedRows = mode === "single-large-polygon" ? 1 : featureCount;
  if (mode === "single-large-polygon") {
    await writeSingleLargePolygon(inputPath, polygonVertexCount);
  } else {
    await writeFeatureCollection(inputPath, featureCount);
  }
  const elapsedMs = [];
  let finalScan;

  for (let run = 0; run < repetitions; run += 1) {
    const prepared = await prepareGisInput(inputPath, undefined, runtimeEnvironment);
    let newlineCount = 0;
    const runOgr2Ogr = service.runOgr2Ogr.bind(service);
    service.runOgr2Ogr = async (args, options, env, onStdout) => runOgr2Ogr(
      args,
      options,
      env,
      (chunk) => {
        newlineCount += chunk.match(/\n/g)?.length ?? 0;
        onStdout?.(chunk);
      },
    );

    const startedAt = performance.now();
    try {
      finalScan = await service.scanFeatureDimensions(prepared, "dimension_scan_benchmark", undefined, {});
    } finally {
      elapsedMs.push(performance.now() - startedAt);
      service.runOgr2Ogr = runOgr2Ogr;
      await prepared.cleanup();
    }

    const observedRows = newlineCount - 1;
    if (observedRows !== expectedRows) {
      throw new Error(`Run ${run + 1} scanned ${observedRows} rows; expected ${expectedRows}.`);
    }
    const validScan = mode === "single-large-polygon"
      ? !finalScan.mixed && finalScan.hasZ && !finalScan.hasMissingZ && finalScan.targetSuffix === "Z"
      : finalScan.mixed && finalScan.hasZ && finalScan.hasMissingZ && finalScan.targetSuffix === "Z";
    if (!validScan) {
      throw new Error(`Unexpected dimension scan result: ${JSON.stringify(finalScan)}`);
    }
  }

  console.log(JSON.stringify({
    runtime: service.runtimeStatus(),
    mode,
    expectedFeatureCount: expectedRows,
    polygonVertexCount: mode === "single-large-polygon" ? polygonVertexCount : undefined,
    repetitions,
    observedSignatures: [...finalScan.signatures],
    hasZ: finalScan.hasZ,
    hasMissingZ: finalScan.hasMissingZ,
    targetSuffix: finalScan.targetSuffix,
    elapsedMs: elapsedMs.map((value) => Math.round(value)),
    medianMs: Math.round(median(elapsedMs)),
    inputBytes: (await stat(inputPath)).size,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
