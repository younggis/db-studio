import type { ColumnInfo, DatabaseEngine } from "@db-studio/shared";
export interface SpatialIndexDiagnostic {
    engine: DatabaseEngine;
    schema: string;
    table: string;
    spatialColumns: string[];
    hasSpatialColumn: boolean;
    severity: "info" | "warning";
    message: string;
    suggestionSql?: string;
    reasons: string[];
}
export declare function diagnoseSpatialIndex(input: {
    engine: DatabaseEngine;
    schema: string;
    table: string;
    columns: ColumnInfo[];
}): SpatialIndexDiagnostic;
//# sourceMappingURL=spatial-index-diagnostic.d.ts.map