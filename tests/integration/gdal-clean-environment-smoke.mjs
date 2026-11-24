import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = path.resolve(process.env.DBSTUDIO_GDAL_RUNTIME_ROOT
  || path.join(root, "apps", "desktop", "release-static-gdal", "win-unpacked", "resources", "gdal"));
const bin = path.join(runtimeRoot, "bin");
const executable = (name) => path.join(bin, process.platform === "win32" ? `${name}.exe` : name);
const gdalinfo = executable("gdalinfo");
const ogrinfo = executable("ogrinfo");
const ogr2ogr = executable("ogr2ogr");

assert.equal(process.platform, "win32", "This smoke verifies the bundled Windows GDAL runtime.");
const systemRoot = process.env.SystemRoot || process.env.WINDIR;
assert.ok(systemRoot, "Windows SystemRoot is unavailable.");
const system32 = path.join(systemRoot, "System32");
const cacheRoot = path.resolve(root, ".cache");
const tempRoot = path.join(cacheRoot, `gdal-clean-env-${Date.now()}-${process.pid}`);
const gdalData = [path.join(runtimeRoot, "data"), path.join(runtimeRoot, "share", "gdal")]
  .find((candidate) => candidate && requireFile(candidate, ["gdalvrt.xsd", "GDALLogoBW.svg"]));
const projData = [path.join(runtimeRoot, "proj"), path.join(runtimeRoot, "share", "proj")]
  .find((candidate) => requireFile(candidate, ["proj.db"]));
assert.ok(gdalData, "Bundled GDAL data directory is missing.");
assert.ok(projData, "Bundled PROJ database is missing.");

const environment = {
  SystemRoot: systemRoot,
  WINDIR: systemRoot,
  PATH: [bin, system32].join(path.delimiter),
  TEMP: tempRoot,
  TMP: tempRoot,
  GDAL_DATA: gdalData,
  PROJ_DATA: projData,
  PROJ_LIB: projData,
  PROJ_NETWORK: "OFF",
};
const run = async (file, args) => execFileAsync(file, args, {
  cwd: tempRoot,
  env: environment,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
  timeout: 120_000,
});

await mkdir(tempRoot, { recursive: false });
let verification;
try {
  const input = path.join(tempRoot, "input.geojson");
  const projected = path.join(tempRoot, "projected.gpkg");
  const roundtrip = path.join(tempRoot, "roundtrip.geojson");
  const sourceFeature = {
    type: "Feature",
    properties: { name: "隔离运行时测试" },
    geometry: { type: "Point", coordinates: [1, 1] },
  };
  await writeFile(input, JSON.stringify({ type: "FeatureCollection", features: [sourceFeature] }), "utf8");

  const { stdout: version } = await run(gdalinfo, ["--version"]);
  assert.match(version, /GDAL 3\./);
  const { stdout: formats } = await run(ogrinfo, ["--formats"]);
  for (const driver of ["ESRI Shapefile", "GeoJSON", "KML", "MapInfo File", "GPKG"]) {
    assert.ok(formats.includes(driver), `The bundled OGR runtime is missing the ${driver} driver.`);
  }

  await run(ogr2ogr, ["-f", "GPKG", "-t_srs", "EPSG:3857", "-nln", "clean_env_points", projected, input]);
  const { stdout: inspection } = await run(ogrinfo, ["-json", "-ro", "-so", "-al", projected]);
  const dataset = JSON.parse(inspection);
  assert.equal(dataset.layers?.length, 1);
  const layer = dataset.layers[0];
  const targetCrs = layer.geometryFields?.[0]?.coordinateSystem?.projjson?.id;
  assert.equal(Number(layer.featureCount), 1);
  assert.equal(targetCrs?.authority, "EPSG");
  assert.equal(Number(targetCrs?.code), 3857);
  assert.ok(Number(layer.geometryFields?.[0]?.extent?.[0]) > 100_000, "PROJ did not transform the synthetic easting.");
  assert.ok(Number(layer.geometryFields?.[0]?.extent?.[1]) > 100_000, "PROJ did not transform the synthetic northing.");

  await run(ogr2ogr, ["-f", "GeoJSON", "-t_srs", "EPSG:4326", roundtrip, projected]);
  const output = JSON.parse(await readFile(roundtrip, "utf8"));
  assert.equal(output.features?.length, 1);
  assert.equal(output.features[0].properties?.name, sourceFeature.properties.name);
  const [longitude, latitude] = output.features[0].geometry.coordinates;
  assert.ok(Math.abs(longitude - 1) <= 1e-5);
  assert.ok(Math.abs(latitude - 1) <= 1e-5);

  verification = {
    gdalVersion: version.trim(),
    runtimeRoot,
    path: environment.PATH,
    projNetwork: environment.PROJ_NETWORK,
    requiredDrivers: ["ESRI Shapefile", "GeoJSON", "KML", "MapInfo File", "GPKG"],
    projectedSrid: Number(targetCrs.code),
    projectedExtent: layer.geometryFields[0].extent,
    roundtripFeatures: output.features.length,
    roundtripCoordinates: [longitude, latitude],
    temporaryDirectory: tempRoot,
  };
} finally {
  const resolvedTempRoot = path.resolve(tempRoot);
  assert.equal(path.dirname(resolvedTempRoot), cacheRoot, "Refusing to remove a path outside the project cache.");
  assert.match(path.basename(resolvedTempRoot), /^gdal-clean-env-\d+-\d+$/, "Refusing to remove an unexpected smoke directory.");
  await rm(resolvedTempRoot, { recursive: true, force: true });
}

assert.equal(existsSync(tempRoot), false, "The clean-environment smoke directory was not removed.");
verification.temporaryDirectoryCleaned = true;
process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);

function requireFile(directory, names) {
  return names.some((name) => existsSync(path.join(directory, name)));
}
