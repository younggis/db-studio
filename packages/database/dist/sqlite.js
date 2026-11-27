import { DatabaseSync } from "node:sqlite";
import { decodeGeoPackageGeometry, decodeSpatiaLiteGeometry, encodeGeoPackageGeometry, encodeSpatiaLiteGeometry, isSpatiaLiteGeometryBlob, isSpatialTransferValue } from "@db-studio/shared";
import { assertSingleRowAffected, buildCreateTableStatement, buildTableTransferPageQuery, groupForeignKeyRows, queryStreamBatchSize, throwIfQueryStreamAborted, validateUpdateStatements } from "./adapter.js";
export function sqliteConfigFromEnvironment(env = process.env) {
    const path = env.DBSTUDIO_SQLITE_PATH?.trim();
    if (!path) {
        throw new Error("Set DBSTUDIO_SQLITE_PATH to the SQLite database file path.");
    }
    return { path };
}
export class SqliteAdapter {
    database;
    constructor(config) {
        if (!config.path.trim())
            throw new Error("SQLite database path cannot be empty.");
        this.database = new DatabaseSync(config.path, { readOnly: config.readOnly ?? false });
    }
    async testConnection() {
        const row = this.database.prepare("SELECT sqlite_version() AS version").get();
        if (!row)
            throw new Error("SQLite did not return its version.");
        return {
            database: this.database.location() ?? ":memory:",
            serverVersion: row.version,
        };
    }
    async query(sql, parameters = []) {
        const startTime = new Date();
        let status = 'success';
        let errorMessage;
        try {
            const statement = this.database.prepare(sql);
            const bindings = normalizeParameters(parameters);
            const columns = statement.columns().map((column) => column.name);
            const command = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
            const endTime = new Date();
            if (columns.length > 0) {
                const rows = statement.all(...bindings);
                const rowCount = rows.length;
                return {
                    columns,
                    rows,
                    rowCount,
                    command,
                    metrics: {
                        startTime,
                        endTime,
                        duration: endTime.getTime() - startTime.getTime(),
                        rowCount,
                        affectedRows: command !== 'SELECT' ? rowCount : undefined,
                        status: 'success',
                    },
                };
            }
            const result = statement.run(...bindings);
            const affectedRows = Number(result.changes);
            return {
                columns: [],
                rows: [],
                rowCount: affectedRows,
                command,
                metrics: {
                    startTime,
                    endTime,
                    duration: endTime.getTime() - startTime.getTime(),
                    rowCount: affectedRows,
                    affectedRows,
                    status: 'success',
                },
            };
        }
        catch (error) {
            const endTime = new Date();
            status = 'error';
            errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const enhancedError = error;
            enhancedError.metrics = {
                startTime,
                endTime,
                duration: endTime.getTime() - startTime.getTime(),
                rowCount: 0,
                status,
                errorMessage,
            };
            throw enhancedError;
        }
    }
    async *queryStream(sql, parameters = [], options = {}) {
        const statement = this.database.prepare(sql);
        const bindings = normalizeParameters(parameters);
        const columns = statement.columns().map((column) => column.name);
        const command = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
        if (columns.length === 0) {
            const result = statement.run(...bindings);
            throwIfQueryStreamAborted(options.signal);
            yield { columns: [], rows: [], rowCount: Number(result.changes), command };
            return;
        }
        const batchSize = queryStreamBatchSize(options);
        let rows = [];
        let yielded = false;
        for (const row of statement.iterate(...bindings)) {
            throwIfQueryStreamAborted(options.signal);
            rows.push(row);
            if (rows.length < batchSize)
                continue;
            yielded = true;
            yield { columns, rows, rowCount: rows.length, command };
            rows = [];
            await new Promise((resolve) => setImmediate(resolve));
        }
        throwIfQueryStreamAborted(options.signal);
        if (rows.length > 0 || !yielded)
            yield { columns, rows, rowCount: rows.length, command };
    }
    async updateRows(statements) {
        const batch = validateUpdateStatements(statements);
        if (batch.length === 0)
            return [];
        this.database.exec("BEGIN IMMEDIATE");
        const results = [];
        try {
            for (const statement of batch) {
                const result = this.database.prepare(statement.sql).run(...normalizeParameters(statement.parameters));
                const rowCount = Number(result.changes);
                assertSingleRowAffected(rowCount);
                results.push({
                    columns: [],
                    rows: [],
                    rowCount,
                    command: "UPDATE",
                });
            }
            this.database.exec("COMMIT");
            return results;
        }
        catch (error) {
            try {
                this.database.exec("ROLLBACK");
            }
            catch { /* Preserve the update error if rollback itself fails. */ }
            throw error;
        }
    }
    async listDatabases() {
        const rows = this.database.prepare("PRAGMA database_list").all();
        return rows.map((row) => row.name);
    }
    async listSchemas() {
        const databases = await this.listDatabases();
        return [...new Set([...databases, "temp"])];
    }
    async listTables(schema = "main") {
        const databaseNames = await this.listDatabases();
        if (schema !== "temp" && !databaseNames.includes(schema)) {
            throw new Error(`SQLite schema '${schema}' is not attached to this connection.`);
        }
        const identifier = `"${schema.replaceAll('"', '""')}"`;
        const rows = this.database
            .prepare(`SELECT name, type FROM ${identifier}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
            .all();
        return rows.map((row) => ({
            schema,
            name: row.name,
            type: row.type === "view" ? "view" : "table",
        }));
    }
    async getTableColumns(table, schema = "main") {
        const databaseNames = await this.listDatabases();
        if (schema !== "temp" && !databaseNames.includes(schema)) {
            throw new Error(`SQLite schema '${schema}' is not attached to this connection.`);
        }
        const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
        const quotedTable = `"${table.replaceAll('"', '""')}"`;
        const rows = this.database
            .prepare(`PRAGMA ${quotedSchema}.table_xinfo(${quotedTable})`)
            .all();
        if (rows.length === 0) {
            throw new Error(`SQLite table or view '${schema}.${table}' was not found.`);
        }
        return rows.filter((row) => row.hidden !== 1).map((row) => ({
            name: row.name,
            dataType: row.type,
            nullable: row.notnull === 0 && row.pk === 0,
            defaultValue: row.dflt_value === null || row.dflt_value === undefined
                ? null
                : String(row.dflt_value),
            primaryKey: row.pk > 0,
            ordinalPosition: Number(row.cid) + 1,
        }));
    }
    async getTableForeignKeys(table, schema = "main") {
        const databaseNames = await this.listDatabases();
        if (schema !== "temp" && !databaseNames.includes(schema))
            throw new Error("SQLite schema '" + schema + "' is not attached to this connection.");
        const quotedSchema = "\"" + schema.replaceAll("\"", "\"\"") + "\"";
        const quotedTable = "\"" + table.replaceAll("\"", "\"\"") + "\"";
        const sql = "PRAGMA " + quotedSchema + ".foreign_key_list(" + quotedTable + ")";
        const rows = this.database.prepare(sql).all();
        return groupForeignKeyRows(rows.sort((a, b) => a.id - b.id || a.seq - b.seq).map((row) => ({
            name: "fk_" + row.id,
            column_name: row.from,
            referenced_schema: schema,
            referenced_table: row.table,
            referenced_column: row.to,
        })));
    }
    async readTable(table, schema = "main") {
        const quotedSchema = quoteIdentifier(schema);
        const quotedTable = quoteIdentifier(table);
        return this.query(`SELECT * FROM ${quotedSchema}.${quotedTable}`);
    }
    async readTablePage(table, columns, primaryKeys, cursor, limit, schema = "main", options = {}) {
        const query = buildTableTransferPageQuery("sqlite", schema, table, columns, primaryKeys, cursor, limit, options);
        const result = await this.query(query.sql, query.parameters);
        const spatialColumns = options.spatialWkbColumns ?? [];
        if (!spatialColumns.length)
            return result;
        const rows = result.rows.map((row) => {
            const normalized = { ...row };
            for (const column of spatialColumns) {
                const key = Object.keys(normalized).find((candidate) => candidate.toLocaleUpperCase("en-US") === column.toLocaleUpperCase("en-US")) ?? column;
                const value = normalized[key];
                if (value === null || value === undefined) {
                    normalized[key] = null;
                    continue;
                }
                const geometry = isSpatiaLiteGeometryBlob(value)
                    ? decodeSpatiaLiteGeometry(value)
                    : decodeGeoPackageGeometry(value);
                if (geometry === null)
                    throw new Error(`SQLite spatial column '${column}' returned an empty geometry value.`);
                normalized[key] = geometry;
            }
            return normalized;
        });
        return { ...result, rows };
    }
    async createTable(table, columns, schema = "main") {
        this.database.exec(buildCreateTableStatement("sqlite", table, columns, schema));
    }
    async insertRows(table, columns, rows, schema = "main") {
        if (columns.length === 0)
            throw new Error("At least one destination column is required.");
        if (rows.length === 0)
            return 0;
        let spatialiteTarget = false;
        if (rows.some((row) => row.some(isSpatialTransferValue))) {
            try {
                spatialiteTarget = Boolean(this.database.prepare("SELECT 1 FROM geometry_columns WHERE lower(f_table_name) = lower(?) LIMIT 1").get(table));
            }
            catch {
                // No SpatiaLite metadata table — this is a GeoPackage/plain SQLite database.
            }
        }
        const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const columnList = columns.map(quoteIdentifier).join(", ");
        const placeholders = columns.map(() => "?").join(", ");
        const statement = this.database.prepare(`INSERT INTO ${target} (${columnList}) VALUES (${placeholders})`);
        this.database.exec("BEGIN");
        try {
            for (const row of rows) {
                const values = row.map((value) => {
                    if (!isSpatialTransferValue(value))
                        return value;
                    return spatialiteTarget
                        ? encodeSpatiaLiteGeometry(value.wkb, value.srid ?? 0)
                        : encodeGeoPackageGeometry(value.wkb, value.srid ?? 0);
                });
                statement.run(...normalizeParameters(values));
            }
            this.database.exec("COMMIT");
            return rows.length;
        }
        catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }
    async close() {
        if (this.database.isOpen)
            this.database.close();
    }
}
function quoteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function normalizeParameters(parameters) {
    return parameters.map((value) => {
        if (value === undefined || value === null)
            return null;
        if (typeof value === "boolean")
            return value ? 1 : 0;
        if (value instanceof Date) {
            if (Number.isNaN(value.getTime()))
                throw new TypeError("SQLite date parameters must be valid dates.");
            return value.toISOString();
        }
        if (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "bigint" ||
            ArrayBuffer.isView(value)) {
            if (ArrayBuffer.isView(value)) {
                return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            }
            return value;
        }
        if (value instanceof ArrayBuffer)
            return new Uint8Array(value);
        throw new TypeError("SQLite parameters must be scalar values or binary data.");
    });
}
//# sourceMappingURL=sqlite.js.map