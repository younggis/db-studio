// Phase 3: layer health summary. Combines the already-available inspect,
// attribute preview and geometry validation results into one report the import
// wizard can show before any data is written.
import type {
  GisAttributePreview,
  GisDatasetInfo,
  GisGeometryValidationReport,
  GisLayerInfo,
} from "@db-studio/gis";

interface EncodingInfo {
  source: string;
  declaredEncoding?: string;
  detectedEncoding?: string;
  confidence?: number | null;
  warnings?: string[];
}

export interface LayerHealthReport {
  file: string;
  format: string;
  driver: string;
  layer: string;
  crs: string | null;
  featureCount: number | null;
  fieldCount: number;
  geometryTypes: Array<{ type: string; count: number }>;
  dimensions: string[];
  invalidGeometryCount: number;
  issuesTruncated: boolean;
  encoding: {
    source: string;
    declared: string | null;
    detected: string | null;
    confidence: number | null;
    requiresUserChoice: boolean;
  };
  warnings: string[];
  canMakeValid: boolean;
  makeValidHint?: string;
}

function geometrySignature(geometry: unknown): { type: string; dimension: string } | undefined {
  if (!geometry || typeof geometry !== "object") return undefined;
  const record = geometry as Record<string, unknown>;
  if (typeof record.type !== "string") return undefined;
  const coordinates = record.coordinates;
  let dimension = "XY";
  const scan = (value: unknown): void => {
    if (!Array.isArray(value) || value.length < 3) return;
    if (typeof value[0] === "number" && typeof value[1] === "number" && typeof value[2] === "number") {
      if (value.length >= 4) dimension = "XYZM"; else dimension = "XYZ";
      return;
    }
    for (const child of value) scan(child);
  };
  scan(coordinates);
  return { type: record.type.toUpperCase(), dimension };
}

export function summarizeLayerHealth(input: {
  info: GisDatasetInfo;
  layer: GisLayerInfo;
  preview: GisAttributePreview;
  validation: GisGeometryValidationReport;
}): LayerHealthReport {
  const { info, layer, preview, validation } = input;
  const counts = new Map<string, number>();
  const dimensions = new Set<string>();
  for (const feature of preview.features ?? []) {
    const signature = geometrySignature(feature.geometry);
    if (!signature) continue;
    counts.set(signature.type, (counts.get(signature.type) ?? 0) + 1);
    dimensions.add(signature.dimension);
  }
  const geometryTypes = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const encoding: EncodingInfo = preview.encoding ?? info.encoding;
  const warnings = [...(info.warnings ?? []), ...(preview.warnings ?? []), ...(validation.warnings ?? [])];
  const invalidGeometryCount = validation.issueCount;
  const canMakeValid = invalidGeometryCount > 0;
  const report: LayerHealthReport = {
    file: info.path,
    format: info.format,
    driver: info.driver,
    layer: layer.name,
    crs: layer.crs ?? null,
    featureCount: layer.featureCount ?? preview.featureCount ?? validation.featureCount,
    fieldCount: layer.fields.length,
    geometryTypes,
    dimensions: [...dimensions].sort(),
    invalidGeometryCount,
    issuesTruncated: validation.issuesTruncated,
    encoding: {
      source: encoding.source,
      declared: encoding.declaredEncoding ?? null,
      detected: encoding.detectedEncoding ?? null,
      confidence: encoding.confidence ?? null,
      requiresUserChoice: preview.requiresUserChoice,
    },
    warnings,
    canMakeValid,
    makeValidHint: canMakeValid
      ? "可在导入时启用“导入前修复无效几何（GDAL MakeValid）”；修复可能改变几何类型或使要素变空。"
      : undefined,
  };
  if (encoding.source === "heuristic" || preview.requiresUserChoice) {
    report.warnings = [...report.warnings, "编码为候选推断，请在导入前确认中文属性预览。"];
  }
  return report;
}
