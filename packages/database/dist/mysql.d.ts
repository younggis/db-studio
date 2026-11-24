import { type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { type DatabaseAdapter, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";
export interface MySqlConnectionConfig {
    host: string;
    port: number;
    user: string;
    password?: string;
    database?: string;
    connectTimeout?: number;
}
export declare function mysqlConfigFromEnvironment(env?: NodeJS.ProcessEnv): MySqlConnectionConfig;
export declare function mariaDbConfigFromEnvironment(env?: NodeJS.ProcessEnv): MySqlConnectionConfig;
export declare class MySqlAdapter implements DatabaseAdapter {
    protected readonly config: MySqlConnectionConfig;
    private connectionPromise?;
    constructor(config: MySqlConnectionConfig);
    protected get tableTransferEngine(): "mysql" | "mariadb";
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    query(sql: string, parameters?: unknown[]): Promise<QueryResult>;
    queryStream(sql: string, parameters?: unknown[], options?: QueryStreamOptions): AsyncGenerator<QueryResultBatch>;
    updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]>;
    listDatabases(): Promise<string[]>;
    listSchemas(): Promise<string[]>;
    listTables(schema?: string | undefined): Promise<TableInfo[]>;
    getTableColumns(table: string, schema?: string | undefined): Promise<ColumnInfo[]>;
    getTableForeignKeys(table: string, schema?: string | undefined): Promise<import("@db-studio/shared").TableForeignKeyInfo[]>;
    readTable(table: string, schema?: string | undefined): Promise<QueryResult>;
    readTablePage(table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, schema?: string | undefined, options?: TableTransferReadOptions): Promise<QueryResult>;
    createTable(table: string, columns: ImportTableColumn[], schema?: string | undefined): Promise<void>;
    insertRows(table: string, columns: string[], rows: unknown[][], schema?: string | undefined): Promise<number>;
    insertRowWithStreamedLobs(table: string, columns: string[], row: unknown[], schema?: string | undefined): Promise<number>;
    close(): Promise<void>;
    private getConnection;
}
export declare class MariaDbAdapter extends MySqlAdapter {
    protected get tableTransferEngine(): "mysql" | "mariadb";
    getTableColumns(table: string, schema?: string | undefined): Promise<ColumnInfo[]>;
}
//# sourceMappingURL=mysql.d.ts.map