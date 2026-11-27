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
export function formatSelectionAsPlainText(selectedData, delimiter = '\t') {
    if (selectedData.length === 0)
        return '';
    return selectedData
        .map(row => row.map(cell => formatCellValue(cell)).join(delimiter))
        .join('\n');
}
/**
 * Format selection as CSV
 */
export function formatSelectionAsCsv(selectedData, includeHeader = false, columns) {
    if (selectedData.length === 0)
        return '';
    const lines = [];
    // Add header if requested
    if (includeHeader && columns) {
        lines.push(columns.map(escapeCsvValue).join(','));
    }
    // Add data rows
    for (const row of selectedData) {
        lines.push(row.map(cell => escapeCsvValue(formatCellValue(cell))).join(','));
    }
    return lines.join('\n');
}
/**
 * Format selection as JSON array
 */
export function formatSelectionAsJson(selectedData, columns, pretty = true) {
    if (selectedData.length === 0)
        return '[]';
    const objects = selectedData.map(row => {
        const obj = {};
        row.forEach((cell, idx) => {
            if (idx < columns.length) {
                obj[columns[idx]] = cell;
            }
        });
        return obj;
    });
    return JSON.stringify(objects, null, pretty ? 2 : 0);
}
/**
 * Format selection as SQL INSERT statements
 */
export function formatSelectionAsInsert(selectedData, columns, tableName, schemaName) {
    if (selectedData.length === 0)
        return '';
    const qualifiedTable = schemaName
        ? `"${schemaName}"."${tableName}"`
        : `"${tableName}"`;
    const columnList = columns.map(c => `"${c}"`).join(', ');
    const values = selectedData
        .map(row => `  (${row.map(formatSqlValue).join(', ')})`)
        .join(',\n');
    return `INSERT INTO ${qualifiedTable} (${columnList})\nVALUES\n${values};`;
}
/**
 * Format selection with column names (for copying with headers)
 */
export function formatSelectionWithHeaders(selectedData, columns, delimiter = '\t') {
    if (selectedData.length === 0)
        return '';
    const header = columns.join(delimiter);
    const data = formatSelectionAsPlainText(selectedData, delimiter);
    return `${header}\n${data}`;
}
/**
 * Format a single cell value as string
 */
function formatCellValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (value instanceof Buffer) {
        // Format binary data as hex string
        return `0x${value.toString('hex')}`;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}
/**
 * Escape a value for CSV format
 */
function escapeCsvValue(value) {
    // If value contains comma, quote, or newline, wrap in quotes and escape quotes
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}
/**
 * Format a value for SQL INSERT statement
 */
function formatSqlValue(value) {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }
    if (value instanceof Buffer) {
        // Binary data as hex literal
        return `'\\x${value.toString('hex')}'`;
    }
    if (value instanceof Date) {
        return `'${value.toISOString()}'`;
    }
    if (typeof value === 'object') {
        // JSON data
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }
    // String: escape single quotes
    return `'${String(value).replace(/'/g, "''")}'`;
}
export function calculateSelectionStats(selectedData) {
    if (selectedData.length === 0) {
        return { cellCount: 0, rowCount: 0, colCount: 0, estimatedSize: 0 };
    }
    const rowCount = selectedData.length;
    const colCount = selectedData[0]?.length ?? 0;
    const cellCount = selectedData.reduce((sum, row) => sum + row.length, 0);
    // Estimate size (rough approximation)
    let estimatedSize = 0;
    for (const row of selectedData) {
        for (const cell of row) {
            if (cell === null || cell === undefined) {
                estimatedSize += 4; // "NULL"
            }
            else if (typeof cell === 'string') {
                estimatedSize += cell.length;
            }
            else if (typeof cell === 'number') {
                estimatedSize += 8;
            }
            else if (cell instanceof Buffer) {
                estimatedSize += cell.length * 2; // hex representation
            }
            else {
                estimatedSize += JSON.stringify(cell).length;
            }
        }
    }
    return { cellCount, rowCount, colCount, estimatedSize };
}
/**
 * Check if selection is too large for copy
 */
export function isSelectionTooLarge(stats, maxCells = 10_000, maxSize = 10_000_000 // 10 MB
) {
    return stats.cellCount > maxCells || stats.estimatedSize > maxSize;
}
//# sourceMappingURL=result-formatters.js.map