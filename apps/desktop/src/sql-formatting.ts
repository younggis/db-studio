import type { DatabaseEngine } from "@db-studio/shared";

/** Minimal formatter sufficient for the SQL editor's "Format" action. */
export function formatSqlDocument(source: string, engine?: DatabaseEngine): string {
  const keywords = /\b(SELECT|FROM|WHERE|AND|OR|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|VIEW|ALTER|DROP|WITH|DISTINCT|CASE|WHEN|THEN|ELSE|END|NULL|IS|NOT|IN|EXISTS|UNION|ALL)\b/gi;
  return source
    .replace(/\s+/g, " ")
    .trim()
    .replace(keywords, (match) => "\n" + match)
    .replace(/^\n+/, "")
    .replace(/,\s*/g, ",\n  ")
    .replace(/\n\s*\n+/g, "\n");
}

export function sqlFormattingLanguage(engine?: DatabaseEngine): string {
  return engine === "postgres" ? "PostgreSQL"
    : engine === "sqlite" ? "SQLite"
    : engine === "mysql" || engine === "mariadb" ? "MySQL"
    : engine ?? "SQL";
}
