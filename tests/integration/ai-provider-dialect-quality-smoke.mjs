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
  const columns = [
    { name: "id", dataType: "integer", nullable: false, primaryKey: true },
    { name: "label", dataType: "text", nullable: false, primaryKey: false },
  ];
  const table = (schema, name = "ai_smoke_places") => ({ schema, name, type: "table", columns });
  const limit = /\bLIMIT\s+1\b|\bFETCH\s+(?:FIRST|NEXT)\s+1\b/i;
  const relationalCases = [
    {
      name: "postgres", engine: "postgres", serverVersion: "16", database: "ai_dialect_smoke", schema: "public",
      tables: [table("public")],
      accepts: (sql) => limit.test(sql) && !/\bTOP\b/i.test(sql),
    },
    {
      name: "mysql", engine: "mysql", serverVersion: "8.4", database: "ai_dialect_smoke", schema: "ai_dialect_smoke",
      tables: [table("ai_dialect_smoke")],
      accepts: (sql) => /\bLIMIT\s+1\b/i.test(sql) && !/\bTOP\b|\bFETCH\b/i.test(sql),
    },
    {
      name: "mariadb", engine: "mariadb", serverVersion: "11.4", database: "ai_dialect_smoke", schema: "ai_dialect_smoke",
      tables: [table("ai_dialect_smoke")],
      accepts: (sql) => /\bLIMIT\s+1\b/i.test(sql) && !/\bTOP\b|\bFETCH\b/i.test(sql),
    },
    {
      name: "sqlserver", engine: "sqlserver", serverVersion: "2022", database: "ai_dialect_smoke", schema: "dbo",
      tables: [table("dbo")],
      accepts: (sql) => /\bTOP\s*(?:\(\s*1\s*\)|1)(?=\s|,|$)/i.test(sql) || /\bOFFSET\s+0\s+ROWS\s+FETCH\s+(?:NEXT|FIRST)\s+1\s+ROWS?\s+ONLY\b/i.test(sql),
    },
    {
      name: "oracle", engine: "oracle", serverVersion: "23ai", database: "ai_dialect_smoke", schema: "AI_DIALECT_SMOKE",
      tables: [table("AI_DIALECT_SMOKE", "AI_SMOKE_PLACES")],
      accepts: (sql) => /\bFETCH\s+(?:FIRST|NEXT)\s+1\s+ROWS?\s+ONLY\b|\bROWNUM\s*<=?\s*1\b/i.test(sql) && !/\bLIMIT\b|\bTOP\b/i.test(sql),
    },
    {
      name: "sqlite", engine: "sqlite", serverVersion: "3", database: "ai_dialect_smoke", schema: "main",
      tables: [table("main")],
      accepts: (sql) => /\bLIMIT\s+1\b/i.test(sql) && !/\bTOP\b|\bFETCH\b/i.test(sql),
    },
  ];

  const spatialTable = {
    schema: "public", name: "ai_smoke_places", type: "table",
    columns: [
      ...columns,
      { name: "location", dataType: "geography", nullable: false, primaryKey: false,
        spatial: { kind: "geography", geometryType: "POINT", srid: 4326 } },
    ],
  };
  const scenarios = [
    ...relationalCases.map((item) => ({
      ...item,
      task: "generate",
      request: "只读取 id 和 label，按 id 升序返回第一条记录。使用当前数据库方言的正确分页语法。",
      context: {
        engine: item.engine, serverVersion: item.serverVersion, database: item.database, schema: item.schema,
        tables: item.tables,
      },
    })),
    {
      name: "postgis", task: "gis",
      request: "查询以经纬度 -122.4、37.8 为中心，半径 2500 米内的地点，仅返回 id 和 label。",
      accepts: (sql) => /\bST_DWithin\s*\(/i.test(sql) && /\b4326\b/.test(sql) && /\b2500\b/.test(sql),
      context: {
        engine: "postgres", serverVersion: "16", database: "ai_dialect_smoke", schema: "public",
        tables: [spatialTable],
        postgis: {
          version: "3.6.4",
          spatialColumns: [{ schema: "public", table: "ai_smoke_places", column: "location", kind: "geography", geometryType: "POINT", srid: 4326 }],
          supportedFunctions: ["ST_DWITHIN", "ST_SETSRID", "ST_MAKEPOINT"],
        },
      },
    },
  ];

  const requestedCases = (process.argv[2] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const requestedNames = new Set(requestedCases);
  const selectedScenarios = requestedNames.size ? scenarios.filter((scenario) => requestedNames.has(scenario.name)) : scenarios;
  if (requestedNames.size && (selectedScenarios.length !== requestedNames.size || !selectedScenarios.length)) {
    process.stderr.write("Unknown dialect smoke case.\n");
    process.exitCode = 2;
  } else {
    let activeCase = "configuration";
    let diagnostics;
    try {
    const results = [];
    for (const scenario of selectedScenarios) {
      activeCase = scenario.name;
      diagnostics = undefined;
      const response = await runSqlAssistant({ ...chat, timeoutMs }, {
        task: scenario.task,
        request: scenario.request,
        context: scenario.context,
      });
      const sql = response.result.sql ?? "";
      diagnostics = {
        taskMatched: response.result.task === scenario.task,
        hasSql: Boolean(sql),
        validationValid: response.validation?.valid === true,
        readOnly: response.validation?.readOnly === true,
        parsed: response.validation?.parsed === true,
        dialectSyntaxMatched: scenario.accepts(sql),
        referencedTableCount: response.validation?.referencedTables.length ?? 0,
        validationErrorCount: response.validation?.errors.length ?? 0,
      };
      if (!diagnostics.taskMatched || !diagnostics.hasSql || !diagnostics.validationValid
        || !diagnostics.readOnly || !diagnostics.dialectSyntaxMatched) {
        throw new Error("dialect-quality-check-failed");
      }
      const caseResult = { name: scenario.name, ok: true, validatedReadOnly: true };
      results.push(caseResult);
      process.stdout.write(`${JSON.stringify({ event: "case", ...caseResult })}\n`);
    }

      process.stdout.write(`${JSON.stringify({
        ok: true,
        cases: results,
        schemaSent: "synthetic ai_smoke_places schema only",
        responseContentLogged: false,
        sqlExecuted: false,
      })}\n`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "quality-or-provider";
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const failureClass = error instanceof Error && /无效结构/.test(error.message) ? "invalid-structured-output" : code;
      process.stderr.write(`${JSON.stringify({
        ok: false,
        failedCase: activeCase,
        errorCode: code,
        errorName,
        failureClass,
        ...(failureClass === "invalid-structured-output" && error instanceof Error
          ? { errorMessage: error.message.slice(0, 360) }
          : {}),
        diagnostics,
        responseContentLogged: false,
        sqlExecuted: false,
      })}\n`);
      process.exitCode = 1;
    }
  }
}
