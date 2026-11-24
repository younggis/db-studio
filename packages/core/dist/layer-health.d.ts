import type { GisAttributePreview, GisDatasetInfo, GisGeometryValidationReport, GisLayerInfo } from "@db-studio/gis";
export interface LayerHealthReport {
    file: string;
    format: string;
    driver: string;
    layer: string;
    crs: string | null;
    featureCount: number | null;
    fieldCount: number;
    geometryTypes: Array<{
        type: string;
        count: number;
    }>;
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
export declare function summarizeLayerHealth(input: {
    info: GisDatasetInfo;
    layer: GisLayerInfo;
    preview: GisAttributePreview;
    validation: GisGeometryValidationReport;
}): LayerHealthReport;
//# sourceMappingURL=layer-health.d.ts.map