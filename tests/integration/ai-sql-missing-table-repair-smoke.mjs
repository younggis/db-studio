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
    const database = required("DBSTUDIO_PG_DATABASE", "dbstudio_test");
    return {
      schema: "public", database, serverVersion: "16",
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
      schema: database, database, serverVersion: maria ? "11.4" : "8.4",
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
      schema: "dbo", database, serverVersion: "2022",
      service: CoreService.fromSqlServerConfig({
        server: "127.0.0.1", port: port("SQLSERVER_PORT", "21433"), database,
        user: "sa", password: required("SQLSERVER_SA_PASSWORD"), encrypt: true, trustServerCertificate: true,
        connectionTimeout: 8_000, requestTimeout: 8_000,
      }),
    };
  }
  if (engine === "oracle") {
    const user = required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase();
    const serviceName = required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1");
    return {
      schema: user, database: serviceName, serverVersion: "23ai",
      service: CoreService.fromOracleConfig({
        user, password: required("ORACLE_PASSWORD"),
        connectString: `//127.0.0.1:${port("ORACLE_PORT", "21521")}/${serviceName}`,
        connectTimeout: 10, callTimeout: 8_000,
      }),
    };
  }
  return {
    schema: "main", database: "synthetic", serverVersion: "3.54",
    service: CoreService.fromSqliteConfig({ path: sqlitePath }),
  };
}

function expectedMissingTable(engine, error) {
  if (engine === "postgres") return error.code === "42P01";
  if (engine === "mysql" || engine === "mariadb") return error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146;
  if (engine === "sqlserver") return error.number === 208 || /invalid object name/i.test(error.message);
  if (engine === "oracle") return error.code === "ORA-00942";
  return ["SQLITE_ERROR", "ERR_SQLITE_ERROR"].includes(error.code) && /no such table/i.test(error.message);
}

function normalize(sql) {
  return sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const runId = `${process.pid}-${randomBytes(5).toString("hex")}`;
const cache = path.resolve(".cache", `ai-missing-table-${runId}`);
mkdirSync(cache, { recursive: true });
const allEngines = ["postgres", "mysql", "mariadb", "sqlserver", "oracle", "sqlite"];
const selectedEngines = process.argv[2] ? process.argv[2].split(",").map((engine) => engine.trim()).filter(Boolean) : allEngines;
assert.ok(selectedEngines.length > 0 && selectedEngines.every((engine) => allEngines.includes(engine)), "Select one or more supported SQL engines.");
const results = [];

for (const engine of selectedEngines) {
  const suffix = randomBytes(5).toString("hex");
  const sqlitePath = path.join(cache, `missing-${suffix}.sqlite`);
  const actualName = engine === "oracle" ? `AI_REPAIR_${suffix.toUpperCase()}` : `ai_repair_${suffix}`;
  const wrongName = engine === "oracle" ? `AI_REPAlR_${suffix.toUpperCase()}` : `ai_reapir_${suffix}`;
  let item;
  let created = false;
  let stage = "fixture-config";
  let databaseError;
  let outcome;
  try {
    item = makeEngine(engine, sqlitePath);
    if (["postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(engine)) {
      assert.equal(item.database, engine === "oracle" ? "FREEPDB1" : "dbstudio_test", `${engine} must use the isolated project test database service.`);
    }
    const actual = `${quote(engine, item.schema)}.${quote(engine, actualName)}`;
    const missing = `${quote(engine, item.schema)}.${quote(engine, wrongName)}`;
    const id = quote(engine, engine === "oracle" ? "ID" : "id");
    const label = quote(engine, engine === "oracle" ? "LABEL" : "label");
    const integer = engine === "oracle" ? "NUMBER" : engine === "sqlserver" ? "int" : "integer";
    const text = engine === "oracle" ? "VARCHAR2(100)" : engine === "sqlserver" ? "nvarchar(100)" : "varchar(100)";

    stage = "fixture-create";
    await item.service.query(`CREATE TABLE ${actual} (${id} ${integer} PRIMARY KEY, ${label} ${text} NOT NULL)`);
    created = true;
    await item.service.query(`INSERT INTO ${actual} (${id}, ${label}) VALUES (1, 'synthetic-row')`);

    const selectedSql = `SELECT ${id}, ${label} FROM ${missing} WHERE ${id} = 1`;
    stage = "database-error";
    try {
      await item.service.query(selectedSql);
    } catch (error) {
      databaseError = error;
    }
    assert.ok(databaseError && expectedMissingTable(engine, databaseError), `${engine} must produce its expected missing-table error.`);

    stage = "model-repair";
    const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "repair",
      request: `当前 ${engine} 查询因表不存在失败。请仅根据给定 Schema 找出包含 id 和 label 的地点表，将错误表名改为该真实表；保留 SELECT id, label 和 id = 1 筛选，不增加表、字段、函数或其他条件。`,
      context: {
        engine,
        serverVersion: item.serverVersion,
        database: item.database,
        schema: item.schema,
        tables: [{
          schema: item.schema,
          name: actualName,
          type: "table",
          columns: [
            { name: engine === "oracle" ? "ID" : "id", dataType: integer, nullable: false, primaryKey: true },
            { name: engine === "oracle" ? "LABEL" : "label", dataType: text, nullable: false, primaryKey: false },
          ],
        }],
        selectedSql,
        error: {
          code: String(databaseError.code ?? databaseError.number ?? databaseError.errno ?? "DB_ERROR"),
          message: String(databaseError.message).slice(0, 1_000),
        },
      },
    });

    stage = "repair-guard";
    const sql = response.result.sql ?? "";
    const normalized = normalize(sql);
    const sources = [...normalized.matchAll(/\bfrom\s+((?:[a-z_][a-z0-9_$]*\s*\.\s*)?[a-z_][a-z0-9_$]*)/g)]
      .map((match) => match[1].replace(/\s/g, ""));
    const reference = response.validation?.referencedTables ?? [];
    assert.equal(response.result.task, "repair");
    assert.equal(response.validation?.valid, true);
    assert.equal(response.validation?.readOnly, true);
    assert.match(normalized, /^\s*select\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?id\s*,\s*(?:[a-z_][a-z0-9_$]*\s*\.\s*)?label\s+from\b/);
    assert.match(normalized, /\bid\s*=\s*1\b/);
    assert.doesNotMatch(normalized, /\b(?:insert|update|delete|merge|create|alter|drop|truncate|copy|join|union|intersect|except)\b/);
    assert.equal((normalized.match(/\bfrom\b/g) ?? []).length, 1);
    assert.equal(sources.length, 1);
    assert.ok(sources[0] === actualName.toLowerCase() || sources[0] === `${item.schema.toLowerCase()}.${actualName.toLowerCase()}`);
    assert.equal((normalized.match(/\b[a-z_][a-z0-9_$]*\s*\(/g) ?? []).length, 0, "No functions are needed for this fixture.");
    if (reference.length) {
      assert.equal(reference.length, 1);
      assert.equal(reference[0]?.name?.toLowerCase(), actualName.toLowerCase());
      if (reference[0]?.schema) assert.equal(reference[0].schema.toLowerCase(), item.schema.toLowerCase());
    }

    stage = "repair-execute";
    const result = await item.service.query(sql);
    assert.equal(result.rows.length, 1);
    assert.ok(Object.values(result.rows[0]).some((value) => value === "synthetic-row"));
    outcome = { engine, ok: true, databaseError: "missing-table", validatedReadOnly: true, sourceMatched: true, repairExecuted: true, resultRows: 1 };
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
    };
  } finally {
    let fixtureRemoved = !created;
    if (item && created) {
      try {
        const tableName = engine === "oracle" ? `AI_REPAIR_${suffix.toUpperCase()}` : `ai_repair_${suffix}`;
        const actual = `${quote(engine, item.schema)}.${quote(engine, tableName)}`;
        await item.service.query(engine === "oracle" ? `DROP TABLE ${actual}` : `DROP TABLE IF EXISTS ${actual}`);
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
const ok = results.length === selectedEngines.length && results.every((result) => result.ok && result.fixtureRemoved);
process.stdout.write(`${JSON.stringify({
  ok,
  scenarios: results,
  schemaSent: "random synthetic table and missing-table errors only",
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
if (!ok) process.exitCode = 1;
