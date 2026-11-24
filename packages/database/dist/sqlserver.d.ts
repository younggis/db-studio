import { type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { type DatabaseAdapter, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";
export interface SqlServerConnectionConfig {
    server?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionString?: string;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    connectionTimeout?: number;
    requestTimeout?: number;
}
export declare function sqlServerConfigFromEnvironment(env?: NodeJS.ProcessEnv): SqlServerConnectionConfig;
export declare class SqlServerAdapter implements DatabaseAdapter {
    private readonly pool;
    private connection?;
    constructor(config: SqlServerConnectionConfig);
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    query(statement: string, parameters?: unknown[]): Promise<QueryResult>;
    queryStream(statement: string, parameters?: unknown[], options?: QueryStreamOptions): AsyncGenerator<QueryResultBatch>;
    updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]>;
    listDatabases(): Promise<string[]>;
    listSchemas(): Promise<string[]>;
    listTables(schema?: string): Promise<TableInfo[]>;
    getTableColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    getTableForeignKeys(table: string, schema?: string): Promise<import("@db-studio/shared").TableForeignKeyInfo[]>;
    readTable(table: string, schema?: string): Promise<QueryResult>;
    readTablePage(table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, schema?: string, options?: TableTransferReadOptions): Promise<QueryResult>;
    private readTablePageWithStreamedLobs;
    private createSqlServerLobCell;
    createTable(table: string, columns: ImportTableColumn[], schema?: string): Promise<void>;
    insertRows(table: string, columns: string[], rows: unknown[][], schema?: string): Promise<number>;
    insertRowWithStreamedLobs(table: string, columns: string[], row: unknown[], schema?: string): Promise<number>;
    close(): Promise<void>;
    private connect;
}
//# sourceMappingURL=sqlserver.d.ts.map