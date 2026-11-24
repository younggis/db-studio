import type { DatabaseEngine } from "@db-studio/shared";
import type { GisSpatialExtent } from "@db-studio/gis";
export interface SpatialPredicate {
    sql: string;
    parameters: unknown[];
}
/** Build a WHERE-fragment predicate for a source-CRS rectangle. */
export declare function spatialFilterPredicate(engine: DatabaseEngine, geometryColumn: string, extent: GisSpatialExtent): SpatialPredicate;
export declare function validateExtent(extent: GisSpatialExtent): void;
//# sourceMappingURL=spatial-filter-sql.d.ts.map