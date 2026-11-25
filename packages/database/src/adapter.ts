import type { ColumnInfo, DatabaseEngine, ParameterizedSqlStatement, QueryResult, QueryResultBatch, QueryStreamOptions, QueryStreamCell, TableForeignKeyInfo, TableInfo, TableRowChange } from "@db-studio/shared";

export function queryStreamBatchSize(options: QueryStreamOptions = {}): number {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("Query stream batch size must be between 1 and 10000.");
  }
  return batchSize;
}

export function throwIfQueryStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Query streaming was cancelled.");
}

export async function* batchBufferedQueryResult(
  result: QueryResult,
  options: QueryStreamOptions = {},
): AsyncGenerator<QueryResultBatch> {
  const batchSize = queryStreamBatchSize(options);
  if (result.rows.length === 0) {
    throwIfQueryStreamAborted(options.signal);
    yield { ...result, rows: [] };
    return;
  }
  for (let offset = 0; offset < result.rows.length; offset += batchSize) {
    throwIfQueryStreamAborted(options.signal);
    const rows = result.rows.slice(offset, offset + batchSize);
    yield { columns: result.columns, rows, rowCount: rows.length, command: result.command };
  }
}

export interface ForeignKeyMetadataRow {
  name: unknown;
  column_name: unknown;
  referenced_schema?: unknown;
  referenced_table: unknown;
  referenced_column: unknown;
}

export type ImportColumnType = "text" | "integer" | "real" | "boolean" | "date" | "time" | "datetime" | "json" | "binary";

export interface ImportTableColumn {
  name: string;
  type: ImportColumnType;
}

export interface TableTransferReadOptions {
  streamLobs?: boolean;
  streamLobColumns?: Record<string, "utf8" | "buffer">;
  exactNumericColumns?: string[];
  jsonTextColumns?: string[];
  spatialWkbColumns?: string[];
}

export function groupForeignKeyRows(rows: ForeignKeyMetadataRow[]): TableForeignKeyInfo[] {
  const grouped = new Map<string, TableForeignKeyInfo>();
  for (const row of rows) {
    const name = String(row.name ?? "");
    const item = grouped.get(name) ?? {
      name,
      columns: [],
      referencedSchema: row.referenced_schema === null || row.referenced_schema === undefined ? undefined : String(row.referenced_schema),
      referencedTable: String(row.referenced_table ?? ""),
      referencedColumns: [],
    };
    item.columns.push(String(row.column_name ?? ""));
    item.referencedColumns.push(String(row.referenced_column ?? ""));
    grouped.set(name, item);
  }
  return [...grouped.values()];
}

export interface DatabaseAdapter {
  testConnection(): Promise<{ database: string; serverVersion: string }>;
  query(sql: string, parameters?: unknown[]): Promise<QueryResult>;
  queryStream(sql: string, parameters?: unknown[], options?: QueryStreamOptions): AsyncIterable<QueryResultBatch>;
  updateRows(statements: ParameterizedSqlStatement[]): Promise<QueryResult[]>;
  listDatabases(): Promise<string[]>;
  listSchemas(): Promise<string[]>;
  listTables(schema?: string, options?: { limit?: number }): Promise<TableInfo[]>;  listTables(schema?: string): Promise<TableInfo[]>;
  getTableColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
  getTableForeignKeys(table: string, schema?: string): Promise<TableForeignKeyInfo[]>;
  readTable(table: string, schema?: string): Promise<QueryResult>;
  readTablePage(
    table: string,
    columns: string[],
    primaryKeys: string[],
    cursor: unknown[] | undefined,
    limit: number,
    schema?: string,
    options?: TableTransferReadOptions,
  ): Promise<QueryResult>;
  createTable(table: string, columns: ImportTableColumn[], schema?: string): Promise<void>;
  insertRows(table: string, columns: string[], rows: unknown[][], schema?: string): Promise<number>;
  insertRowWithStreamedLobs?(
    table: string,
    columns: string[],
    row: unknown[],
    schema?: string,
  ): Promise<number>;
  close(): Promise<void>;
}

export function buildCreateTableStatement(
  engine: DatabaseEngine,
  table: string,
  columns: ImportTableColumn[],
  schema: string,
): string {
  if (engine === "mongodb") throw new Error("MongoDB collections cannot be created through the relational table importer.");
  if (!table.trim() || !schema.trim() || columns.length === 0) {
    throw new Error("A schema, table name, and at least one column are required.");
  }
  if (new Set(columns.map((column) => column.name)).size !== columns.length
    || columns.some((column) => !column.name.trim())) {
    throw new Error("Imported table columns must have unique, non-empty names.");
  }
  const types = engine === "postgres"
    ? { text: "TEXT", integer: "BIGINT", real: "DOUBLE PRECISION", boolean: "BOOLEAN", date: "DATE", time: "TIME", datetime: "TIMESTAMPTZ", json: "JSONB", binary: "BYTEA" }
    : engine === "sqlite"
      ? { text: "TEXT", integer: "INTEGER", real: "REAL", boolean: "INTEGER", date: "TEXT", time: "TEXT", datetime: "TEXT", json: "TEXT", binary: "BLOB" }
      : engine === "mysql" || engine === "mariadb"
        ? { text: "LONGTEXT", integer: "BIGINT", real: "DOUBLE", boolean: "BOOLEAN", date: "DATE", time: "TIME(3)", datetime: "DATETIME(3)", json: "JSON", binary: "LONGBLOB" }
        : engine === "sqlserver"
          ? { text: "NVARCHAR(MAX)", integer: "BIGINT", real: "FLOAT", boolean: "BIT", date: "DATE", time: "TIME(3)", datetime: "DATETIME2(3)", json: "NVARCHAR(MAX)", binary: "VARBINARY(MAX)" }
          : { text: "CLOB", integer: "NUMBER(19)", real: "BINARY_DOUBLE", boolean: "NUMBER(1)", date: "DATE", time: "VARCHAR2(32)", datetime: "TIMESTAMP(3)", json: "CLOB", binary: "BLOB" };
  const definitions = columns.map((column) => `${quoteIdentifier(engine, column.name)} ${types[column.type]} NULL`);
  return `CREATE TABLE ${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)} (${definitions.join(", ")})`;
}

export function validateUpdateStatements(input: ParameterizedSqlStatement[]): ParameterizedSqlStatement[] {
  if (!Array.isArray(input) || input.length > 100) {
    throw new Error("An update batch cannot contain more than 100 statements.");
  }
  for (const statement of input) {
    if (!statement || typeof statement.sql !== "string" || statement.sql.length > 100_000
      || !/^UPDATE\b/i.test(statement.sql.trimStart())
      || !Array.isArray(statement.parameters) || statement.parameters.length > 2_000) {
      throw new Error("Each batch item must be a bounded, parameterized UPDATE statement.");
    }
  }
  return input;
}

export function assertSingleRowAffected(rowCount: number): void {
  if (rowCount !== 1) {
    throw new Error(`Expected one row in the update batch, but the database affected ${rowCount}; the transaction was rolled back.`);
  }
}

const READ_ONLY_DATA_TYPE = /(?:array|binary|blob|bytea|clob|geography|geometry|image|json|large\s+object|object|raster|raw|variant|xml)/i;

function quoteIdentifier(engine: DatabaseEngine, identifier: string): string {
  if (engine === "mysql" || engine === "mariadb") return `\`${identifier.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return "[" + identifier.replaceAll("]", "]]") + "]";
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parameterPlaceholder(engine: DatabaseEngine, index: number): string {
  if (engine === "postgres") return `$${index}`;
  if (engine === "sqlserver") return `@p${index}`;
  if (engine === "oracle") return `:${index}`;
  return "?";
}

export function buildTableTransferPageQuery(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  columns: string[],
  primaryKeys: string[],
  cursor: unknown[] | undefined,
  limit: number,
  options: TableTransferReadOptions = {},
): { sql: string; parameters: unknown[]; spatialSridAliases?: Record<string, string>; spatialGtypeAliases?: Record<string, string>; spatialVerticesAliases?: Record<string, string> } {
  if (!schema.trim() || !table.trim()) throw new Error("Table transfer requires a schema and table name.");
  if (!columns.length || columns.some((column) => !column.trim()) || new Set(columns).size !== columns.length) {
    throw new Error("Table transfer requires unique, non-empty columns.");
  }
  if (!primaryKeys.length || new Set(primaryKeys).size !== primaryKeys.length || primaryKeys.some((key) => !columns.includes(key))) {
    throw new Error("Table transfer requires primary-key columns selected from the source columns.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Table transfer page size must be an integer from 1 to 1,000.");
  }
  if (cursor && (cursor.length !== primaryKeys.length || cursor.some((value) => value === null || value === undefined))) {
    throw new Error("Table transfer cursor must contain one non-null value per primary-key column.");
  }
  const exactNumericColumns = options.exactNumericColumns ?? [];
  if (new Set(exactNumericColumns).size !== exactNumericColumns.length
    || exactNumericColumns.some((column) => !columns.includes(column))) {
    throw new Error("Exact-numeric projection columns must be unique selected columns.");
  }
  const jsonTextColumns = options.jsonTextColumns ?? [];
  if (new Set(jsonTextColumns).size !== jsonTextColumns.length
    || jsonTextColumns.some((column) => !columns.includes(column))) {
    throw new Error("JSON text projection columns must be unique selected columns.");
  }
  if (jsonTextColumns.length && !["postgres", "mysql", "mariadb"].includes(engine)) {
    throw new Error(`JSON text projection is not supported for ${engine}.`);
  }
  const spatialWkbColumns = options.spatialWkbColumns ?? [];
  if (new Set(spatialWkbColumns).size !== spatialWkbColumns.length
    || spatialWkbColumns.some((column) => !columns.includes(column))) {
    throw new Error("Spatial WKB projection columns must be unique selected columns.");
  }
  if (spatialWkbColumns.length && !["postgres", "sqlserver", "mysql", "mariadb", "oracle", "sqlite"].includes(engine)) {
    throw new Error(`Spatial WKB projection is not supported for ${engine}.`);
  }
  if (engine === "mongodb") throw new Error("MongoDB does not support relational table transfer queries.");

  const quote = (identifier: string) => quoteIdentifier(engine, identifier);
  const parameters: unknown[] = [];
  const placeholder = (value: unknown) => {
    parameters.push(value);
    return parameterPlaceholder(engine, parameters.length);
  };
  let where = "";
  if (cursor) {
    const alternatives = primaryKeys.map((key, index) => {
      const terms = primaryKeys.slice(0, index).map((previousKey, previousIndex) =>
        `${quote(previousKey)} = ${placeholder(cursor[previousIndex])}`,
      );
      terms.push(`${quote(key)} > ${placeholder(cursor[index])}`);
      return `(${terms.join(" AND ")})`;
    });
    where = ` WHERE ${alternatives.join(" OR ")}`;
  }
  const orderBy = primaryKeys.map(quote).join(", ");
  const limitParameter = placeholder(limit);
  const pagination = engine === "sqlserver" || engine === "oracle"
    ? ` OFFSET 0 ROWS FETCH NEXT ${limitParameter} ROWS ONLY`
    : ` LIMIT ${limitParameter}`;
  const oracleSourceAlias = engine === "oracle" ? "dbstudio_source" : undefined;
  const spatialSridAliases: Record<string, string> = {};
  const spatialGtypeAliases: Record<string, string> = {};
  const spatialVerticesAliases: Record<string, string> = {};
  const usedAliases = new Set(columns.map((column) => column.toLocaleLowerCase("en-US")));
  const oracleAliasIndexes: Record<string, number> = {};
  const nextOracleAlias = (prefix: "srid" | "gtype" | "vertices"): string => {
    let aliasIndex = (oracleAliasIndexes[prefix] ?? 0) + 1;
    let alias = `__dbstudio_spatial_${prefix}_${aliasIndex}`;
    while (usedAliases.has(alias.toLocaleLowerCase("en-US"))) alias = `__dbstudio_spatial_${prefix}_${++aliasIndex}`;
    oracleAliasIndexes[prefix] = aliasIndex;
    usedAliases.add(alias.toLocaleLowerCase("en-US"));
    return alias;
  };
  const selection = columns.flatMap((column) => {
    if (spatialWkbColumns.includes(column)) {
      const identifier = quote(column);
      if (engine === "oracle") {
        const sourceIdentifier = `${oracleSourceAlias}.${identifier}`;
        const sridAlias = nextOracleAlias("srid");
        const gtypeAlias = nextOracleAlias("gtype");
        const verticesAlias = nextOracleAlias("vertices");
        spatialSridAliases[column] = sridAlias;
        spatialGtypeAliases[column] = gtypeAlias;
        spatialVerticesAliases[column] = verticesAlias;
        // TO_WKBGEOMETRY drops Z and rejects 4D SDO_GEOMETRY values. Use a 2D
        // structural WKB for non-XY rows and carry the Z/M ordinates separately
        // through GETVERTICES so the adapter can rebuild dimensional WKB.
        return [
          `CASE WHEN ${sourceIdentifier} IS NULL THEN NULL `
            + `WHEN TRUNC(${sourceIdentifier}.SDO_GTYPE / 1000) = 2 THEN MDSYS.SDO_UTIL.TO_WKBGEOMETRY(${sourceIdentifier}) `
            + `ELSE MDSYS.SDO_UTIL.TO_WKBGEOMETRY(MDSYS.SDO_CS.MAKE_2D(${sourceIdentifier})) END AS ${identifier}`,
          `CASE WHEN ${sourceIdentifier} IS NULL THEN NULL ELSE ${sourceIdentifier}.SDO_SRID END AS ${quote(sridAlias)}`,
          `CASE WHEN ${sourceIdentifier} IS NULL THEN NULL ELSE ${sourceIdentifier}.SDO_GTYPE END AS ${quote(gtypeAlias)}`,
          `CASE WHEN ${sourceIdentifier} IS NULL OR TRUNC(${sourceIdentifier}.SDO_GTYPE / 1000) = 2 THEN NULL ELSE `
            + `(SELECT JSON_ARRAYAGG(JSON_OBJECT('x' VALUE vertex.x, 'y' VALUE vertex.y, 'z' VALUE vertex.z, 'w' VALUE vertex.w) `
            + `ORDER BY vertex.id RETURNING CLOB) FROM TABLE(MDSYS.SDO_UTIL.GETVERTICES(${sourceIdentifier})) vertex) `
            + `END AS ${quote(verticesAlias)}`,
        ];
      }
      const expression = engine === "postgres"
        ? `encode(ST_AsBinary(${identifier}), 'hex') || ':' || ST_SRID(${identifier})::text`
        : engine === "sqlserver"
          ? `CONVERT(varchar(max), ${identifier}.AsBinaryZM(), 2) + ':' + CONVERT(varchar(10), ${identifier}.STSrid)`
          : engine === "mysql"
            ? `CONCAT(HEX(ST_AsWKB(${identifier}, 'axis-order=long-lat')), ':', ST_SRID(${identifier}))`
            : engine === "mariadb"
              ? `CONCAT(HEX(ST_AsWKB(${identifier})), ':', ST_SRID(${identifier}))`
              // SQLite has no WKB SQL functions; the raw geometry BLOB is
              // decoded into a SpatialTransferValue by SqliteAdapter.
              : identifier;
      return `CASE WHEN ${identifier} IS NULL THEN NULL ELSE ${expression} END AS ${identifier}`;
    }
    if (jsonTextColumns.includes(column)) {
      const expression = engine === "postgres"
        ? `${quote(column)}::text`
        : `CAST(${quote(column)} AS CHAR)`;
      return `${expression} AS ${quote(column)}`;
    }
    return engine === "sqlserver" && exactNumericColumns.includes(column)
      ? `CONVERT(varchar(100), ${quote(column)}) AS ${quote(column)}`
      : quote(column);
  });
  return {
    sql: `SELECT ${selection.join(", ")} FROM ${quote(schema)}.${quote(table)}${oracleSourceAlias ? ` ${oracleSourceAlias}` : ""}${where} ORDER BY ${orderBy}${pagination}`,
    parameters,
    ...(Object.keys(spatialSridAliases).length ? { spatialSridAliases } : {}),
    ...(Object.keys(spatialGtypeAliases).length ? { spatialGtypeAliases } : {}),
    ...(Object.keys(spatialVerticesAliases).length ? { spatialVerticesAliases } : {}),
  };
}

function isSafeBoundValue(value: unknown, allowDate: boolean): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return allowDate && value instanceof Date && Number.isFinite(value.getTime());
}

export function buildTableUpdateStatements(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  columns: ColumnInfo[],
  changes: TableRowChange[],
): ParameterizedSqlStatement[] {
  if (engine === "mongodb") throw new Error("MongoDB documents cannot be edited as SQL table rows.");
  if (!schema.trim() || !table.trim() || schema.length > 400 || table.length > 400) {
    throw new Error("A valid schema and table are required for row updates.");
  }
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
    throw new Error("A table update batch must contain 1 to 100 rows.");
  }

  const primaryKeys = columns.filter((column) => column.primaryKey);
  if (!primaryKeys.length) throw new Error("This table has no primary key and cannot be edited safely.");
  const primaryKeyNames = new Set(primaryKeys.map((column) => column.name));
  const columnsByName = new Map(columns.map((column) => [column.name, column]));
  if (primaryKeys.some((column) => READ_ONLY_DATA_TYPE.test(column.dataType))) {
    throw new Error("This table has a complex primary key and cannot be edited safely.");
  }

  let textValueLength = 0;
  const validateValue = (value: unknown, allowDate: boolean): boolean => {
    if (typeof value === "string") {
      textValueLength += value.length;
      return textValueLength <= 1_000_000;
    }
    return isSafeBoundValue(value, allowDate);
  };

  return changes.map((change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)
      || !change.primaryKeyValues || typeof change.primaryKeyValues !== "object" || Array.isArray(change.primaryKeyValues)
      || !change.values || typeof change.values !== "object" || Array.isArray(change.values)) {
      throw new Error("Each row change must include primary key values and edited column values.");
    }
    const keyNames = Object.keys(change.primaryKeyValues);
    if (keyNames.length > 256 || keyNames.some((name) => !name || name.length > 400)) {
      throw new Error("A row locator has too many or invalid field names.");
    }
    if (keyNames.length !== primaryKeys.length || primaryKeys.some((column) => !Object.hasOwn(change.primaryKeyValues, column.name))) {
      throw new Error("Row locator fields must exactly match the table's primary key.");
    }
    for (const key of primaryKeys) {
      if (!validateValue(change.primaryKeyValues[key.name], true)) {
        throw new Error(`Primary key value for ${key.name} is not a supported scalar.`);
      }
    }

    const editedNames = Object.keys(change.values);
    if (!editedNames.length || editedNames.length > 256 || editedNames.some((name) => !name || name.length > 400)) {
      throw new Error("Each row change must edit 1 to 256 valid columns.");
    }
    const values: Array<{ column: ColumnInfo; value: unknown }> = editedNames.map((name) => {
      const column = columnsByName.get(name);
      if (!column || primaryKeyNames.has(name) || READ_ONLY_DATA_TYPE.test(column.dataType)) {
        throw new Error(`Column ${name} is not editable.`);
      }
      const value = change.values[name];
      if (!validateValue(value, false)) throw new Error(`Value for ${name} must be a scalar or NULL, with at most 1 MB of text per batch.`);
      if (value === null && !column.nullable) throw new Error(`Column ${name} does not allow NULL.`);
      return { column, value };
    });

    const parameters: unknown[] = [];
    const assignments = values.map(({ column, value }) => {
      parameters.push(value);
      return `${quoteIdentifier(engine, column.name)} = ${parameterPlaceholder(engine, parameters.length)}`;
    });
    const predicates = primaryKeys.map((column) => {
      const value = change.primaryKeyValues[column.name];
      const identifier = quoteIdentifier(engine, column.name);
      if (value === null) return `${identifier} IS NULL`;
      parameters.push(value);
      return `${identifier} = ${parameterPlaceholder(engine, parameters.length)}`;
    });
    const qualifiedTable = `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`;
    return {
      sql: `UPDATE ${qualifiedTable}\nSET ${assignments.join(", ")}\nWHERE ${predicates.join(" AND ")}`,
      parameters,
    };
  });
}
