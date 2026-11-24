import { Pool, type PoolConfig } from "pg";
import { isQueryStreamCell, isSpatialTransferValue, type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamCell, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { assertSingleRowAffected, batchBufferedQueryResult, buildCreateTableStatement, buildTableTransferPageQuery, groupForeignKeyRows, queryStreamBatchSize, throwIfQueryStreamAborted, validateUpdateStatements, type DatabaseAdapter, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";

export interface PostgresConnectionConfig extends Omit<PoolConfig, "password"> {
  password?: string;
}

export function postgresConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PostgresConnectionConfig {
  const connectionString = env.DBSTUDIO_DATABASE_URL || env.DATABASE_URL;
  if (connectionString) {
    return { connectionString, connectionTimeoutMillis: 5_000 };
  }

  if (!env.PGDATABASE || !env.PGUSER) {
    throw new Error(
      "Configure PostgreSQL with DATABASE_URL or PGDATABASE and PGUSER (PGHOST and PGPORT are optional).",
    );
  }

  const port = env.PGPORT ? Number(env.PGPORT) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PGPORT must be an integer between 1 and 65535.");
  }

  return {
    host: env.PGHOST || "localhost",
    port,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD || undefined,
    ssl: env.PGSSLMODE === "require" ? true : undefined,
    connectionTimeoutMillis: 5_000,
  };
}

export class PostgresAdapter implements DatabaseAdapter {
  private readonly pool: Pool;
  private streamCursorSequence = 0;

  constructor(config: PostgresConnectionConfig) {
    this.pool = new Pool({ max: 4, idleTimeoutMillis: 10_000, ...config });
  }

  async testConnection(): Promise<{ database: string; serverVersion: string }> {
    const result = await this.pool.query<{
      database: string;
      server_version: string;
    }>("SELECT current_database() AS database, current_setting('server_version') AS server_version");
    const row = result.rows[0];
    if (!row) throw new Error("PostgreSQL returned no connection details.");
    return { database: row.database, serverVersion: row.server_version };
  }

  async query(sql: string, parameters: unknown[] = []): Promise<QueryResult> {
    const result = await this.pool.query(sql, parameters);
    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.rows.length,
      command: result.command,
    };
  }

  async *queryStream(sql: string, parameters: unknown[] = [], options: QueryStreamOptions = {}): AsyncGenerator<QueryResultBatch> {
    const batchSize = queryStreamBatchSize(options);
    throwIfQueryStreamAborted(options.signal);
    const client = await this.pool.connect();
    const cursor = `dbstudio_stream_${++this.streamCursorSequence}`;
    const quotedCursor = `"${cursor}"`;
    let transactionStarted = false;
    let cursorDeclared = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(`DECLARE ${quotedCursor} NO SCROLL CURSOR FOR ${sql}`, parameters);
      cursorDeclared = true;
      const header = await client.query(`FETCH FORWARD 0 FROM ${quotedCursor}`);
      const columns = header.fields.map((field) => field.name);
      let yielded = false;
      while (true) {
        throwIfQueryStreamAborted(options.signal);
        const result = await client.query(`FETCH FORWARD ${batchSize} FROM ${quotedCursor}`);
        const rows = result.rows as Record<string, unknown>[];
        if (rows.length === 0) {
          if (!yielded) yield { columns, rows: [], rowCount: 0, command: "SELECT" };
          break;
        }
        yielded = true;
        yield { columns, rows, rowCount: rows.length, command: "SELECT" };
        if (rows.length < batchSize) break;
      }
      await client.query(`CLOSE ${quotedCursor}`);
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      transactionStarted = false;
      if (cursorDeclared || options.signal?.aborted) throw error;
      // A cursor can only wrap a row-producing SELECT. Preserve ordinary CLI
      // query semantics for statements (such as DML or SHOW) that cannot be
      // declared as cursors; the failed declaration was rolled back first.
      yield* batchBufferedQueryResult(await this.query(sql, parameters), options);
    } finally {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]> {
    const batch = validateUpdateStatements(statements);
    if (batch.length === 0) return [];
    const client = await this.pool.connect();
    const results: QueryResult[] = [];
    try {
      await client.query("BEGIN");
      for (const statement of batch) {
        const result = await client.query(statement.sql, statement.parameters);
        const rowCount = result.rowCount ?? 0;
        assertSingleRowAffected(rowCount);
        results.push({
          columns: [],
          rows: [],
          rowCount,
          command: result.command,
        });
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      "SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
    );
    return result.rows.map((row) => row.name);
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY schema_name",
    );
    return result.rows.map((row) => row.name);
  }

  async listTables(schema = "public"): Promise<TableInfo[]> {
    const result = await this.pool.query<{
      schema: string;
      name: string;
      table_type: string;
      comment: string | null;
    }>(
      `SELECT t.table_schema AS schema, t.table_name AS name, t.table_type,
         obj_description(c.oid, 'pg_class') AS comment
       FROM information_schema.tables AS t
       LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = t.table_schema
       LEFT JOIN pg_catalog.pg_class AS c ON c.relnamespace = n.oid AND c.relname = t.table_name
       WHERE t.table_schema = $1 AND t.table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY t.table_name`,
      [schema],
    );
    return result.rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.table_type === "VIEW" ? "view" : "table",
      comment: row.comment,
    }));
  }

  async getTableColumns(table: string, schema = "public"): Promise<ColumnInfo[]> {
    const result = await this.pool.query<{
      name: string;
      data_type: string;
      nullable: boolean;
      default_value: string | null;
      primary_key: boolean;
      ordinal_position: number;
      comment: string | null;
    }>(
      `SELECT
         c.column_name AS name,
         CASE
           WHEN c.data_type = 'USER-DEFINED' AND lower(c.udt_name) IN ('geometry', 'geography') THEN lower(c.udt_name)
           ELSE c.data_type
         END AS data_type,
         c.is_nullable = 'YES' AS nullable,
         c.column_default AS default_value,
         EXISTS (
           SELECT 1
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu
             ON kcu.constraint_catalog = tc.constraint_catalog
            AND kcu.constraint_schema = tc.constraint_schema
            AND kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
            AND kcu.table_name = tc.table_name
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = c.table_schema
             AND tc.table_name = c.table_name
             AND kcu.column_name = c.column_name
         ) AS primary_key,
         c.ordinal_position AS ordinal_position,
         col_description(pc.oid, pa.attnum) AS comment
       FROM information_schema.columns AS c
       LEFT JOIN pg_catalog.pg_namespace AS pn ON pn.nspname = c.table_schema
       LEFT JOIN pg_catalog.pg_class AS pc ON pc.relnamespace = pn.oid AND pc.relname = c.table_name
       LEFT JOIN pg_catalog.pg_attribute AS pa ON pa.attrelid = pc.oid AND pa.attname = c.column_name AND pa.attnum > 0
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table],
    );
    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      nullable: row.nullable,
      defaultValue: row.default_value,
      primaryKey: row.primary_key,
      ordinalPosition: Number(row.ordinal_position),
      comment: row.comment,
    }));
  }

  async getTableForeignKeys(table: string, schema = "public") {
    const result = await this.pool.query<{
      name: string;
      column_name: string;
      referenced_schema: string;
      referenced_table: string;
      referenced_column: string;
    }>(
      "SELECT con.conname AS name, source_column.attname AS column_name, " +
      "referenced_namespace.nspname AS referenced_schema, referenced_table.relname AS referenced_table, " +
      "target_column.attname AS referenced_column " +
      "FROM pg_constraint AS con " +
      "JOIN pg_class AS source_table ON source_table.oid = con.conrelid " +
      "JOIN pg_namespace AS source_namespace ON source_namespace.oid = source_table.relnamespace " +
      "JOIN pg_class AS referenced_table ON referenced_table.oid = con.confrelid " +
      "JOIN pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_table.relnamespace " +
      "JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS source_key(attnum, ordinality) ON true " +
      "JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS target_key(attnum, ordinality) ON target_key.ordinality = source_key.ordinality " +
      "JOIN pg_attribute AS source_column ON source_column.attrelid = source_table.oid AND source_column.attnum = source_key.attnum " +
      "JOIN pg_attribute AS target_column ON target_column.attrelid = referenced_table.oid AND target_column.attnum = target_key.attnum " +
      "WHERE con.contype = 'f' AND source_namespace.nspname = $1 AND source_table.relname = $2 " +
      "ORDER BY con.conname, source_key.ordinality",
      [schema, table],
    );
    return groupForeignKeyRows(result.rows);
  }

  async readTable(table: string, schema = "public"): Promise<QueryResult> {
    return this.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
  }

  async readTablePage(
    table: string,
    columns: string[],
    primaryKeys: string[],
    cursor: unknown[] | undefined,
    limit: number,
    schema = "public",
    options: TableTransferReadOptions = {},
  ): Promise<QueryResult> {
    const streamColumns = Object.entries(options.streamLobColumns ?? {});
    if (streamColumns.length) {
      return this.readTablePageWithStreamedLobs(table, columns, primaryKeys, cursor, limit, schema, streamColumns, options.jsonTextColumns ?? []);
    }
    const query = buildTableTransferPageQuery("postgres", schema, table, columns, primaryKeys, cursor, limit, {
      jsonTextColumns: options.jsonTextColumns,
      spatialWkbColumns: options.spatialWkbColumns,
    });
    return this.query(query.sql, query.parameters);
  }

  private async readTablePageWithStreamedLobs(
    table: string,
    columns: string[],
    primaryKeys: string[],
    cursor: unknown[] | undefined,
    limit: number,
    schema: string,
    streamColumns: Array<[string, "utf8" | "buffer"]>,
    jsonTextColumns: string[],
  ): Promise<QueryResult> {
    const source = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const baseColumns = columns.filter((column) => !streamColumns.some(([name]) => name === column));
    const page = buildTableTransferPageQuery("postgres", schema, table, baseColumns, primaryKeys, cursor, limit, {
      jsonTextColumns: jsonTextColumns.filter((column) => baseColumns.includes(column)),
    });
    const flags = streamColumns.map((_, index) => `__dbstudio_lob_present_${index}`);
    const joins = primaryKeys.map((key) => `page.${quoteIdentifier(key)} = source.${quoteIdentifier(key)}`).join(" AND ");
    const flagSelect = streamColumns.map(([column], index) =>
      `source.${quoteIdentifier(column)} IS NOT NULL AS ${quoteIdentifier(flags[index]!)}`,
    ).join(", ");
    const result = await this.pool.query(
      `SELECT page.*, ${flagSelect} FROM (${page.sql}) AS page ` +
      `JOIN ${source} AS source ON ${joins}`,
      page.parameters,
    );
    const rows = result.rows as Array<Record<string, unknown>>;
    return {
      columns: [...baseColumns, ...streamColumns.map(([column]) => column)],
      rows: rows.map((row) => {
        const output = { ...row };
        streamColumns.forEach(([column, encoding], index) => {
          const present = output[flags[index]!];
          delete output[flags[index]!];
          output[column] = present === true
            ? this.createPostgresLobCell(table, schema, column, primaryKeys, primaryKeys.map((key) => output[key]), encoding)
            : null;
        });
        return output;
      }),
      rowCount: result.rowCount ?? rows.length,
      command: result.command,
    };
  }

  private createPostgresLobCell(
    table: string,
    schema: string,
    column: string,
    primaryKeys: string[],
    keyValues: unknown[],
    encoding: "utf8" | "buffer",
  ): QueryStreamCell {
    const controller = new AbortController();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const keyFilter = primaryKeys.map((key, index) => `${quoteIdentifier(key)} = $${index + 2}`).join(" AND ");
    const cell = {
      __dbStudioQueryStreamCell: true as const,
      encoding,
      stream: (async function* (adapter: PostgresAdapter): AsyncGenerator<string | Uint8Array> {
        const client = await adapter.pool.connect();
        let transactionStarted = false;
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          transactionStarted = true;
          let offset = 1;
          while (!controller.signal.aborted) {
            const chunkSize = encoding === "buffer" ? 256 * 1024 : 64 * 1024;
            const result = await client.query<{ value: string | Buffer | null }>(
              `SELECT substring(${quoteIdentifier(column)} FROM $1::integer FOR $${keyValues.length + 2}::integer) AS value ` +
              `FROM ${target} WHERE ${keyFilter}`,
              [offset, ...keyValues, chunkSize],
            );
            const value = result.rows[0]?.value;
            if (value === null || value === undefined || value.length === 0) break;
            yield value;
            if (encoding === "buffer") offset += (value as Buffer).byteLength;
            else {
              let characters = 0;
              for (const _character of value as string) characters += 1;
              offset += characters;
            }
          }
          if (controller.signal.aborted) throw new Error(`PostgreSQL LOB stream '${column}' was cancelled.`);
          await client.query("COMMIT");
          transactionStarted = false;
        } catch (error) {
          if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
          transactionStarted = false;
          throw error;
        } finally {
          client.release();
        }
      })(this),
      destroy() {
        controller.abort();
      },
    };
    return cell;
  }

  async createTable(table: string, columns: ImportTableColumn[], schema = "public"): Promise<void> {
    await this.query(buildCreateTableStatement("postgres", table, columns, schema));
  }

  async insertRows(table: string, columns: string[], rows: unknown[][], schema = "public"): Promise<number> {
    if (columns.length === 0) throw new Error("At least one destination column is required.");
    if (rows.length === 0) return 0;
    const client = await this.pool.connect();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const columnList = columns.map(quoteIdentifier).join(", ");
    const maxParametersPerRow = rows.reduce<number>((maximum, row) => Math.max(
      maximum,
      row.reduce<number>((count, value) => count + (isSpatialTransferValue(value) ? 2 : 1), 0),
    ), columns.length);
    const batchSize = Math.max(1, Math.min(500, Math.floor(60_000 / maxParametersPerRow)));
    try {
      await client.query("BEGIN");
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const values: unknown[] = [];
        const tuples = batch.map((row) => `(${row.map((value) => {
          if (isSpatialTransferValue(value)) {
            values.push(Buffer.from(value.wkb));
            const wkb = `$${values.length}`;
            values.push(value.srid);
            const srid = `$${values.length}`;
            const geometry = `ST_GeomFromWKB(${wkb}, ${srid})`;
            return value.spatialType === "geography"
              ? `ST_SetSRID(${geometry}, ${srid})::geography`
              : geometry;
          }
          values.push(value);
          return `$${values.length}`;
        }).join(", ")})`);
        await client.query(
          `INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`,
          values,
        );
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async insertRowWithStreamedLobs(table: string, columns: string[], row: unknown[], schema = "public"): Promise<number> {
    if (columns.length === 0 || row.length !== columns.length) {
      throw new Error("A streamed transfer row must match its destination columns.");
    }
    const streamed = row.flatMap((value, index) => isQueryStreamCell(value)
      ? [{ index, column: columns[index]!, cell: value }]
      : []);
    if (streamed.length === 0) throw new Error("A streamed transfer row must contain at least one LOB stream.");

    const targetColumns = new Map((await this.getTableColumns(table, schema)).map((column) => [column.name, column]));
    for (const item of streamed) {
      const targetColumn = targetColumns.get(item.column);
      const dataType = targetColumn?.dataType.trim().toUpperCase();
      if (!targetColumn) throw new Error(`Destination column '${item.column}' was not found.`);
      if (item.cell.encoding === "utf8" && !isPostgresTextDataType(dataType ?? "")) {
        throw new Error(`Cannot stream Oracle text LOB data into PostgreSQL ${dataType || "unknown"} column '${item.column}'.`);
      }
      if (item.cell.encoding === "buffer" && dataType !== "BYTEA") {
        throw new Error(`Cannot stream Oracle binary LOB data into PostgreSQL ${dataType || "unknown"} column '${item.column}'.`);
      }
    }

    const client = await this.pool.connect();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const targetAlias = "__dbstudio_target";
    const columnList = columns.map(quoteIdentifier).join(", ");
    const values = row.map((value) => isQueryStreamCell(value)
      ? value.encoding === "utf8" ? "" : Buffer.alloc(0)
      : value);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    let location: { tableoid: string; ctid: string } | undefined;
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO ${target} AS ${quoteIdentifier(targetAlias)} (${columnList}) VALUES (${placeholders}) ` +
        `RETURNING ${targetAlias}.tableoid::text AS "__dbstudio_tableoid", ${targetAlias}.ctid::text AS "__dbstudio_ctid"`,
        values,
      );
      const insertedLocation = inserted.rows[0] as Record<string, unknown> | undefined;
      if (inserted.rowCount !== 1 || !insertedLocation) {
        throw new Error("PostgreSQL did not return the inserted row location for streamed LOB transfer.");
      }
      location = {
        tableoid: String(insertedLocation.__dbstudio_tableoid),
        ctid: String(insertedLocation.__dbstudio_ctid),
      };

      for (const item of streamed) {
        let pendingText: string[] = [];
        let pendingBuffers: Buffer[] = [];
        let pendingBytes = 0;
        let chunksRead = 0;
        let bytesRead = 0;
        const expression = item.cell.encoding === "utf8" ? "|| $1::text" : "|| $1::bytea";
        const flush = async () => {
          if (pendingBytes === 0 || !location) return;
          const chunk = item.cell.encoding === "utf8" ? pendingText.join("") : Buffer.concat(pendingBuffers);
          const result = await client.query(
            `UPDATE ${target} AS ${quoteIdentifier(targetAlias)} ` +
            `SET ${quoteIdentifier(item.column)} = ${quoteIdentifier(targetAlias)}.${quoteIdentifier(item.column)} ${expression} ` +
            `WHERE ${quoteIdentifier(targetAlias)}.tableoid = $2::oid AND ${quoteIdentifier(targetAlias)}.ctid = $3::tid ` +
            `RETURNING ${quoteIdentifier(targetAlias)}.tableoid::text AS "__dbstudio_tableoid", ` +
            `${quoteIdentifier(targetAlias)}.ctid::text AS "__dbstudio_ctid"`,
            [chunk, location.tableoid, location.ctid],
          );
          const updatedLocation = result.rows[0] as Record<string, unknown> | undefined;
          if (result.rowCount !== 1 || !updatedLocation) {
            throw new Error(`PostgreSQL lost the target row while appending streamed LOB column '${item.column}'.`);
          }
          location = {
            tableoid: String(updatedLocation.__dbstudio_tableoid),
            ctid: String(updatedLocation.__dbstudio_ctid),
          };
          pendingText = [];
          pendingBuffers = [];
          pendingBytes = 0;
        };

        try {
          for await (const value of item.cell.stream) {
            chunksRead += 1;
            if (item.cell.encoding === "utf8") {
              if (typeof value !== "string") throw new Error(`Text LOB stream '${item.column}' emitted non-text data.`);
              pendingText.push(value);
              const chunkBytes = Buffer.byteLength(value, "utf8");
              pendingBytes += chunkBytes;
              bytesRead += chunkBytes;
            } else {
              if (!(value instanceof Uint8Array)) throw new Error(`Binary LOB stream '${item.column}' emitted non-binary data.`);
              const buffer = Buffer.from(value);
              pendingBuffers.push(buffer);
              pendingBytes += buffer.byteLength;
              bytesRead += buffer.byteLength;
            }
            if (pendingBytes >= 256 * 1024) await flush();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Reading streamed ${item.cell.encoding === "utf8" ? "text" : "binary"} LOB column '${item.column}' failed after ${chunksRead} chunks (${bytesRead} bytes): ${message}`, { cause: error });
        }
        await flush();
        item.cell.destroy();
      }

      await client.query("COMMIT");
      return 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      for (const item of streamed) item.cell.destroy();
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isPostgresTextDataType(dataType: string): boolean {
  return /^(?:TEXT|CHARACTER VARYING|VARCHAR|CHARACTER|CHAR|BPCHAR)(?:\s*\(\s*\d+\s*\))?$/.test(dataType);
}
