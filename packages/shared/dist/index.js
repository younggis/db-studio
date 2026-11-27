import { databaseEngines } from "./database-engines.js";
export { schemaTableKey } from "./schema-table-key.js";
export { databaseEngines };
export { oracleSdo2dWkbToDimensionalWkb } from "./oracle-gis-wkb.js";
export { decodeGeoPackageGeometry, encodeGeoPackageGeometry, importColumnTypeFromSqliteDeclaration } from "./geopackage.js";
export { decodeSpatiaLiteGeometry, encodeSpatiaLiteGeometry, isSpatiaLiteGeometryBlob } from "./spatialite.js";
export { parseWkbToGeojson, batchParseWkb, getWkbGeometryType } from "./wkb-geojson.js";
export function isQueryStreamCell(value) {
    if (!value || typeof value !== "object")
        return false;
    const cell = value;
    return cell.__dbStudioQueryStreamCell === true
        && (cell.encoding === "utf8" || cell.encoding === "buffer")
        && typeof cell.stream?.[Symbol.asyncIterator] === "function"
        && typeof cell.destroy === "function";
}
export { parseTabularData, queryResultToCsv } from "./format.js";
export { formatSelectionAsPlainText, formatSelectionAsCsv, formatSelectionAsJson, formatSelectionAsInsert, formatSelectionWithHeaders, calculateSelectionStats, isSelectionTooLarge, } from "./result-formatters.js";
export { parseExcelWorkbook, queryResultToXlsx } from "./spreadsheet.js";
export { appendQueryHistory, clearQueryHistory, createEmptyQueryHistorySnapshot, normalizeQueryHistorySnapshot, parseQueryExecutionRecord, parseQueryFavorite, removeQueryFavorite, upsertQueryFavorite, MAX_QUERY_HISTORY_ENTRIES, MAX_QUERY_FAVORITES, MAX_QUERY_SQL_LENGTH, } from "./query-history.js";
export function isSpatialTransferValue(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    return candidate.kind === "db-studio-spatial-wkb"
        && (candidate.spatialType === "geometry" || candidate.spatialType === "geography")
        && candidate.wkb instanceof Uint8Array
        && (candidate.srid === null || Number.isSafeInteger(candidate.srid));
}
//# sourceMappingURL=index.js.map