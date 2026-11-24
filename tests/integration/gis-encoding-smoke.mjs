import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GdalService } from "../../packages/gis/dist/index.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "dbstudio-gis-encoding-smoke-"));

try {
  const gdal = new GdalService(process.env);
  const runtime = gdal.runtimeStatus();
  assert.equal(runtime.available, true, "Set DBSTUDIO_GDAL_BIN or add GDAL/OGR to PATH before this smoke test.");

  const legacyCsv = path.join(directory, "legacy-csv.csv");
  const legacyCsvBytes = Buffer.concat([
    Buffer.from('WKT,name,note\r\n"POINT (121.5 31.2)",', "ascii"),
    Buffer.from("B1B1BEA9CAD0C2B7", "hex"),
    Buffer.from(",", "ascii"),
    Buffer.from("C3FBB3C6", "hex"),
    Buffer.from("\r\n", "ascii"),
  ]);
  await writeFile(legacyCsv, legacyCsvBytes);
  const csvInfo = await gdal.inspect(legacyCsv);
  assert.equal(csvInfo.driver, "CSV");
  assert.equal(csvInfo.encoding.source, "unknown", "A CSV without a BOM must require an explicit source encoding.");
  const undecodedCsvPreview = await gdal.previewAttributes(legacyCsv);
  assert.equal(undecodedCsvPreview.requiresUserChoice, true);
  const decodedCsvPreview = await gdal.previewAttributes(legacyCsv, { sourceEncoding: "GBK" });
  assert.equal(decodedCsvPreview.requiresUserChoice, false);
  assert.equal(decodedCsvPreview.rows[0]?.name, "北京市路");
  assert.equal(decodedCsvPreview.rows[0]?.note, "名称");
  assert.deepEqual(await readFile(legacyCsv), legacyCsvBytes, "CSV preview must leave the source bytes untouched.");
  const convertedCsv = path.join(directory, "legacy-csv.geojson");
  await gdal.convert(legacyCsv, convertedCsv, { sourceEncoding: "GBK" });
  const convertedCsvFeature = JSON.parse(await readFile(convertedCsv, "utf8")).features[0];
  assert.equal(convertedCsvFeature.properties.name, "北京市路");
  assert.equal(convertedCsvFeature.properties.note, "名称");
  assert.deepEqual(await readFile(legacyCsv), legacyCsvBytes, "CSV conversion must leave the source bytes untouched.");

  const source = path.join(directory, "source.geojson");
  await writeFile(source, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [121.5, 31.2] },
      properties: { name: "道路名称", note: "中文编码验证" },
    }],
  }), "utf8");

  const results = [];
  const heuristicCsv = path.join(directory, "legacy-high-confidence.csv");
  const heuristicCsvBytes = Buffer.concat([
    Buffer.from("WKT,name\r\n", "ascii"),
    ...Array.from({ length: 120 }, () => Buffer.concat([
      Buffer.from('"POINT (121.5 31.2)",', "ascii"),
      Buffer.from("D6D0CEC4B5C0C2B7", "hex"),
      Buffer.from("\r\n", "ascii"),
    ])),
  ]);
  await writeFile(heuristicCsv, heuristicCsvBytes);
  const heuristicInfo = await gdal.inspect(heuristicCsv);
  assert.equal(heuristicInfo.encoding.source, "heuristic");
  assert.equal(heuristicInfo.encoding.detectedEncoding, "GB18030");
  assert.ok(heuristicInfo.warnings?.some((warning) => warning.includes("verify the attribute preview")));
  const heuristicPreview = await gdal.previewAttributes(heuristicCsv);
  assert.equal(heuristicPreview.requiresUserChoice, false);
  assert.equal(heuristicPreview.rows[0]?.name, "中文道路");
  const heuristicOutput = path.join(directory, "legacy-high-confidence.geojson");
  await gdal.convert(heuristicCsv, heuristicOutput);
  const heuristicFeature = JSON.parse(await readFile(heuristicOutput, "utf8")).features[0];
  assert.equal(heuristicFeature.properties.name, "中文道路");
  assert.deepEqual(await readFile(heuristicCsv), heuristicCsvBytes);
  results.push({ encoding: heuristicInfo.encoding, rows: heuristicPreview.rows.length, heuristicCsvConverted: true });

  for (const format of ["shp", "geojson", "kml", "tab", "gpkg"]) {
    const output = path.join(directory, `roads.${format}`);
    const targetEncoding = format === "shp" || format === "tab" ? "GBK" : undefined;
    await gdal.convert(source, output, { targetEncoding });
    const preview = await gdal.previewAttributes(output);
    assert.equal(preview.requiresUserChoice, false, `${format} encoding should be known for the fixture.`);
    assert.equal(preview.rows[0]?.name ?? preview.rows[0]?.Name, "道路名称", `${format} must preserve the Chinese name attribute.`);
    assert.equal(preview.rows[0]?.note, "中文编码验证", `${format} must preserve Chinese text values.`);
    results.push({ format, encoding: preview.encoding, rows: preview.rows.length });

    if (format === "shp") {
      const overridePreview = await gdal.previewAttributes(output, { sourceEncoding: "GBK" });
      assert.equal(overridePreview.rows[0]?.name, "道路名称", "Shapefile source encoding override must decode DBF values.");
    }
    if (format === "tab") {
      const tabBefore = await readFile(output);
      const mid = output.replace(/\.tab$/i, ".dat");
      const midBefore = await readFile(mid);
      const overridePreview = await gdal.previewAttributes(output, { sourceEncoding: "GBK" });
      assert.equal(overridePreview.rows[0]?.name, "道路名称", "MapInfo source encoding override must decode attributes.");
      assert.deepEqual(await readFile(output), tabBefore, "MapInfo preview must leave the original TAB file untouched.");
      assert.deepEqual(await readFile(mid), midBefore, "MapInfo preview must leave the original DAT file untouched.");
    }
  }

  const shapefile = path.join(directory, "roads.shp");
  const projected = path.join(directory, "roads-3857.shp");
  const shapefileInfo = await gdal.inspect(shapefile);
  assert.notEqual(shapefileInfo.encoding.source, "unknown", `The generated Shapefile should retain a usable encoding: ${JSON.stringify(shapefileInfo.encoding)}`);
  await gdal.convert(shapefile, projected, { targetCrs: "EPSG:3857" });
  const projectedInfo = await gdal.inspect(projected);
  assert.notEqual(projectedInfo.encoding.source, "unknown", `The reprojected Shapefile should retain a usable encoding: ${JSON.stringify(projectedInfo.encoding)}`);
  const projectedLayer = projectedInfo.layers[0];
  assert.match(projectedLayer?.crs ?? "", /3857/);
  const standardGeoJson = path.join(directory, "roads-rfc7946.geojson");
  await gdal.convert(projected, standardGeoJson);
  const geoJson = JSON.parse(await readFile(standardGeoJson, "utf8"));
  assert.equal("crs" in geoJson, false, "RFC 7946 output must not write the legacy crs member.");
  const coordinates = geoJson.features[0].geometry.coordinates;
  assert.ok(Math.abs(coordinates[0] - 121.5) < 0.00001, "RFC 7946 output must transform projected X to longitude.");
  assert.ok(Math.abs(coordinates[1] - 31.2) < 0.00001, "RFC 7946 output must transform projected Y to latitude.");

  const utmSource = path.join(directory, "utm-central-meridian.geojson");
  const utmProjected = path.join(directory, "utm-zone-51n.gpkg");
  const utmWebMercator = path.join(directory, "utm-zone-51n-to-3857.gpkg");
  const utmGeoJsonPath = path.join(directory, "utm-zone-51n-rfc7946.geojson");
  await writeFile(utmSource, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [123, 0] },
      properties: { name: "UTM central meridian" },
    }],
  }), "utf8");
  await gdal.convert(utmSource, utmProjected, { targetCrs: "EPSG:32651" });
  const utmProjectedLayer = (await gdal.inspect(utmProjected)).layers[0];
  assert.match(utmProjectedLayer?.crs ?? "", /32651/, "UTM output must retain EPSG:32651 metadata.");
  await gdal.convert(utmProjected, utmWebMercator, { targetCrs: "EPSG:3857" });
  const utmWebMercatorLayer = (await gdal.inspect(utmWebMercator)).layers[0];
  assert.match(utmWebMercatorLayer?.crs ?? "", /3857/, "Projected-to-projected output must retain EPSG:3857 metadata.");
  assert.ok(Math.abs((utmWebMercatorLayer?.extent?.minX ?? 0) - 13692297.367572648) < 0.05, "UTM-to-Web-Mercator must preserve the known longitude 123 easting.");
  assert.ok(Math.abs(utmWebMercatorLayer?.extent?.minY ?? Number.POSITIVE_INFINITY) < 0.05, "UTM-to-Web-Mercator must preserve the equator northing.");
  await gdal.convert(utmProjected, utmGeoJsonPath);
  const utmGeoJson = JSON.parse(await readFile(utmGeoJsonPath, "utf8"));
  const utmRoundTripCoordinates = utmGeoJson.features[0]?.geometry?.coordinates;
  assert.ok(Math.abs(utmRoundTripCoordinates?.[0] - 123) < 0.00000001, "UTM zone 51N central meridian must return to longitude 123.");
  assert.ok(Math.abs(utmRoundTripCoordinates?.[1] ?? Number.POSITIVE_INFINITY) < 0.00000001, "UTM equator must return to latitude 0.");

  const cgcsSource = path.join(directory, "cgcs2000-source.geojson");
  const cgcsGpkg = path.join(directory, "cgcs2000.gpkg");
  const cgcsRoundTrip = path.join(directory, "cgcs2000-roundtrip.geojson");
  const cgcsCoordinates = [116.397, 39.908];
  await writeFile(cgcsSource, JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: cgcsCoordinates }, properties: { name: "EPSG:4490 control point" } }],
  }), "utf8");
  await gdal.convert(cgcsSource, cgcsGpkg, { targetCrs: "EPSG:4490" });
  const cgcsLayer = (await gdal.inspect(cgcsGpkg)).layers[0];
  assert.match(cgcsLayer?.crs ?? "", /4490/, "GeoPackage must retain the EPSG:4490 target CRS.");
  await gdal.convert(cgcsGpkg, cgcsRoundTrip);
  const cgcsRoundTripCoordinates = JSON.parse(await readFile(cgcsRoundTrip, "utf8")).features[0]?.geometry?.coordinates;
  assert.ok(Math.abs(cgcsRoundTripCoordinates?.[0] - cgcsCoordinates[0]) < 0.00001, "EPSG:4490 round trip must preserve longitude within 1e-5 degrees.");
  assert.ok(Math.abs(cgcsRoundTripCoordinates?.[1] - cgcsCoordinates[1]) < 0.00001, "EPSG:4490 round trip must preserve latitude within 1e-5 degrees.");

  const customWkt = 'PROJCS["WGS 84 / UTM zone 51N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';
  const customWktSource = path.join(directory, "custom-wkt-source.geojson");
  const customWktOutput = path.join(directory, "custom-wkt-output.geojson");
  await writeFile(customWktSource, JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [500000, 0] }, properties: { name: "custom WKT axis-order control" } }],
  }), "utf8");
  await gdal.convert(customWktSource, customWktOutput, { sourceCrs: customWkt, targetCrs: "EPSG:4326" });
  const customWktCoordinates = JSON.parse(await readFile(customWktOutput, "utf8")).features[0]?.geometry?.coordinates;
  assert.ok(Math.abs(customWktCoordinates?.[0] - 123) < 0.00000001, "Custom WKT easting/northing must transform to longitude 123 without axis reversal.");
  assert.ok(Math.abs(customWktCoordinates?.[1] ?? Number.POSITIVE_INFINITY) < 0.00000001, "Custom WKT equator must transform to latitude 0.");

  const preciseCoordinates = [121.12345678901234, 31.12345678901234, 12.345678901234567];
  const preciseInput = path.join(directory, "precise-input.geojson");
  const preciseOutput = path.join(directory, "precise-output.geojson");
  await writeFile(preciseInput, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: preciseCoordinates },
      properties: { name: "binary64 roundtrip" },
    }],
  }), "utf8");
  const preciseResult = await gdal.convert(preciseInput, preciseOutput);
  const preciseGeoJson = JSON.parse(await readFile(preciseOutput, "utf8"));
  assert.deepEqual(
    preciseGeoJson.features[0]?.geometry?.coordinates,
    preciseCoordinates,
    "RFC 7946 conversion must round-trip finite binary64 XYZ coordinates without default seven-place rounding.",
  );
  assert.ok(
    preciseResult.operationReport?.warnings.some((warning) => warning.includes("17 decimal places")),
    "The GeoJSON report should disclose its coordinate precision policy.",
  );
  await assert.rejects(
    gdal.convert(source, path.join(directory, "wrong-crs.geojson"), { targetCrs: "EPSG:3857" }),
    /RFC 7946 GeoJSON output uses WGS 84/,
  );

  console.log(JSON.stringify({ ok: true, gdalVersion: runtime.version, results, projectedCrs: projectedLayer.crs, rfc7946Coordinates: coordinates, utmCrs: utmProjectedLayer.crs, utmWebMercatorExtent: utmWebMercatorLayer.extent, utmRfc7946Coordinates: utmRoundTripCoordinates, cgcsCrs: cgcsLayer.crs, cgcsRoundTripCoordinates, customWktCoordinates, preciseRfc7946Coordinates: preciseGeoJson.features[0].geometry.coordinates }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
