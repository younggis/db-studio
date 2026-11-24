import { isQueryStreamCell, queryResultToCsv } from "@db-studio/shared";
export function formatQueryResult(result, format) {
    if (format === "json") {
        return JSON.stringify({ columns: result.columns, rows: result.rows, rowCount: result.rowCount }, null, 2);
    }
    if (format === "ndjson") {
        return result.rows.map((row) => JSON.stringify(row)).join("\n");
    }
    if (format === "csv") {
        return queryResultToCsv(result);
    }
    const widths = result.columns.map((column) => Math.min(40, column.length));
    const rows = result.rows.map((row) => result.columns.map((column, index) => {
        const value = displayCell(row[column]).replace(/\r?\n/g, "↵");
        widths[index] = Math.min(40, Math.max(widths[index] ?? 0, value.length));
        return value;
    }));
    const renderRow = (cells) => "| " + cells.map((cell, index) => padCell(cell, widths[index] ?? 0)).join(" | ") + " |";
    const separator = "| " + widths.map((width) => "-".repeat(width)).join(" | ") + " |";
    const output = [renderRow(result.columns), separator, ...rows.map(renderRow)];
    output.push("(" + String(result.rowCount) + " rows)");
    return output.join("\n");
}
export async function writeQueryResultNdjsonStream(batches, output, signal) {
    let rowCount = 0;
    for await (const batch of batches) {
        for (const row of batch.rows) {
            if (signal?.aborted)
                throw new Error("Query streaming was cancelled.");
            await writeNdjsonRow(row, output, signal);
            rowCount += 1;
        }
    }
    return rowCount;
}
async function writeNdjsonRow(row, output, signal) {
    await writeOutput(output, "{", signal);
    let first = true;
    for (const [key, value] of Object.entries(row)) {
        if (value === undefined || typeof value === "function" || typeof value === "symbol")
            continue;
        if (!first)
            await writeOutput(output, ",", signal);
        first = false;
        await writeOutput(output, JSON.stringify(key) + ":", signal);
        if (isQueryStreamCell(value))
            await writeQueryStreamCell(value, output, signal);
        else
            await writeOutput(output, JSON.stringify(value) ?? "null", signal);
    }
    await writeOutput(output, "}\n", signal);
}
async function writeQueryStreamCell(cell, output, signal) {
    try {
        if (cell.encoding === "utf8") {
            await writeOutput(output, "\"", signal);
            const decoder = new TextDecoder("utf-8", { fatal: true });
            for await (const chunk of cell.stream) {
                const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
                if (text)
                    await writeOutput(output, escapeJsonStringChunk(text), signal);
            }
            const remainder = decoder.decode();
            if (remainder)
                await writeOutput(output, escapeJsonStringChunk(remainder), signal);
            await writeOutput(output, "\"", signal);
        }
        else {
            await writeOutput(output, "{\"type\":\"Buffer\",\"data\":[", signal);
            let first = true;
            for await (const chunk of cell.stream) {
                if (typeof chunk === "string")
                    throw new Error("Oracle BLOB stream returned text data.");
                const bytes = Array.from(chunk, (value) => String(value));
                if (bytes.length) {
                    await writeOutput(output, (first ? "" : ",") + bytes.join(","), signal);
                    first = false;
                }
            }
            await writeOutput(output, "]}", signal);
        }
    }
    finally {
        cell.destroy();
    }
}
function escapeJsonStringChunk(value) {
    let escaped = "";
    for (const character of value) {
        switch (character) {
            case "\\":
                escaped += "\\\\";
                break;
            case "\"":
                escaped += "\\\"";
                break;
            case "\b":
                escaped += "\\b";
                break;
            case "\f":
                escaped += "\\f";
                break;
            case "\n":
                escaped += "\\n";
                break;
            case "\r":
                escaped += "\\r";
                break;
            case "\t":
                escaped += "\\t";
                break;
            default: {
                const codePoint = character.codePointAt(0);
                escaped += codePoint < 0x20 ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
            }
        }
    }
    return escaped;
}
async function writeOutput(output, chunk, signal) {
    if (signal?.aborted)
        throw new Error("Query streaming was cancelled.");
    if (!output.write(chunk))
        await waitForWritableDrain(output, signal);
}
function waitForWritableDrain(output, signal) {
    if (signal?.aborted)
        return Promise.reject(new Error("Query streaming was cancelled."));
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            output.removeListener("drain", onDrain);
            output.removeListener("error", onError);
            output.removeListener("close", onClose);
            signal?.removeEventListener("abort", onAbort);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("Query output stream closed before it could drain."));
        };
        const onAbort = () => {
            cleanup();
            reject(new Error("Query streaming was cancelled."));
        };
        output.once("drain", onDrain);
        output.once("error", onError);
        output.once("close", onClose);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}
function displayCell(value) {
    if (value === null || value === undefined)
        return "NULL";
    if (typeof value === "string")
        return value;
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
function padCell(value, width) {
    const shortened = value.length > width ? value.slice(0, Math.max(0, width - 1)) + "…" : value;
    return shortened.padEnd(width, " ");
}
//# sourceMappingURL=format.js.map