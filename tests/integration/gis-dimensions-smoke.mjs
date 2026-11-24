import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GdalService } from "../../packages/gis/dist/index.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-dimensions-"));

try {
  const gdalBin = process.env.DBSTUDIO_GDAL_BIN;
  assert.ok(gdalBin, "Set DBSTUDIO_GDAL_BIN to a GDAL/OGR bin directory before this smoke test.");
  const executable = (name) => path.join(gdalBin, process.platform === "win32" ? `${name}.exe` : name);
  const ogr2ogr = executable("ogr2ogr");
  assert.ok(existsSync(ogr2ogr), `GDAL utility was not found: ${ogr2ogr}`);

  const gdal = new GdalService(process.env);
  const runtime = gdal.runtimeStatus();
  assert.equal(runtime.available, true, "The configured GDAL runtime must be available.");

  const csv = path.join(directory, "measured.csv");
  const source = path.join(directory, "measured.gpkg");
  await writeFile(csv, 'WKT,id\n"POINT ZM (1 2 3 4)",1\n', "utf8");
  execFileSync(ogr2ogr, [
    "-f", "GPKG", source, csv,
    "-oo", "GEOM_POSSIBLE_NAMES=WKT",
    "-nlt", "POINTZM",
    "-a_srs", "EPSG:4326",
  ], { env: process.env, windowsHide: true, encoding: "utf8" });

  const sourceInfo = await gdal.inspect(source);
  assert.equal(sourceInfo.layers[0]?.geometryType, "PointZM", "The fixture must include both Z and M ordinates.");

  const nullEmptyCsv = path.join(directory, "null-empty.csv");
  const nullEmptyGpkg = path.join(directory, "null-empty.gpkg");
  const nullEmptyShapefile = path.join(directory, "null-empty.shp");
  await writeFile(nullEmptyCsv, 'WKT,id\n"POINT (1 2)",1\n"POINT EMPTY",2\n,3\n', "utf8");
  execFileSync(ogr2ogr, [
    "-f", "GPKG", nullEmptyGpkg, nullEmptyCsv,
    "-oo", "GEOM_POSSIBLE_NAMES=WKT",
    "-nln", "probe",
    "-nlt", "POINT",
    "-a_srs", "EPSG:4326",
  ], { env: process.env, windowsHide: true, encoding: "utf8" });
  const nullEmptyReport = await gdal.checkGeometry(nullEmptyGpkg, { sourceLayer: "probe" });
  assert.deepEqual(nullEmptyReport.geometryCounts, [
    { field: "geom", featureCount: 3, nullGeometryCount: 1, emptyGeometryCount: 1 },
  ]);

  execFileSync(ogr2ogr, ["-f", "ESRI Shapefile", nullEmptyShapefile, nullEmptyGpkg, "-overwrite"], {
    env: process.env,
    windowsHide: true,
    encoding: "utf8",
  });
  const shapefileReport = await gdal.checkGeometry(nullEmptyShapefile, { sourceEncoding: "UTF-8" });
  // GDAL 3.12.2 reports the Shapefile POINT EMPTY as NULL; 3.12.1 reports it as
  // an empty geometry. Both are valid driver representations, so accept either.
  assert.equal(shapefileReport.geometryCounts.length, 1, "Shapefile should report one geometry field.");
  assert.match(JSON.stringify(shapefileReport.geometryCounts[0]), /"field":null/);
  assert.equal(shapefileReport.geometryCounts[0]?.featureCount, 3);
  assert.equal(shapefileReport.geometryCounts[0]?.nullGeometryCount, 2);
  assert.ok([0, 2].includes(shapefileReport.geometryCounts[0]?.emptyGeometryCount ?? -1));

  const expectations = [
    { format: "shp", extension: "shp", geometryType: "PointZM", lostDimensions: [] },
    { format: "geojson", extension: "geojson", geometryType: "PointZ", lostDimensions: ["M"] },
    { format: "kml", extension: "kml", geometryType: "Geometry", lostDimensions: ["M"] },
    { format: "tab", extension: "tab", geometryType: "Point", lostDimensions: ["Z", "M"] },
    { format: "gpkg", extension: "gpkg", geometryType: "PointZM", lostDimensions: [] },
  ];
  const results = [];

  for (const expectation of expectations) {
    const output = path.join(directory, `result.${expectation.extension}`);
    const result = await gdal.convert(source, output);
    const layer = result.layers[0];
    assert.equal(layer?.geometryType, expectation.geometryType, `${expectation.format} geometry dimensions changed unexpectedly.`);
    const warnings = result.operationReport?.warnings ?? [];
    for (const dimension of expectation.lostDimensions) {
      assert.ok(
        warnings.some((warning) => warning.includes(`${dimension} (`)),
        `${expectation.format} must report loss of ${dimension} ordinates.`,
      );
    }
    if (expectation.lostDimensions.length === 0) {
      assert.ok(!warnings.some((warning) => /drop [ZM]|does not preserve [ZM]/i.test(warning)));
    }

    if (expectation.format === "geojson") {
      const data = JSON.parse(await readFile(output, "utf8"));
      assert.deepEqual(data.features[0]?.geometry?.coordinates, [1, 2, 3], "RFC 7946 GeoJSON should retain Z but not M.");
    } else if (expectation.format === "kml") {
      const data = await readFile(output, "utf8");
      assert.match(data, /<coordinates>1,2,3<\/coordinates>/, "KML should retain altitude while omitting M.");
    }

    results.push({ format: expectation.format, geometryType: layer?.geometryType, warnings });
  }

  console.log(JSON.stringify({
    ok: true,
    gdalVersion: runtime.version,
    sourceGeometryType: sourceInfo.layers[0]?.geometryType,
    nullEmptyGeometryCounts: { gpkg: nullEmptyReport.geometryCounts, shapefile: shapefileReport.geometryCounts },
    results,
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
