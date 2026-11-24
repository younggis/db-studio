import oracledb from "oracledb";
import type { ExecuteOptions } from "oracledb";
import { type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { type DatabaseAdapter, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";
export interface OracleConnectionConfig {
    user: string;
    password: string;
    connectString: string;
    /** Oracle Net connection timeout, in seconds. */
    connectTimeout?: number;
    /** Maximum duration for each database round trip, in milliseconds. */
    callTimeout?: number;
}
export interface OracleQueryStreamOptions extends QueryStreamOptions {
    fetchTypeHandler?: ExecuteOptions["fetchTypeHandler"];
}
export declare function oracleConfigFromEnvironment(env?: NodeJS.ProcessEnv): OracleConnectionConfig;
export interface OracleSdoWkbValue {
    wkb: Buffer;
    srid: number | null;
    dimensions: 2 | 3 | 4;
}
/** Normalize OGC/ISO WKB dimensional type codes to the EWKB variant accepted by Oracle SDO_UTIL. */
export declare function normalizeWkbForOracleSdo(wkb: Uint8Array, expectedSrid: number | null): OracleSdoWkbValue;
export declare class OracleAdapter implements DatabaseAdapter {
    private readonly config;
    private connection?;
    constructor(config: OracleConnectionConfig);
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    query(sql: string, parameters?: unknown[], options?: Pick<ExecuteOptions, "fetchTypeHandler">): Promise<QueryResult>;
    queryStream(sql: string, parameters?: unknown[], options?: OracleQueryStreamOptions): AsyncGenerator<QueryResultBatch>;
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
    insertRowWithStreamedLobs(table: string, columns: string[], row: unknown[], schema?: string): Promise<number>;
    close(): Promise<void>;
    private connect;
    private defaultSchema;
}
export declare function oracleTransferFetchTypeHandler(metadata: Parameters<NonNullable<ExecuteOptions["fetchTypeHandler"]>>[0]): {
    type: oracledb.DbType & {
        num: 2001;
        name: "DB_TYPE_VARCHAR";
        columnTypeName: "VARCHAR2";
        oraTypeNum: 1;
        bufferSizeFactor: 4;
        csfrm: oracledb.CSFRM_IMPLICIT;
    };
} | {
    type: oracledb.DbType & {
        num: 2006;
        name: "DB_TYPE_RAW";
        columnTypeName: "RAW";
        oraTypeNum: 23;
        bufferSizeFactor: 1;
    };
} | undefined;
//# sourceMappingURL=oracle.d.ts.map