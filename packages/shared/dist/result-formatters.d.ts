/**
 * Query result formatters for copy/export operations
 *
 * Supports multiple output formats:
 * - Plain text (tab-delimited)
 * - CSV
 * - JSON
 * - SQL INSERT statements
 */
/**
 * Format selection as plain text (tab-delimited)
 */
export declare function formatSelectionAsPlainText(selectedData: Array<Array<unknown>>, delimiter?: string): string;
/**
 * Format selection as CSV
 */
export declare function formatSelectionAsCsv(selectedData: Array<Array<unknown>>, includeHeader?: boolean, columns?: string[]): string;
/**
 * Format selection as JSON array
 */
export declare function formatSelectionAsJson(selectedData: Array<Array<unknown>>, columns: string[], pretty?: boolean): string;
/**
 * Format selection as SQL INSERT statements
 */
export declare function formatSelectionAsInsert(selectedData: Array<Array<unknown>>, columns: string[], tableName: string, schemaName?: string): string;
/**
 * Format selection with column names (for copying with headers)
 */
export declare function formatSelectionWithHeaders(selectedData: Array<Array<unknown>>, columns: string[], delimiter?: string): string;
/**
 * Calculate selection statistics
 */
export interface SelectionStats {
    cellCount: number;
    rowCount: number;
    colCount: number;
    estimatedSize: number;
}
export declare function calculateSelectionStats(selectedData: Array<Array<unknown>>): SelectionStats;
/**
 * Check if selection is too large for copy
 */
export declare function isSelectionTooLarge(stats: SelectionStats, maxCells?: number, maxSize?: number): boolean;
//# sourceMappingURL=result-formatters.d.ts.map