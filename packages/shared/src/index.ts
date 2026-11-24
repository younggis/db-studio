import { databaseEngines } from "./database-engines.js";
export { schemaTableKey } from "./schema-table-key.js";
export { databaseEngines };
export { oracleSdo2dWkbToDimensionalWkb } from "./oracle-gis-wkb.js";
export { decodeGeoPackageGeometry, encodeGeoPackageGeometry, importColumnTypeFromSqliteDeclaration } from "./geopackage.js";
export { decodeSpatiaLiteGeometry, encodeSpatiaLiteGeometry, isSpatiaLiteGeometryBlob } from "./spatialite.js";

export type DatabaseEngine = (typeof databaseEngines)[number];

export interface DatabaseCapabilities {
  sql: boolean;
  documents: boolean;
  schemas: boolean;
  spatial: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  command?: string;
}

export interface QueryResultBatch {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Number of rows in this batch, or affected rows for a non-row statement. */
  rowCount: number;
  command?: string;
}

/** A database value that must be consumed as a stream by queryStream callers. */
export interface QueryStreamCell {
  readonly __dbStudioQueryStreamCell: true;
  /** UTF-8 text is emitted as a JSON string; binary data follows Buffer.toJSON(). */
  readonly encoding: "utf8" | "buffer";
  readonly stream: AsyncIterable<string | Uint8Array>;
  destroy(): void;
}

export function isQueryStreamCell(value: unknown): value is QueryStreamCell {
  if (!value || typeof value !== "object") return false;
  const cell = value as Partial<QueryStreamCell>;
  return cell.__dbStudioQueryStreamCell === true
    && (cell.encoding === "utf8" || cell.encoding === "buffer")
    && typeof cell.stream?.[Symbol.asyncIterator] === "function"
    && typeof cell.destroy === "function";
}

export interface QueryStreamOptions {
  /** Maximum rows retained by the adapter before yielding to its consumer. */
  batchSize?: number;
  signal?: AbortSignal;
}

export interface ParameterizedSqlStatement {
  sql: string;
  parameters: unknown[];
}

export interface TableRowChange {
  primaryKeyValues: Record<string, unknown>;
  values: Record<string, unknown>;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: "table" | "view";
  comment?: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  /** Maximum declared string/binary length where the engine exposes it; -1 means MAX. */
  maximumLength?: number | null;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  ordinalPosition: number;
  comment?: string | null;
}

export interface TableForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
}

export { parseTabularData, queryResultToCsv } from "./format.js";
export type { TabularData } from "./format.js";
export { parseExcelWorkbook, queryResultToXlsx } from "./spreadsheet.js";
export {
  appendQueryHistory,
  clearQueryHistory,
  createEmptyQueryHistorySnapshot,
  normalizeQueryHistorySnapshot,
  parseQueryExecutionRecord,
  parseQueryFavorite,
  removeQueryFavorite,
  upsertQueryFavorite,
  MAX_QUERY_HISTORY_ENTRIES,
  MAX_QUERY_FAVORITES,
  MAX_QUERY_SQL_LENGTH,
} from "./query-history.js";
export type { QueryExecutionRecord, QueryFavorite, QueryHistorySnapshot } from "./query-history.js";

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  ordinalPosition: number;
}

export interface SpatialTransferValue {
  kind: "db-studio-spatial-wkb";
  spatialType: "geometry" | "geography";
  wkb: Uint8Array;
  srid: number | null;
}

export function isSpatialTransferValue(value: unknown): value is SpatialTransferValue {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SpatialTransferValue>;
  return candidate.kind === "db-studio-spatial-wkb"
    && (candidate.spatialType === "geometry" || candidate.spatialType === "geography")
    && candidate.wkb instanceof Uint8Array
    && (candidate.srid === null || Number.isSafeInteger(candidate.srid));
}

export interface ConnectionSummary {
  name: string;
  engine: DatabaseEngine;
  source: "environment" | "saved";
  host?: string;
  port?: number;
  database?: string;
  path?: string;
}
