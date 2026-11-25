import type { DatabaseEngine, ColumnInfo, TableForeignKeyInfo } from "@db-studio/shared";
export interface BackupTable {
    name: string;
    columns: ColumnInfo[];
    foreignKeys: TableForeignKeyInfo[];
    rows: Array<Record<string, unknown>>;
}
export interface BackupOptions {
    includeData?: boolean;
    /** Maximum rows emitted per INSERT statement for readable dumps. */
    batchSize?: number;
}
export declare function sqlLiteral(value: unknown, engine: DatabaseEngine): string;
export declare function buildCreateTableSql(engine: DatabaseEngine, schema: string, table: BackupTable): string;
export declare function buildInsertSql(engine: DatabaseEngine, schema: string, table: BackupTable, options?: BackupOptions): string[];
export declare function buildBackupSql(engine: DatabaseEngine, schema: string, tables: BackupTable[], options?: BackupOptions): string;
/** Split a SQL dump into executable statements, respecting quotes/comments. */
export declare function splitSqlStatements(sql: string): string[];
//# sourceMappingURL=logical-backup.d.ts.map