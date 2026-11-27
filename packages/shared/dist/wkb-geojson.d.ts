/**
 * WKB (Well-Known Binary) to GeoJSON converter
 *
 * Supports standard OGC WKB and PostGIS Extended WKB (EWKB) formats.
 * Handles 2D, 3D (Z), M, and 4D (ZM) geometries.
 */
export interface GeoJSONGeometry {
    type: string;
    coordinates: any;
    bbox?: [number, number, number, number];
}
export interface WkbParseOptions {
    /** Maximum recursion depth for nested geometries (default: 32) */
    maxDepth?: number;
    /** Include SRID in output metadata (default: true) */
    includeSrid?: boolean;
}
export interface WkbParseResult {
    geometry: GeoJSONGeometry;
    srid?: number | null;
    hasZ: boolean;
    hasM: boolean;
    coordinateDimension: 2 | 3 | 4;
}
/**
 * Parse WKB (Well-Known Binary) to GeoJSON
 *
 * @param wkb - WKB data as Buffer or hex string
 * @param options - Parse options
 * @returns Parsed geometry with metadata
 *
 * @example
 * ```typescript
 * const result = parseWkbToGeojson(buffer);
 * console.log(result.geometry); // GeoJSON geometry
 * console.log(result.srid);     // SRID if present
 * console.log(result.hasZ);     // true if 3D
 * ```
 */
export declare function parseWkbToGeojson(wkb: Buffer | string, options?: WkbParseOptions): WkbParseResult;
/**
 * Batch parse multiple WKB values, skipping nulls and errors
 *
 * @param wkbs - Array of WKB values (Buffer, hex string, or null)
 * @param maxCount - Maximum number to parse (default: 5000)
 * @returns Array of parse results or null for failed/null inputs
 */
export declare function batchParseWkb(wkbs: Array<Buffer | string | null>, maxCount?: number): Array<WkbParseResult | null>;
/**
 * Extract geometry type name from WKB without full parsing
 *
 * @param wkb - WKB data
 * @returns Geometry type name or null if parsing fails
 */
export declare function getWkbGeometryType(wkb: Buffer | string): string | null;
//# sourceMappingURL=wkb-geojson.d.ts.map