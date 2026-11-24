import { describe, expect, it } from "vitest";
import { CoreService } from "@db-studio/core";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProgram } from "./index.js";

const core = CoreService.fromEnvironment();
const gdalAvailable = core.getGdalRuntimeStatus().available;
const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/points.geojson",
);

describe("GIS CLI options", () => {
  it("exposes the opt-in UTF-8 Shapefile tail replacement flag", () => {
    const gisCommand = createProgram().commands.find((command) => command.name() === "gis");
    const importCommand = gisCommand?.commands.find((command) => command.name() === "import");
    const exportCommand = gisCommand?.commands.find((command) => command.name() === "export");

    expect(importCommand?.options.some((option) => option.long === "--replace-incomplete-utf8-tails")).toBe(true);
    expect(exportCommand?.options.some((option) => option.long === "--bbox")).toBe(true);
  });
});

describe.skipIf(!gdalAvailable)("GDAL GIS integration", () => {
  it("inspects GeoJSON fields, geometry, CRS, extent and count", async () => {
    const info = await core.inspectGisFile(fixture);

    expect(info.format).toBe("GeoJSON");
    expect(info.layers).toHaveLength(1);
    expect(info.layers[0]).toMatchObject({
      name: "points",
      geometryType: "Point",
      crs: "EPSG:4326",
      featureCount: 2,
      extent: { minX: 1.25, minY: 2.5, maxX: 1.25, maxY: 2.5 },
    });
    expect(info.layers[0]?.fields).toContainEqual({
      name: "名称",
      type: "String",
      nullable: true,
    });
  });

  it("transforms coordinates when converting to GeoPackage", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "db-studio-gis-"));
    const output = path.join(temporary, "projected.gpkg");
    try {
      const info = await core.convertGisFile(fixture, output, { targetCrs: "EPSG:3857" });
      expect(info.format).toBe("GeoPackage");
      expect(info.layers[0]?.crs).toBe("EPSG:3857");
      expect(info.layers[0]?.extent?.minX).toBeGreaterThan(100_000);
      expect(info.layers[0]?.extent?.minY).toBeGreaterThan(200_000);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 20_000);

  it("selects one layer from a multi-layer dataset and names the output layer", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "db-studio-gis-layers-"));
    const input = path.join(temporary, "multi-layer.gpkg");
    const output = path.join(temporary, "selected-layer.gpkg");
    const ogr2ogr = core.getGdalRuntimeStatus().ogr2ogr;
    const ogrinfo = core.getGdalRuntimeStatus().ogrinfo;
    if (!ogr2ogr || !ogrinfo) throw new Error("GDAL vector tools are unavailable.");
    const runOgr2ogr = (args: string[]) => execFileSync(ogr2ogr, args, { stdio: "ignore", windowsHide: true, timeout: 20_000 });
    try {
      runOgr2ogr(["-f", "GPKG", input, fixture, "-nln", "source_one"]);
      runOgr2ogr(["-update", input, fixture, "-nln", "source_two"]);

      const source = await core.inspectGisFile(input);
      expect(source.layers.map((layer) => layer.name)).toEqual(["source_one", "source_two"]);
      await expect(core.convertGisFile(input, output, { targetLayerName: "renamed", sourceEncoding: "UTF-8" }))
        .rejects.toThrow("requires a single selected source layer");

      const result = await core.convertGisFile(input, output, {
        sourceLayer: "source_two",
        targetLayerName: "renamed",
        sourceEncoding: "UTF-8",
        datasetCreationOptions: ["VERSION=1.2"],
        layerCreationOptions: ["SPATIAL_INDEX=NO"],
      });
      expect(result.layers.map((layer) => layer.name)).toEqual(["renamed"]);
      expect(result.layers[0]?.featureCount).toBe(2);
      expect(result.operationReport?.featureCount).toBe(2);
      expect(result.operationReport?.successfulFeatures).toBe(2);
      const gdalRoot = path.resolve(path.dirname(ogrinfo), "..");
      const rtreeTables = execFileSync(ogrinfo, [
        "-ro", "-q", "-dialect", "SQLite", "-sql",
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rtree_%'",
        output,
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          GDAL_DATA: path.join(gdalRoot, "data"),
          PROJ_DATA: path.join(gdalRoot, "proj"),
          PROJ_LIB: path.join(gdalRoot, "proj"),
        },
      });
      expect(rtreeTables).not.toContain("rtree_");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);

  it("applies driver-specific creation options to GeoJSON, CSV and Shapefile", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "db-studio-gis-driver-matrix-"));
    const geojson = path.join(temporary, "bbox.geojson");
    const csv = path.join(temporary, "semicolon.csv");
    const shapefile = path.join(temporary, "indexed.shp");
    try {
      const geojsonInfo = await core.convertGisFile(fixture, geojson, {
        layerCreationOptions: ["WRITE_BBOX=YES"],
      });
      const geojsonDocument = JSON.parse(await readFile(geojson, "utf8")) as {
        bbox?: unknown;
        features: unknown[];
      };
      expect(geojsonInfo.layers[0]?.featureCount).toBe(2);
      expect(geojsonDocument.bbox).toBeDefined();
      expect(geojsonDocument.features).toHaveLength(2);

      const csvInfo = await core.convertGisFile(fixture, csv, {
        layerCreationOptions: ["SEPARATOR=SEMICOLON"],
      });
      const csvHeader = (await readFile(csv, "utf8")).split(/\r?\n/, 1)[0] ?? "";
      expect(csvInfo.layers[0]?.featureCount).toBe(2);
      expect(csvHeader).toContain(";");
      expect(csvHeader).not.toContain(",");
      expect(existsSync(path.join(temporary, "semicolon.csvt"))).toBe(true);

      const shapefileInfo = await core.convertGisFile(fixture, shapefile, {
        layerCreationOptions: ["SPATIAL_INDEX=YES"],
      });
      expect(shapefileInfo.layers[0]?.featureCount).toBe(2);
      expect(existsSync(path.join(temporary, "indexed.qix"))).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);

  it("applies an explicitly selected PROJ coordinate operation", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "db-studio-gis-operation-"));
    const automatic = path.join(temporary, "automatic.gpkg");
    const explicit = path.join(temporary, "explicit.gpkg");
    const coordinateOperation = "+proj=pipeline +step +proj=axisswap +order=2,1 +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=webmerc +ellps=WGS84 +step +proj=affine +xoff=10";
    try {
      const automaticInfo = await core.convertGisFile(fixture, automatic, { targetCrs: "EPSG:3857" });
      const explicitInfo = await core.convertGisFile(fixture, explicit, { targetCrs: "EPSG:3857", coordinateOperation });
      const automaticX = automaticInfo.layers[0]?.extent?.minX;
      const explicitX = explicitInfo.layers[0]?.extent?.minX;
      expect(automaticX).toBeDefined();
      expect(explicitX).toBeCloseTo(automaticX! + 10, 2);
      expect(explicitInfo.operationReport?.warnings?.join(" ")).toContain("explicit PROJ coordinate operation");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a CRS transform when the source dataset has no CRS", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "db-studio-gis-"));
    const shapefile = path.join(temporary, "missing-crs.shp");
    const projected = path.join(temporary, "projected.gpkg");
    try {
      await core.convertGisFile(fixture, shapefile);
      await rm(path.join(temporary, "missing-crs.prj"));
      await expect(
        core.convertGisFile(shapefile, projected, { targetCrs: "EPSG:3857" }),
      ).rejects.toThrow("Source CRS is missing");
      expect(existsSync(projected)).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 20_000);
});
