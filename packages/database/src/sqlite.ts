import { DatabaseSync } from "node:sqlite";
import { decodeGeoPackageGeometry, decodeSpatiaLiteGeometry, encodeGeoPackageGeometry, encodeSpatiaLiteGeometry, isSpatiaLiteGeometryBlob, isSpatialTransferValue, type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { assertSingleRowAffected, buildCreateTableStatement, buildTableTransferPageQuery, groupForeignKeyRows, queryStreamBatchSize, throwIfQueryStreamAborted, validateUpdateStatements, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";

export interface SqliteConnectionConfig {
  path: string;
  readOnly?: boolean;
}

export function sqliteConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SqliteConnectionConfig {
  const path = env.DBSTUDIO_SQLITE_PATH?.trim();
  if (!path) {
    throw new Error("Set DBSTUDIO_SQLITE_PATH to the SQLite database file path.");
  }
  return { path };
}

export class SqliteAdapter {
  private readonly database: DatabaseSync;

  constructor(config: SqliteConnectionConfig) {
    if (!config.path.trim()) throw new Error("SQLite database path cannot be empty.");
    this.database = new DatabaseSync(config.path, { readOnly: config.readOnly ?? false });
  }

  async testConnection(): Promise<{ database: string; serverVersion: string }> {
    const row = this.database.prepare("SELECT sqlite_version() AS version").get() as
      | { version: string }
      | undefined;
    if (!row) throw new Error("SQLite did not return its version.");
    return {
      database: this.database.location() ?? ":memory:",
      serverVersion: row.version,
    };
  }

  async query(sql: string, parameters: unknown[] = []): Promise<QueryResult> {
    const startTime = new Date();
    let status: 'success' | 'error' = 'success';
    let errorMessage: string | undefined;

    try {
      const statement = this.database.prepare(sql);
      const bindings = normalizeParameters(parameters);
      const columns = statement.columns().map((column) => column.name);
      const command = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
      const endTime = new Date();

      if (columns.length > 0) {
        const rows = statement.all(...bindings) as Record<string, unknown>[];
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
    } catch (error) {
      const endTime = new Date();
      status = 'error';
      errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const enhancedError = error as any;
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

  async *queryStream(sql: string, parameters: unknown[] = [], options: QueryStreamOptions = {}): AsyncGenerator<QueryResultBatch> {
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
    let rows: Record<string, unknown>[] = [];
    let yielded = false;
    for (const row of statement.iterate(...bindings) as Iterable<Record<string, unknown>>) {
      throwIfQueryStreamAborted(options.signal);
      rows.push(row);
      if (rows.length < batchSize) continue;
      yielded = true;
      yield { columns, rows, rowCount: rows.length, command };
      rows = [];
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throwIfQueryStreamAborted(options.signal);
    if (rows.length > 0 || !yielded) yield { columns, rows, rowCount: rows.length, command };
  }

  async updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]> {
    const batch = validateUpdateStatements(statements);
    if (batch.length === 0) return [];
    this.database.exec("BEGIN IMMEDIATE");
    const results: QueryResult[] = [];
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
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the update error if rollback itself fails. */ }
      throw error;
    }
  }

  async listDatabases(): Promise<string[]> {
    const rows = this.database.prepare("PRAGMA database_list").all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  async listSchemas(): Promise<string[]> {
    const databases = await this.listDatabases();
    return [...new Set([...databases, "temp"])];
  }

  async listTables(schema = "main"): Promise<TableInfo[]> {
    const databaseNames = await this.listDatabases();
    if (schema !== "temp" && !databaseNames.includes(schema)) {
      throw new Error(`SQLite schema '${schema}' is not attached to this connection.`);
    }
    const identifier = `"${schema.replaceAll('"', '""')}"`;
    const rows = this.database
      .prepare(
        `SELECT name, type FROM ${identifier}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string }>;
    return rows.map((row) => ({
      schema,
      name: row.name,
      type: row.type === "view" ? "view" : "table",
    }));
  }

  async getTableColumns(table: string, schema = "main"): Promise<ColumnInfo[]> {
    const databaseNames = await this.listDatabases();
    if (schema !== "temp" && !databaseNames.includes(schema)) {
      throw new Error(`SQLite schema '${schema}' is not attached to this connection.`);
    }
    const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
    const quotedTable = `"${table.replaceAll('"', '""')}"`;
    const rows = this.database
      .prepare(`PRAGMA ${quotedSchema}.table_xinfo(${quotedTable})`)
      .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
      hidden: number;
    }>;
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

  async getTableForeignKeys(table: string, schema = "main") {
    const databaseNames = await this.listDatabases();
    if (schema !== "temp" && !databaseNames.includes(schema)) throw new Error("SQLite schema '" + schema + "' is not attached to this connection.");
    const quotedSchema = "\"" + schema.replaceAll("\"", "\"\"") + "\"";
    const quotedTable = "\"" + table.replaceAll("\"", "\"\"") + "\"";
    const sql = "PRAGMA " + quotedSchema + ".foreign_key_list(" + quotedTable + ")";
    const rows = this.database.prepare(sql).all() as Array<{ id: number; seq: number; table: string; from: string; to: string }>;
    return groupForeignKeyRows(rows.sort((a, b) => a.id - b.id || a.seq - b.seq).map((row) => ({
      name: "fk_" + row.id,
      column_name: row.from,
      referenced_schema: schema,
      referenced_table: row.table,
      referenced_column: row.to,
    })));
  }

  async readTable(table: string, schema = "main"): Promise<QueryResult> {
    const quotedSchema = quoteIdentifier(schema);
    const quotedTable = quoteIdentifier(table);
    return this.query(`SELECT * FROM ${quotedSchema}.${quotedTable}`);
  }

  async readTablePage(table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, schema = "main", options: TableTransferReadOptions = {}): Promise<QueryResult> {
    const query = buildTableTransferPageQuery("sqlite", schema, table, columns, primaryKeys, cursor, limit, options);
    const result = await this.query(query.sql, query.parameters);
    const spatialColumns = options.spatialWkbColumns ?? [];
    if (!spatialColumns.length) return result;
    const rows = result.rows.map((row) => {
      const normalized: Record<string, unknown> = { ...row };
      for (const column of spatialColumns) {
        const key = Object.keys(normalized).find((candidate) =>
          candidate.toLocaleUpperCase("en-US") === column.toLocaleUpperCase("en-US")) ?? column;
        const value = normalized[key];
        if (value === null || value === undefined) {
          normalized[key] = null;
          continue;
        }
        const geometry = isSpatiaLiteGeometryBlob(value)
          ? decodeSpatiaLiteGeometry(value)
          : decodeGeoPackageGeometry(value);
        if (geometry === null) throw new Error(`SQLite spatial column '${column}' returned an empty geometry value.`);
        normalized[key] = geometry;
      }
      return normalized;
    });
    return { ...result, rows };
  }

  async createTable(table: string, columns: ImportTableColumn[], schema = "main"): Promise<void> {
    this.database.exec(buildCreateTableStatement("sqlite", table, columns, schema));
  }

  async insertRows(table: string, columns: string[], rows: unknown[][], schema = "main"): Promise<number> {
    if (columns.length === 0) throw new Error("At least one destination column is required.");
    if (rows.length === 0) return 0;
    let spatialiteTarget = false;
    if (rows.some((row) => row.some(isSpatialTransferValue))) {
      try {
        spatialiteTarget = Boolean(this.database.prepare(
          "SELECT 1 FROM geometry_columns WHERE lower(f_table_name) = lower(?) LIMIT 1",
        ).get(table));
      } catch {
        // No SpatiaLite metadata table — this is a GeoPackage/plain SQLite database.
      }
    }
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const columnList = columns.map(quoteIdentifier).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const statement = this.database.prepare(
      `INSERT INTO ${target} (${columnList}) VALUES (${placeholders})`,
    );
    this.database.exec("BEGIN");
    try {
      for (const row of rows) {
        const values = row.map((value) => {
          if (!isSpatialTransferValue(value)) return value;
          return spatialiteTarget
            ? encodeSpatiaLiteGeometry(value.wkb, value.srid ?? 0)
            : encodeGeoPackageGeometry(value.wkb, value.srid ?? 0);
        });
        statement.run(...normalizeParameters(values));
      }
      this.database.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.database.isOpen) this.database.close();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type SqliteBinding = null | string | number | bigint | Uint8Array;

function normalizeParameters(parameters: unknown[]): SqliteBinding[] {
  return parameters.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError("SQLite date parameters must be valid dates.");
      return value.toISOString();
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      ArrayBuffer.isView(value)
    ) {
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      return value;
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new TypeError("SQLite parameters must be scalar values or binary data.");
  });
}
