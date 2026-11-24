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
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return [[match[1], value]];
  }));
}

const dockerEnv = readDockerEnv();
function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const host = process.env.DBSTUDIO_REPAIR_HOST || "127.0.0.1";
const port = Number(process.env.DBSTUDIO_POSTGIS_PORT || dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432");
const database = required("DBSTUDIO_PG_DATABASE", "dbstudio_test");
assert.equal(host, "127.0.0.1", "This smoke test only permits the authorized local isolated PostgreSQL service.");
assert.equal(database, "dbstudio_test", "This smoke test only permits the project test database.");
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "PostgreSQL port must be valid.");

const suffix = randomBytes(6).toString("hex");
const tableName = `ai_repair_${suffix}`;
const tableSql = `public.${q(tableName)}`;
const service = CoreService.fromPostgresConfig({
  host,
  port,
  database,
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: required("DBSTUDIO_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 8_000,
});

let tableCreated = false;
let stage = "settings";
let outcome;
let failure;
try {
  const settings = await readDesktopAiModelSettings();
  const chat = settings.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
    ?? settings.chatModels.find((model) => model.enabled);
  assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

  stage = "fixture-create";
  await service.query(`CREATE TABLE ${tableSql} (id integer PRIMARY KEY, label text NOT NULL)`);
  tableCreated = true;
  await service.query(`INSERT INTO ${tableSql} (id, label) VALUES (1, 'synthetic-row')`);

  stage = "fixture-error";
  const brokenSql = `SELECT title FROM ${tableSql} WHERE id = 1`;
  let databaseError;
  try {
    await service.query(brokenSql);
  } catch (error) {
    databaseError = error;
  }
  assert.ok(databaseError, "The deliberately missing column must fail in PostgreSQL before requesting a repair.");
  assert.equal(databaseError.code, "42703", "The fixture must produce PostgreSQL undefined_column.");

  stage = "model-repair";
  const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
    task: "repair",
    request: "修复当前 PostgreSQL 查询错误。只把不存在的 title 改为当前表中实际存在且表达地点名称的 label；保留 id = 1 筛选和读取意图，不增加表、字段或其他条件。",
    context: {
      engine: "postgres",
      serverVersion: "16",
      database,
      schema: "public",
      tables: [{
        schema: "public",
        name: tableName,
        type: "table",
        columns: [
          { name: "id", dataType: "integer", nullable: false, primaryKey: true },
          { name: "label", dataType: "text", nullable: false, primaryKey: false },
        ],
      }],
      selectedSql: brokenSql,
      error: {
        code: databaseError.code,
        message: String(databaseError.message).slice(0, 1_000),
      },
    },
  });

  stage = "repair-guard";
  const repairedSql = response.result.sql ?? "";
  assert.equal(response.result.task, "repair");
  assert.ok(repairedSql, "The model must return a repaired SQL statement.");
  assert.equal(response.validation?.valid, true, "The repaired query must pass the SQL read-only and schema validator.");
  assert.equal(response.validation?.readOnly, true);
  const referenced = response.validation?.referencedTables ?? [];
  assert.equal(referenced.length, 1, "Only the synthetic fixture table may be referenced.");
  assert.equal(referenced[0]?.schema?.toLowerCase(), "public");
  assert.equal(referenced[0]?.name?.toLowerCase(), tableName.toLowerCase());
  const normalized = repairedSql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
  assert.match(normalized, /^\s*select\b/, "Only a direct SELECT is allowed for this execution check.");
  assert.match(normalized, /\blabel\b/, "The result must project the known label field.");
  assert.match(normalized, /\bid\s*=\s*1\b/, "The original id filter must be preserved.");
  assert.doesNotMatch(normalized, /\btitle\b/, "The nonexistent field must be removed.");
  assert.doesNotMatch(normalized, /\b[a-z_][a-z0-9_$]*\s*\(/, "No SQL functions are needed for this fixture.");
  assert.doesNotMatch(normalized, /\b(union|intersect|except)\b/, "Set operations are not needed for this fixture.");

  stage = "repair-execute";
  const repairedResult = await service.query(repairedSql);
  assert.equal(repairedResult.rows.length, 1, "The repaired SELECT must return exactly one synthetic row.");
  assert.equal(repairedResult.rows[0].label, "synthetic-row");

  outcome = {
    ok: true,
    scenario: "postgres-live-missing-column-repair",
    engine: "postgres",
    databaseErrorCode: "42703",
    validatedReadOnly: true,
    targetTableMatched: true,
    intentPreserved: true,
    repairExecuted: true,
    resultRows: 1,
    schemaSent: "random synthetic table and undefined_column error only",
    businessRowsSent: false,
    credentialsSent: false,
    responseContentLogged: false,
  };
} catch (error) {
  failure = {
    scenario: "postgres-live-missing-column-repair",
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    databaseErrorCode: error?.code,
    providerStatus: error?.status,
    providerCode: error?.providerCode,
    schemaSent: "synthetic only",
    responseContentLogged: false,
  };
  process.exitCode = 1;
} finally {
  if (tableCreated) {
    try {
      await service.query(`DROP TABLE IF EXISTS ${tableSql}`);
      tableCreated = false;
    } catch (error) {
      failure ??= {
        scenario: "postgres-live-missing-column-repair",
        stage: "fixture-cleanup",
        errorName: error instanceof Error ? error.name : "UnknownError",
        databaseErrorCode: error?.code,
        schemaSent: "synthetic only",
        responseContentLogged: false,
      };
      process.exitCode = 1;
    }
  }
}

if (failure) {
  process.stderr.write(`${JSON.stringify({ ok: false, ...failure })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ ...outcome, fixtureRemoved: !tableCreated })}\n`);
}
