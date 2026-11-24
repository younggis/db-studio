import { type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";
export interface SqliteConnectionConfig {
    path: string;
    readOnly?: boolean;
}
export declare function sqliteConfigFromEnvironment(env?: NodeJS.ProcessEnv): SqliteConnectionConfig;
export declare class SqliteAdapter {
    private readonly database;
    constructor(config: SqliteConnectionConfig);
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    query(sql: string, parameters?: unknown[]): Promise<QueryResult>;
    queryStream(sql: string, parameters?: unknown[], options?: QueryStreamOptions): AsyncGenerator<QueryResultBatch>;
    updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]>;
    listDatabases(): Promise<string[]>;
    listSchemas(): Promise<string[]>;
    listTables(schema?: string): Promise<TableInfo[]>;
    getTableColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    getTableForeignKeys(table: string, schema?: string): Promise<import("@db-studio/shared").TableForeignKeyInfo[]>;
    readTable(table: string, schema?: string): Promise<QueryResult>;
    readTablePage(table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, schema?: string, options?: TableTransferReadOptions): Promise<QueryResult>;
    createTable(table: string, columns: ImportTableColumn[], schema?: string): Promise<void>;
    insertRows(table: string, columns: string[], rows: unknown[][], schema?: string): Promise<number>;
    close(): Promise<void>;
}
//# sourceMappingURL=sqlite.d.ts.map