import type { DatabaseEngine, TableInfo } from "@db-studio/shared";

export interface SqlCompletionContext {
  engine?: DatabaseEngine;
  schema?: string;
  tables: TableInfo[];
}

export interface SqlCompletionState {
  kind?: "table" | "column" | "other";
  prefix: string;
  schemaPrefix?: string;
  qualified?: boolean;
  cteNames?: string[];
  columns?: string[];
  table?: string;
}

export function quoteSqlIdentifier(engine: DatabaseEngine | undefined, name: string): string {
  if (engine === "mysql" || engine === "mariadb") return "`" + name.replaceAll("`", "``") + "`";
  if (engine === "sqlserver") return "[" + name.replaceAll("]", "]]") + "]";
  return '"' + name.replaceAll('"', '""') + '"';
}

export function sameSqlCompletionScope(a?: SqlCompletionContext, b?: SqlCompletionContext): boolean {
  if (!a || !b) return false;
  return a.engine === b.engine && a.schema === b.schema && a.tables === b.tables;
}

/** Detect the completion target from SQL text left of the cursor. */
export function getSqlCompletionContext(
  beforeCursor: string,
  _tables: TableInfo[],
  _schema?: string,
  _afterCursor?: string,
): SqlCompletionState | undefined {
  const match = beforeCursor.match(/([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)$/);
  if (match) return { kind: "column", prefix: match[2]!, table: match[1]! };
  const word = beforeCursor.match(/([A-Za-z_][\w]*)$/);
  return word ? { kind: "table", prefix: word[1]! } : undefined;
}
