import oracledb from "oracledb";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { BindParameters, Connection, ExecuteOptions, Lob } from "oracledb";
import { isQueryStreamCell, isSpatialTransferValue, oracleSdo2dWkbToDimensionalWkb, type ColumnInfo, type ParameterizedSqlStatement, type QueryResult, type QueryResultBatch, type QueryStreamCell, type QueryStreamOptions, type TableInfo } from "@db-studio/shared";
import { assertSingleRowAffected, batchBufferedQueryResult, buildCreateTableStatement, buildTableTransferPageQuery, groupForeignKeyRows, queryStreamBatchSize, throwIfQueryStreamAborted, validateUpdateStatements, type DatabaseAdapter, type ImportTableColumn, type TableTransferReadOptions } from "./adapter.js";

export interface OracleConnectionConfig {
  user: string;
  password: string;
  connectString: string;
  /** Oracle Net connection timeout, in seconds. */
  connectTimeout?: number;
  /** Maximum duration for each database round trip, in milliseconds. */
  callTimeout?: number;
}

export interface OracleQueryStreamOptions extends QueryStreamOptions {
  fetchTypeHandler?: ExecuteOptions["fetchTypeHandler"];
}

export function oracleConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): OracleConnectionConfig {
  const user = env.ORACLE_USER?.trim();
  if (!user) throw new Error("Set ORACLE_USER for Oracle Database connections.");
  const password = env.ORACLE_PASSWORD;
  if (!password) throw new Error("Set ORACLE_PASSWORD for Oracle Database connections.");

  const configuredConnectString = env.DBSTUDIO_ORACLE_CONNECT_STRING?.trim() || env.ORACLE_CONNECT_STRING?.trim();
  const host = env.ORACLE_HOST?.trim();
  const service = env.ORACLE_SERVICE_NAME?.trim();
  const port = positiveInteger(env.ORACLE_PORT, 1521, "ORACLE_PORT");
  if (port > 65_535) throw new Error("ORACLE_PORT must be between 1 and 65535.");
  const connectString = configuredConnectString || (host && service ? `//${host}:${port}/${service}` : undefined);
  if (!connectString) {
    throw new Error("Set ORACLE_CONNECT_STRING or both ORACLE_HOST and ORACLE_SERVICE_NAME for Oracle Database connections.");
  }

  return {
    user,
    password,
    connectString,
    connectTimeout: positiveInteger(env.ORACLE_CONNECT_TIMEOUT, 10, "ORACLE_CONNECT_TIMEOUT"),
    callTimeout: positiveInteger(env.ORACLE_CALL_TIMEOUT, 30_000, "ORACLE_CALL_TIMEOUT"),
  };
}

export interface OracleSdoWkbValue {
  wkb: Buffer;
  srid: number | null;
  dimensions: 2 | 3 | 4;
}

/** Normalize OGC/ISO WKB dimensional type codes to the EWKB variant accepted by Oracle SDO_UTIL. */
export function normalizeWkbForOracleSdo(wkb: Uint8Array, expectedSrid: number | null): OracleSdoWkbValue {
  const input = Buffer.from(wkb.buffer, wkb.byteOffset, wkb.byteLength);
  if (input.length === 0) throw new Error("Oracle spatial import received an empty WKB value.");
  if (expectedSrid !== null && (!Number.isSafeInteger(expectedSrid) || expectedSrid < 0)) {
    throw new Error("Oracle spatial import received an invalid SRID.");
  }

  let embeddedSrid: number | null = null;
  const readUInt32 = (offset: number, littleEndian: boolean, label: string): number => {
    if (offset < 0 || offset + 4 > input.length) throw new Error(`Oracle spatial import received truncated WKB ${label}.`);
    return littleEndian ? input.readUInt32LE(offset) : input.readUInt32BE(offset);
  };
  const assertCountFits = (count: number, offset: number, bytesPerItem: number, label: string): void => {
    if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor((input.length - offset) / bytesPerItem)) {
      throw new Error(`Oracle spatial import received an invalid or truncated WKB ${label} count.`);
    }
  };

  const parseGeometry = (start: number, depth: number): { end: number; bytes: Buffer; baseType: number; dimensions: 2 | 3 | 4 } => {
    if (depth > 32) throw new Error("Oracle spatial import received a WKB geometry nested too deeply.");
    if (start < 0 || start + 5 > input.length) throw new Error("Oracle spatial import received truncated WKB geometry header.");
    const byteOrder = input[start]!;
    if (byteOrder !== 0 && byteOrder !== 1) throw new Error("Oracle spatial import received an invalid WKB byte order.");
    const littleEndian = byteOrder === 1;
    const rawType = readUInt32(start + 1, littleEndian, "type");
    const hasZFlag = (rawType & 0x8000_0000) !== 0;
    const hasMFlag = (rawType & 0x4000_0000) !== 0;
    const hasSridFlag = (rawType & 0x2000_0000) !== 0;
    let baseType = rawType & 0x1fff_ffff;
    let hasZ = hasZFlag;
    let hasM = hasMFlag;
    if (!hasZFlag && !hasMFlag) {
      if (baseType >= 3_000 && baseType < 4_000) {
        hasZ = true;
        hasM = true;
        baseType -= 3_000;
      } else if (baseType >= 2_000 && baseType < 3_000) {
        hasM = true;
        baseType -= 2_000;
      } else if (baseType >= 1_000 && baseType < 2_000) {
        hasZ = true;
        baseType -= 1_000;
      }
    }
    if (baseType < 1 || baseType > 7) {
      throw new Error(`Oracle spatial import does not support WKB geometry type ${baseType}.`);
    }
    const dimensions = (2 + Number(hasZ) + Number(hasM)) as 2 | 3 | 4;
    const ewkbType = baseType | (hasZ ? 0x8000_0000 : 0) | (hasM ? 0x4000_0000 : 0);
    const header = Buffer.alloc(5);
    header[0] = byteOrder;
    if (littleEndian) header.writeUInt32LE(ewkbType >>> 0, 1);
    else header.writeUInt32BE(ewkbType >>> 0, 1);

    let offset = start + 5;
    if (hasSridFlag) {
      const currentSrid = readUInt32(offset, littleEndian, "SRID");
      offset += 4;
      if (embeddedSrid !== null && embeddedSrid !== currentSrid) {
        throw new Error("Oracle spatial import received conflicting embedded WKB SRIDs.");
      }
      embeddedSrid = currentSrid;
    }

    const chunks: Uint8Array[] = [header];
    if (baseType === 1) {
      const coordinateBytes = dimensions * 8;
      if (offset + coordinateBytes > input.length) throw new Error("Oracle spatial import received truncated WKB point coordinates.");
      chunks.push(input.subarray(offset, offset + coordinateBytes));
      offset += coordinateBytes;
    } else if (baseType === 2) {
      const count = readUInt32(offset, littleEndian, "point");
      assertCountFits(count, offset + 4, dimensions * 8, "point");
      const end = offset + 4 + count * dimensions * 8;
      chunks.push(input.subarray(offset, end));
      offset = end;
    } else if (baseType === 3) {
      const ringCount = readUInt32(offset, littleEndian, "ring");
      assertCountFits(ringCount, offset + 4, 4, "ring");
      let cursor = offset + 4;
      for (let ring = 0; ring < ringCount; ring += 1) {
        const pointCount = readUInt32(cursor, littleEndian, "ring point");
        assertCountFits(pointCount, cursor + 4, dimensions * 8, "ring point");
        cursor += 4 + pointCount * dimensions * 8;
      }
      chunks.push(input.subarray(offset, cursor));
      offset = cursor;
    } else {
      const childCount = readUInt32(offset, littleEndian, "child geometry");
      assertCountFits(childCount, offset + 4, 9, "child geometry");
      const expectedChildType = baseType === 4 ? 1 : baseType === 5 ? 2 : baseType === 6 ? 3 : undefined;
      const childChunks: Uint8Array[] = [input.subarray(offset, offset + 4)];
      let cursor = offset + 4;
      for (let child = 0; child < childCount; child += 1) {
        const parsedChild = parseGeometry(cursor, depth + 1);
        if (parsedChild.dimensions !== dimensions || (expectedChildType !== undefined && parsedChild.baseType !== expectedChildType)) {
          throw new Error("Oracle SDO_GEOMETRY import requires consistent dimensions and child types in multi-geometries.");
        }
        childChunks.push(parsedChild.bytes);
        cursor = parsedChild.end;
      }
      chunks.push(Buffer.concat(childChunks));
      offset = cursor;
    }

    return { end: offset, bytes: Buffer.concat(chunks), baseType, dimensions };
  };

  const parsed = parseGeometry(0, 0);
  if (parsed.end !== input.length) throw new Error("Oracle spatial import received trailing bytes after the WKB geometry.");
  if (embeddedSrid !== null && expectedSrid !== null && embeddedSrid !== expectedSrid) {
    throw new Error(`Oracle spatial import received embedded SRID ${embeddedSrid}, expected ${expectedSrid}.`);
  }
  return {
    wkb: parsed.bytes,
    srid: expectedSrid ?? (embeddedSrid === null || embeddedSrid === 0 ? null : embeddedSrid),
    dimensions: parsed.dimensions,
  };
}

export class OracleAdapter implements DatabaseAdapter {
  private connection?: Promise<Connection>;

  constructor(private readonly config: OracleConnectionConfig) {}

  async testConnection(): Promise<{ database: string; serverVersion: string }> {
    const result = await (await this.connect()).execute(
      `SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS "database",
              (SELECT version FROM product_component_version
               WHERE product LIKE 'Oracle%Database%' AND ROWNUM = 1) AS "server_version"
       FROM dual`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const row = result.rows?.[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("Oracle Database returned no connection details.");
    return {
      database: String(row.database ?? ""),
      serverVersion: String(row.server_version ?? ""),
    };
  }

  async query(
    sql: string,
    parameters: unknown[] = [],
    options: Pick<ExecuteOptions, "fetchTypeHandler"> = {},
  ): Promise<QueryResult> {
    const startTime = new Date();
    let status: 'success' | 'error' = 'success';
    let errorMessage: string | undefined;

    try {
      const statement = removeTrailingSemicolon(sql);
      if (!statement) throw new Error("SQL statement cannot be empty.");
      const result = await (await this.connect()).execute(statement, parameters, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
        ...options,
      });
      const endTime = new Date();
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
      const rowCount = result.rowsAffected ?? rows.length;
      const command = statement.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
      const affectedRows = result.rowsAffected !== undefined && rows.length === 0 ? result.rowsAffected : undefined;

      return {
        columns: result.metaData?.map((column) => column.name) ?? Object.keys(rows[0] ?? {}),
        rows,
        rowCount,
        command,
        metrics: {
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime(),
          rowCount,
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

  async *queryStream(sql: string, parameters: unknown[] = [], options: OracleQueryStreamOptions = {}): AsyncGenerator<QueryResultBatch> {
    const batchSize = queryStreamBatchSize(options);
    throwIfQueryStreamAborted(options.signal);
    const statement = removeTrailingSemicolon(sql);
    if (!statement) throw new Error("SQL statement cannot be empty.");
    const result = await (await this.connect()).execute(statement, parameters, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      resultSet: true,
      fetchArraySize: batchSize,
      autoCommit: true,
      ...(options.fetchTypeHandler ? { fetchTypeHandler: options.fetchTypeHandler } : {}),
    });
    const resultSet = result.resultSet;
    if (!resultSet) {
      yield* batchBufferedQueryResult({
        columns: result.metaData?.map((column) => column.name) ?? [],
        rows: (result.rows ?? []) as Record<string, unknown>[],
        rowCount: result.rowsAffected ?? result.rows?.length ?? 0,
        command: statement.trimStart().split(/\s+/, 1)[0]?.toUpperCase(),
      }, options);
      return;
    }

    const metadata = result.metaData ?? [];
    const columns = metadata.map((column) => column.name);
    const command = statement.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
    let yielded = false;
    try {
      while (true) {
        throwIfQueryStreamAborted(options.signal);
        const rows = await resultSet.getRows(batchSize) as Record<string, unknown>[];
        if (rows.length === 0) {
          if (!yielded) yield { columns, rows: [], rowCount: 0, command };
          break;
        }
        yielded = true;
        yield {
          columns,
          rows: rows.map((row) => streamOracleLobCells(row, metadata, true)),
          rowCount: rows.length,
          command,
        };
        if (rows.length < batchSize) break;
      }
    } finally {
      await resultSet.close();
    }
  }

  async updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]> {
    const batch = validateUpdateStatements(statements);
    if (batch.length === 0) return [];
    const connection = await this.connect();
    const results: QueryResult[] = [];
    try {
      for (const statement of batch) {
        const sql = removeTrailingSemicolon(statement.sql);
        const result = await connection.execute(sql, statement.parameters, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          autoCommit: false,
        });
        const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
        const rowCount = result.rowsAffected ?? rows.length;
        assertSingleRowAffected(rowCount);
        results.push({
          columns: result.metaData?.map((column) => column.name) ?? Object.keys(rows[0] ?? {}),
          rows,
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
    const result = await this.query(`SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS "name" FROM dual`);
    return result.rows.map((row) => String(row.name));
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.query(`SELECT username AS "name" FROM all_users ORDER BY username`);
    return result.rows.map((row) => String(row.name));
  }

  async listTables(schema = this.defaultSchema()): Promise<TableInfo[]> {
    const owner = schema.toUpperCase();
    const result = await this.query(
      `SELECT owner AS "schema", table_name AS "name", 'table' AS "type"
       FROM all_tables WHERE owner = :1
       UNION ALL
       SELECT owner AS "schema", view_name AS "name", 'view' AS "type"
       FROM all_views WHERE owner = :1
       ORDER BY "name"`,
      [owner, owner],
    );
    return result.rows.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: String(row.type) === "view" ? "view" : "table",
    }));
  }

  async getTableColumns(table: string, schema = this.defaultSchema()): Promise<ColumnInfo[]> {
    const result = await this.query(
      `SELECT c.column_name AS "name",
              c.data_type AS "data_type",
              CASE WHEN c.nullable = 'Y' THEN 1 ELSE 0 END AS "nullable",
              c.data_default AS "default_value",
              CASE WHEN EXISTS (
                SELECT 1
                FROM all_constraints pk
                JOIN all_cons_columns pkc
                  ON pkc.owner = pk.owner AND pkc.constraint_name = pk.constraint_name
                 AND pkc.table_name = pk.table_name
                WHERE pk.constraint_type = 'P'
                  AND pk.owner = c.owner AND pk.table_name = c.table_name
                  AND pkc.column_name = c.column_name
              ) THEN 1 ELSE 0 END AS "primary_key",
              c.column_id AS "ordinal_position"
       FROM all_tab_columns c
       WHERE c.owner = :1 AND c.table_name = :2
       ORDER BY c.column_id`,
      [schema.toUpperCase(), table],
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      dataType: String(row.data_type ?? ""),
      nullable: Number(row.nullable) === 1,
      defaultValue: row.default_value === null || row.default_value === undefined
        ? null
        : String(row.default_value),
      primaryKey: Number(row.primary_key) === 1,
      ordinalPosition: Number(row.ordinal_position),
    }));
  }

  async getTableForeignKeys(table: string, schema = this.defaultSchema()) {
    const result = await this.query(
      "SELECT fk.constraint_name AS name, fkc.column_name AS column_name, " +
      "pk.owner AS referenced_schema, pk.table_name AS referenced_table, pkc.column_name AS referenced_column " +
      "FROM all_constraints fk " +
      "JOIN all_cons_columns fkc ON fkc.owner = fk.owner AND fkc.constraint_name = fk.constraint_name " +
      "JOIN all_constraints pk ON pk.owner = fk.r_owner AND pk.constraint_name = fk.r_constraint_name " +
      "AND pk.constraint_type IN ('P', 'U') " +
      "JOIN all_cons_columns pkc ON pkc.owner = pk.owner AND pkc.constraint_name = pk.constraint_name " +
      "AND pkc.position = fkc.position " +
      "WHERE fk.constraint_type = 'R' AND fk.owner = :1 AND fk.table_name = :2 " +
      "ORDER BY fk.constraint_name, fkc.position",
      [schema.toUpperCase(), table],
    );
    return groupForeignKeyRows(result.rows as Array<{
      name: unknown; column_name: unknown; referenced_schema?: unknown; referenced_table: unknown; referenced_column: unknown;
    }>);
  }

  async readTable(table: string, schema = this.defaultSchema()): Promise<QueryResult> {
    return this.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
  }

  async readTablePage(table: string, columns: string[], primaryKeys: string[], cursor: unknown[] | undefined, limit: number, schema = this.defaultSchema(), options: TableTransferReadOptions = {}): Promise<QueryResult> {
    const query = buildTableTransferPageQuery("oracle", schema, table, columns, primaryKeys, cursor, limit, options);
    if (options.streamLobs) {
      const result = await (await this.connect()).execute(query.sql, query.parameters, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      const metadata = result.metaData ?? [];
      const rows = ((result.rows ?? []) as Array<Record<string, unknown>>)
        .map((row) => streamOracleLobCells(row, metadata, true));
      const spatial = normalizeOracleSpatialRows(rows, options.spatialWkbColumns ?? [], query.spatialSridAliases, query.spatialGtypeAliases, query.spatialVerticesAliases);
      const hiddenAliases = new Set([...Object.values(query.spatialSridAliases ?? {}), ...Object.values(query.spatialGtypeAliases ?? {}), ...Object.values(query.spatialVerticesAliases ?? {})]
        .map((alias) => alias.toLocaleUpperCase("en-US")));
      return {
        columns: metadata.map((column) => column.name).filter((name) => !hiddenAliases.has(name.toLocaleUpperCase("en-US"))),
        rows: spatial,
        rowCount: result.rowsAffected ?? spatial.length,
        command: "SELECT",
      };
    }
    const result = await this.query(query.sql, query.parameters, { fetchTypeHandler: oracleTransferFetchTypeHandler });
    if (!query.spatialSridAliases) return result;
    const hiddenAliases = new Set([...Object.values(query.spatialSridAliases), ...Object.values(query.spatialGtypeAliases ?? {}), ...Object.values(query.spatialVerticesAliases ?? {})]
      .map((alias) => alias.toLocaleUpperCase("en-US")));
    return {
      ...result,
      columns: result.columns.filter((name) => !hiddenAliases.has(name.toLocaleUpperCase("en-US"))),
      rows: normalizeOracleSpatialRows(result.rows, options.spatialWkbColumns ?? [], query.spatialSridAliases, query.spatialGtypeAliases, query.spatialVerticesAliases),
    };
  }

  async createTable(table: string, columns: ImportTableColumn[], schema = this.defaultSchema()): Promise<void> {
    await this.query(buildCreateTableStatement("oracle", table, columns, schema));
  }

  async insertRows(table: string, columns: string[], rows: unknown[][], schema = this.defaultSchema()): Promise<number> {
    if (columns.length === 0) throw new Error("At least one destination column is required.");
    if (rows.some((row) => row.length !== columns.length)) {
      throw new Error("Every imported row must match the destination column count.");
    }
    if (rows.length === 0) return 0;

    const connection = await this.connect();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const columnList = columns.map(quoteIdentifier).join(", ");
    const targetColumnTypes = new Map(
      (await this.getTableColumns(table, schema)).map((column) => [column.name, column.dataType.toUpperCase()]),
    );
    try {
      for (const row of rows) {
        const binds: unknown[] = [];
        const valueExpressions = row.map((value, index) => {
          const bindPlaceholder = `:${binds.length + 1}`;
          const columnType = targetColumnTypes.get(columns[index]!)?.replace(/^MDSYS\./i, "") ?? "";
          if (value === null && columnType === "SDO_GEOMETRY") return "CAST(NULL AS MDSYS.SDO_GEOMETRY)";
          if (isSpatialTransferValue(value)) {
            if (value.spatialType !== "geometry" || columnType !== "SDO_GEOMETRY") {
              throw new Error("Oracle spatial row transfer supports geometry values only for SDO_GEOMETRY columns.");
            }
            const normalized = normalizeWkbForOracleSdo(value.wkb, value.srid);
            binds.push({ val: normalized.wkb, type: oracledb.BUFFER });
            const wkbPlaceholder = bindPlaceholder;
            if (normalized.srid === null) return `MDSYS.SDO_UTIL.FROM_WKBGEOMETRY(${wkbPlaceholder})`;
            const sridPlaceholder = `:${binds.length + 1}`;
            binds.push({ val: normalized.srid, type: oracledb.NUMBER });
            return `MDSYS.SDO_UTIL.FROM_WKBGEOMETRY(${wkbPlaceholder}, ${sridPlaceholder})`;
          }
          if (value instanceof Uint8Array) {
            binds.push({ val: Buffer.from(value), type: oracledb.BUFFER });
            return bindPlaceholder;
          }
          const rawColumnType = targetColumnTypes.get(columns[index]!) ?? "";
          if (typeof value === "string" && rawColumnType === "DATE") {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
              throw new Error(`Oracle DATE imports require an ISO YYYY-MM-DD value for column '${columns[index]}'.`);
            }
            binds.push(value);
            return `TO_DATE(${bindPlaceholder}, 'YYYY-MM-DD')`;
          }
          if (typeof value === "string" && /^TIMESTAMP(?:\s*\(\d+\))?$/.test(rawColumnType)) {
            const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(value);
            if (!match) {
              throw new Error(`Oracle TIMESTAMP imports require an ISO local date-time with at most millisecond precision for column '${columns[index]}'.`);
            }
            binds.push(`${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(3, "0")}`);
            return `TO_TIMESTAMP(${bindPlaceholder}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3')`;
          }
          if (typeof value === "string" && rawColumnType === "CLOB") binds.push({ val: value, type: oracledb.CLOB });
          else if (typeof value === "string" && rawColumnType === "NCLOB") binds.push({ val: value, type: oracledb.NCLOB });
          else binds.push(value);
          return bindPlaceholder;
        });
        const statement = `INSERT INTO ${target} (${columnList}) VALUES (${valueExpressions.join(", ")})`;
        await connection.execute(statement, binds, { autoCommit: false });
      }
      await connection.commit();
      return rows.length;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  }

  async insertRowWithStreamedLobs(table: string, columns: string[], row: unknown[], schema = this.defaultSchema()): Promise<number> {
    if (columns.length === 0 || row.length !== columns.length) {
      throw new Error("A streamed transfer row must match its destination columns.");
    }
    const streamed = row.flatMap((value, index) => isQueryStreamCell(value)
      ? [{ index, column: columns[index]!, cell: value }]
      : []);
    if (streamed.length === 0) throw new Error("A streamed transfer row must contain at least one LOB stream.");

    const targetTypes = new Map((await this.getTableColumns(table, schema)).map((column) => [column.name, column.dataType.trim().toUpperCase()]));
    for (const item of streamed) {
      const dataType = targetTypes.get(item.column);
      if (!dataType) throw new Error(`Destination column '${item.column}' was not found.`);
      const compatible = item.cell.encoding === "buffer"
        ? dataType === "BLOB"
        : dataType === "CLOB" || dataType === "NCLOB";
      if (!compatible) {
        throw new Error(`Cannot stream ${item.cell.encoding === "utf8" ? "text" : "binary"} data into Oracle ${dataType} column '${item.column}'.`);
      }
    }

    const connection = await this.connect();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const bindValues: Record<string, unknown> = {};
    const outBindNames = new Map<number, string>();
    const values = row.map((value, index) => {
      if (isQueryStreamCell(value)) {
        const dataType = targetTypes.get(columns[index]!)!;
        const outName = `dbstudio_lob${outBindNames.size}`;
        outBindNames.set(index, outName);
        bindValues[outName] = {
          dir: oracledb.BIND_OUT,
          type: dataType === "BLOB" ? oracledb.BLOB : dataType === "NCLOB" ? oracledb.NCLOB : oracledb.CLOB,
        };
        return dataType === "BLOB" ? "EMPTY_BLOB()" : "EMPTY_CLOB()";
      }
      const bindName = `dbstudio_value${index}`;
      if (value instanceof Uint8Array) bindValues[bindName] = { val: Buffer.from(value), type: oracledb.BUFFER };
      else bindValues[bindName] = value;
      return `:${bindName}`;
    });
    const returning = [...outBindNames.values()].map((name) => `:${name}`).join(", ");
    const returningColumns = [...outBindNames.keys()].map((index) => quoteIdentifier(columns[index]!)).join(", ");
    const statement = `INSERT INTO ${target} (${columns.map(quoteIdentifier).join(", ")}) ` +
      `VALUES (${values.join(", ")}) RETURNING ${returningColumns} INTO ${returning}`;
    const lobs: Lob[] = [];
    try {
      const result = await connection.execute(statement, bindValues as BindParameters, { autoCommit: false });
      const outBinds = result.outBinds as Record<string, unknown> | undefined;
      if (!outBinds) throw new Error("Oracle did not return writable LOB locators for streamed transfer.");
      for (const item of streamed) {
        const outName = outBindNames.get(item.index)!;
        const returned = outBinds[outName];
        const lob = (Array.isArray(returned) ? returned[0] : returned) as Lob | undefined;
        if (!lob || typeof lob.write !== "function") {
          throw new Error(`Oracle did not return a writable LOB locator for '${item.column}'.`);
        }
        lobs.push(lob);
        const completed = finished(lob, { readable: false });
        try {
          for await (const chunk of item.cell.stream) {
            if (item.cell.encoding === "utf8" && typeof chunk !== "string") {
              throw new Error(`Text LOB stream '${item.column}' emitted non-text data.`);
            }
            if (item.cell.encoding === "buffer" && !(chunk instanceof Uint8Array)) {
              throw new Error(`Binary LOB stream '${item.column}' emitted non-binary data.`);
            }
            if (!lob.write(chunk)) await once(lob, "drain");
          }
          lob.end();
          await completed;
        } catch (error) {
          lob.destroy(error instanceof Error ? error : new Error(String(error)));
          await completed.catch(() => undefined);
          throw error;
        } finally {
          item.cell.destroy();
        }
      }
      await connection.commit();
      return 1;
    } catch (error) {
      for (const lob of lobs) lob.destroy();
      for (const item of streamed) item.cell.destroy();
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.connection) return;
    const pending = this.connection;
    this.connection = undefined;
    const connection = await pending.catch(() => undefined);
    if (connection) await connection.close();
  }

  private connect(): Promise<Connection> {
    this.connection ??= oracledb.getConnection({
      user: this.config.user,
      password: this.config.password,
      connectString: this.config.connectString,
      connectTimeout: this.config.connectTimeout ?? 10,
    }).then((connection) => {
      connection.callTimeout = this.config.callTimeout ?? 30_000;
      return connection;
    }).catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  private defaultSchema(): string {
    return this.config.user.toUpperCase();
  }
}

function quoteIdentifier(identifier: string): string {
  if (!identifier.trim()) throw new Error("Oracle identifiers cannot be empty.");
  return `"${identifier.replaceAll('"', '""')}"`;
}

function removeTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
}

export function oracleTransferFetchTypeHandler(metadata: Parameters<NonNullable<ExecuteOptions["fetchTypeHandler"]>>[0]) {
  if (metadata.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING };
  if (metadata.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
  if (metadata.dbType === oracledb.DB_TYPE_CLOB) return { type: oracledb.STRING };
  if (metadata.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
  return undefined;
}

function normalizeOracleSpatialRows(
  rows: Array<Record<string, unknown>>,
  spatialWkbColumns: string[],
  spatialSridAliases: Record<string, string> | undefined,
  spatialGtypeAliases: Record<string, string> | undefined,
  spatialVerticesAliases: Record<string, string> | undefined,
): Array<Record<string, unknown>> {
  if (!spatialWkbColumns.length) return rows;
  if (!spatialSridAliases || !spatialGtypeAliases) throw new Error("Oracle spatial transfer is missing the SRID or geometry-type projection.");
  return rows.map((row) => {
    const normalized = { ...row };
    for (const column of spatialWkbColumns) {
      const alias = spatialSridAliases[column];
      const gtypeAlias = spatialGtypeAliases[column];
      const verticesAlias = spatialVerticesAliases?.[column];
      if (!alias || !gtypeAlias || !verticesAlias) {
        throw new Error(`Oracle spatial transfer is missing the SRID, geometry-type or vertex alias for '${column}'.`);
      }
      const findKey = (name: string): string | undefined => Object.keys(normalized)
        .find((key) => key.toLocaleUpperCase("en-US") === name.toLocaleUpperCase("en-US"));
      const columnKey = findKey(column);
      const sridKey = findKey(alias);
      const gtypeKey = findKey(gtypeAlias);
      const verticesKey = findKey(verticesAlias);
      if (!columnKey || !sridKey || !gtypeKey || !verticesKey) {
        throw new Error(`Oracle spatial transfer did not return WKB, SRID, SDO_GTYPE and SDO vertices for '${column}'.`);
      }
      const wkb = normalized[columnKey];
      const sridValue = normalized[sridKey];
      const gtypeValue = normalized[gtypeKey];
      const vertexJson = normalized[verticesKey];
      delete normalized[sridKey];
      delete normalized[gtypeKey];
      delete normalized[verticesKey];
      if (wkb === null || wkb === undefined) {
        normalized[columnKey] = null;
        continue;
      }
      if (!(wkb instanceof Uint8Array)) throw new Error(`Oracle spatial transfer returned non-binary WKB for '${column}'.`);
      const gtype = Number(gtypeValue);
      if (!Number.isSafeInteger(gtype)) throw new Error(`Oracle spatial transfer returned an invalid SDO_GTYPE for '${column}'.`);
      const srid = sridValue === null || sridValue === undefined ? null : Number(sridValue);
      if (srid !== null && !Number.isSafeInteger(srid)) throw new Error(`Oracle spatial transfer returned an invalid SRID for '${column}'.`);
      const dimensions = Math.trunc(gtype / 1_000);
      let outputWkb: Uint8Array = Buffer.from(wkb);
      if (dimensions !== 2) {
        if (typeof vertexJson !== "string") {
          throw new Error(`Oracle spatial transfer did not return SDO Z/M vertex ordinates as text for '${column}'.`);
        }
        outputWkb = oracleSdo2dWkbToDimensionalWkb(outputWkb, gtype, vertexJson);
      }
      normalized[columnKey] = {
        kind: "db-studio-spatial-wkb",
        spatialType: "geometry",
        wkb: outputWkb,
        srid,
      };
    }
    return normalized;
  });
}

function streamOracleLobCells(
  row: Record<string, unknown>,
  metadata: Array<{ name: string; dbType?: unknown }>,
  keepOpenUntilConsumerFinishes = false,
): Record<string, unknown> {
  for (const column of metadata) {
    const value = row[column.name];
    const encoding = column.dbType === oracledb.DB_TYPE_CLOB || column.dbType === oracledb.DB_TYPE_NCLOB
      ? "utf8"
      : column.dbType === oracledb.DB_TYPE_BLOB ? "buffer" : undefined;
    if (!encoding || !value || typeof value !== "object") continue;
    const lob = value as {
      [Symbol.asyncIterator]?: () => AsyncIterator<string | Uint8Array>;
      chunkSize?: number;
      pieceSize?: number;
      setEncoding?: (encoding: BufferEncoding) => unknown;
      _autoCloseLob?: boolean;
      destroy?: () => unknown;
    };
    if (typeof lob[Symbol.asyncIterator] !== "function" || typeof lob.destroy !== "function") continue;
    if (encoding === "utf8") {
      if (typeof lob.setEncoding !== "function") continue;
      lob.setEncoding("utf8");
      if (Number.isSafeInteger(lob.chunkSize) && lob.chunkSize! > 0) {
        lob.pieceSize = Math.ceil(64 * 1024 / lob.chunkSize!) * lob.chunkSize!;
      }
    }
    if (keepOpenUntilConsumerFinishes) {
      if (typeof lob._autoCloseLob !== "boolean") {
        lob.destroy();
        throw new Error("Oracle driver does not expose the expected LOB lifecycle control for streamed consumption.");
      }
      // node-oracledb 26 can close a paused LOB before consumers drain buffered pieces.
      // The CLI or transfer writer destroys the LOB after full consumption or failure.
      lob._autoCloseLob = false;
    }
    const cell: QueryStreamCell = {
      __dbStudioQueryStreamCell: true,
      encoding,
      stream: value as AsyncIterable<string | Uint8Array>,
      destroy: () => { lob.destroy?.(); },
    };
    row[column.name] = cell;
  }
  return row;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
