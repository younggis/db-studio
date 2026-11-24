import { type ColumnInfo, type DatabaseEngine, type SpatialTransferValue } from "@db-studio/shared";
export declare function spatialTypeOf(dataType: string, engine?: DatabaseEngine): SpatialTransferValue["spatialType"] | undefined;
export declare function supportsSpatialTransfer(engine: DatabaseEngine | undefined, spatialType: SpatialTransferValue["spatialType"]): boolean;
export interface SpatialTransferConversionOptions {
    /** Retag geometry as geography (or back). The caller must ensure a valid geographic SRID; the destination engine still enforces its CRS rules. */
    allowSpatialTypeConversion?: boolean;
}
export declare function convertTransferValue(value: unknown, source: ColumnInfo, target: ColumnInfo, sourceEngine?: DatabaseEngine, targetEngine?: DatabaseEngine, options?: SpatialTransferConversionOptions): unknown;
//# sourceMappingURL=table-transfer-conversion.d.ts.map