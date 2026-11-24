import { runSqlAssistant } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);

if (!chat) {
  process.stderr.write("An enabled Chat model is required in encrypted desktop settings.\n");
  process.exitCode = 2;
} else {
  const timeoutMs = 45_000;
  const tables = [{
    schema: "public", name: "ai_smoke_places", type: "table",
    columns: [
      { name: "id", dataType: "integer", nullable: false, primaryKey: true },
      { name: "label", dataType: "text", nullable: false, primaryKey: false },
    ],
  }];
  const scenarios = [
    {
      name: "postgres-missing-column",
      request: "修复缺失字段错误，保留按 id=1 筛选并返回地点 label 的意图，只能使用给定字段。",
      context: {
        engine: "postgres", serverVersion: "16", database: "ai_provider_smoke", schema: "public", tables,
        selectedSql: "SELECT title FROM public.ai_smoke_places WHERE id = 1",
        error: { code: "42703", message: 'column "title" does not exist' },
      },
      accepts: (sql) => /\blabel\b/i.test(sql) && !/\btitle\b/i.test(sql),
    },
    {
      name: "mysql-top-to-limit",
      request: "修复 MySQL 方言错误，保持按 id 升序返回第一条记录，使用当前 Schema 中的字段。",
      context: {
        engine: "mysql", serverVersion: "8.4", database: "ai_provider_smoke", schema: "ai_provider_smoke",
        tables: [{ ...tables[0], schema: "ai_provider_smoke" }],
        selectedSql: "SELECT TOP 1 id, label FROM ai_provider_smoke.ai_smoke_places ORDER BY id",
        error: { code: "1064", message: "You have an error in your SQL syntax near '1'" },
      },
      accepts: (sql) => /\bLIMIT\s+1\b/i.test(sql) && !/\bTOP\b/i.test(sql),
    },
    {
      name: "mariadb-top-to-limit",
      request: "修复 MariaDB 方言错误，保持按 id 升序返回第一条记录，使用当前 Schema 中的字段。",
      context: {
        engine: "mariadb", serverVersion: "11.4", database: "ai_provider_smoke", schema: "ai_provider_smoke",
        tables: [{ ...tables[0], schema: "ai_provider_smoke" }],
        selectedSql: "SELECT TOP 1 id, label FROM ai_provider_smoke.ai_smoke_places ORDER BY id",
        error: { code: "1064", message: "You have an error in your SQL syntax near '1'" },
      },
      accepts: (sql) => /\bLIMIT\s+1\b/i.test(sql) && !/\bTOP\b|\bFETCH\b/i.test(sql)
        && /\bORDER\s+BY\s+id\b/i.test(sql),
    },
    {
      name: "sqlserver-limit-to-fetch",
      request: "修复 SQL Server 分页语法错误，保持按 id 升序返回第一条记录。",
      context: {
        engine: "sqlserver", serverVersion: "16.0", database: "ai_provider_smoke", schema: "dbo",
        tables: [{ ...tables[0], schema: "dbo" }],
        selectedSql: "SELECT id, label FROM dbo.ai_smoke_places ORDER BY id LIMIT 1",
        error: { code: "102", message: "Incorrect syntax near 'LIMIT'." },
      },
      accepts: (sql) => !/\bLIMIT\b/i.test(sql) && /\bORDER\s+BY\s+id\b/i.test(sql)
        && (/\bTOP\s*\(?\s*1\b/i.test(sql) || /\bFETCH\s+NEXT\s+1\s+ROWS?\s+ONLY\b/i.test(sql)),
    },
    {
      name: "oracle-top-to-fetch",
      request: "修复 Oracle 分页语法错误，保持按 ID 升序返回第一条记录。",
      context: {
        engine: "oracle", serverVersion: "23.0", database: "FREEPDB1", schema: "AI_PROVIDER_SMOKE",
        tables: [{ ...tables[0], schema: "AI_PROVIDER_SMOKE", name: "AI_SMOKE_PLACES",
          columns: tables[0].columns.map((column) => ({ ...column, name: column.name.toUpperCase() })) }],
        selectedSql: "SELECT TOP 1 ID, LABEL FROM AI_PROVIDER_SMOKE.AI_SMOKE_PLACES ORDER BY ID",
        error: { code: "ORA-00923", message: "FROM keyword not found where expected" },
      },
      accepts: (sql) => !/\bTOP\b/i.test(sql) && /\bORDER\s+BY\s+ID\b/i.test(sql)
        && (/\bFETCH\s+FIRST\s+1\s+ROWS?\s+ONLY\b/i.test(sql) || /\bROWNUM\s*<=\s*1\b/i.test(sql)),
    },
    {
      name: "sqlite-top-to-limit",
      request: "修复 SQLite 分页语法错误，保持按 id 升序返回第一条记录。",
      context: {
        engine: "sqlite", serverVersion: "3.54", database: "synthetic", schema: "main",
        tables: [{ ...tables[0], schema: "main" }],
        selectedSql: "SELECT TOP 1 id, label FROM main.ai_smoke_places ORDER BY id",
        error: { code: "SQLITE_ERROR", message: 'near "1": syntax error' },
      },
      accepts: (sql) => /\bLIMIT\s+1\b/i.test(sql) && !/\bTOP\b/i.test(sql)
        && /\bORDER\s+BY\s+id\b/i.test(sql),
    },
    {
      name: "postgres-backtick-identifier",
      request: "修复 PostgreSQL 标识符引用语法，保留按 id=1 筛选并返回 label 的意图。",
      context: {
        engine: "postgres", serverVersion: "16", database: "ai_provider_smoke", schema: "public", tables,
        selectedSql: "SELECT `label` FROM public.ai_smoke_places WHERE id = 1",
        error: { code: "42601", message: 'syntax error at or near "`"' },
      },
      accepts: (sql) => /\blabel\b/i.test(sql) && /\bid\s*=\s*1\b/i.test(sql) && !/`/.test(sql),
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    try {
      const response = await runSqlAssistant({ ...chat, timeoutMs }, {
        task: "repair",
        request: scenario.request,
        context: scenario.context,
      });
      const sql = response.result.sql ?? "";
      if (response.result.task !== "repair" || !sql || response.validation?.valid !== true || !scenario.accepts(sql)) {
        results.push({ name: scenario.name, ok: false });
      } else {
        results.push({ name: scenario.name, ok: true, validatedReadOnly: true });
      }
    } catch {
      results.push({ name: scenario.name, ok: false });
    }
  }

  const ok = results.every((result) => result.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    cases: results,
    schemaSent: "synthetic ai_smoke_places(id, label) only",
    responseContentLogged: false,
    sqlExecuted: false,
  })}\n`);
  if (!ok) {
    process.exitCode = 1;
  }
}
