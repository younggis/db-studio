import type { DatabaseEngine } from "@db-studio/shared";
export interface SchemaColumn {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue: string | null;
    primaryKey: boolean;
    ordinalPosition: number;
}
export interface SchemaForeignKey {
    name: string;
    columns: string[];
    referencedSchema?: string;
    referencedTable: string;
    referencedColumns: string[];
}
export interface SchemaIndex {
    name: string;
    columns: string[];
    unique: boolean;
}
export interface SchemaTable {
    name: string;
    columns: SchemaColumn[];
    foreignKeys: SchemaForeignKey[];
    indexes: SchemaIndex[];
}
export interface SchemaSnapshot {
    engine: DatabaseEngine;
    schema: string;
    tables: SchemaTable[];
}
export type SchemaStatementKind = "create-table" | "drop-table" | "add-column" | "drop-column" | "alter-column" | "add-foreign-key" | "drop-foreign-key" | "create-index" | "drop-index";
export interface SchemaStatement {
    id: string;
    kind: SchemaStatementKind;
    table: string;
    reason: string;
    sql: string;
    risk: "low" | "medium" | "high";
    selected: boolean;
}
export interface SchemaDiffOptions {
    /** Include destructive statements (DROP TABLE/COLUMN/FK/INDEX). Default false. */
    includeDrops?: boolean;
}
export declare function diffSchemaSnapshots(source: SchemaSnapshot, target: SchemaSnapshot, options?: SchemaDiffOptions): SchemaStatement[];
//# sourceMappingURL=schema-diff.d.ts.map