import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
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

function port(name, fallback) {
  const value = Number(required(name, fallback));
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 65_535, `${name} must be a valid TCP port.`);
  return value;
}

function quote(engine, name) {
  if (engine === "mysql" || engine === "mariadb") return `\`${name.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return `[${name.replaceAll("]", "]]" )}]`;
  return `"${name.replaceAll('"', '""')}"`;
}

function makeEngine(engine, sqlitePath) {
  if (engine === "postgres") {
    return {
      assistantEngine: "postgres", schema: "public", database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
      serverVersion: "16", service: CoreService.fromPostgresConfig({
        host: "127.0.0.1", port: port("DBSTUDIO_POSTGIS_PORT", "25432"),
        database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
        user: required("DBSTUDIO_PG_USER", "dbstudio"), password: required("DBSTUDIO_PG_PASSWORD"),
        ssl: false, connectionTimeoutMillis: 8_000, statement_timeout: 8_000,
      }),
    };
  }
  if (engine === "mysql" || engine === "mariadb") {
    const maria = engine === "mariadb";
    const database = required(maria ? "MARIADB_DATABASE" : "MYSQL_DATABASE", "dbstudio_test");
    return {
      assistantEngine: engine, schema: database, database, serverVersion: maria ? "11.4" : "8.4",
      service: maria
        ? CoreService.fromMariaDbConfig({
            host: "127.0.0.1", port: port("MARIADB_PORT", "23307"), database,
            user: required("MARIADB_USER", "dbstudio"), password: required("MARIADB_PASSWORD"), connectTimeout: 8_000,
          })
        : CoreService.fromMySqlConfig({
            host: "127.0.0.1", port: port("MYSQL_PORT", "23306"), database,
            user: required("MYSQL_USER", "dbstudio"), password: required("MYSQL_PASSWORD"), connectTimeout: 8_000,
          }),
    };
  }
  if (engine === "sqlserver") {
    return {
      assistantEngine: engine, schema: "dbo", database: required("SQLSERVER_DATABASE", "dbstudio_test"), serverVersion: "2022",
      service: CoreService.fromSqlServerConfig({
        server: "127.0.0.1", port: port("SQLSERVER_PORT", "21433"),
        database: required("SQLSERVER_DATABASE", "dbstudio_test"), user: "sa",
        password: required("SQLSERVER_SA_PASSWORD"), encrypt: true, trustServerCertificate: true,
        connectionTimeout: 8_000, requestTimeout: 8_000,
      }),
    };
  }
  if (engine === "oracle") {
    const user = required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase();
    return {
      assistantEngine: engine, schema: user, database: "FREEPDB1", serverVersion: "23ai",
      service: CoreService.fromOracleConfig({
        user, password: required("ORACLE_PASSWORD"),
        connectString: `//127.0.0.1:${port("ORACLE_PORT", "21521")}/${required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1")}`,
        connectTimeout: 10, callTimeout: 8_000,
      }),
    };
  }
  return {
    assistantEngine: "sqlite", schema: "main", database: "synthetic", serverVersion: "3.54",
    service: CoreService.fromSqliteConfig({ path: sqlitePath }),
  };
}

function fixture(engine, suffix, sqlitePath) {
  const oracle = engine === "oracle";
  const name = oracle ? `AI_REPAIR_${suffix.toUpperCase()}` : `ai_repair_${suffix.toLowerCase()}`;
  const details = makeEngine(engine, sqlitePath);
  const qualified = `${quote(engine, details.schema)}.${quote(engine, name)}`;
  const id = quote(engine, oracle ? "ID" : "id");
  const label = quote(engine, oracle ? "LABEL" : "label");
  const integer = oracle ? "NUMBER" : engine === "sqlserver" ? "int" : "integer";
  const text = oracle ? "VARCHAR2(100)" : engine === "sqlserver" ? "nvarchar(100)" : "varchar(100)";
  return {
    ...details,
    name,
    qualified,
    id,
    label,
    createSql: `CREATE TABLE ${qualified} (${id} ${integer} PRIMARY KEY, ${label} ${text} NOT NULL)`,
    insertSql: `INSERT INTO ${qualified} (${id}, ${label}) VALUES (1, 'synthetic-row')`,
    dropSql: engine === "oracle" ? `DROP TABLE ${qualified}` : `DROP TABLE IF EXISTS ${qualified}`,
    columns: [
      { name: oracle ? "ID" : "id", dataType: integer, nullable: false, primaryKey: true },
      { name: oracle ? "LABEL" : "label", dataType: text, nullable: false, primaryKey: false },
    ],
  };
}

function normalizedSql(sql) {
  return sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
}

function isExpectedMissingColumn(engine, error) {
  if (engine === "postgres") return error.code === "42703";
  if (engine === "mysql" || engine === "mariadb") return error.code === "ER_BAD_FIELD_ERROR" || error.errno === 1054;
  if (engine === "sqlserver") return error.number === 207 || /invalid column name/i.test(error.message);
  if (engine === "oracle") return error.code === "ORA-00904";
  return ["SQLITE_ERROR", "ERR_SQLITE_ERROR"].includes(error.code) && /no such column/i.test(error.message);
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const cache = path.resolve(".cache", `ai-sql-repair-matrix-${process.pid}-${randomBytes(5).toString("hex")}`);
mkdirSync(cache, { recursive: true });
const results = [];
const allEngines = ["postgres", "mysql", "mariadb", "sqlserver", "oracle", "sqlite"];
const selectedEngines = process.argv[2] ? process.argv[2].split(",").map((engine) => engine.trim()).filter(Boolean) : allEngines;
assert.ok(selectedEngines.length > 0 && selectedEngines.every((engine) => allEngines.includes(engine)), "Select one or more supported SQL engines.");
for (const engine of selectedEngines) {
  const suffix = randomBytes(5).toString("hex");
  const sqlitePath = path.join(cache, `repair-${suffix}.sqlite`);
  let item;
  let created = false;
  let stage = "fixture-config";
  let guardFailure;
  let filterDiagnostics;
  let outcome;
  let databaseError;
  try {
    item = fixture(engine, suffix, sqlitePath);
    if (["postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(engine)) {
      assert.equal(item.database, engine === "oracle" ? "FREEPDB1" : "dbstudio_test", `${engine} must use the project test database service.`);
    }

    stage = "fixture-create";
    await item.service.query(item.createSql);
    created = true;
    await item.service.query(item.insertSql);

    const brokenSql = `SELECT title FROM ${item.qualified} WHERE ${item.id} = 1`;
    stage = "fixture-error";
    try {
      await item.service.query(brokenSql);
    } catch (error) {
      databaseError = error;
    }
    assert.ok(databaseError && isExpectedMissingColumn(engine, databaseError), `${engine}: fixture must produce a missing-column error.`);

    stage = "model-repair";
    const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "repair",
      request: `修复当前 ${engine} 查询的真实缺列错误。只将不存在的 title 改为当前表中实际存在且表示地点名称的 label；保留 id = 1 筛选和读取意图，不增加表、字段或条件。`,
      context: {
        engine: item.assistantEngine,
        serverVersion: item.serverVersion,
        database: item.database,
        schema: item.schema,
        tables: [{ schema: item.schema, name: item.name, type: "table", columns: item.columns }],
        selectedSql: brokenSql,
        error: { code: String(databaseError.code ?? databaseError.number ?? databaseError.errno ?? "DB_ERROR"), message: String(databaseError.message).slice(0, 1_000) },
      },
    });

    stage = "repair-guard";
    const checkGuard = (condition, label) => {
      guardFailure = label;
      assert.ok(condition, label);
      guardFailure = undefined;
    };
    const sql = response.result.sql ?? "";
    checkGuard(response.result.task === "repair", "task-mismatch");
    checkGuard(Boolean(sql), "sql-missing");
    checkGuard(response.validation?.valid === true, "schema-validation-failed");
    checkGuard(response.validation?.readOnly === true, "not-read-only");
    const normalized = normalizedSql(sql);
    filterDiagnostics = {
      hasWhere: /\bwhere\b/.test(normalized),
      mentionsId: /\bid\b/.test(normalized),
      mentionsOne: /\b1\b/.test(normalized),
      idEqualsOne: /\bid\s*=\s*1\b/.test(normalized),
      oneEqualsId: /\b1\s*=\s*id\b/.test(normalized),
      idInOne: /\bid\s+in\s*\(\s*1\s*\)/.test(normalized),
      idEqualsParameter: /\bid\s*=\s*(?:\?|\$\d+|@[a-z_][a-z0-9_]*|:\d+)/.test(normalized),
      idEqualsStringOne: /\bid\s*=\s*'1'/.test(normalized),
    };
    checkGuard(/^\s*select\b/.test(normalized), "not-select");
    checkGuard(/\blabel\b/.test(normalized), "expected-column-omitted");
    checkGuard(/\bid\s*=\s*1\b/.test(normalized), "filter-not-preserved");
    checkGuard(!/\btitle\b/.test(normalized), "missing-column-retained");
    checkGuard(!/\b[a-z_][a-z0-9_$]*\s*\(/.test(normalized), "unexpected-function");
    checkGuard(!/\b(union|intersect|except|join)\b/.test(normalized), "unexpected-query-operation");
    checkGuard((normalized.match(/\bfrom\b/g) ?? []).length === 1, "unexpected-source-count");
    checkGuard(new RegExp(`\\bfrom\\s+${item.schema.toLowerCase()}\\s*\\.\\s*${item.name.toLowerCase()}\\b`).test(normalized), "source-table-mismatch");
    const references = response.validation?.referencedTables ?? [];
    if (references.length) {
      checkGuard(references.length === 1, "referenced-table-count-mismatch");
      checkGuard(references[0]?.schema?.toLowerCase() === item.schema.toLowerCase(), "referenced-schema-mismatch");
      checkGuard(references[0]?.name?.toLowerCase() === item.name.toLowerCase(), "referenced-table-mismatch");
    }

    stage = "repair-execute";
    const actual = await item.service.query(sql);
    assert.equal(actual.rows.length, 1);
    assert.ok(Object.values(actual.rows[0]).some((value) => value === "synthetic-row" || value === "SYNTHETIC-ROW"));
    outcome = { engine, ok: true, databaseError: "missing-column", validatedReadOnly: true, sourceMatched: true, resultRows: 1 };
  } catch (error) {
    outcome = {
      engine,
      ok: false,
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      databaseErrorCode: databaseError?.code,
      databaseErrorNumber: databaseError?.errno ?? databaseError?.number,
      failureCode: error?.code,
      providerStatus: error?.status,
      providerCode: error?.providerCode,
      providerHttpStatus: error instanceof Error ? error.message.match(/\bHTTP\s+(\d{3})\b/i)?.[1] : undefined,
      guardFailure,
      filterDiagnostics,
    };
  } finally {
    let fixtureRemoved = !created;
    if (item && created) {
      try {
        await item.service.query(item.dropSql);
        fixtureRemoved = true;
      } catch (error) {
        outcome = { engine, ok: false, stage: "fixture-cleanup", databaseErrorCode: error?.code };
      }
    }
    if (engine === "sqlite") rmSync(sqlitePath, { force: true });
    results.push({ ...outcome, fixtureRemoved });
  }
}

rmSync(cache, { recursive: true, force: true });
const ok = results.length === selectedEngines.length && results.every((result) => result.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  scenarios: results,
  schemaSent: "random synthetic table and missing-column errors only",
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
if (!ok) process.exitCode = 1;
