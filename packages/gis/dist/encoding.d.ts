export type EncodingSource = "metadata" | "format" | "user" | "heuristic" | "ascii-compatible" | "unknown";
export interface EncodingDetectionResult {
    declaredEncoding?: string;
    detectedEncoding?: string;
    source: EncodingSource;
    confidence: number | null;
    warnings: string[];
}
export interface PreparedGisInput {
    path: string;
    env: NodeJS.ProcessEnv;
    openOptions?: string[];
    warnings?: string[];
    cleanup(): Promise<void>;
}
export declare function isVirtualZipPath(filePath: string): boolean;
export declare function normalizeTextEncoding(value: string): string;
export declare function toGdalEncodingName(value: string): string;
export declare function detectGisEncoding(filePath: string, userOverride?: string): Promise<EncodingDetectionResult>;
export declare function effectiveSourceEncoding(result: EncodingDetectionResult): string | undefined;
export declare function encodingForGisDriver(driverShortName: string, result: EncodingDetectionResult): EncodingDetectionResult;
export declare function prepareGisInput(filePath: string, encoding: string | undefined, baseEnvironment: NodeJS.ProcessEnv, zipFilenameEncoding?: string, replaceIncompleteUtf8Tails?: boolean): Promise<PreparedGisInput>;
export interface InvalidDbfUtf8Field {
    recordNumber: number;
    fieldName: string;
}
export declare function findInvalidDbfUtf8Field(shapefilePath: string): Promise<InvalidDbfUtf8Field | undefined>;
//# sourceMappingURL=encoding.d.ts.map