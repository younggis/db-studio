import { describe, expect, it } from "vitest";
import { summarizeLayerHealth } from "./layer-health.js";
import type { GisAttributePreview, GisDatasetInfo, GisGeometryValidationReport, GisLayerInfo } from "@db-studio/gis";

const layer: GisLayerInfo = {
  name: "roads", featureCount: 2, crs: "EPSG:4326",
  fields: [
    { name: "id", type: "Integer", nullable: false },
    { name: "name", type: "String", nullable: true },
  ],
  geometryType: "Point", geometryCount: 2,
  extent: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
} as GisLayerInfo;

const info: GisDatasetInfo = {
  path: "F:/data/roads.geojson", format: "GeoJSON", driver: "GeoJSON", layers: [layer],
  encoding: { source: "format", declaredEncoding: "UTF-8", confidence: null, warnings: [] },
};

const preview: GisAttributePreview = {
  layer: "roads",
  fields: layer.fields,
  featureCount: 2,
  requiresUserChoice: false,
  warnings: [],
  encoding: { source: "format", declaredEncoding: "UTF-8", confidence: null, warnings: [] },
  rows: [{ id: 1, name: "a" }],
  features: [
    { geometry: { type: "Point", coordinates: [104, 30] } },
    { geometry: { type: "Point", coordinates: [103, 31, 5] } },
  ],
};

const validation: GisGeometryValidationReport = {
  layer: "roads", featureCount: 2,
  geometryCounts: [{ field: null, featureCount: 2, nullGeometryCount: 0, emptyGeometryCount: 0 }],
  issueCount: 0, issues: [], issuesTruncated: false, warnings: [],
};

describe("layer health summary", () => {
  it("summarises CRS, count, fields, geometry types and dimensions", () => {
    const report = summarizeLayerHealth({ info, layer, preview, validation });
    expect(report).toMatchObject({
      file: "F:/data/roads.geojson", layer: "roads", crs: "EPSG:4326",
      featureCount: 2, fieldCount: 2, invalidGeometryCount: 0,
    });
    expect(report.geometryTypes).toEqual([{ type: "POINT", count: 2 }]);
    expect(report.dimensions).toEqual(["XY", "XYZ"]);
    expect(report.canMakeValid).toBe(false);
  });

  it("flags invalid geometries and adds a MakeValid hint", () => {
    const report = summarizeLayerHealth({
      info, layer, preview,
      validation: { ...validation, issueCount: 3, issuesTruncated: true },
    });
    expect(report.canMakeValid).toBe(true);
    expect(report.makeValidHint).toContain("MakeValid");
    expect(report.issuesTruncated).toBe(true);
  });

  it("warns when encoding is a heuristic requiring confirmation", () => {
    const report = summarizeLayerHealth({
      info, layer, validation,
      preview: { ...preview, requiresUserChoice: true, encoding: { source: "heuristic", detectedEncoding: "GBK", confidence: 0.72, warnings: [] } },
    });
    expect(report.encoding.requiresUserChoice).toBe(true);
    expect(report.encoding.confidence).toBe(0.72);
    expect(report.warnings.join(" ")).toContain("编码为候选推断");
  });

  it("merges warnings from all three sources without mutating inputs", () => {
    const withWarnings = {
      info: { ...info, warnings: ["info-warn"] },
      preview: { ...preview, warnings: ["preview-warn"] },
      validation: { ...validation, warnings: ["validation-warn"] },
    };
    const report = summarizeLayerHealth({ ...withWarnings, layer });
    expect(report.warnings).toContain("info-warn");
    expect(report.warnings).toContain("preview-warn");
    expect(report.warnings).toContain("validation-warn");
    expect(info.warnings).toBeUndefined();
  });
});
