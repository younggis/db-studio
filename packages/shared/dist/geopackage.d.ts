import type { SpatialTransferValue } from "./index.js";
/** Extracts standard WKB and its GeoPackage SRS id from a GeoPackage geometry blob. */
export declare function decodeGeoPackageGeometry(value: unknown): SpatialTransferValue | null;
/** Wraps standard WKB in the minimal GeoPackage binary header without an envelope. */
export declare function encodeGeoPackageGeometry(value: unknown, srsId: number, empty?: boolean): Buffer;
export declare function importColumnTypeFromSqliteDeclaration(dataType: string): "text" | "integer" | "real" | "boolean" | "date" | "time" | "datetime" | "json" | "binary";
//# sourceMappingURL=geopackage.d.ts.map