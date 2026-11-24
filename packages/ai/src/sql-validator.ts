import { createRequire } from "node:module";
import type { SqlAssistantContext, SqlValidationResult } from "./types.js";

const { Parser } = createRequire(import.meta.url)("node-sql-parser") as typeof import("node-sql-parser");

const parserDialect: Partial<Record<SqlAssistantContext["engine"], string>> = {
  postgres: "Postgresql",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "Sqlite",
  sqlserver: "TransactSQL",
};
const writeOperations = new Set(["insert", "update", "delete", "merge", "create", "alter", "drop", "truncate", "replace", "call", "execute", "into"]);

function stripCommentsAndStrings(sql: string, maskQuotedIdentifiers = false): string {
  let output = "";
  let state: "plain" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "plain";
  const tick = String.fromCharCode(96);
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "line") {
      if (char === "\n") { output += "\n"; state = "plain"; } else output += " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { output += "  "; index += 1; state = "plain"; } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (state !== "plain") {
      const closes = state === "single" ? "'" : state === "double" ? "\"" : state === "backtick" ? tick : "]";
      if (char === closes) {
        if (next === closes && state !== "bracket") {
          output += state === "single" ? "  " : char;
          index += 1;
        }
        else { output += " "; state = "plain"; }
      } else output += char === "\n" ? "\n" : state === "single" || maskQuotedIdentifiers ? " " : (char === ";" ? " " : char);
      continue;
    }
    if (char === "-" && next === "-") { output += "  "; index += 1; state = "line"; }
    else if (char === "/" && next === "*") { output += "  "; index += 1; state = "block"; }
    else if (char === "'") { output += " "; state = "single"; }
    else if (char === "\"") { output += " "; state = "double"; }
    else if (char === tick) { output += " "; state = "backtick"; }
    else if (char === "[") { output += " "; state = "bracket"; }
    else output += char;
  }
  return output;
}

function countStatements(clean: string): number {
  const trimmed = clean.trim().replace(/;+$/, "").trim();
  return trimmed ? trimmed.split(";").filter((part) => part.trim()).length : 0;
}

function hasWriteOperation(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasWriteOperation);
  if (!node || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string" && writeOperations.has(record.type.toLowerCase())) return true;
  return Object.values(record).some(hasWriteOperation);
}

function normalizedName(value: string): string {
  const tick = String.fromCharCode(96);
  const first = value[0];
  const last = value.at(-1);
  if ((first === "\"" && last === "\"") || (first === tick && last === tick) || (first === "[" && last === "]")) value = value.slice(1, -1);
  return value.replaceAll("\"\"", "\"");
}

function tableParts(value: string): { schema?: string; name: string } | undefined {
  const parts = value.split("::");
  if (parts.length >= 3) {
    const schemaToken = parts[1] === "null" ? undefined : parts[1];
    const name = normalizedName(parts.slice(2).join("::"));
    const qualified = schemaToken ? schemaToken.split(".") : [];
    return { schema: qualified.at(-1), name };
  }
  const path = value.split(".");
  return { schema: path.length > 1 ? normalizedName(path.at(-2)!) : undefined, name: normalizedName(path.at(-1)!) };
}

/**
 * System catalogs / information views are valid query targets even though they
 * are never part of the Schema Context sent to the model. Without this list a
 * correct "list all tables" query is falsely reported as referencing an unknown table.
 */
const SYSTEM_OBJECTS: Readonly<Record<string, ReadonlySet<string>>> = {
  postgres: new Set(["information_schema.tables", "information_schema.columns", "information_schema.schemata",
    "information_schema.views", "information_schema.table_constraints", "information_schema.key_column_usage",
    "information_schema.statistics", "pg_catalog.pg_tables", "pg_catalog.pg_class", "pg_catalog.pg_namespace",
    "pg_catalog.pg_index", "pg_catalog.pg_attribute", "pg_tables", "pg_class", "pg_namespace", "pg_index", "pg_attribute"]),
  mysql: new Set(["information_schema.tables", "information_schema.columns", "information_schema.schemata",
    "information_schema.statistics", "information_schema.table_constraints", "performance_schema"]),
  mariadb: new Set(["information_schema.tables", "information_schema.columns", "information_schema.schemata",
    "information_schema.statistics", "information_schema.table_constraints", "performance_schema"]),
  sqlserver: new Set(["information_schema.tables", "information_schema.columns", "information_schema.schemata",
    "information_schema.views", "sys.tables", "sys.columns", "sys.schemas", "sys.indexes", "sys.objects"]),
  oracle: new Set(["user_tables", "all_tables", "dba_tables", "user_tab_columns", "all_tab_columns",
    "dba_tab_columns", "user_views", "all_views", "user_constraints", "all_constraints", "dual"]),
  sqlite: new Set(["sqlite_master", "sqlite_schema", "sqlite_temp_master", "pragma_table_info", "pragma_table_list"]),
};

function isSystemObject(engine: string | undefined, candidate: { schema?: string; name: string }): boolean {
  const objects = engine ? SYSTEM_OBJECTS[engine] : undefined;
  if (!objects) return false;
  const name = candidate.name.toLowerCase();
  const qualified = `${candidate.schema ? candidate.schema.toLowerCase() + "." : ""}${name}`;
  return objects.has(qualified) || objects.has(name);
}

function tableExists(context: SqlAssistantContext, candidate: { schema?: string; name: string }): boolean {
  if (isSystemObject(context.engine, candidate)) return true;
  return context.tables.some((table) => table.name === candidate.name && (!candidate.schema || candidate.schema === table.schema));
}

function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_][A-Za-z0-9_$]*)(?:\s*\([^)]*\))?\s+as\s*\(/gi;
  for (const match of sql.matchAll(pattern)) names.add(match[1]!.toLowerCase());
  return names;
}

function selectOutputAliases(node: Record<string, unknown>): Set<string> {
  const aliases = new Set<string>();
  if (!Array.isArray(node.columns)) return aliases;
  for (const projection of node.columns) {
    if (!projection || typeof projection !== "object") continue;
    const alias = (projection as Record<string, unknown>).as;
    if (typeof alias === "string" && alias.trim()) aliases.add(normalizedName(alias).toLowerCase());
  }
  return aliases;
}

function physicalColumnNames(node: unknown, engine: string): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown, aliases = new Set<string>(), inOrderBy = false, inDatePart = false): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, aliases, inOrderBy, inDatePart);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "select") {
      const localAliases = selectOutputAliases(record);
      for (const [key, child] of Object.entries(record)) visit(child, localAliases, key === "orderby", false);
      return;
    }
    if (record.type === "column_ref") {
      const name = columnNameFromAst(record)?.toLowerCase();
      const unqualified = record.table == null && record.db == null;
      if (name && !(engine === "sqlserver" && name.startsWith("@")) && !inDatePart && !(inOrderBy && unqualified && aliases.has(name))) names.add(name);
      return;
    }
    const functionName = record.type === "function" && record.name && typeof record.name === "object"
      ? ((record.name as Record<string, unknown>).name as Array<{ value?: unknown }> | undefined)?.[0]?.value
      : undefined;
    const args = record.args && typeof record.args === "object" ? record.args as Record<string, unknown> : undefined;
    const argumentValues = Array.isArray(args?.value) ? args.value : undefined;
    if (engine === "sqlserver" && String(functionName).toLowerCase() === "dateadd" && argumentValues) {
      argumentValues.forEach((argument, index) => visit(argument, aliases, inOrderBy, index === 0));
      for (const [key, child] of Object.entries(record)) {
        if (key !== "args") visit(child, aliases, inOrderBy, false);
      }
      return;
    }
    for (const child of Object.values(record)) visit(child, aliases, inOrderBy, false);
  };
  visit(node);
  return names;
}

function columnNameFromAst(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  if (typeof record.value === "string") return normalizedName(record.value);
  if (typeof record.as === "string") return normalizedName(record.as);
  if (record.expr !== undefined) return columnNameFromAst(record.expr);
  if (record.type === "column_ref") {
    let column: unknown = record.column;
    while (column && typeof column === "object" && "expr" in column) column = (column as Record<string, unknown>).expr;
    return typeof column === "string" ? normalizedName(column) : columnNameFromAst(column);
  }
  return undefined;
}

function cteOutputColumns(node: unknown): Map<string, Set<string>> {
  const output = new Map<string, Set<string>>();
  const statement = Array.isArray(node) && node.length === 1 ? node[0] : node;
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) return output;
  const withItems = (statement as Record<string, unknown>).with;
  if (!Array.isArray(withItems)) return output;
  for (const item of withItems) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = columnNameFromAst(record.name)?.toLowerCase();
    if (!name) continue;
    const columns = new Set<string>();
    if (Array.isArray(record.columns) && record.columns.length > 0) {
      for (const column of record.columns) {
        const columnName = columnNameFromAst(column);
        if (columnName) columns.add(columnName.toLowerCase());
      }
    } else {
      const statement = record.stmt && typeof record.stmt === "object" ? record.stmt as Record<string, unknown> : undefined;
      const projections = Array.isArray(statement?.columns) ? statement.columns : [];
      for (const projection of projections) {
        if (!projection || typeof projection !== "object") continue;
        const columnName = columnNameFromAst(projection);
        if (columnName) columns.add(columnName.toLowerCase());
      }
    }
    if (columns.size === 0) columns.add("*");
    output.set(name, columns);
  }
  return output;
}

function unqualifiedCteOutputReferences(node: unknown, context: SqlAssistantContext): Map<string, number> {
  const output = new Map<string, number>();
  const statement = Array.isArray(node) && node.length === 1 ? node[0] : node;
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) return output;
  const query = statement as Record<string, unknown>;
  if (query.type !== "select") return output;
  const cteColumns = cteOutputColumns(query);
  const cteBodyUnqualifiedColumns = new Set<string>();
  const withItems = Array.isArray(query.with) ? query.with : [];
  const collectCteBodyColumns = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectCteBodyColumns(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "column_ref" && record.table == null && record.db == null) {
      const name = columnNameFromAst(record)?.toLowerCase();
      if (name) cteBodyUnqualifiedColumns.add(name);
      return;
    }
    for (const child of Object.values(record)) collectCteBodyColumns(child);
  };
  for (const item of withItems) {
    if (item && typeof item === "object") collectCteBodyColumns((item as Record<string, unknown>).stmt);
  }
  const visibleCteColumns = new Map<string, Set<string>>();
  const outerPhysicalColumns = new Set<string>();
  const from = Array.isArray(query.from) ? query.from : [];
  for (const relation of from) {
    if (!relation || typeof relation !== "object") continue;
    const record = relation as Record<string, unknown>;
    const table = record.table;
    if (typeof table !== "string") continue;
    const name = normalizedName(table).toLowerCase();
    const columns = cteColumns.get(name);
    if (columns) {
      visibleCteColumns.set(name, columns);
      continue;
    }
    const schema = typeof record.db === "string" ? normalizedName(record.db).toLowerCase() : undefined;
    const physicalTable = context.tables.find((candidate) => candidate.name.toLowerCase() === name &&
      (!schema || candidate.schema?.toLowerCase() === schema));
    for (const column of physicalTable?.columns ?? []) outerPhysicalColumns.add(column.name.toLowerCase());
  }
  if (!visibleCteColumns.size) return output;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "select") return;
    if (record.type === "column_ref") {
      if (record.table == null && record.db == null) {
        const name = columnNameFromAst(record)?.toLowerCase();
        if (!name) return;
        const existsOnPhysicalTable = outerPhysicalColumns.has(name);
        if (!existsOnPhysicalTable && !cteBodyUnqualifiedColumns.has(name) &&
            [...visibleCteColumns.values()].filter((columns) => columns.has(name)).length === 1) {
          output.set(name, (output.get(name) ?? 0) + 1);
        }
      }
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  for (const key of ["columns", "from", "where", "groupby", "having", "orderby"]) visit(query[key]);
  return output;
}

function explicitCteColumnNames(node: unknown): Set<string> {
  const output = new Set<string>();
  const statement = Array.isArray(node) && node.length === 1 ? node[0] : node;
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) return output;
  const withItems = (statement as Record<string, unknown>).with;
  if (!Array.isArray(withItems)) return output;
  for (const item of withItems) {
    if (!item || typeof item !== "object") continue;
    const columns = (item as Record<string, unknown>).columns;
    if (!Array.isArray(columns)) continue;
    for (const column of columns) {
      const name = columnNameFromAst(column);
      if (name) output.add(name.toLowerCase());
    }
  }
  return output;
}

function parsedColumn(value: string): { qualifier?: { schema?: string; name: string }; name: string } | undefined {
  const parts = value.split("::");
  if (parts.length < 3) return undefined;
  const rawQualifier = parts.slice(1, -1).join("::");
  return {
    ...(rawQualifier.toLowerCase() === "null" ? {} : { qualifier: tableParts(rawQualifier) }),
    name: normalizedName(parts.at(-1)!),
  };
}

export function validateSql(sql: string, context: SqlAssistantContext, declaredObjects: string[] = []): SqlValidationResult {
  const errors: string[] = [];
  const warnings = ["静态检查不能替代数据库权限、人工审查或实际执行验证。"];
  if (!sql.trim()) errors.push("模型未返回 SQL。");
  if (sql.length > 50_000) errors.push("SQL 超过 50,000 个字符。");
  const clean = stripCommentsAndStrings(sql);
  if (countStatements(clean) !== 1) errors.push("只允许生成一条 SQL 语句。");
  const keywords = stripCommentsAndStrings(sql, true);
  if (/\b(insert|update|delete|merge|create|alter|drop|truncate|replace|call|execute|grant|revoke|commit|rollback|copy)\b/i.test(keywords)) {
    errors.push("助手默认仅提供只读查询；该 SQL 包含写入或执行操作。");
  }
  if (/\bselect\b[\s\S]*?\binto\b/i.test(keywords)) {
    errors.push("助手默认仅提供只读查询；SELECT INTO 会写入目标或变量。");
  }
  if (/\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b|\block\s+in\s+share\s+mode\b/i.test(keywords)) {
    errors.push("助手默认仅提供只读查询；该 SQL 会获取行锁。");
  }
  if (/\b(?:nextval|setval|set_config|pg_notify|lo_import|lo_export|dblink_exec|get_lock|release_lock|release_all_locks)\s*\(|\bpg_(?:try_)?advisory_(?:(?:xact_)?(?:lock|unlock)(?:_shared)?|unlock_all)\s*\(|\blast_insert_id\s*\(\s*[^)]|\b[a-z_][\w$]*\.nextval\b|\bnext\s+value\s+for\b/i.test(keywords)) {
    errors.push("助手默认仅提供只读查询；该 SQL 调用了会改变数据库、序列或会话状态的操作。");
  }
  if (!/^\s*(select|with)\b/i.test(clean)) errors.push("助手默认仅提供 SELECT 查询草稿。");
  if (/\b(pg_sleep|dblink|lo_import|lo_export|xp_cmdshell|load_file|readfile|writefile|utl_http|http_get)\s*\(/i.test(clean)) {
    warnings.push("SQL 中包含可能产生外部访问或副作用的函数，需人工审查。");
  }
  let parsed = false;
  let rawTables: string[] = [];
  let rawColumns: string[] = [];
  let physicalColumns = new Set<string>();
  let cteColumns = new Map<string, Set<string>>();
  let explicitCteColumns = new Set<string>();
  let unqualifiedCteColumns = new Map<string, number>();
  const dialect = parserDialect[context.engine];
  if (dialect && !errors.length) {
    try {
      const parser = new Parser();
      const ast = parser.astify(sql, { database: dialect });
      physicalColumns = physicalColumnNames(ast, context.engine);
      cteColumns = cteOutputColumns(ast);
      explicitCteColumns = explicitCteColumnNames(ast);
      unqualifiedCteColumns = unqualifiedCteOutputReferences(ast, context);
      const statements = Array.isArray(ast) ? ast : [ast];
      if (statements.length !== 1) errors.push("SQL 解析器检测到多条语句。");
      parsed = true;
      if (statements.length !== 1 || statements.some(hasWriteOperation)) errors.push("SQL 解析器检测到非只读操作或写入目标。");
      const aliases = cteNames(clean);
      rawTables = parser.tableList(sql, { database: dialect }).filter((raw) => {
        const table = tableParts(raw);
        return !table || Boolean(table.schema) || !aliases.has(table.name.toLowerCase());
      });
      rawColumns = parser.columnList(sql, { database: dialect }).filter((raw) => {
        const column = parsedColumn(raw);
        return !column || physicalColumns.has(column.name.toLowerCase());
      });
      rawColumns = rawColumns.filter((raw) => {
        const column = parsedColumn(raw);
        if (!column || column.qualifier) return true;
        const name = column.name.toLowerCase();
        const remaining = unqualifiedCteColumns.get(name) ?? 0;
        if (remaining === 0) return true;
        unqualifiedCteColumns.set(name, remaining - 1);
        return false;
      });
    } catch {
      warnings.push("当前解析器无法确认此方言语法；请用当前数据库验证。");
    }
  } else if (!dialect) {
    warnings.push("当前暂未提供该方言的 SQL AST 解析器；只执行保守的语句、写入和已知副作用检查，不能自动验证列引用。");
  }
  const referencedTables = rawTables.map(tableParts).filter((table): table is { schema?: string; name: string } => Boolean(table?.name));
  const allReferences = [...referencedTables, ...declaredObjects.map(tableParts).filter((table): table is { schema?: string; name: string } => Boolean(table?.name))];
  const unique = new Map<string, { schema?: string; name: string }>();
  for (const item of allReferences) unique.set((item.schema ?? "") + "." + item.name, item);
  const unknown = [...unique.values()].filter((candidate) => !tableExists(context, candidate));
  if ([...unique.values()].some((candidate) => isSystemObject(context.engine, candidate))) {
    warnings.push("查询引用了数据库系统目录/信息视图；静态检查只校验业务表，请人工确认。");
  }
  if (unknown.length) errors.push("Schema Context 中不存在模型引用的表：" + unknown.map((item) => (item.schema ? item.schema + "." : "") + item.name).join(", "));
  if (parsed && rawColumns.length) {
    const unresolvedColumns = new Set<string>();
    for (const rawColumn of rawColumns) {
      const column = parsedColumn(rawColumn);
      if (!column || !column.name || column.name === "*" || column.name === "(.*)") continue;
      if (column.qualifier && cteColumns.has(column.qualifier.name.toLowerCase())) {
        const available = cteColumns.get(column.qualifier.name.toLowerCase())!;
        if (available.has("*") || available.has(column.name.toLowerCase())) continue;
        unresolvedColumns.add(rawColumn);
        continue;
      }
      const candidateReferences = column.qualifier
        ? referencedTables.filter((table) => table.name.toLowerCase() === column.qualifier!.name.toLowerCase() &&
            (!column.qualifier!.schema || table.schema?.toLowerCase() === column.qualifier!.schema.toLowerCase()))
        : referencedTables;
      if (candidateReferences.length === 0) continue;
      const candidates = context.tables.filter((table) => candidateReferences.some((reference) =>
        reference.name.toLowerCase() === table.name.toLowerCase() &&
        (!reference.schema || reference.schema.toLowerCase() === table.schema?.toLowerCase()),
      ));
      if (candidates.length > 0 && !candidates.some((table) => table.columns.some((item) => item.name.toLowerCase() === column.name.toLowerCase())) &&
          !explicitCteColumns.has(column.name.toLowerCase())) {
        unresolvedColumns.add(rawColumn);
      }
    }
    if (unresolvedColumns.size) errors.push("Schema Context 中不存在模型引用的列：" + [...unresolvedColumns].join(", "));
  }
  if (!rawTables.length && parsed && /\b(from|join)\b/i.test(clean)) warnings.push("解析器未能列出 SQL 引用的表，请人工核对对象名称。");
  return {
    valid: errors.length === 0,
    readOnly: !errors.some((error) => /只读|SELECT/.test(error)),
    parsed,
    errors,
    warnings: [...new Set(warnings)],
    referencedTables,
  };
}
