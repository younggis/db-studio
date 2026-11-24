import { type EncodingDetectionResult } from "./encoding.js";
export type { EncodingDetectionResult, EncodingSource } from "./encoding.js";
export interface GisFieldInfo {
    name: string;
    type: string;
    subType?: string;
    width?: number;
    precision?: number;
    nullable?: boolean;
}
export type GisFieldTargetType = "string" | "integer" | "integer64" | "real" | "date" | "time" | "datetime";
export interface GisFieldMapping {
    source: string;
    target: string;
    targetType?: GisFieldTargetType;
}
export interface GisSpatialExtent {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
export interface GisLayerInfo {
    name: string;
    fidColumnName?: string | null;
    geometryType: string | null;
    geometryFields?: Array<{
        name: string | null;
        type: string | null;
    }>;
    crs: string | null;
    featureCount: number | null;
    extent: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null;
    fields: GisFieldInfo[];
}
export interface GisDatasetInfo {
    path: string;
    format: string;
    driver: string;
    layers: GisLayerInfo[];
    encoding: EncodingDetectionResult;
    warnings?: string[];
    operationReport?: GisOperationReport;
}
export interface GisAttributePreview {
    layer: string;
    fields: GisFieldInfo[];
    rows: Array<Record<string, unknown>>;
    features: Array<{
        geometry: unknown;
    }>;
    featureCount: number | null;
    encoding: EncodingDetectionResult;
    requiresUserChoice: boolean;
    warnings: string[];
}
export interface GisGeometryIssue {
    reason: string;
    locations: Array<{
        x: number;
        y: number;
    }>;
}
export interface GisGeometryValidationReport {
    layer: string;
    featureCount: number | null;
    geometryCounts: Array<{
        field: string | null;
        featureCount: number;
        nullGeometryCount: number;
        emptyGeometryCount: number;
    }>;
    issueCount: number;
    issues: GisGeometryIssue[];
    issuesTruncated: boolean;
    warnings: string[];
}
export interface GisOperationReport {
    operation: "convert" | "import" | "export";
    status: "completed" | "failed" | "cancelled";
    input: string;
    output: string;
    featureCount: number | null;
    successfulFeatures: number | null;
    failedFeatures: number | null;
    failedSamples: string[];
    warnings?: string[];
}
export interface GisInputOptions {
    sourceEncoding?: string;
    /** Character encoding used by entry names stored inside a ZIP archive. */
    zipFilenameEncoding?: string;
}
export interface GdalOperationOptions {
    signal?: AbortSignal;
    onProgress?: OgrProgress;
}
export interface GisCrsOptions {
    sourceCrs?: string;
    targetCrs?: string;
    /** Explicit PROJ coordinate-operation pipeline, corresponding to ogr2ogr -ct. */
    coordinateOperation?: string;
}
export interface GisDriverCreationOption {
    name: string;
    value: string;
}
export interface GisOutputFormatOptions {
    /** Repeatable GDAL NAME=VALUE dataset creation options. */
    datasetCreationOptions?: string[];
    /** Repeatable GDAL NAME=VALUE layer creation options. */
    layerCreationOptions?: string[];
}
export declare function parseGisDriverCreationOptions(entries: string[]): GisDriverCreationOption[];
export interface GisConversionOptions extends GisCrsOptions, GisOutputFormatOptions, GisInputOptions {
    targetEncoding?: string;
    sourceLayer?: string;
    targetLayerName?: string;
    fieldMappings?: GisFieldMapping[];
    spatialFilter?: GisSpatialExtent;
    makeValid?: boolean;
    replaceIncompleteUtf8Tails?: boolean;
}
export interface GisExportOptions extends GisCrsOptions, GisOutputFormatOptions {
    targetEncoding?: string;
    targetLayerName?: string;
    fieldMappings?: GisFieldMapping[];
    /** Select source features intersecting this rectangle in the source CRS. */
    spatialFilter?: GisSpatialExtent;
}
export declare function parseGisSpatialExtent(value: string): GisSpatialExtent;
export declare class GisOperationError extends Error {
    readonly report: GisOperationReport;
    constructor(message: string, report: GisOperationReport);
}
export interface GdalRuntimeStatus {
    available: boolean;
    version: string | null;
    ogrinfo: string | null;
    ogr2ogr: string | null;
    gdalinfo: string | null;
}
export interface GdalPostgresConnection {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean | {
        rejectUnauthorized?: boolean;
    };
}
export type OgrProgress = (percent: number) => void;
export declare class GdalService {
    private readonly env;
    constructor(env?: NodeJS.ProcessEnv);
    runtimeStatus(): GdalRuntimeStatus;
    inspect(filePath: string, options?: GisInputOptions): Promise<GisDatasetInfo>;
    previewAttributes(filePath: string, options?: GisInputOptions & {
        sourceLayer?: string;
        limit?: number;
    }): Promise<GisAttributePreview>;
    checkGeometry(filePath: string, options?: GisInputOptions & {
        sourceLayer?: string;
        sampleLimit?: number;
    }): Promise<GisGeometryValidationReport>;
    inspectPostgresTable(table: string, connection: GdalPostgresConnection): Promise<GisLayerInfo>;
    private assertPostgresTableAbsent;
    convert(input: string, output: string, options?: GisConversionOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    importToPostgres(input: string, table: string, connection: GdalPostgresConnection, options?: {
        mode?: "create" | "append" | "overwrite";
        sourceLayer?: string;
        sourceCrs?: string;
        targetCrs?: string;
        coordinateOperation?: string;
        fieldMappings?: GisFieldMapping[];
        sourceEncoding?: string;
        zipFilenameEncoding?: string;
        replaceIncompleteUtf8Tails?: boolean;
        spatialFilter?: GisSpatialExtent;
        makeValid?: boolean;
    }, operationOptions?: GdalOperationOptions): Promise<GisOperationReport>;
    private scanFeatureDimensions;
    exportFromPostgres(table: string, output: string, connection: GdalPostgresConnection, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    importToSqlite(input: string, databasePath: string, table: string, storage: "spatialite" | "geopackage", options?: {
        mode?: "create" | "append" | "overwrite";
        sourceLayer?: string;
        sourceCrs?: string;
        targetCrs?: string;
        coordinateOperation?: string;
        fieldMappings?: GisFieldMapping[];
        sourceEncoding?: string;
        zipFilenameEncoding?: string;
        replaceIncompleteUtf8Tails?: boolean;
        spatialFilter?: GisSpatialExtent;
        makeValid?: boolean;
        createSpatialIndex?: boolean;
        initializeSpatialite?: boolean;
    }, operationOptions?: GdalOperationOptions): Promise<GisOperationReport>;
    private initializeSpatialiteMetadata;
    exportFromSqlite(databasePath: string, table: string, output: string, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    private runOgr2Ogr;
    private assertInputFile;
    private requireExecutable;
    private resolveExecutable;
    private readVersion;
}
export declare function companionFileWarnings(filePath: string, directoryEntries: readonly string[]): string[];
export declare function buildFieldProjectionSql(layer: GisLayerInfo, mappings?: GisFieldMapping[], options?: {
    stringWidth?: number;
    includeGeometry?: boolean;
}): string | undefined;
export declare function buildGeoJsonStringSubtypeSchemaOverride(layer: GisLayerInfo, mappings?: GisFieldMapping[]): string | undefined;
export declare function geoJsonJsonSubtypeImportWarning(layer: GisLayerInfo, mappings: GisFieldMapping[], errorText: string): string | undefined;
export declare function buildPostgresNumericColumnTypeOverrides(layer: GisLayerInfo, mappings?: GisFieldMapping[]): {
    option?: string;
    skippedFields: string[];
};
export declare function buildPostgresColumnTypeOverrides(layer: GisLayerInfo, mappings?: GisFieldMapping[]): {
    option?: string;
    skippedFields: string[];
    numericFields: string[];
    stringFields: string[];
};
export declare function appendCrsOptions(args: string[], source: GisDatasetInfo, options: GisCrsOptions): void;
export declare function appendGeometryValidityOptions(args: string[], makeValid?: boolean): void;
export declare function buildKmlIdAttributeMapping(layer: GisLayerInfo, fieldMappings?: GisFieldMapping[]): GisFieldMapping | undefined;
export declare function formatConversionWarnings(output: string, sourceLayers?: GisLayerInfo[], fieldMappings?: GisFieldMapping[]): string[];
//# sourceMappingURL=index.d.ts.map