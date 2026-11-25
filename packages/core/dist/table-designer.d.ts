import type { DatabaseEngine } from "@db-studio/shared";
export interface DesignerColumn {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue: string | null;
    primaryKey: boolean;
}
export interface DesignerIndex {
    name: string;
    columns: string[];
    unique: boolean;
}
export interface DesignerForeignKey {
    name: string;
    columns: string[];
    referencedSchema?: string;
    referencedTable: string;
    referencedColumns: string[];
}
export interface DesignerTable {
    name: string;
    columns: DesignerColumn[];
    indexes: DesignerIndex[];
    foreignKeys: DesignerForeignKey[];
}
export declare function buildDesignerSql(engine: DatabaseEngine, schema: string, mode: "create" | "alter", table: DesignerTable, existingColumns?: string[]): string[];
//# sourceMappingURL=table-designer.d.ts.map