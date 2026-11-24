export function queryResultToCsv(result, options = {}) {
    const lines = [result.columns.map((column) => csvCell(column, options.spreadsheetSafe)).join(",")];
    for (const row of result.rows) {
        lines.push(result.columns.map((column) => csvCell(row[column], options.spreadsheetSafe, options.nullValue)).join(","));
    }
    return lines.join("\n");
}
function csvCell(value, spreadsheetSafe = false, nullValue) {
    if (value === null || value === undefined)
        return nullValue ?? "";
    let text = displayCell(value);
    if (spreadsheetSafe &&
        typeof value === "string" &&
        /^[\t\r ]*[=+\-@]/.test(text)) {
        text = `'${text}`;
    }
    return /[",\r\n]/.test(text) || (nullValue !== undefined && text === nullValue)
        ? `"${text.replaceAll('"', '""')}"`
        : text;
}
function displayCell(value) {
    if (typeof value === "string")
        return value;
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
export function parseTabularData(content, format, options = {}) {
    if (format === "json")
        return parseJsonData(content);
    return parseCsvData(content, options.nullValue ?? "\\N");
}
function parseJsonData(content) {
    let value;
    try {
        value = JSON.parse(content.replace(/^\uFEFF/, ""));
    }
    catch (error) {
        throw new Error(`Invalid JSON data: ${error instanceof Error ? error.message : "parse error"}`);
    }
    let columns;
    let rowsValue;
    if (Array.isArray(value)) {
        rowsValue = value;
        const firstRow = value[0];
        if (isRecord(firstRow))
            columns = Object.keys(firstRow);
        else if (value.length === 0)
            throw new Error("JSON array is empty and has no column names.");
        else
            throw new Error("JSON data must be an array of objects.");
    }
    else if (isRecord(value) && Array.isArray(value.columns) && Array.isArray(value.rows)) {
        columns = value.columns.map((column) => String(column));
        rowsValue = value.rows;
    }
    else {
        throw new Error("JSON data must be an array of objects or a query-result object with columns and rows.");
    }
    validateColumns(columns);
    const rawRows = rowsValue;
    const rows = rawRows.map((row, index) => {
        if (!isRecord(row))
            throw new Error(`JSON row ${index + 1} must be an object.`);
        const rowColumns = Object.keys(row);
        if (rowColumns.length !== columns.length || columns.some((column) => !Object.hasOwn(row, column))) {
            throw new Error(`JSON row ${index + 1} must contain exactly the columns: ${columns.join(", ")}.`);
        }
        return Object.fromEntries(columns.map((column) => [column, row[column]]));
    });
    return { columns, rows };
}
function parseCsvData(content, nullValue) {
    if (!nullValue)
        throw new Error("CSV null marker must not be empty.");
    const input = content.replace(/^\uFEFF/, "");
    const records = [];
    let record = [];
    let field = "";
    let inQuotes = false;
    let wasQuoted = false;
    let endedAtRecordBoundary = false;
    const finishField = () => {
        record.push({ value: field, quoted: wasQuoted });
        field = "";
        wasQuoted = false;
    };
    const finishRecord = () => {
        finishField();
        records.push(record);
        record = [];
        endedAtRecordBoundary = true;
    };
    for (let index = 0; index < input.length;) {
        const character = input[index];
        if (inQuotes) {
            if (character === '"' && input[index + 1] === '"') {
                field += '"';
                index += 2;
            }
            else if (character === '"') {
                inQuotes = false;
                index += 1;
            }
            else {
                field += character;
                index += 1;
            }
            endedAtRecordBoundary = false;
            continue;
        }
        if (character === '"') {
            if (field.length > 0)
                throw new Error("CSV quotes may only begin at the start of a field.");
            inQuotes = true;
            wasQuoted = true;
            endedAtRecordBoundary = false;
            index += 1;
        }
        else if (character === ",") {
            finishField();
            endedAtRecordBoundary = false;
            index += 1;
        }
        else if (character === "\n" || character === "\r") {
            finishRecord();
            if (character === "\r" && input[index + 1] === "\n")
                index += 2;
            else
                index += 1;
        }
        else {
            field += character;
            endedAtRecordBoundary = false;
            index += 1;
        }
    }
    if (inQuotes)
        throw new Error("CSV contains an unterminated quoted field.");
    if (!endedAtRecordBoundary && (field.length > 0 || record.length > 0 || input.length > 0))
        finishRecord();
    if (records.length === 0)
        throw new Error("CSV file is empty.");
    const columns = records[0].map((cell) => cell.value);
    validateColumns(columns);
    const rows = records.slice(1).map((cells, index) => {
        if (cells.length !== columns.length) {
            throw new Error(`CSV row ${index + 2} has ${cells.length} values; expected ${columns.length}.`);
        }
        return Object.fromEntries(columns.map((column, columnIndex) => {
            const cell = cells[columnIndex];
            return [column, !cell.quoted && cell.value === nullValue ? null : cell.value];
        }));
    });
    return { columns, rows };
}
function validateColumns(columns) {
    if (columns.length === 0 || columns.some((column) => !column.trim())) {
        throw new Error("Data file must contain non-empty column names.");
    }
    if (new Set(columns).size !== columns.length) {
        throw new Error("Data file contains duplicate column names.");
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=format.js.map