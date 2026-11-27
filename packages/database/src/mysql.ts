import { createConnection } from "mysql2/promise";
import { createConnection as createRawConnection } from "mysql2";
import { isQueryStreamCell, isSpatialTransferValue, type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamCell, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { assertSingleRowAffected, batchBufferedQueryResult, buildCreateTableStatement, buildTableTransferPageQuery, groupForeignKeyRows, queryStreamBatchSize, throwIfQueryStreamAborted, validateUpdateStatements, type DatabaseAdapter, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";

export interface MySqlConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  connectTimeout?: number;
}

export function mysqlConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): MySqlConnectionConfig {
  const connectionUrl = env.DBSTUDIO_MYSQL_URL || env.DBSTUDIO_DATABASE_URL || env.DATABASE_URL;
  if (connectionUrl) {
    const url = new URL(connectionUrl);
    if (!new Set(["mysql:", "mysql2:", "mariadb:"]).has(url.protocol)) {
      throw new Error("MySQL connection URL must use the mysql: protocol.");
    }
    const port = url.port ? Number(url.port) : 3306;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("MySQL connection URL contains an invalid port.");
    }
    return {
      host: url.hostname || "127.0.0.1",
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.length > 1 ? decodeURIComponent(url.pathname.slice(1)) : undefined,
    };
  }

  const user = env.MYSQL_USER?.trim();
  if (!user) throw new Error("Set MYSQL_USER or DBSTUDIO_MYSQL_URL for MySQL connections.");
  const port = env.MYSQL_PORT ? Number(env.MYSQL_PORT) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MYSQL_PORT must be an integer between 1 and 65535.");
  }
  const connectTimeout = env.MYSQL_CONNECT_TIMEOUT ? Number(env.MYSQL_CONNECT_TIMEOUT) : 10_000;
  if (!Number.isInteger(connectTimeout) || connectTimeout < 1) {
    throw new Error("MYSQL_CONNECT_TIMEOUT must be a positive integer.");
  }
  return {
    host: env.MYSQL_HOST?.trim() || "127.0.0.1",
    port,
    user,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE?.trim() || undefined,
    connectTimeout,
  };
}

export function mariaDbConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): MySqlConnectionConfig {
  return mysqlConfigFromEnvironment({
    ...env,
    DBSTUDIO_MYSQL_URL: env.DBSTUDIO_MARIADB_URL || env.DBSTUDIO_MYSQL_URL,
    MYSQL_HOST: env.MARIADB_HOST || env.MYSQL_HOST,
    MYSQL_PORT: env.MARIADB_PORT || env.MYSQL_PORT,
    MYSQL_USER: env.MARIADB_USER || env.MYSQL_USER,
    MYSQL_PASSWORD: env.MARIADB_PASSWORD ?? env.MYSQL_PASSWORD,
    MYSQL_DATABASE: env.MARIADB_DATABASE || env.MYSQL_DATABASE,
    MYSQL_CONNECT_TIMEOUT: env.MARIADB_CONNECT_TIMEOUT || env.MYSQL_CONNECT_TIMEOUT,
  });
}

export class MySqlAdapter implements DatabaseAdapter {
  private connectionPromise?: ReturnType<typeof createConnection>;

  constructor(protected readonly config: MySqlConnectionConfig) {}

  protected get tableTransferEngine(): "mysql" | "mariadb" {
    return "mysql";
  }

  async testConnection(): Promise<{ database: string; serverVersion: string }> {
    const result = await this.query(
      "SELECT COALESCE(DATABASE(), '') AS databaseName, VERSION() AS serverVersion",
    );
    const row = result.rows[0];
    if (!row) throw new Error("MySQL did not return connection details.");
    return {
      database: String(row.databaseName ?? ""),
      serverVersion: String(row.serverVersion ?? ""),
    };
  }

  async query(sql: string, parameters: unknown[] = []): Promise<QueryResult> {
    const startTime = new Date();
    let status: 'success' | 'error' = 'success';
    let errorMessage: string | undefined;

    try {
      const connection = await this.getConnection();
      const [result, fields] = await connection.execute(sql, normalizeParameters(parameters));
      const endTime = new Date();
      const command = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();

      if (Array.isArray(result)) {
        const rows = result as Array<Record<string, unknown>>;
        const rowCount = rows.length;
        return {
          columns: fields?.map((field) => field.name) ?? Object.keys(rows[0] ?? {}),
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

      const resultHeader = result as { affectedRows?: number };
      const affectedRows = resultHeader.affectedRows ?? 0;
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
    const batchSize = queryStreamBatchSize(options);
    throwIfQueryStreamAborted(options.signal);
    const rawConnection = createRawConnection(this.config);
    await new Promise<void>((resolve, reject) => {
      rawConnection.connect((error) => error ? reject(error) : resolve());
    });
    const query = rawConnection.query(sql, normalizeParameters(parameters));
    const fieldNames = new Map<number, string>();
    let affectedRows = 0;
    query.on("fields", (fields) => {
      if (!Array.isArray(fields)) return;
      fields.forEach((field, index) => {
        if (field && typeof field.name === "string") fieldNames.set(index, field.name);
      });
    });
    query.on("result", (result) => {
      const count = (result as { affectedRows?: number }).affectedRows;
      if (typeof count === "number") affectedRows = count;
    });
    const stream = query.stream({ highWaterMark: batchSize, objectMode: true });
    const onAbort = () => stream.destroy(new Error("Query streaming was cancelled."));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const columns = () => [...fieldNames.entries()].sort(([left], [right]) => left - right).map(([, name]) => name);
    const command = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
    let rows: Record<string, unknown>[] = [];
    let yielded = false;
    let completed = false;
    try {
      for await (const value of stream) {
        throwIfQueryStreamAborted(options.signal);
        if (fieldNames.size === 0) continue;
        rows.push(value as Record<string, unknown>);
        if (rows.length < batchSize) continue;
        yielded = true;
        yield { columns: columns(), rows, rowCount: rows.length, command };
        rows = [];
      }
      completed = true;
      throwIfQueryStreamAborted(options.signal);
      if (fieldNames.size === 0) {
        yield { columns: [], rows: [], rowCount: affectedRows, command };
      } else if (rows.length > 0 || !yielded) {
        yield { columns: columns(), rows, rowCount: rows.length, command };
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!completed) {
        stream.destroy();
      }
      if (completed) await new Promise<void>((resolve) => rawConnection.end(() => resolve()));
      else rawConnection.destroy();
    }
  }

  async updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]> {
    const batch = validateUpdateStatements(statements);
    if (batch.length === 0) return [];
    const connection = await this.getConnection();
    const results: QueryResult[] = [];
    await connection.beginTransaction();
    try {
      for (const statement of batch) {
        const [result] = await connection.execute(statement.sql, normalizeParameters(statement.parameters));
        const header = result as { affectedRows?: number };
        const rowCount = header.affectedRows ?? 0;
        assertSingleRowAffected(rowCount);
        results.push({
          columns: [],
          rows: [],
          rowCount,
          command: "UPDATE",
        });
      }
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.query(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
    );
    return result.rows.map((row) => String(row.name));
  }

  async listSchemas(): Promise<string[]> {
    return this.listDatabases();
  }

  async listTables(schema = this.config.database): Promise<TableInfo[]> {
    if (!schema) throw new Error("Choose a MySQL database before listing its tables.");
    const result = await this.query(
      "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [schema],
    );
    return result.rows.map((row) => ({
      schema,
      name: String(row.name),
      type: String(row.type).toUpperCase() === "VIEW" ? "view" : "table",
    }));
  }

  async getTableColumns(table: string, schema = this.config.database): Promise<ColumnInfo[]> {
    if (!schema) throw new Error("Choose a MySQL database before listing its table columns.");
    const result = await this.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS data_type,
              IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS default_value,
              COLUMN_KEY = 'PRI' AS primary_key, ORDINAL_POSITION AS ordinal_position
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [schema, table],
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      dataType: String(row.data_type ?? ""),
      nullable: Boolean(row.nullable),
      defaultValue: row.default_value === null || row.default_value === undefined
        ? null
        : String(row.default_value),
      primaryKey: Boolean(row.primary_key),
      ordinalPosition: Number(row.ordinal_position),
    }));
  }

  async getTableForeignKeys(table: string, schema = this.config.database) {
    if (!schema) throw new Error("Choose a MySQL database before listing its foreign keys.");
    const result = await this.query(
      "SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name, " +
      "REFERENCED_TABLE_SCHEMA AS referenced_schema, REFERENCED_TABLE_NAME AS referenced_table, " +
      "REFERENCED_COLUMN_NAME AS referenced_column " +
      "FROM information_schema.KEY_COLUMN_USAGE " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL " +
      "ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
      [schema, table],
    );
    return groupForeignKeyRows(result.rows as Array<{
      name: unknown; column_name: unknown; referenced_schema?: unknown; referenced_table: unknown; referenced_column: unknown;
    }>);
  }

  async readTable(table: string, schema = this.config.database): Promise<QueryResult> {
    if (!schema) throw new Error("Choose a MySQL database before reading table rows.");
    return this.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
  }

  async readTablePage(
    table: string,
    columns: string[],
    primaryKeys: string[],
    cursor: unknown[] | undefined,
    limit: number,
    schema = this.config.database,
    options: TableTransferReadOptions = {},
  ): Promise<QueryResult> {
    if (!schema) throw new Error("Choose a MySQL database before reading table rows.");
    const query = buildTableTransferPageQuery(this.tableTransferEngine, schema, table, columns, primaryKeys, cursor, limit, options);
    return this.query(query.sql, query.parameters);
  }

  async createTable(table: string, columns: ImportTableColumn[], schema = this.config.database): Promise<void> {
    if (!schema) throw new Error("Choose a MySQL database before creating a table.");
    await this.query(buildCreateTableStatement("mysql", table, columns, schema));
  }

  async insertRows(table: string, columns: string[], rows: unknown[][], schema = this.config.database): Promise<number> {
    if (!schema) throw new Error("Choose a MySQL database before importing rows.");
    if (columns.length === 0) throw new Error("At least one destination column is required.");
    if (rows.length === 0) return 0;

    const connection = await this.getConnection();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const columnList = columns.map(quoteIdentifier).join(", ");
    const maximumParametersPerRow = Math.max(1, ...rows.map((row) => row.reduce<number>(
      (count, value) => count + (isSpatialTransferValue(value) ? 2 : 1),
      0,
    )));
    const batchSize = Math.max(1, Math.min(500, Math.floor(60_000 / maximumParametersPerRow)));
    await connection.beginTransaction();
    try {
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const values: unknown[] = [];
        const tuples = batch.map((row) => `(${row.map((value) => {
          if (isSpatialTransferValue(value)) {
            if (value.spatialType !== "geometry") {
              throw new Error("MySQL/MariaDB spatial row transfer supports geometry values only; geography has no matching destination type.");
            }
            values.push(Buffer.from(value.wkb), value.srid);
            return this.tableTransferEngine === "mysql"
              ? "ST_GeomFromWKB(?, ?, 'axis-order=long-lat')"
              : "ST_GeomFromWKB(?, ?)";
          }
          values.push(value);
          return "?";
        }).join(", ")})`);
        await connection.execute(
          `INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`,
          normalizeParameters(values),
        );
      }
      await connection.commit();
      return rows.length;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  }

  async insertRowWithStreamedLobs(table: string, columns: string[], row: unknown[], schema = this.config.database): Promise<number> {
    const streamed = row.flatMap((value, index) => isQueryStreamCell(value)
      ? [{ index, column: columns[index]!, cell: value }]
      : []);
    try {
      if (!schema) throw new Error("Choose a MySQL database before importing rows.");
      if (columns.length === 0 || row.length !== columns.length) {
        throw new Error("A streamed transfer row must match its destination columns.");
      }
      if (streamed.length === 0) throw new Error("A streamed transfer row must contain at least one LOB stream.");

      const [targetColumns, targetLobMetadata] = await Promise.all([
        this.getTableColumns(table, schema),
        this.query(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, CHARACTER_SET_NAME AS character_set_name
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
          [schema, table],
        ),
      ]);
      const targetColumnsByName = new Map(targetColumns.map((column) => [column.name, column]));
      const targetLobColumnsByName = new Map(targetLobMetadata.rows.map((column) => [String(column.name), {
        dataType: String(column.data_type ?? "").toLowerCase(),
        characterSet: column.character_set_name === null || column.character_set_name === undefined
          ? null
          : String(column.character_set_name).toLowerCase(),
      }]));
      for (const item of streamed) {
        const targetColumn = targetColumnsByName.get(item.column);
        const targetLobColumn = targetLobColumnsByName.get(item.column);
        const compatible = item.cell.encoding === "buffer"
          ? targetLobColumn?.dataType === "longblob"
          : targetLobColumn?.dataType === "longtext" && targetLobColumn.characterSet === "utf8mb4";
        if (!targetColumn || !compatible) {
          const expected = item.cell.encoding === "buffer" ? "LONGBLOB" : "LONGTEXT CHARACTER SET utf8mb4";
          throw new Error(`Cannot stream Oracle ${item.cell.encoding === "utf8" ? "text" : "binary"} LOB data into MySQL/MariaDB '${item.column}'; expected ${expected}.`);
        }
      }

      const primaryKeys = targetColumns.filter((column) => column.primaryKey);
      if (primaryKeys.length === 0) {
        throw new Error("MySQL streamed LOB transfer requires a destination primary key to locate the inserted row.");
      }
      const keyIndexes = primaryKeys.map((column) => columns.indexOf(column.name));
      if (keyIndexes.some((index) => index < 0)) {
        throw new Error("MySQL streamed LOB transfer requires every destination primary-key column in the mapped row.");
      }
      const keyValues = keyIndexes.map((index) => row[index]);
      if (keyValues.some((value) => value === null || value === undefined || isQueryStreamCell(value))) {
        throw new Error("MySQL streamed LOB transfer requires non-null scalar destination primary-key values.");
      }

      const connection = await this.getConnection();
      const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const columnList = columns.map(quoteIdentifier).join(", ");
      const values = row.map((value) => isQueryStreamCell(value)
        ? value.encoding === "utf8" ? "" : Buffer.alloc(0)
        : value);
      const placeholders = values.map(() => "?").join(", ");
      const keyPredicates = primaryKeys.map((column) => `${quoteIdentifier(column.name)} = ?`).join(" AND ");
      await connection.beginTransaction();
      try {
        await connection.execute(
          `INSERT INTO ${target} (${columnList}) VALUES (${placeholders})`,
          normalizeParameters(values),
        );

        for (const item of streamed) {
          const column = quoteIdentifier(item.column);
          const empty = item.cell.encoding === "utf8" ? "''" : "_binary''";
          const pendingText: string[] = [];
          const pendingBuffers: Buffer[] = [];
          let pendingBytes = 0;
          let chunksRead = 0;
          let bytesRead = 0;
          const flush = async () => {
            if (pendingBytes === 0) return;
            const chunk: string | Buffer = item.cell.encoding === "utf8" ? pendingText.join("") : Buffer.concat(pendingBuffers);
            const [result] = await connection.execute(
              `UPDATE ${target} SET ${column} = CONCAT(COALESCE(${column}, ${empty}), ?) WHERE ${keyPredicates}`,
              normalizeParameters([chunk, ...keyValues]),
            );
            const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;
            if (affectedRows !== 1) {
              throw new Error(`MySQL affected ${affectedRows} rows while appending streamed LOB column '${item.column}'.`);
            }
            pendingText.length = 0;
            pendingBuffers.length = 0;
            pendingBytes = 0;
          };

          try {
            for await (const chunk of item.cell.stream) {
              chunksRead += 1;
              if (item.cell.encoding === "utf8") {
                if (typeof chunk !== "string") throw new Error(`Text LOB stream '${item.column}' emitted non-text data.`);
                pendingText.push(chunk);
                const chunkBytes = Buffer.byteLength(chunk, "utf8");
                pendingBytes += chunkBytes;
                bytesRead += chunkBytes;
              } else {
                if (!(chunk instanceof Uint8Array)) throw new Error(`Binary LOB stream '${item.column}' emitted non-binary data.`);
                const buffer = Buffer.from(chunk);
                pendingBuffers.push(buffer);
                pendingBytes += buffer.byteLength;
                bytesRead += buffer.byteLength;
              }
              if (pendingBytes >= 256 * 1024) await flush();
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Streaming ${item.cell.encoding === "utf8" ? "text" : "binary"} LOB column '${item.column}' failed after ${chunksRead} chunks (${bytesRead} bytes): ${message}`, { cause: error });
          }
          await flush();
        }

        await connection.commit();
        return 1;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      for (const item of streamed) item.cell.destroy();
    }
  }

  async close(): Promise<void> {
    if (!this.connectionPromise) return;
    const connection = await this.connectionPromise.catch(() => undefined);
    this.connectionPromise = undefined;
    if (connection) await connection.end();
  }

  private getConnection(): ReturnType<typeof createConnection> {
    this.connectionPromise ??= createConnection(this.config);
    return this.connectionPromise;
  }
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

export class MariaDbAdapter extends MySqlAdapter {
  protected override get tableTransferEngine(): "mysql" | "mariadb" {
    return "mariadb";
  }

  override async getTableColumns(table: string, schema = this.config.database): Promise<ColumnInfo[]> {
    const columns = await super.getTableColumns(table, schema);
    if (!schema) return columns;
    const longTextColumns = columns.filter((column) => /^LONGTEXT\b/i.test(column.dataType.trim()));
    if (!longTextColumns.length) return columns;

    const result = await this.query(
      `SELECT cc.CHECK_CLAUSE AS check_clause
       FROM information_schema.TABLE_CONSTRAINTS AS tc
       JOIN information_schema.CHECK_CONSTRAINTS AS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
      [schema, table],
    );
    const checkClauses = result.rows.map((row) => normalizeMariaDbCheckClause(row.check_clause));
    const jsonColumns = new Set(longTextColumns
      .filter((column) => {
        const name = normalizeMariaDbCheckClause(column.name);
        return checkClauses.some((clause) => clause.includes(`json_valid(${name})`));
      })
      .map((column) => column.name));

    return columns.map((column) => jsonColumns.has(column.name) ? { ...column, dataType: "JSON" } : column);
  }
}

function normalizeMariaDbCheckClause(value: unknown): string {
  return String(value ?? "").replace(/[\s`\"]/g, "").toLocaleLowerCase("en-US");
}

type MySqlBinding = null | string | number | bigint | boolean | Date | Uint8Array;

function normalizeParameters(parameters: unknown[]): MySqlBinding[] {
  return parameters.map((value) => {
    if (value === undefined || value === null) return null;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean" ||
      value instanceof Date ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw new TypeError("MySQL parameters must be scalar values, dates, or binary data.");
  });
}
