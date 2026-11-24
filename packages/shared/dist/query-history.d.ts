import type { DatabaseEngine } from "./index.js";
export declare const MAX_QUERY_HISTORY_ENTRIES = 80;
export declare const MAX_QUERY_FAVORITES = 20;
export declare const MAX_QUERY_SQL_LENGTH = 5000;
export interface QueryExecutionRecord {
    id: string;
    connectionId: string;
    connectionName: string;
    engine: DatabaseEngine;
    sql: string;
    executedAt: string;
    durationMs: number;
    outcome: "success" | "error";
    rowCount?: number;
    command?: string;
}
export interface QueryFavorite {
    id: string;
    title: string;
    connectionId?: string;
    connectionName: string;
    engine: DatabaseEngine;
    sql: string;
    createdAt: string;
    updatedAt: string;
}
export interface QueryHistorySnapshot {
    version: 1;
    history: QueryExecutionRecord[];
    favorites: QueryFavorite[];
}
export declare function parseQueryExecutionRecord(value: unknown): QueryExecutionRecord;
export declare function parseQueryFavorite(value: unknown): QueryFavorite;
export declare function createEmptyQueryHistorySnapshot(): QueryHistorySnapshot;
export declare function normalizeQueryHistorySnapshot(value: unknown): QueryHistorySnapshot;
export declare function appendQueryHistory(snapshot: QueryHistorySnapshot, input: unknown): QueryHistorySnapshot;
export declare function clearQueryHistory(snapshot: QueryHistorySnapshot, connectionId?: string): QueryHistorySnapshot;
export declare function upsertQueryFavorite(snapshot: QueryHistorySnapshot, input: unknown): QueryHistorySnapshot;
export declare function removeQueryFavorite(snapshot: QueryHistorySnapshot, id: string): QueryHistorySnapshot;
//# sourceMappingURL=query-history.d.ts.map