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
        server: "127.0.0.1", port: port("SQLSERVER_PORT", "21433"), database,
        user: "sa", password: required("SQLSERVER_SA_PASSWORD"), encrypt: true, trustServerCertificate: true,
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
  const name = oracle ? `AI_DATE_${suffix.toUpperCase()}` : `ai_date_${suffix.toLowerCase()}`;
  const details = makeEngine(engine, sqlitePath);
  const qualified = `${quote(engine, details.schema)}.${quote(engine, name)}`;
  const idName = oracle ? "ID" : "id";
  const createdAtName = oracle ? "CREATED_AT" : "created_at";
  const id = quote(engine, idName);
  const createdAt = quote(engine, createdAtName);
  const dataType = engine === "postgres" ? "timestamp with time zone"
    : engine === "mysql" || engine === "mariadb" ? "datetime(6)"
      : engine === "sqlserver" ? "datetime2"
        : engine === "oracle" ? "timestamp with time zone" : "text";
  const createSql = `CREATE TABLE ${qualified} (${id} ${oracle ? "NUMBER" : engine === "sqlserver" ? "int" : "integer"} PRIMARY KEY, ${createdAt} ${dataType} NOT NULL)`;
  let insertRecentSql;
  let insertOldSql;
  if (engine === "postgres") {
    insertRecentSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (1, CURRENT_TIMESTAMP)`;
    insertOldSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (2, CURRENT_TIMESTAMP - INTERVAL '30 days')`;
  } else if (engine === "mysql" || engine === "mariadb") {
    insertRecentSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (1, CURRENT_TIMESTAMP)`;
    insertOldSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (2, CURRENT_TIMESTAMP - INTERVAL 30 DAY)`;
  } else if (engine === "sqlserver") {
    insertRecentSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (1, CURRENT_TIMESTAMP)`;
    insertOldSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (2, DATEADD(day, -30, CURRENT_TIMESTAMP))`;
  } else if (engine === "oracle") {
    insertRecentSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (1, CURRENT_TIMESTAMP)`;
    insertOldSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (2, CURRENT_TIMESTAMP - INTERVAL '30' DAY)`;
  } else {
    insertRecentSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (1, datetime('now'))`;
    insertOldSql = `INSERT INTO ${qualified} (${id}, ${createdAt}) VALUES (2, datetime('now', '-30 days'))`;
  }
  const badDateExpression = engine === "sqlserver"
    ? "DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)"
    : engine === "oracle"
      ? "DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)"
      : "DATEADD(day, -7, CURRENT_TIMESTAMP)";
  const columns = [
    { name: idName, dataType: oracle ? "NUMBER" : engine === "sqlserver" ? "int" : "integer", nullable: false, primaryKey: true },
    { name: createdAtName, dataType, nullable: false, primaryKey: false },
  ];
  return {
    ...details, engine, name, qualified, idName, createdAtName, createdAt, dataType,
    createSql, insertRecentSql, insertOldSql, badDateExpression, columns,
    dropSql: engine === "oracle" ? `DROP TABLE ${qualified}` : `DROP TABLE IF EXISTS ${qualified}`,
  };
}

function normalize(sql, stripLiterals = true) {
  let value = sql.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (stripLiterals) value = value.replace(/'(?:''|[^'])*'/g, "''");
  return value.replace(/["`\[\]]/g, "").toLowerCase();
}

function correctDateWindow(engine, sql) {
  if (engine === "postgres") return /\binterval\s*'\s*7\s*(?:day|days)\s*'/i.test(sql);
  if (engine === "mysql" || engine === "mariadb") return /\binterval\s+7\s+(?:day|days)\b/i.test(sql);
  if (engine === "sqlserver") return /\bdateadd\s*\(\s*day\s*,\s*-?\s*7\s*,/i.test(sql);
  if (engine === "oracle") return /\binterval\s*'\s*7\s*'\s+day\b/i.test(sql);
  return /\bdatetime\s*\(\s*'now'\s*,\s*'-7 days?'\s*\)/i.test(sql);
}

function allowedDateFunctions(engine, functions) {
  const allowed = engine === "sqlite" ? new Set(["datetime", "date", "strftime"])
    : engine === "sqlserver" ? new Set(["dateadd", "getdate", "sysdatetime", "sysutcdatetime", "cast", "convert"])
      : engine === "mysql" || engine === "mariadb" ? new Set(["date_sub", "now"])
        : engine === "postgres" ? new Set(["now"])
          : new Set();
  return functions.every((name) => allowed.has(name));
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const cache = path.resolve(".cache", `ai-date-repair-${process.pid}-${randomBytes(5).toString("hex")}`);
mkdirSync(cache, { recursive: true });
const allEngines = ["postgres", "mysql", "mariadb", "sqlserver", "oracle", "sqlite"];
const engines = process.argv[2] ? process.argv[2].split(",").map((engine) => engine.trim()).filter(Boolean) : allEngines;
assert.ok(engines.length > 0 && engines.every((engine) => allEngines.includes(engine)), "Select one or more supported SQL engines.");
const results = [];
for (const engine of engines) {
  const suffix = randomBytes(5).toString("hex");
  const sqlitePath = path.join(cache, `date-${suffix}.sqlite`);
  let item;
  let created = false;
  let stage = "fixture-config";
  let outcome;
  let databaseError;
  let guardDiagnostics;
  let dateFunctionDiagnostics;
  let validationErrorKinds;
  let parserCouldNotConfirm;
  try {
    item = fixture(engine, suffix, sqlitePath);
    if (["postgres", "mysql", "mariadb", "sqlserver", "oracle"].includes(engine)) {
      assert.equal(item.database, engine === "oracle" ? "FREEPDB1" : "dbstudio_test", `${engine} must use the project test database.`);
    }
    stage = "fixture-create";
    await item.service.query(item.createSql);
    created = true;
    await item.service.query(item.insertRecentSql);
    await item.service.query(item.insertOldSql);

    const brokenSql = `SELECT ${quote(engine, item.idName)} FROM ${item.qualified} WHERE ${quote(engine, item.createdAtName)} >= ${item.badDateExpression}`;
    stage = "database-error";
    try { await item.service.query(brokenSql); } catch (error) { databaseError = error; }
    assert.ok(databaseError, `${engine}: deliberately incompatible DATEADD/DATE_SUB syntax must fail.`);

    stage = "model-repair";
    const engineGuidance = engine === "sqlite"
      ? "SQLite 的时间戳边界必须使用 datetime('now', '-7 days')，不要使用 date() 把精确时间截断到日期。"
      : "";
    const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: "repair",
      request: `修复当前 ${engine} 查询中的真实日期函数方言错误。表中 created_at 是时间列。正确查询最近 7 天的记录，保留 id 投影和 created_at >= 时间边界，不改变表或时间窗口；必须使用 ${engine} 兼容的日期语法。${engineGuidance}`,
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
    const sql = response.result.sql ?? "";
    const normalized = normalize(sql);
    const normalizedWithLiterals = normalize(sql, false);
    const functions = [...normalized.matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/g)].map((match) => match[1]);
    dateFunctionDiagnostics = {
      sqliteUsesDatetime: engine !== "sqlite" || functions.includes("datetime"),
      sqliteUsesDate: engine !== "sqlite" || functions.includes("date"),
      sqliteUsesStrftime: engine !== "sqlite" || functions.includes("strftime"),
      sqlServerUsesDateAdd: engine !== "sqlserver" || functions.includes("dateadd"),
    };
    validationErrorKinds = [...new Set((response.validation?.errors ?? []).map((message) =>
      /不存在模型引用的列/.test(message) ? "unknown-column"
        : /不存在模型引用的表/.test(message) ? "unknown-table"
          : /只读|SELECT INTO|写入/.test(message) ? "read-only"
            : "other"))];
    parserCouldNotConfirm = response.validation?.warnings?.some((message) => /解析器无法确认/.test(message)) === true;
    const refs = response.validation?.referencedTables ?? [];
    const exactSource = new RegExp(`\\bfrom\\s+${item.schema.toLowerCase()}\\s*\\.\\s*${item.name.toLowerCase()}\\b`).test(normalized);
    const onlySource = (normalized.match(/\bfrom\b/g) ?? []).length === 1;
    guardDiagnostics = {
      taskCorrect: response.result.task === "repair",
      returnedSql: Boolean(sql),
      valid: response.validation?.valid === true,
      readOnly: response.validation?.readOnly === true,
      idProjection: /^\s*select\s+id\b/.test(normalized),
      exactSource,
      createdAtLowerBound: /\bcreated_at\s*>=/.test(normalized),
      oneFrom: onlySource,
      noJoinOrWrites: !/\b(join|union|intersect|except|insert|update|delete|merge|create|alter|drop|truncate|copy)\b/.test(normalized),
      sevenDayNativeSyntax: correctDateWindow(engine, normalizedWithLiterals),
      allowedDateFunctions: allowedDateFunctions(engine, functions),
      incompatibleDateFunctionRemoved: engine === "sqlserver"
        ? !/\bdate_sub\s*\(/.test(normalized)
        : engine === "mysql" || engine === "mariadb"
          ? !/\bdateadd\s*\(/.test(normalized)
          : !/\b(?:dateadd|date_sub)\s*\(/.test(normalized),
      referencedSourceMatches: !refs.length || (refs.length === 1 && refs[0]?.schema?.toLowerCase() === item.schema.toLowerCase() && refs[0]?.name?.toLowerCase() === item.name.toLowerCase()),
    };
    for (const [check, passed] of Object.entries(guardDiagnostics)) assert.equal(passed, true, `${engine}: repair guard failed (${check}).`);
    if (refs.length) {
      assert.equal(refs.length, 1);
      assert.equal(refs[0]?.schema?.toLowerCase(), item.schema.toLowerCase());
      assert.equal(refs[0]?.name?.toLowerCase(), item.name.toLowerCase());
    }

    stage = "repair-execute";
    const actual = await item.service.query(sql);
    assert.equal(actual.rows.length, 1);
    assert.equal(Number(actual.rows[0][item.idName] ?? actual.rows[0][item.idName.toLowerCase()]), 1);
    outcome = { engine, ok: true, databaseErrorCode: String(databaseError.code ?? databaseError.number ?? databaseError.errno ?? "DB_ERROR"), nativeDateSyntax: true, validatedReadOnly: true, sourceMatched: true, resultRows: 1 };
  } catch (error) {
    outcome = {
      engine, ok: false, stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      failureCode: error?.code,
      databaseErrorCode: databaseError?.code,
      databaseErrorNumber: databaseError?.errno ?? databaseError?.number,
      databaseErrorMentionsBadDateFunction: databaseError ? /dateadd|date_sub|function|invalid identifier|not recognized/i.test(String(databaseError.message)) : undefined,
      guardDiagnostics,
      dateFunctionDiagnostics,
      validationErrorKinds,
      parserCouldNotConfirm,
      providerStatus: error?.status,
      providerCode: error?.providerCode,
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
  schemaSent: "random synthetic timestamp table and dialect errors only",
  businessRowsSent: false,
  credentialsSent: false,
  responseContentLogged: false,
})}\n`);
if (!ok) process.exitCode = 1;
