import type { SpatialTransferValue } from "./index.js";
/** Detects SpatiaLite's native geometry BLOB header. */
export declare function isSpatiaLiteGeometryBlob(value: unknown): value is Uint8Array;
/**
 * Decodes a SpatiaLite-native geometry BLOB into standard WKB plus its SRID.
 * Supports the uncompressed and the lossy float32-delta compressed variants,
 * XY/XYZ/XYM/XYZM, and all seven geometry types.
 */
export declare function decodeSpatiaLiteGeometry(value: unknown): SpatialTransferValue | null;
/** Wraps standard WKB in an uncompressed SpatiaLite geometry BLOB. */
export declare function encodeSpatiaLiteGeometry(value: Uint8Array, srid: number): Buffer;
//# sourceMappingURL=spatialite.d.ts.map