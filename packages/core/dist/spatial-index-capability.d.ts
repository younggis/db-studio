import type { DatabaseEngine } from "@db-studio/shared";
export interface SpatialIndexCapability {
    create: boolean;
    append: boolean;
    overwrite: boolean;
    notes: string[];
}
export declare function spatialIndexCapability(engine: DatabaseEngine): SpatialIndexCapability;
export declare function assertSpatialIndexSupported(engine: DatabaseEngine, mode: "create" | "append" | "overwrite"): void;
//# sourceMappingURL=spatial-index-capability.d.ts.map