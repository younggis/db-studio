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
    const database = required("DBSTUDIO_PG_DATABASE", "dbstudio_test");
    return {
      assistantEngine: engine, schema: "public", database, serverVersion: "16",
      service: CoreService.fromPostgresConfig({
        host: "127.0.0.1", port: port("DBSTUDIO_POSTGIS_PORT", "25432"), database,
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
    const database = required("SQLSERVER_DATABASE", "dbstudio_test");
    return {
      assistantEngine: engine, schema: "dbo", database, serverVersion: "2022",
      service: CoreService.fromSqlServerConfig({
        server: "127.0.0.1", port: port("SQLSERVER_PORT", "21433"), database, user: "sa",
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
  const name = oracle ? `AI_PARAM_${suffix.toUpperCase()}` : `ai_param_${suffix.toLowerCase()}`;
  const details = makeEngine(engine, sqlitePath);
  const qualified = `${quote(engine, details.schema)}.${quote(engine, name)}`;
  const idName = oracle ? "ID" : "id";
  const labelName = oracle ? "LABEL" : "label";
  const id = quote(engine, idName);
  const label = quote(engine, labelName);
  const integer = oracle ? "NUMBER" : engine === "sqlserver" ? "int" : "integer";
  const text = oracle ? "VARCHAR2(80)" : engine === "sqlserver" ? "nvarchar(80)" : "varchar(80)";
  const badPlaceholder = engine === "postgres" || engine === "mysql" || engine === "mariadb" ? ":1"
    : engine === "sqlserver" || engine === "oracle" ? "?" : "?0";
  const correctPlaceholder = engine === "postgres" ? "$1"
    : engine === "sqlserver" ? "@p1"
      : engine === "oracle" ? ":1" : "?";
  return {
    ...details, engine, name, qualified, idName, labelName, id, label, badPlaceholder, correctPlaceholder,
    createSql: `CREATE TABLE ${qualified} (${id} ${integer} PRIMARY KEY, ${label} ${text} NOT NULL)`,
    insertSql: `INSERT INTO ${qualified} (${id}, ${label}) VALUES (1, 'synthetic-parameter-row')`,
    brokenSql: `SELECT ${label} FROM ${qualified} WHERE ${id} = ${badPlaceholder}`,
    dropSql: engine === "oracle" ? `DROP TABLE ${qualified} PURGE` : `DROP TABLE IF EXISTS ${qualified}`,
    columns: [
      { name: idName, dataType: integer, nullable: false, primaryKey: true },
      { name: labelName, dataType: text, nullable: false, primaryKey: false },
    ],
  };
}

function normalizedSql(sql) {
  return sql.replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
}

function hasSingleExpectedPlaceholder(engine, sql) {
  const clean = sql.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").toLowerCase();
  if (engine === "postgres") return (clean.match(/\$[0-9]+/g) ?? []).join(",") === "$1";
  if (engine === "sqlserver") return (clean.match(/@p[0-9]+\b/g) ?? []).join(",") === "@p1";
  if (engine === "oracle") return (clean.match(/:[0-9]+\b/g) ?? []).join(",") === ":1";
  if (engine === "sqlite") return (clean.match(/\?[0-9]*/g) ?? []).join(",") === "?";
  return (clean.match(/\?/g) ?? []).length === 1 && !/\$[0-9]+|:[0-9]+|@p[0-9]+/i.test(clean);
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const cache = path.resolve(".cache", `ai-parameter-repair-${process.pid}-${randomBytes(5).toString("hex")}`);
mkdirSync(cache, { recursive: true });
const allEngines = ["postgres", "mysql", "mariadb", "sqlserver", "oracle", "sqlite"];
const engines = process.argv[2] ? process.argv[2].split(",").map((engine) => engine.trim()).filter(Boolean) : allEngines;
assert.ok(engines.length > 0 && engines.every((engine) => allEngines.includes(engine)), "Select one or more supported SQL engines.");
const results = [];
for (const engine of engines) {
  const suffix = randomBytes(5).toString("hex");
  const sqlitePath = path.join(cache, `parameter-${suffix}.sqlite`);
  let item;
  let created = false;
  let stage = "fixture-config";
  let outcome;
  let databaseError;
  let guardDiagnostics;
  let validationErrorKinds;
  try {
    item = fixture(engine, suffix, sqlitePath);
    if (["postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(engine)) {
      assert.equal(item.database, engine === "oracle" ? "FREEPDB1" : "dbstudio_test", `${engine} must use the project test database.`);
    }
    stage = "fixture-create";
    await item.service.query(item.createSql);
    created = true;
    await item.service.query(item.insertSql);

    stage = "database-error";
    try { await item.service.query(item.brokenSql, [1]); } catch (error) { databaseError = error; }
    assert.ok(databaseError, `${engine}: the incompatible placeholder must fail with the adapter's one-item binding.`);

    stage = "model-repair";
    const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "repair",
      request: `修复当前 ${engine} 查询的真实 SQL 参数占位符错误。应用已经按位置绑定且只传入 1 个合成参数；保留现有绑定顺序和数量，使用当前驱动支持的第一个占位符，不能把参数值 1 写进 SQL，也不要增删条件或列。`,
      context: {
        engine: item.assistantEngine,
        serverVersion: item.serverVersion,
        database: item.database,
        schema: item.schema,
        tables: [{ schema: item.schema, name: item.name, type: "table", columns: item.columns }],
        selectedSql: item.brokenSql,
        error: { code: String(databaseError.code ?? databaseError.number ?? databaseError.errno ?? "DB_ERROR"), message: String(databaseError.message).slice(0, 1_000) },
      },
    });

    stage = "repair-guard";
    const sql = response.result.sql ?? "";
    const normalized = normalizedSql(sql);
    const references = response.validation?.referencedTables ?? [];
    validationErrorKinds = [...new Set((response.validation?.errors ?? []).map((message) =>
      /不存在模型引用的列/.test(message) ? "unknown-column"
        : /不存在模型引用的表/.test(message) ? "unknown-table"
          : /只读|SELECT INTO|写入/.test(message) ? "read-only"
            : "other"))];
    const correctFilter = new RegExp(`\\b${item.idName.toLowerCase()}\\s*=\\s*${item.correctPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    guardDiagnostics = {
      taskCorrect: response.result.task === "repair",
      returnedSql: Boolean(sql),
      valid: response.validation?.valid === true,
      readOnly: response.validation?.readOnly === true,
      labelProjectionPreserved: new RegExp(`^\\s*select\\s+${item.labelName.toLowerCase()}\\b`).test(normalized),
      exactSource: new RegExp(`\\bfrom\\s+${item.schema.toLowerCase()}\\s*\\.\\s*${item.name.toLowerCase()}\\b`).test(normalized),
      oneBoundPlaceholder: hasSingleExpectedPlaceholder(engine, sql),
      originalFilterUsesPlaceholder: correctFilter.test(sql.replace(/["`\[\]]/g, "").toLowerCase()),
      noLiteralParameterValue: !new RegExp(`\\b${item.idName.toLowerCase()}\\s*=\\s*1\\b`).test(normalized),
      noJoinsOrWrites: !/\b(join|union|intersect|except|insert|update|delete|merge|create|alter|drop|truncate|copy)\b/.test(normalized),
      oneFrom: (normalized.match(/\bfrom\b/g) ?? []).length === 1,
      referencedSourceMatches: !references.length || (references.length === 1 && references[0]?.schema?.toLowerCase() === item.schema.toLowerCase() && references[0]?.name?.toLowerCase() === item.name.toLowerCase()),
    };
    for (const [check, passed] of Object.entries(guardDiagnostics)) assert.equal(passed, true, `${engine}: parameter repair guard failed (${check}).`);

    stage = "repair-execute";
    const actual = await item.service.query(sql, [1]);
    assert.equal(actual.rows.length, 1);
    assert.ok(Object.values(actual.rows[0]).some((value) => value === "synthetic-parameter-row"));
    outcome = { engine, ok: true, databaseErrorCode: String(databaseError.code ?? databaseError.number ?? databaseError.errno ?? "DB_ERROR"), placeholderRepaired: true, oneBoundParameterPreserved: true, validatedReadOnly: true, sourceMatched: true, resultRows: 1 };
  } catch (error) {
    outcome = {
      engine, ok: false, stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      failureCode: error?.code,
      databaseErrorCode: databaseError?.code,
      databaseErrorNumber: databaseError?.errno ?? databaseError?.number,
      guardDiagnostics,
      validationErrorKinds,
    };
  } finally {
    let fixtureRemoved = !created;
    if (item && created) {
      try { await item.service.query(item.dropSql); fixtureRemoved = true; }
      catch (error) { outcome = { engine, ok: false, stage: "fixture-cleanup", databaseErrorCode: error?.code }; }
    }
    if (engine === "sqlite") rmSync(sqlitePath, { force: true });
    results.push({ ...outcome, fixtureRemoved });
  }
}

rmSync(cache, { recursive: true, force: true });
const ok = results.length === engines.length && results.every((result) => result.ok && result.fixtureRemoved);
process.stdout.write(`${JSON.stringify({
  ok,
  scenarios: results,
  schemaSent: "random synthetic parameter test schema and placeholder errors only",
  parameterValuesSent: false,
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
if (!ok) process.exitCode = 1;
