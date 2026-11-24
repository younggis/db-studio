import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const requireFromDatabase = createRequire(path.join(root, "packages", "database", "package.json"));
const mysql = requireFromDatabase("mysql2/promise");
const mssql = requireFromDatabase("mssql");
const oracledb = requireFromDatabase("oracledb");
const reportPath = path.join(root, ".cache", "ai-cli-explain-plan-real-multidb-last.json");
const chatRequestTimeoutMs = Number(process.env.DBSTUDIO_AI_PLAN_TEST_TIMEOUT_MS ?? "180000");
assert.ok(Number.isInteger(chatRequestTimeoutMs) && chatRequestTimeoutMs >= 1_000 && chatRequestTimeoutMs <= 300_000,
  "DBSTUDIO_AI_PLAN_TEST_TIMEOUT_MS must be an integer from 1000 to 300000.");
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "dbstudio-cli-plan-real-multidb-"));
const sqlPath = path.join(temporaryDirectory, "synthetic-query.sql");
const planPath = path.join(temporaryDirectory, "synthetic-plan.txt");
const sqliteDatabasePath = path.join(temporaryDirectory, "synthetic-plan.sqlite");
const environment = { ...process.env };
for (const name of [
  "DBSTUDIO_USER_DATA_DIR", "MODEL_OPENAI_BASE_URL", "MODEL_OPENAI_MODEL", "MODEL_OPENAI_API_KEY",
  "MODEL_OPENAI_TEMPERATURE", "MODEL_OPENAI_MAX_OUTPUT_TOKENS", "MODEL_OPENAI_TIMEOUT_MS", "MODEL_OPENAI_STREAMING",
  "DBSTUDIO_AI_BASE_URL", "DBSTUDIO_AI_MODEL", "DBSTUDIO_AI_API_KEY", "DASHSCOPE_API_KEY",
  "DBSTUDIO_DATABASE_TYPE", "DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLITE_PATH",
  "DBSTUDIO_MYSQL_URL", "DBSTUDIO_MARIADB_URL", "DBSTUDIO_SQLSERVER_URL", "DBSTUDIO_ORACLE_CONNECT_STRING",
  "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE",
  "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_CONNECT_TIMEOUT",
  "MARIADB_HOST", "MARIADB_PORT", "MARIADB_DATABASE", "MARIADB_USER", "MARIADB_PASSWORD", "MARIADB_CONNECT_TIMEOUT",
  "SQLSERVER_HOST", "SQLSERVER_PORT", "SQLSERVER_DATABASE", "SQLSERVER_USER", "SQLSERVER_PASSWORD",
  "SQLSERVER_ENCRYPT", "SQLSERVER_TRUST_SERVER_CERTIFICATE", "SQLSERVER_CONNECT_TIMEOUT", "SQLSERVER_REQUEST_TIMEOUT",
  "ORACLE_USER", "ORACLE_PASSWORD", "ORACLE_HOST", "ORACLE_PORT", "ORACLE_SERVICE_NAME",
  "ORACLE_CONNECT_STRING", "ORACLE_CONNECT_TIMEOUT", "ORACLE_CALL_TIMEOUT",
]) delete environment[name];

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
const sensitiveDockerValues = Object.entries(dockerEnv)
  .filter(([name]) => /PASSWORD|SECRET|TOKEN|API_KEY/i.test(name))
  .map(([, value]) => value)
  .filter((value) => value.length >= 4);

function databaseEnvironment(engine) {
  const env = { ...environment, DBSTUDIO_DATABASE_TYPE: engine };
  if (engine === "mysql") {
    Object.assign(env, {
      MYSQL_HOST: "127.0.0.1", MYSQL_PORT: dockerEnv.MYSQL_PORT || "23306",
      MYSQL_DATABASE: dockerEnv.MYSQL_DATABASE || "dbstudio_test",
      MYSQL_USER: dockerEnv.MYSQL_USER || "dbstudio", MYSQL_PASSWORD: dockerEnv.MYSQL_PASSWORD,
    });
  } else if (engine === "mariadb") {
    Object.assign(env, {
      MARIADB_HOST: "127.0.0.1", MARIADB_PORT: dockerEnv.MARIADB_PORT || "23307",
      MARIADB_DATABASE: dockerEnv.MARIADB_DATABASE || "dbstudio_test",
      MARIADB_USER: dockerEnv.MARIADB_USER || "dbstudio", MARIADB_PASSWORD: dockerEnv.MARIADB_PASSWORD,
    });
  } else if (engine === "sqlserver") {
    Object.assign(env, {
      SQLSERVER_HOST: "127.0.0.1", SQLSERVER_PORT: "21433", SQLSERVER_DATABASE: "dbstudio_test",
      SQLSERVER_USER: "sa", SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD,
      SQLSERVER_ENCRYPT: "true", SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
      SQLSERVER_CONNECT_TIMEOUT: "10000", SQLSERVER_REQUEST_TIMEOUT: "30000",
    });
  } else if (engine === "oracle") {
    Object.assign(env, {
      ORACLE_USER: "SYSTEM", ORACLE_PASSWORD: dockerEnv.ORACLE_PASSWORD,
      ORACLE_HOST: "127.0.0.1", ORACLE_PORT: "21521", ORACLE_SERVICE_NAME: "FREEPDB1",
      ORACLE_CONNECT_TIMEOUT: "10", ORACLE_CALL_TIMEOUT: "30000",
    });
  } else if (engine === "sqlite") {
    env.DBSTUDIO_SQLITE_PATH = sqliteDatabasePath;
  } else throw new Error(`Unsupported live plan engine: ${engine}`);
  return env;
}

function runCli(args, env = environment, timeout = 120_000) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function createSqlitePlanCases() {
  const database = new DatabaseSync(sqliteDatabasePath);
  let cleaned = false;
  try {
    const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
    database.exec(`
      CREATE TABLE ai_plan_orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX ai_plan_customer_idx ON ai_plan_orders (customer_id);
    `);
    const insert = database.prepare("INSERT INTO ai_plan_orders (id, customer_id, status) VALUES (?, ?, ?)");
    database.exec("BEGIN");
    try {
      for (let id = 1; id <= 10_000; id += 1) {
        insert.run(id, (id % 100) + 1, id % 4 === 0 ? "open" : "closed");
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    report.syntheticRowsCreated += 10_000;

    const definitions = [
      {
        name: "sqlite-index-search-live-plan",
        sql: "SELECT id FROM ai_plan_orders WHERE customer_id = 42;\n",
        focus: "the SEARCH operation and the customer index",
        expected: [/\bsearch\b/i, /ai_plan_customer_idx|index/i],
      },
      {
        name: "sqlite-table-scan-live-plan",
        sql: "SELECT id FROM ai_plan_orders WHERE status = 'open';\n",
        focus: "the full table SCAN and the fact that status has no index",
        expected: [/\bscan\b/i, /ai_plan_orders/i],
      },
    ];

    const scenarios = definitions.map((definition) => {
      const rows = database.prepare(`EXPLAIN QUERY PLAN ${definition.sql}`).all();
      assert.ok(rows.length > 0, `${definition.name}: SQLite returned no plan rows.`);
      report.explainStatementExecuted = true;
      const plan = [
        `SQLite ${sqliteVersion} EXPLAIN QUERY PLAN raw detail rows (the SELECT was not executed):`,
        ...rows.map((row) => `${row.id} | ${row.parent} | ${row.detail}`),
        "Row-count estimates, costs, and runtime measurements: not provided by this output.",
      ].join("\n");
      for (const pattern of definition.expected) {
        assert.match(plan, pattern, `${definition.name}: actual plan omitted ${pattern.source}.`);
      }
      return {
        ...definition,
        source: "sqlite-explain-query-plan",
        executionMode: "plan-only",
        engine: "sqlite",
        dialects: ["sqlite"],
        plan,
        planOperators: rows.map((row) => row.detail),
        focus: definition.focus,
        estimateAndRuntimeUnavailable: true,
      };
    });
    return scenarios;
  } finally {
    try {
      database.exec("DROP TABLE IF EXISTS ai_plan_orders");
      database.close();
      cleaned = true;
    } catch {
      try { database.close(); } catch { /* Keep cleanup failure visible in the report. */ }
    }
    report.databaseCleanup.sqlite = cleaned;
    assert.ok(cleaned, "SQLite synthetic plan table or connection did not clean up.");
  }
}

function safeError(error) {
  let message = String(error?.message ?? error);
  for (const value of sensitiveDockerValues) message = message.split(value).join("[REDACTED]");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .replaceAll(root, "<workspace>")
    .replaceAll(temporaryDirectory, "<temporary>")
    .slice(0, 1_200);
}

function batches(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function mysqlAccessPattern(value) {
  if (value.toLowerCase() === "all") return /access_type\s*[=:]?\s*ALL|full table scan|table scan|全表扫描/i;
  if (value.toLowerCase() === "eq_ref") return /eq_ref|primary.?key|主键/i;
  if (value.toLowerCase() === "ref") return /access_type\s*[=:]?\s*ref|index lookup|索引查找/i;
  if (value.toLowerCase() === "range") return /range|范围/i;
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function createMySqlPlanCase(engine) {
  const env = databaseEnvironment(engine);
  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: Number(engine === "mysql" ? env.MYSQL_PORT : env.MARIADB_PORT),
    database: engine === "mysql" ? env.MYSQL_DATABASE : env.MARIADB_DATABASE,
    user: engine === "mysql" ? env.MYSQL_USER : env.MARIADB_USER,
    password: engine === "mysql" ? env.MYSQL_PASSWORD : env.MARIADB_PASSWORD,
    connectTimeout: 10_000,
  });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const customers = `ai_plan_customers_${suffix}`;
  const orders = `ai_plan_orders_${suffix}`;
  const query = `SELECT c.region, COUNT(*) AS open_orders
FROM \`${orders}\` AS o
JOIN \`${customers}\` AS c ON c.id = o.customer_id
WHERE c.region = 'north' AND o.status = 'open'
GROUP BY c.region`;
  try {
    await connection.query(`CREATE TEMPORARY TABLE \`${customers}\` (
      id INT NOT NULL PRIMARY KEY,
      region VARCHAR(16) NOT NULL
    ) ENGINE=InnoDB`);
    await connection.query(`CREATE TEMPORARY TABLE \`${orders}\` (
      id BIGINT NOT NULL PRIMARY KEY,
      customer_id INT NOT NULL,
      status VARCHAR(12) NOT NULL,
      KEY ai_plan_customer_idx (customer_id)
    ) ENGINE=InnoDB`);
    const customerRows = Array.from({ length: 500 }, (_, index) => [index + 1, index % 10 === 0 ? "north" : "south"]);
    for (const chunk of batches(customerRows, 250)) {
      await connection.query(`INSERT INTO \`${customers}\` (id, region) VALUES ?`, [chunk]);
    }
    const orderRows = Array.from({ length: 12_000 }, (_, index) => [
      index + 1, (index % 500) + 1, index % 5 === 0 ? "open" : "closed",
    ]);
    for (const chunk of batches(orderRows, 500)) {
      await connection.query(`INSERT INTO \`${orders}\` (id, customer_id, status) VALUES ?`, [chunk]);
    }
    report.syntheticRowsCreated += customerRows.length + orderRows.length;
    const [rows] = await connection.query(`EXPLAIN FORMAT=JSON ${query}`);
    report.explainStatementExecuted = true;
    const row = rows?.[0];
    assert.ok(row, `${engine} EXPLAIN returned no rows.`);
    const rawPlan = row.EXPLAIN ?? row.explain ?? Object.values(row)[0];
    const planObject = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
    const plan = JSON.stringify(planObject, null, 2);
    const accessTypes = [...new Set([...plan.matchAll(/"access_type"\s*:\s*"([^"]+)"/gi)].map((match) => match[1]))];
    assert.ok(accessTypes.length > 0, `${engine} JSON plan did not include an access_type.`);
    const expected = accessTypes.slice(0, 3).map(mysqlAccessPattern);
    expected.push(/rows|cost|estimate|估算/i);
    return {
      name: `${engine}-live-temp-table-explain-json`,
      source: `${engine}-explain-format-json`,
      executionMode: "estimated",
      engine,
      dialects: [engine],
      sql: `${query};\n`,
      plan,
      focus: `the ${accessTypes.join(" and ")} access paths, estimated rows and costs`,
      planOperators: accessTypes,
      expected,
    };
  } finally {
    let cleaned = true;
    try { await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${orders}\`, \`${customers}\``); }
    catch { cleaned = false; }
    try { await connection.end(); }
    catch { cleaned = false; }
    report.databaseCleanup[engine] = cleaned;
    assert.ok(cleaned, `${engine} temporary tables or connection did not clean up.`);
  }
}

function sqlServerInsertValues(table, columns, rows) {
  const quoteValue = (value) => typeof value === "number" ? String(value) : `N'${String(value).replaceAll("'", "''")}'`;
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${rows.map((row) => `(${row.map(quoteValue).join(", ")})`).join(", ")}`;
}

function sqlServerOperatorPattern(operator) {
  if (/hash match/i.test(operator)) return /hash match|hash join|哈希/i;
  if (/nested loops/i.test(operator)) return /nested loops?|嵌套循环/i;
  if (/merge join/i.test(operator)) return /merge join|合并连接/i;
  if (/index seek/i.test(operator)) return /index seek|索引查找/i;
  if (/index scan|table scan/i.test(operator)) return /index scan|table scan|扫描/i;
  if (/aggregate/i.test(operator)) return /aggregate|聚合/i;
  return new RegExp(operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function createSqlServerPlanCase() {
  const env = databaseEnvironment("sqlserver");
  const pool = new mssql.ConnectionPool({
    server: "127.0.0.1",
    port: Number(env.SQLSERVER_PORT),
    database: env.SQLSERVER_DATABASE,
    user: env.SQLSERVER_USER,
    password: env.SQLSERVER_PASSWORD,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 10_000 },
    options: { encrypt: true, trustServerCertificate: true },
  });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const customers = `#ai_plan_customers_${suffix}`;
  const orders = `#ai_plan_orders_${suffix}`;
  const transaction = new mssql.Transaction(pool);
  const query = `SELECT c.region, COUNT_BIG(*) AS open_orders
FROM ${orders} AS o
JOIN ${customers} AS c ON c.id = o.customer_id
WHERE c.region = N'north' AND o.status = N'open'
GROUP BY c.region
OPTION (HASH JOIN)`;
  let statisticsProfileEnabled = false;
  let transactionOpen = false;
  try {
    await pool.connect();
    await transaction.begin();
    transactionOpen = true;
    await transaction.request().batch(`CREATE TABLE ${customers} (id INT NOT NULL PRIMARY KEY, region NVARCHAR(16) NOT NULL);
      CREATE TABLE ${orders} (id BIGINT NOT NULL PRIMARY KEY, customer_id INT NOT NULL, status NVARCHAR(12) NOT NULL);
      CREATE INDEX ai_plan_customer_idx ON ${orders} (customer_id);`);
    const customerRows = Array.from({ length: 500 }, (_, index) => [index + 1, index % 10 === 0 ? "north" : "south"]);
    for (const chunk of batches(customerRows, 250)) {
      await transaction.request().batch(sqlServerInsertValues(customers, ["id", "region"], chunk));
    }
    const orderRows = Array.from({ length: 12_000 }, (_, index) => [
      index + 1, (index % 500) + 1, index % 5 === 0 ? "open" : "closed",
    ]);
    for (const chunk of batches(orderRows, 500)) {
      await transaction.request().batch(sqlServerInsertValues(orders, ["id", "customer_id", "status"], chunk));
    }
    report.syntheticRowsCreated += customerRows.length + orderRows.length;
    statisticsProfileEnabled = true;
    await transaction.request().batch("SET STATISTICS PROFILE ON");
    const result = await transaction.request().query(query);
    report.executedSyntheticQuerySql = true;
    const resultSets = result.recordsets ?? (result.recordset ? [result.recordset] : []);
    const planRows = resultSets.find((rows) => {
      const columns = Object.keys(rows[0] ?? {});
      return columns.includes("PhysicalOp") && columns.includes("NodeId");
    }) ?? [];
    const resultShape = {
      recordsetCount: result.recordset?.length ?? null,
      recordsets: resultSets.map((rows) => ({ count: rows.length, columns: Object.keys(rows[0] ?? {}) })),
      rowsAffected: result.rowsAffected ?? [],
    };
    assert.ok(planRows.length > 0, `SQL Server did not return STATISTICS PROFILE rows: ${JSON.stringify(resultShape)}`);
    report.explainStatementExecuted = true;
    const operators = [...new Set(planRows.map((row) => String(row.PhysicalOp ?? "")).filter(Boolean))];
    assert.ok(operators.length > 0, "SQL Server plan had no physical operators.");
    const keyOperators = operators.filter((operator) => /hash match|nested loops|merge join|index seek|index scan|table scan|aggregate/i.test(operator));
    assert.ok(keyOperators.length > 0, "SQL Server plan had no expected relational operators.");
    assert.ok(planRows.some((row) => Number(row.Rows) >= 0), "SQL Server actual plan did not include operator row counts.");
    await transaction.request().batch("SET STATISTICS PROFILE OFF");
    statisticsProfileEnabled = false;
    await transaction.rollback();
    transactionOpen = false;
    return {
      name: "sqlserver-live-temp-table-statistics-profile",
      source: "sqlserver-statistics-profile",
      executionMode: "actual",
      engine: "sqlserver",
      dialects: ["sqlserver", "sql server", "sql server t-sql"],
      sql: `${query};\n`,
      plan: JSON.stringify(planRows, null, 2),
      focus: `the ${keyOperators.slice(0, 3).join(", ")} operators and estimated row counts`,
      planOperators: keyOperators.slice(0, 6),
      expected: keyOperators.slice(0, 2).map(sqlServerOperatorPattern),
    };
  } finally {
    let cleaned = true;
    if (statisticsProfileEnabled && transactionOpen) await transaction.request().batch("SET STATISTICS PROFILE OFF").catch(() => { cleaned = false; });
    if (transactionOpen) await transaction.rollback().catch(() => { cleaned = false; });
    if (pool.connected) await pool.close().catch(() => { cleaned = false; });
    report.databaseCleanup.sqlserver = cleaned;
    assert.ok(cleaned, "SQL Server temporary session objects did not clean up.");
  }
}

function oraclePlanOperators(plan) {
  return [...new Set(plan.split(/\r?\n/)
    .map((line) => line.match(/\|\s*\d+\s*\|\s*([A-Z][A-Z ]+(?:\s+[A-Z]+)?)\s*\|/i)?.[1]?.trim())
    .filter((value) => value && /TABLE ACCESS|INDEX|HASH|NESTED LOOPS|SORT|AGGREGATE/i.test(value)))];
}

function oracleOperatorPattern(operator) {
  if (/HASH/i.test(operator)) return /hash|哈希/i;
  if (/NESTED LOOPS/i.test(operator)) return /nested loops?|嵌套循环/i;
  if (/INDEX/i.test(operator)) return /index|索引/i;
  if (/TABLE ACCESS/i.test(operator)) return /table access|table scan|full scan|表访问|全表扫描/i;
  if (/AGGREGATE|GROUP BY/i.test(operator)) return /aggregate|group by|聚合/i;
  return new RegExp(operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function createOraclePlanCase() {
  const env = databaseEnvironment("oracle");
  const connection = await oracledb.getConnection({
    user: env.ORACLE_USER,
    password: env.ORACLE_PASSWORD,
    connectString: `${env.ORACLE_HOST}:${env.ORACLE_PORT}/${env.ORACLE_SERVICE_NAME}`,
    callTimeout: 30_000,
  });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const customers = `AI_PLAN_CUSTOMERS_${suffix}`;
  const orders = `AI_PLAN_ORDERS_${suffix}`;
  const statementId = `AI_PLAN_${suffix}`;
  const query = `SELECT c.region, COUNT(*) AS open_orders
FROM ${orders} o
JOIN ${customers} c ON c.id = o.customer_id
WHERE c.region = 'north' AND o.status = 'open'
GROUP BY c.region`;
  const createdTables = [];
  let planRowsMayExist = false;
  let planRowsCleaned = true;
  try {
    await connection.execute(`CREATE GLOBAL TEMPORARY TABLE ${customers} (
      id NUMBER NOT NULL PRIMARY KEY,
      region VARCHAR2(16) NOT NULL
    ) ON COMMIT PRESERVE ROWS`);
    createdTables.push(customers);
    await connection.execute(`CREATE GLOBAL TEMPORARY TABLE ${orders} (
      id NUMBER NOT NULL PRIMARY KEY,
      customer_id NUMBER NOT NULL,
      status VARCHAR2(12) NOT NULL
    ) ON COMMIT PRESERVE ROWS`);
    createdTables.push(orders);
    await connection.execute(`CREATE INDEX AI_PLAN_CUSTOMER_IDX_${suffix} ON ${orders} (customer_id)`);
    const customerRows = Array.from({ length: 500 }, (_, index) => [index + 1, index % 10 === 0 ? "north" : "south"]);
    await connection.executeMany(`INSERT INTO ${customers} (id, region) VALUES (:1, :2)`, customerRows, { autoCommit: false });
    const orderRows = Array.from({ length: 12_000 }, (_, index) => [
      index + 1, (index % 500) + 1, index % 5 === 0 ? "open" : "closed",
    ]);
    for (const chunk of batches(orderRows, 1_000)) {
      await connection.executeMany(`INSERT INTO ${orders} (id, customer_id, status) VALUES (:1, :2, :3)`, chunk, { autoCommit: false });
    }
    report.syntheticRowsCreated += customerRows.length + orderRows.length;
    await connection.commit();
    planRowsMayExist = true;
    await connection.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${query}`);
    report.explainStatementExecuted = true;
    const result = await connection.execute(
      `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', '${statementId}', 'BASIC +ROWS +COST'))`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const plan = (result.rows ?? []).map((row) => String(row.PLAN_TABLE_OUTPUT ?? "")).join("\n");
    assert.match(plan, /Plan hash value|Rows|Cost|TABLE ACCESS|INDEX/i, "Oracle DBMS_XPLAN returned no recognizable plan text.");
    const operators = oraclePlanOperators(plan);
    assert.ok(operators.length > 0, "Oracle plan had no table/index/join operators.");
    return {
      name: "oracle-live-gtt-dbms-xplan",
      source: "oracle-dbms-xplan",
      executionMode: "estimated",
      engine: "oracle",
      dialects: ["oracle"],
      sql: `${query};\n`,
      plan,
      focus: `the ${operators.slice(0, 3).join(", ")} operations and estimated row/cost columns`,
      planOperators: operators.slice(0, 8),
      expected: operators.slice(0, 2).map(oracleOperatorPattern),
    };
  } finally {
    if (planRowsMayExist) {
      try {
        await connection.execute(`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :id`, { id: statementId }, { autoCommit: true });
        const remaining = await connection.execute(`SELECT COUNT(*) AS COUNT FROM PLAN_TABLE WHERE STATEMENT_ID = :id`, { id: statementId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        planRowsCleaned = Number(remaining.rows?.[0]?.COUNT ?? 0) === 0;
      } catch {
        planRowsCleaned = false;
      }
    }
    try { await connection.close(); }
    catch { planRowsCleaned = false; }
    const tableCleanupErrors = [];
    let verifyConnection;
    try {
      verifyConnection = await oracledb.getConnection({
        user: env.ORACLE_USER,
        password: env.ORACLE_PASSWORD,
        connectString: `${env.ORACLE_HOST}:${env.ORACLE_PORT}/${env.ORACLE_SERVICE_NAME}`,
        callTimeout: 10_000,
      });
      for (const table of [...createdTables].reverse()) {
        try { await verifyConnection.execute(`DROP TABLE ${table} PURGE`); }
        catch (error) { tableCleanupErrors.push(error); }
      }
      const remaining = await verifyConnection.execute(
        `SELECT COUNT(*) AS COUNT FROM USER_TABLES WHERE TABLE_NAME IN (:customers, :orders)`,
        { customers, orders },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      if (Number(remaining.rows?.[0]?.COUNT ?? 0) !== 0) tableCleanupErrors.push(new Error("Synthetic table metadata remains."));
    } catch (error) {
      tableCleanupErrors.push(error);
    } finally {
      await verifyConnection?.close().catch((error) => tableCleanupErrors.push(error));
    }
    assert.ok(planRowsCleaned, "Oracle PLAN_TABLE rows were not removed.");
    assert.equal(tableCleanupErrors.length, 0, "Oracle synthetic global temporary tables were not removed.");
    report.oraclePlanRowsCleaned = planRowsCleaned;
    report.databaseCleanup.oracle = tableCleanupErrors.length === 0 && planRowsCleaned;
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  status: "failed",
  scope: "SQLite EXPLAIN QUERY PLAN plus MySQL/MariaDB JSON EXPLAIN, Oracle DBMS_XPLAN estimated plans and SQL Server STATISTICS PROFILE actual plan for synthetic data; only synthetic SQL/plan text sent to Chat",
  chatRequestTimeoutMs,
  executedSyntheticQuerySql: false,
  executedUserQuerySql: false,
  explainStatementExecuted: false,
  persistentDatabaseChanges: false,
  syntheticRowsCreated: 0,
  databaseObjectsCleaned: false,
  oraclePlanRowsCleaned: false,
  databaseCleanup: {},
  sqliteSyntheticDatabaseCleaned: false,
  cases: [],
};

try {
  assert.ok(existsSync(cli), `Built CLI entry point is missing: ${cli}`);
  const models = JSON.parse(runCli(["ai", "models", "list"]));
  assert.equal(models.chat?.configured, true, "Encrypted desktop Chat model settings are not available to the CLI.");
  const scenarios = createSqlitePlanCases();
  for (const engine of ["mysql", "mariadb"]) scenarios.push(await createMySqlPlanCase(engine));
  scenarios.push(await createSqlServerPlanCase());
  scenarios.push(await createOraclePlanCase());
  report.sqliteSyntheticDatabaseCleaned = report.databaseCleanup.sqlite === true;
  report.databaseObjectsCleaned = Object.keys(report.databaseCleanup).length === 5
    && Object.values(report.databaseCleanup).every(Boolean);

  for (const scenario of scenarios) {
    writeFileSync(sqlPath, scenario.sql, "utf8");
    writeFileSync(planPath, scenario.plan, "utf8");
    const output = JSON.parse(runCli([
      "ai", "sql", "explain-plan",
      "--connection", "environment",
      "--file", sqlPath,
      "--plan-file", planPath,
      "--request", scenario.estimateAndRuntimeUnavailable
        ? `Explain the supplied SQLite plan. Identify ${scenario.focus}. SQLite EXPLAIN QUERY PLAN here provides a high-level strategy only: explicitly state that the supplied output has no row-count estimates, cost estimates, or runtime measurements. Do not invent any.`
        : `Explain the supplied ${scenario.engine} server plan. Identify ${scenario.focus}. Distinguish optimizer estimates from actual runtime measurements and state when runtime data is absent.`,
      "--format", "json",
    ], {
      ...databaseEnvironment(scenario.engine),
      MODEL_OPENAI_TIMEOUT_MS: String(chatRequestTimeoutMs),
    }, Math.max(120_000, chatRequestTimeoutMs + 30_000)));
    const result = output.result;
    const normalizedDialect = String(result?.dialect ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const dialectMatches = scenario.dialects.some((dialect) => dialect.replace(/[^a-z]/g, "") === normalizedDialect);
    assert.equal(result?.task, "explain-plan", `${scenario.name}: unexpected task.`);
    assert.ok(dialectMatches, `${scenario.name}: unexpected dialect ${String(result?.dialect)}.`);
    assert.ok(typeof result?.explanation === "string" && result.explanation.trim().length >= 40, `${scenario.name}: explanation was missing or too short.`);
    assert.equal(Object.hasOwn(result, "sql"), false, `${scenario.name}: output must not contain executable SQL.`);
    if (scenario.estimateAndRuntimeUnavailable) {
      assert.match(result.explanation, /(?:no|not provided|does not|not include|unavailable|未提供|未包含|没有).{0,80}(?:row|estimate|cost|计数|行数|估算|成本)|(?:row|estimate|cost|计数|行数|估算|成本).{0,80}(?:not provided|not included|unavailable|未提供|未包含|没有)/i,
        `${scenario.name}: failed to state that row estimates and costs are absent.`);
      assert.match(result.explanation, /(?:no|not provided|does not|not include|unavailable|未提供|未包含|没有).{0,80}(?:runtime|actual|measurement|execution time|运行时|实测|执行时间)|(?:runtime|actual|measurement|execution time|运行时|实测|执行时间).{0,80}(?:not provided|not included|unavailable|未提供|未包含|没有)/i,
        `${scenario.name}: failed to state that runtime measurements are absent.`);
    } else {
      assert.match(result.explanation, /estimate|estimated|cost|rows|估算|估计/i, `${scenario.name}: did not discuss plan estimates.`);
      assert.match(result.explanation, /actual|runtime|execution time|measurement|实测|运行时|执行时间/i, `${scenario.name}: did not address missing runtime measurements.`);
    }
    const missingPlanConcepts = scenario.expected
      .filter((pattern) => !pattern.test(result.explanation))
      .map((pattern) => pattern.source);
    if (missingPlanConcepts.length > 0) {
      report.cases.push({
        name: scenario.name,
        planSource: scenario.source,
        engine: scenario.engine,
        dialect: result.dialect,
        planOperators: scenario.planOperators,
        explanationLength: result.explanation.length,
        missingPlanConcepts,
      });
      assert.fail(`${scenario.name}: omitted observed plan concepts ${missingPlanConcepts.join("; ")}.`);
    }
    report.cases.push({
      name: scenario.name,
      planSource: scenario.source,
      executionMode: scenario.executionMode,
      engine: scenario.engine,
      dialect: result.dialect,
      planOperators: scenario.planOperators,
      explanationLength: result.explanation.length,
      hasSqlField: Object.hasOwn(result, "sql"),
      estimateAndRuntimeCaveats: true,
      keyPlanConceptsPresent: scenario.expected.length,
    });
  }
  report.status = "passed";
  report.configuredChatModel = models.chat.model;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = safeError(error);
  console.error(`Real multi-database explain-plan smoke failed: ${report.error}`);
  process.exitCode = 1;
} finally {
  if (path.dirname(temporaryDirectory) !== os.tmpdir() || !path.basename(temporaryDirectory).startsWith("dbstudio-cli-plan-real-multidb-")) {
    throw new Error(`Refusing to remove unexpected temporary path: ${temporaryDirectory}`);
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
  report.cleanedTemporaryFiles = !existsSync(temporaryDirectory);
  report.databaseObjectsCleaned = Object.keys(report.databaseCleanup).length === 5
    && Object.values(report.databaseCleanup).every(Boolean);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
