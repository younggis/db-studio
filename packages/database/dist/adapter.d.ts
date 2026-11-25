import type { ColumnInfo, DatabaseEngine, ParameterizedSqlStatement, QueryResult, QueryResultBatch, QueryStreamOptions, TableForeignKeyInfo, TableInfo, TableRowChange } from "@db-studio/shared";
export declare function queryStreamBatchSize(options?: QueryStreamOptions): number;
export declare function throwIfQueryStreamAborted(signal?: AbortSignal): void;
export declare function batchBufferedQueryResult(result: QueryResult, options?: QueryStreamOptions): AsyncGenerator<QueryResultBatch>;
export interface ForeignKeyMetadataRow {
    name: unknown;
    column_name: unknown;
    referenced_schema?: unknown;
    referenced_table: unknown;
    referenced_column: unknown;
}
export type ImportColumnType = "text" | "integer" | "real" | "boolean" | "date" | "time" | "datetime" | "json" | "binary";
export interface ImportTableColumn {
    name: string;
    type: ImportColumnType;
}
export interface TableTransferReadOptions {
    streamLobs?: boolean;
    streamLobColumns?: Record<string, "utf8" | "buffer">;
    exactNumericColumns?: string[];
    jsonTextColumns?: string[];
    spatialWkbColumns?: string[];
}
export declare function groupForeignKeyRows(rows: ForeignKeyMetadataRow[]): TableForeignKeyInfo[];
export interface DatabaseAdapter {
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    query(sql: string, parameters?: unknown[]): Promise<QueryResult>;
    queryStream(sql: string, parameters?: unknown[], options?: QueryStreamOptions): AsyncIterable<QueryResultBatch>;
    updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]>;
    listDatabases(): Promise<string[]>;
    listSchemas(): Promise<string[]>;
    listTables(schema?: string, options?: {
        limit?: number;
    }): Promise<TableInfo[]>;
    listTables(schema?: string): Promise<TableInfo[]>;
    getTableColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    getTableForeignKeys(table: string, schema?: string): Promise<TableForeignKeyInfo[]>;
    readTable(table: string, schema?: string): Promise<QueryResult>;
    readTablePage(table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, schema?: string, options?: TableTransferReadOptions): Promise<QueryResult>;
    createTable(table: string, columns: ImportTableColumn[], schema?: string): Promise<void>;
    insertRows(table: string, columns: string[], rows: unknown[][], schema?: string): Promise<number>;
    insertRowWithStreamedLobs?(table: string, columns: string[], row: unknown[], schema?: string): Promise<number>;
    close(): Promise<void>;
}
export declare function buildCreateTableStatement(engine: DatabaseEngine, table: string, columns: ImportTableColumn[], schema: string): string;
export declare function validateUpdateStatements(input: ParameterizedSqlStatement[]): ParameterizedSqlStatement[];
export declare function assertSingleRowAffected(rowCount: number): void;
export declare function buildTableTransferPageQuery(engine: DatabaseEngine, schema: string, table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, options?: TableTransferReadOptions): {
    sql: string;
    parameters: unknown[];
    spatialSridAliases?: Record<string, string>;
    spatialGtypeAliases?: Record<string, string>;
    spatialVerticesAliases?: Record<string, string>;
};
export declare function buildTableUpdateStatements(engine: DatabaseEngine, schema: string, table: string, columns: ColumnInfo[], changes: TableRowChange[]): ParameterizedSqlStatement[];
//# sourceMappingURL=adapter.d.ts.map