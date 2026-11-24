import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { CoreService } from "../../packages/core/dist/index.js";
import { runSqlAssistant } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

function readDockerEnv() {
  const text = readFileSync(new URL("../../docker/.env", import.meta.url), "utf8");
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith("#")) return [];
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    return [[match[1], value]];
  }));
}

const dockerEnv = readDockerEnv();
function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}
function port(name, fallback) {
  const value = Number(required(name, fallback));
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 65_535);
  return value;
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const suffix = randomBytes(5).toString("hex");
const configurations = [
  {
    engine: "postgres", assistantEngine: "postgres", schema: "public", database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
    serverVersion: "16", tableName: `ai_ident_${suffix}`,
    service: CoreService.fromPostgresConfig({
      host: "127.0.0.1", port: port("DBSTUDIO_POSTGIS_PORT", "25432"),
      database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
      user: required("DBSTUDIO_PG_USER", "dbstudio"), password: required("DBSTUDIO_PG_PASSWORD"),
      ssl: false, connectionTimeoutMillis: 8_000, statement_timeout: 8_000,
    }),
  },
  {
    engine: "oracle", assistantEngine: "oracle", schema: required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase(),
    database: "FREEPDB1", serverVersion: "23ai", tableName: `AI_IDENT_${suffix.toUpperCase()}`,
    service: CoreService.fromOracleConfig({
      user: required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase(), password: required("ORACLE_PASSWORD"),
      connectString: `//127.0.0.1:${port("ORACLE_PORT", "21521")}/${required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1")}`,
      connectTimeout: 10, callTimeout: 8_000,
    }),
  },
];
const selectedEngine = process.argv[2];
assert.ok(!selectedEngine || configurations.some((item) => item.engine === selectedEngine), "Select postgres or oracle.");

const results = [];
const selectedConfigurations = selectedEngine ? configurations.filter((item) => item.engine === selectedEngine) : configurations;
for (const item of selectedConfigurations) {
  const qualified = item.engine === "postgres"
    ? `public."${item.tableName}"`
    : `"${item.schema}"."${item.tableName}"`;
  let created = false;
  let stage = "fixture-create";
  let databaseError;
  let guardDiagnostics;
  let identifierShape;
  let validationErrorKinds;
  let outcome;
  try {
    await item.service.query(`CREATE TABLE ${qualified} (
      "RecordID" ${item.engine === "oracle" ? "NUMBER" : "integer"} PRIMARY KEY,
      "DisplayName" ${item.engine === "oracle" ? "VARCHAR2(80)" : "varchar(80)"} NOT NULL
    )`);
    created = true;
    await item.service.query(`INSERT INTO ${qualified} ("RecordID", "DisplayName") VALUES (1, 'synthetic-identifier-row')`);

    const selectedSql = `SELECT recordid, displayname FROM ${qualified} WHERE recordid = 1`;
    stage = "database-error";
    try { await item.service.query(selectedSql); } catch (error) { databaseError = error; }
    assert.ok(databaseError, `${item.engine}: unquoted mixed-case identifiers must fail on the target engine.`);

    stage = "model-repair";
    const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "repair",
      request: `修复真实字段名大小写/引用错误。当前 ${item.engine} Schema 中精确列名为 "RecordID" 和 "DisplayName"（区分大小写，必须双引号引用）。原 SQL 没有任何绑定占位符，保留字面条件 RecordID = 1 和两列投影；不得新增占位符或绑定参数，也不要改名或更改筛选值。`,
      context: {
        engine: item.assistantEngine,
        serverVersion: item.serverVersion,
        database: item.database,
        schema: item.schema,
        tables: [{ schema: item.schema, name: item.tableName, type: "table", columns: [
          { name: "RecordID", dataType: item.engine === "oracle" ? "NUMBER" : "integer", nullable: false, primaryKey: true },
          { name: "DisplayName", dataType: item.engine === "oracle" ? "VARCHAR2(80)" : "varchar(80)", nullable: false, primaryKey: false },
        ] }],
        selectedSql,
        error: { code: String(databaseError.code ?? databaseError.number ?? "DB_ERROR"), message: String(databaseError.message).slice(0, 1_000) },
      },
    });

    stage = "repair-guard";
    const sql = response.result.sql ?? "";
    const code = sql.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:''|[^'])*'/g, "''");
    const normalized = code.replace(/["`\[\]]/g, "").toLowerCase();
    const withoutQuotedIdentifiers = code.replace(/"(?:[^"]|"")*"/g, " ");
    const refs = response.validation?.referencedTables ?? [];
    validationErrorKinds = [...new Set((response.validation?.errors ?? []).map((message) =>
      /不存在模型引用的列/.test(message) ? "unknown-column"
        : /不存在模型引用的表/.test(message) ? "unknown-table"
          : /只读|SELECT INTO|写入/.test(message) ? "read-only"
            : "other"))];
    identifierShape = {
      selectedQuotedRecordId: /"RecordID"/.test(code),
      selectedQuotedDisplayName: /"DisplayName"/.test(code),
      lowerQuotedRecordId: /"recordid"/.test(code),
      whereReferencesRecordId: /where\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?"RecordID"/i.test(code),
      whereLiteralOne: /where\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?"RecordID"\s*=\s*1\b/i.test(code),
      hasPlaceholder: /(?:\$[0-9]+|@p[0-9]+|:[0-9]+|\?)/i.test(code),
    };
    guardDiagnostics = {
      taskCorrect: response.result.task === "repair",
      returnedSql: Boolean(sql),
      valid: response.validation?.valid === true,
      readOnly: response.validation?.readOnly === true,
      exactQuotedRecordId: /"RecordID"/i.test(code) && /where\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?"RecordID"\s*=\s*1\b/i.test(code),
      exactQuotedDisplayName: /"DisplayName"/i.test(code),
      unquotedWrongIdentifiersRemoved: !/\b(recordid|displayname)\b/i.test(withoutQuotedIdentifiers),
      projectionPreserved: /^\s*select\s+recordid\s*,\s*displayname\s+from\b/i.test(normalized),
      exactSource: new RegExp(`\\bfrom\\s+${item.schema.toLowerCase()}\\s*\\.\\s*${item.tableName.toLowerCase()}\\b`).test(normalized),
      idFilterPreserved: /where\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?recordid\s*=\s*1\b/i.test(normalized),
      noJoinOrWrites: !/\b(join|union|intersect|except|insert|update|delete|merge|create|alter|drop|truncate|copy)\b/i.test(normalized),
      oneFrom: (normalized.match(/\bfrom\b/g) ?? []).length === 1,
      referencedSourceMatches: !refs.length || (refs.length === 1 && refs[0]?.schema?.toLowerCase() === item.schema.toLowerCase() && refs[0]?.name?.toLowerCase() === item.tableName.toLowerCase()),
    };
    for (const [check, passed] of Object.entries(guardDiagnostics)) assert.equal(passed, true, `${item.engine}: identifier guard failed (${check}).`);

    stage = "repair-execute";
    const actual = await item.service.query(sql);
    assert.equal(actual.rows.length, 1);
    assert.ok(Object.values(actual.rows[0]).some((value) => value === "synthetic-identifier-row"));
    outcome = { engine: item.engine, ok: true, databaseErrorCode: String(databaseError.code ?? databaseError.number ?? "DB_ERROR"), quotedCasePreserved: true, validatedReadOnly: true, sourceMatched: true, resultRows: 1 };
  } catch (error) {
    outcome = {
      engine: item.engine, ok: false, stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      failureCode: error?.code,
      databaseErrorCode: databaseError?.code,
      databaseErrorNumber: databaseError?.number,
      guardDiagnostics,
      identifierShape,
      validationErrorKinds,
    };
  } finally {
    let fixtureRemoved = !created;
    if (created) {
      try {
        await item.service.query(item.engine === "oracle" ? `DROP TABLE ${qualified} PURGE` : `DROP TABLE IF EXISTS ${qualified}`);
        fixtureRemoved = true;
      } catch (error) {
        outcome = { engine: item.engine, ok: false, stage: "fixture-cleanup", databaseErrorCode: error?.code };
      }
    }
    results.push({ ...outcome, fixtureRemoved });
  }
}

const ok = results.length === selectedConfigurations.length && results.every((result) => result.ok && result.fixtureRemoved);
process.stdout.write(`${JSON.stringify({
  ok,
  scenarios: results,
  schemaSent: "random synthetic mixed-case identifier schema only",
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
if (!ok) process.exitCode = 1;
