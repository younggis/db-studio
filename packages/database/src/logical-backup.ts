// Dialect-aware logical backup helpers. Pure functions: no I/O, no execution.
// The generated dump uses the original column types and literal INSERT rows so
// it can be restored into an empty schema of the same engine with plain SQL.
import type { DatabaseEngine, ColumnInfo, TableForeignKeyInfo } from "@db-studio/shared";
import { quoteIdentifier } from "./adapter.js";

export interface BackupTable {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: TableForeignKeyInfo[];
  rows: Array<Record<string, unknown>>;
}

export interface BackupOptions {
  includeData?: boolean;
  /** Maximum rows emitted per INSERT statement for readable dumps. */
  batchSize?: number;
}

export function sqlLiteral(value: unknown, engine: DatabaseEngine): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") {
    if (!Number.isFinite(value as number) && typeof value === "number") return "NULL";
    return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  }
  if (value instanceof Date) return "'" + value.toISOString().replaceAll("'", "''") + "'";
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString("hex");
    if (engine === "postgres") return `'\\x${hex}'`;
    if (engine === "mysql" || engine === "mariadb") return `X'${hex}'`;
    if (engine === "oracle") return `HEXTORAW('${hex}')`;
    if (engine === "sqlserver") return `0x${hex}`;
    return `X'${hex}'`;
  }
  if (typeof value === "object") return "'" + JSON.stringify(value).replaceAll("'", "''") + "'";
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function columnDefinition(engine: DatabaseEngine, column: ColumnInfo): string {
  const name = quoteIdentifier(engine, column.name);
  const type = column.dataType?.trim() || "TEXT";
  const nullable = column.nullable ? "NULL" : "NOT NULL";
  let defaultSql = "";
  if (column.defaultValue != null && column.defaultValue !== "") {
    const raw = column.defaultValue.trim();
    // Catalog default expressions (now(), CURRENT_TIMESTAMP, nextval(...), etc.)
    // are already SQL fragments; quoted string defaults arrive with quotes.
    if (/^'.*'$/.test(raw) || /^-?\d+(\.\d+)?$/.test(raw)
      || /^(true|false|null)$/i.test(raw) || /\w+\s*\(/.test(raw)
      || /^(CURRENT_|GETDATE|SYSDATE)/i.test(raw)) {
      defaultSql = ` DEFAULT ${raw}`;
    } else {
      defaultSql = ` DEFAULT ${sqlLiteral(raw, engine)}`;
    }
  }
  return `${name} ${type} ${nullable}${defaultSql}`;
}

export function buildCreateTableSql(
  engine: DatabaseEngine,
  schema: string,
  table: BackupTable,
): string {
  const q = (identifier: string) => quoteIdentifier(engine, identifier);
  const lines = table.columns.map((column) => "  " + columnDefinition(engine, column));
  const primaryKey = table.columns.filter((column) => column.primaryKey).map((column) => q(column.name));
  if (primaryKey.length) lines.push(`  PRIMARY KEY (${primaryKey.join(", ")})`);
  for (const fk of table.foreignKeys) {
    const columns = fk.columns.map(q).join(", ");
    const referenced = fk.referencedColumns.map(q).join(", ");
    const target = fk.referencedSchema
      ? `${q(fk.referencedSchema)}.${q(fk.referencedTable)}`
      : q(fk.referencedTable);
    lines.push(`  CONSTRAINT ${q(fk.name)} FOREIGN KEY (${columns}) REFERENCES ${target} (${referenced})`);
  }
  const qualified = schema ? `${q(schema)}.${q(table.name)}` : q(table.name);
  return `CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n);`;
}

export function buildInsertSql(
  engine: DatabaseEngine,
  schema: string,
  table: BackupTable,
  options: BackupOptions = {},
): string[] {
  if (!options.includeData || table.columns.length === 0 || table.rows.length === 0) return [];
  const q = (identifier: string) => quoteIdentifier(engine, identifier);
  const qualified = schema ? `${q(schema)}.${q(table.name)}` : q(table.name);
  const columnList = table.columns.map((column) => q(column.name)).join(", ");
  const batch = Math.max(1, Math.min(options.batchSize ?? 100, 1000));
  const statements: string[] = [];
  for (let offset = 0; offset < table.rows.length; offset += batch) {
    const chunk = table.rows.slice(offset, offset + batch);
    const values = chunk
      .map((row) => `  (${table.columns.map((column) => sqlLiteral(row[column.name], engine)).join(", ")})`)
      .join(",\n");
    statements.push(`INSERT INTO ${qualified} (${columnList}) VALUES\n${values};`);
  }
  return statements;
}

export function buildBackupSql(
  engine: DatabaseEngine,
  schema: string,
  tables: BackupTable[],
  options: BackupOptions = {},
): string {
  const header = [
    "-- DB Studio logical backup",
    `-- engine: ${engine}`,
    `-- schema: ${schema}`,
    `-- created-at: ${new Date().toISOString()}`,
    `-- tables: ${tables.length}`,
    "-- Restore into an empty schema of the same engine.",
    "",
  ].join("\n");
  const chunks: string[] = [header];
  for (const table of tables) {
    chunks.push(`-- table: ${table.name} (${table.columns.length} columns, ${table.rows.length} rows)`);
    chunks.push(buildCreateTableSql(engine, schema, table));
    chunks.push(...buildInsertSql(engine, schema, table, options));
    chunks.push("");
  }
  return chunks.join("\n") + "\n";
}

/** Split a SQL dump into executable statements, respecting quotes/comments. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "[" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") { lineComment = false; current += char; }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if ((quote === "'" || quote === '"' || quote === "`") && next === quote) {
          current += next;
          index++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; current += char; index++; continue; }
    if (char === "/" && next === "*") { blockComment = true; index++; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; current += char; continue; }
    if (char === "[" && !current.trim()) { quote = "["; current += char; continue; }
    if (char === "]" && quote === "[") { quote = null; current += char; continue; }
    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
