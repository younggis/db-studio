import { databaseEngines } from "./database-engines.js";
import type { DatabaseEngine } from "./index.js";

export const MAX_QUERY_HISTORY_ENTRIES = 80;
export const MAX_QUERY_FAVORITES = 20;
export const MAX_QUERY_SQL_LENGTH = 5_000;

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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function validEngine(value: unknown): value is DatabaseEngine {
  return typeof value === "string" && (databaseEngines as readonly string[]).includes(value);
}

export function parseQueryExecutionRecord(value: unknown): QueryExecutionRecord {
  if (!isRecord(value)) throw new Error("查询历史记录格式无效。");
  const id = boundedString(value.id, 120);
  const connectionId = boundedString(value.connectionId, 200);
  const connectionName = boundedString(value.connectionName, 160);
  const sql = boundedString(value.sql, MAX_QUERY_SQL_LENGTH);
  if (!id?.trim() || !connectionId?.trim() || !connectionName?.trim() || !validEngine(value.engine) || !sql?.trim() || !validTimestamp(value.executedAt)) {
    throw new Error("查询历史记录缺少有效连接、SQL 或时间信息。");
  }
  if (value.outcome !== "success" && value.outcome !== "error") throw new Error("查询历史状态无效。");
  if (typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 86_400_000) {
    throw new Error("查询耗时无效。");
  }
  const rowCount = value.rowCount;
  if (rowCount !== undefined && (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0)) {
    throw new Error("查询行数无效。");
  }
  const command = value.command === undefined ? undefined : boundedString(value.command, 64);
  if (value.command !== undefined && command === undefined) throw new Error("查询命令过长。");
  return {
    id,
    connectionId,
    connectionName,
    engine: value.engine,
    sql,
    executedAt: new Date(value.executedAt).toISOString(),
    durationMs: value.durationMs,
    outcome: value.outcome,
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(command === undefined ? {} : { command }),
  };
}

export function parseQueryFavorite(value: unknown): QueryFavorite {
  if (!isRecord(value)) throw new Error("查询收藏格式无效。");
  const id = boundedString(value.id, 120);
  const title = boundedString(value.title, 160)?.trim();
  const connectionId = value.connectionId === undefined ? undefined : boundedString(value.connectionId, 200);
  const connectionName = boundedString(value.connectionName, 160);
  const sql = boundedString(value.sql, MAX_QUERY_SQL_LENGTH);
  if (!id?.trim() || !title || !connectionName?.trim() || !validEngine(value.engine) || !sql?.trim() || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) {
    throw new Error("查询收藏缺少有效标题、SQL 或时间信息。");
  }
  if (value.connectionId !== undefined && !connectionId?.trim()) throw new Error("查询收藏连接标识无效。");
  return {
    id,
    title: title.slice(0, 120),
    ...(connectionId ? { connectionId } : {}),
    connectionName,
    engine: value.engine,
    sql,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

export function createEmptyQueryHistorySnapshot(): QueryHistorySnapshot {
  return { version: 1, history: [], favorites: [] };
}

export function normalizeQueryHistorySnapshot(value: unknown): QueryHistorySnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.favorites)) {
    throw new Error("本机查询历史文件格式无效。");
  }
  const history: QueryExecutionRecord[] = [];
  for (const item of value.history.slice(0, MAX_QUERY_HISTORY_ENTRIES)) {
    try { history.push(parseQueryExecutionRecord(item)); } catch { /* Ignore individual damaged entries. */ }
  }
  const favorites: QueryFavorite[] = [];
  for (const item of value.favorites.slice(0, MAX_QUERY_FAVORITES)) {
    try { favorites.push(parseQueryFavorite(item)); } catch { /* Ignore individual damaged entries. */ }
  }
  return { version: 1, history, favorites };
}

export function appendQueryHistory(snapshot: QueryHistorySnapshot, input: unknown): QueryHistorySnapshot {
  const entry = parseQueryExecutionRecord(input);
  return {
    version: 1,
    history: [entry, ...snapshot.history.filter((item) => item.id !== entry.id)].slice(0, MAX_QUERY_HISTORY_ENTRIES),
    favorites: snapshot.favorites,
  };
}

export function clearQueryHistory(snapshot: QueryHistorySnapshot, connectionId?: string): QueryHistorySnapshot {
  return {
    version: 1,
    history: connectionId ? snapshot.history.filter((item) => item.connectionId !== connectionId) : [],
    favorites: snapshot.favorites,
  };
}

export function upsertQueryFavorite(snapshot: QueryHistorySnapshot, input: unknown): QueryHistorySnapshot {
  const favorite = parseQueryFavorite(input);
  return {
    version: 1,
    history: snapshot.history,
    favorites: [favorite, ...snapshot.favorites.filter((item) => item.id !== favorite.id)].slice(0, MAX_QUERY_FAVORITES),
  };
}

export function removeQueryFavorite(snapshot: QueryHistorySnapshot, id: string): QueryHistorySnapshot {
  return { version: 1, history: snapshot.history, favorites: snapshot.favorites.filter((item) => item.id !== id) };
}
