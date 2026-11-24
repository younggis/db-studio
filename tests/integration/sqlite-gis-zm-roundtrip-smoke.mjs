import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteAdapter } from "../../packages/database/dist/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeBin = path.join(root, "apps/desktop/resources/gdal/bin");
const runtimeRoot = path.resolve(runtimeBin, "..");
const cliPath = path.join(root, "apps/cli/dist/index.js");
const ogr2ogr = path.join(runtimeBin, "ogr2ogr.exe");
const outputDirectory = path.join(root, ".cache/gis-roundtrip");
const evidencePath = path.join(outputDirectory, "sqlite-gis-zm-roundtrip-acceptance-20261122.json");
const projData = [path.join(runtimeRoot, "proj"), path.join(runtimeRoot, "share", "proj")]
  .find((directory) => existsSync(path.join(directory, "proj.db")));
const gdalData = [path.join(runtimeRoot, "data"), path.join(runtimeRoot, "share", "gdal")]
  .find((directory) => existsSync(path.join(directory, "gdalvrt.xsd")));
assert.ok(projData, "The staged PROJ database is missing.");
assert.ok(gdalData, "The staged GDAL data directory is missing.");
process.env.DBSTUDIO_GDAL_BIN = runtimeBin;
process.env.PATH = [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter);
process.env.PROJ_DATA = projData;
process.env.PROJ_LIB = projData;
process.env.GDAL_DATA = gdalData;
process.env.PROJ_NETWORK = "OFF";

const temporaryDirectory = await mkdtemp(path.join(outputDirectory, "sqlite-gis-zm-roundtrip-"));
const evidence = {
  date: "2026-11-22",
  status: "running",
  runtime: runtimeBin,
  sourceData: "synthetic POINT ZM CSV, mixed 2D GeoJSON, and mixed Point/MultiPoint ZM CSV only",
  externalDataSent: false,
  sourceFilesModified: false,
  checks: {},
};

async function runCli(databasePath, args) {
  const env = {
    ...process.env,
    DBSTUDIO_DATABASE_TYPE: "sqlite",
    DBSTUDIO_SQLITE_PATH: databasePath,
  };
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function readGpkgDimensions(databasePath, layerName) {
  const db = new SqliteAdapter({ path: databasePath, readOnly: true });
  try {
    const result = await db.query(
      "SELECT geometry_type_name, z, m FROM gpkg_geometry_columns WHERE table_name = ?",
      [layerName],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0];
  } finally {
    await db.close();
  }
}

async function assertFourDimensionalWkt(gpkgPath) {
  const csvPath = path.join(temporaryDirectory, `wkt-${path.basename(gpkgPath, ".gpkg")}.csv`);
  await execFileAsync(ogr2ogr, ["-f", "CSV", "-lco", "GEOMETRY=AS_WKT", csvPath, gpkgPath], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const csv = await readFile(csvPath, "utf8");
  for (const coordinates of ["104 30 5 105", "106 32 6 106"]) {
    assert.match(csv, new RegExp(`POINT\\s+ZM\\s*\\(${coordinates.replaceAll(" ", "\\s+")}\\)`, "i"));
  }
  return { csvPath, csv };
}

async function assertMixedGeometryTypes(gpkgPath) {
  const { stdout } = await execFileAsync(ogr2ogr, ["-f", "GeoJSON", "/vsistdout/", gpkgPath], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const geometryTypes = JSON.parse(stdout).features.map((feature) => feature.geometry?.type ?? null);
  assert.deepEqual(geometryTypes, ["Point", "MultiPoint"]);
  return geometryTypes;
}

async function assertMixedMeasuredWkt(gpkgPath) {
  const csvPath = path.join(temporaryDirectory, `mixed-zm-${path.basename(gpkgPath, ".gpkg")}.csv`);
  await execFileAsync(ogr2ogr, ["-f", "CSV", "-lco", "GEOMETRY=AS_WKT", csvPath, gpkgPath], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const csv = await readFile(csvPath, "utf8");
  assert.ok(csv.includes("POINT ZM (104 30 5 105)"));
  assert.ok(csv.includes("MULTIPOINT ZM ((106 32 6 106),(107 33 7 107))"));
  return csv;
}

try {
  await mkdir(outputDirectory, { recursive: true });
  const sourceCsvPath = path.join(temporaryDirectory, "source-zm.csv");
  const sourceGpkgPath = path.join(temporaryDirectory, "source-zm.gpkg");
  await writeFile(
    sourceCsvPath,
    'WKT,name\r\n"POINT ZM (104 30 5 105)","成都东站"\r\n"POINT ZM (106 32 6 106)","绵阳站"\r\n',
    "utf8",
  );
  await execFileAsync(ogr2ogr, [
    "-f", "GPKG", sourceGpkgPath, sourceCsvPath,
    "-oo", "GEOM_POSSIBLE_NAMES=WKT",
    "-nlt", "POINTZM",
    "-a_srs", "EPSG:4326",
    "-nln", "source_zm",
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const sourceDimensions = await readGpkgDimensions(sourceGpkgPath, "source_zm");
  assert.equal(Number(sourceDimensions.z), 1);
  assert.equal(Number(sourceDimensions.m), 1);
  const sourceWkt = await assertFourDimensionalWkt(sourceGpkgPath);

  const spatialitePath = path.join(temporaryDirectory, "spatialite-zm.sqlite");
  const spatialiteImport = await runCli(spatialitePath, [
    "gis", "import", "--file", sourceGpkgPath, "--target", "zm_features", "--mode", "create",
  ]);
  assert.equal(spatialiteImport.successfulFeatures, 2);
  const spatialiteExportPath = path.join(temporaryDirectory, "spatialite-zm-export.gpkg");
  const spatialiteExport = await runCli(spatialitePath, [
    "gis", "export", "--table", "zm_features", "--output", spatialiteExportPath,
  ]);
  assert.equal(spatialiteExport.operationReport?.successfulFeatures, 2);
  const spatialiteDimensions = await readGpkgDimensions(spatialiteExportPath, "spatialite-zm-export");
  assert.equal(Number(spatialiteDimensions.z), 1);
  assert.equal(Number(spatialiteDimensions.m), 1);
  const spatialiteWkt = await assertFourDimensionalWkt(spatialiteExportPath);

  const geopackagePath = path.join(temporaryDirectory, "container-zm.gpkg");
  const gpkgImport = await runCli(geopackagePath, [
    "gis", "import", "--file", sourceGpkgPath, "--target", "zm_features", "--mode", "create",
  ]);
  assert.equal(gpkgImport.successfulFeatures, 2);
  const gpkgDimensions = await readGpkgDimensions(geopackagePath, "zm_features");
  assert.equal(Number(gpkgDimensions.z), 1);
  assert.equal(Number(gpkgDimensions.m), 1);
  const gpkgExportPath = path.join(temporaryDirectory, "container-zm-export.gpkg");
  const gpkgExport = await runCli(geopackagePath, [
    "gis", "export", "--table", "zm_features", "--output", gpkgExportPath,
  ]);
  assert.equal(gpkgExport.operationReport?.successfulFeatures, 2);
  const gpkgExportDimensions = await readGpkgDimensions(gpkgExportPath, "container-zm-export");
  assert.equal(Number(gpkgExportDimensions.z), 1);
  assert.equal(Number(gpkgExportDimensions.m), 1);
  const gpkgWkt = await assertFourDimensionalWkt(gpkgExportPath);

  const mixedSourcePath = path.join(temporaryDirectory, "mixed-source.geojson");
  const mixedSourceGpkgPath = path.join(temporaryDirectory, "mixed-source.gpkg");
  await writeFile(mixedSourcePath, JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "成都点" }, geometry: { type: "Point", coordinates: [104, 30] } },
      { type: "Feature", properties: { name: "绵阳多点" }, geometry: { type: "MultiPoint", coordinates: [[106, 32], [107, 33]] } },
    ],
  }), "utf8");
  await execFileAsync(ogr2ogr, [
    "-f", "GPKG", mixedSourceGpkgPath, mixedSourcePath, "-nlt", "GEOMETRY", "-a_srs", "EPSG:4326", "-nln", "mixed_source",
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024 });

  const spatialiteMixedImport = await runCli(spatialitePath, [
    "gis", "import", "--file", mixedSourceGpkgPath, "--target", "mixed_features", "--mode", "create",
  ]);
  assert.equal(spatialiteMixedImport.successfulFeatures, 2);
  const spatialiteMixedExportPath = path.join(temporaryDirectory, "spatialite-mixed-export.gpkg");
  const spatialiteMixedExport = await runCli(spatialitePath, [
    "gis", "export", "--table", "mixed_features", "--output", spatialiteMixedExportPath,
  ]);
  assert.equal(spatialiteMixedExport.operationReport?.successfulFeatures, 2);
  const spatialiteMixedTypes = await assertMixedGeometryTypes(spatialiteMixedExportPath);

  const gpkgMixedImport = await runCli(geopackagePath, [
    "gis", "import", "--file", mixedSourceGpkgPath, "--target", "mixed_features", "--mode", "create",
  ]);
  assert.equal(gpkgMixedImport.successfulFeatures, 2);
  const gpkgMixedExportPath = path.join(temporaryDirectory, "container-mixed-export.gpkg");
  const gpkgMixedExport = await runCli(geopackagePath, [
    "gis", "export", "--table", "mixed_features", "--output", gpkgMixedExportPath,
  ]);
  assert.equal(gpkgMixedExport.operationReport?.successfulFeatures, 2);
  const gpkgMixedTypes = await assertMixedGeometryTypes(gpkgMixedExportPath);

  const mixedZmSourceCsvPath = path.join(temporaryDirectory, "mixed-zm-source.csv");
  const mixedZmSourceGpkgPath = path.join(temporaryDirectory, "mixed-zm-source.gpkg");
  await writeFile(
    mixedZmSourceCsvPath,
    'WKT,name\r\n"POINT ZM (104 30 5 105)","成都点"\r\n"MULTIPOINT ZM ((106 32 6 106),(107 33 7 107))","绵阳多点"\r\n',
    "utf8",
  );
  await execFileAsync(ogr2ogr, [
    "-f", "GPKG", mixedZmSourceGpkgPath, mixedZmSourceCsvPath,
    "-oo", "GEOM_POSSIBLE_NAMES=WKT", "-nlt", "GEOMETRY", "-a_srs", "EPSG:4326", "-nln", "mixed_zm_source",
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024 });

  const spatialiteMixedZmImport = await runCli(spatialitePath, [
    "gis", "import", "--file", mixedZmSourceGpkgPath, "--target", "mixed_zm_features", "--mode", "create",
  ]);
  assert.equal(spatialiteMixedZmImport.successfulFeatures, 2);
  const spatialiteMixedZmExportPath = path.join(temporaryDirectory, "spatialite-mixed-zm-export.gpkg");
  const spatialiteMixedZmExport = await runCli(spatialitePath, [
    "gis", "export", "--table", "mixed_zm_features", "--output", spatialiteMixedZmExportPath,
  ]);
  assert.equal(spatialiteMixedZmExport.operationReport?.successfulFeatures, 2);
  const spatialiteMixedZmDimensions = await readGpkgDimensions(spatialiteMixedZmExportPath, "spatialite-mixed-zm-export");
  assert.ok([1, 2].includes(Number(spatialiteMixedZmDimensions.z)));
  assert.ok([1, 2].includes(Number(spatialiteMixedZmDimensions.m)));
  const spatialiteMixedZmWkt = await assertMixedMeasuredWkt(spatialiteMixedZmExportPath);

  const gpkgMixedZmImport = await runCli(geopackagePath, [
    "gis", "import", "--file", mixedZmSourceGpkgPath, "--target", "mixed_zm_features", "--mode", "create",
  ]);
  assert.equal(gpkgMixedZmImport.successfulFeatures, 2);
  const gpkgMixedZmExportPath = path.join(temporaryDirectory, "container-mixed-zm-export.gpkg");
  const gpkgMixedZmExport = await runCli(geopackagePath, [
    "gis", "export", "--table", "mixed_zm_features", "--output", gpkgMixedZmExportPath,
  ]);
  assert.equal(gpkgMixedZmExport.operationReport?.successfulFeatures, 2);
  const gpkgMixedZmDimensions = await readGpkgDimensions(gpkgMixedZmExportPath, "container-mixed-zm-export");
  assert.ok([1, 2].includes(Number(gpkgMixedZmDimensions.z)));
  assert.ok([1, 2].includes(Number(gpkgMixedZmDimensions.m)));
  const gpkgMixedZmWkt = await assertMixedMeasuredWkt(gpkgMixedZmExportPath);

  evidence.checks = {
    sourceGpkg: { features: 2, geometryType: sourceDimensions.geometry_type_name, z: 1, m: 1, sampleWkt: sourceWkt.csv },
    spatialite: {
      importFeatures: spatialiteImport.successfulFeatures,
      exportFeatures: spatialiteExport.operationReport?.successfulFeatures,
      geometryType: spatialiteDimensions.geometry_type_name,
      z: Number(spatialiteDimensions.z),
      m: Number(spatialiteDimensions.m),
      sampleWkt: spatialiteWkt.csv,
    },
    geopackage: {
      importFeatures: gpkgImport.successfulFeatures,
      exportFeatures: gpkgExport.operationReport?.successfulFeatures,
      geometryType: gpkgDimensions.geometry_type_name,
      z: Number(gpkgDimensions.z),
      m: Number(gpkgDimensions.m),
      exportedGeometryType: gpkgExportDimensions.geometry_type_name,
      exportedZ: Number(gpkgExportDimensions.z),
      exportedM: Number(gpkgExportDimensions.m),
      sampleWkt: gpkgWkt.csv,
    },
    mixedGeometry: {
      sourceTypes: ["Point", "MultiPoint"],
      spatialite: { importFeatures: spatialiteMixedImport.successfulFeatures, exportFeatures: spatialiteMixedExport.operationReport?.successfulFeatures, geometryTypes: spatialiteMixedTypes },
      geopackage: { importFeatures: gpkgMixedImport.successfulFeatures, exportFeatures: gpkgMixedExport.operationReport?.successfulFeatures, geometryTypes: gpkgMixedTypes },
    },
    mixedMeasuredGeometry: {
      sourceTypes: ["Point ZM", "Multi Point ZM"],
      spatialite: { importFeatures: spatialiteMixedZmImport.successfulFeatures, exportFeatures: spatialiteMixedZmExport.operationReport?.successfulFeatures, z: Number(spatialiteMixedZmDimensions.z), m: Number(spatialiteMixedZmDimensions.m), sampleWkt: spatialiteMixedZmWkt },
      geopackage: { importFeatures: gpkgMixedZmImport.successfulFeatures, exportFeatures: gpkgMixedZmExport.operationReport?.successfulFeatures, z: Number(gpkgMixedZmDimensions.z), m: Number(gpkgMixedZmDimensions.m), sampleWkt: gpkgMixedZmWkt },
    },
  };
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error?.stack ?? error);
  throw error;
} finally {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({ evidencePath, ...evidence }, null, 2));
