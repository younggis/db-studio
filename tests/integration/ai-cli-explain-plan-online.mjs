import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const requireFromDatabase = createRequire(path.join(root, "packages", "database", "package.json"));
const { Client: PostgresClient } = requireFromDatabase("pg");
const reportDirectory = path.join(root, ".cache");
const realPostgresOnly = process.argv.includes("--real-postgis-only");
const reportPath = path.join(reportDirectory, realPostgresOnly
  ? "ai-cli-explain-plan-real-postgis-last.json"
  : "ai-cli-explain-plan-online-last.json");
const chatRequestTimeoutMs = Number(process.env.DBSTUDIO_AI_PLAN_TEST_TIMEOUT_MS ?? "60000");
assert.ok(Number.isInteger(chatRequestTimeoutMs) && chatRequestTimeoutMs >= 1_000 && chatRequestTimeoutMs <= 300_000,
  "DBSTUDIO_AI_PLAN_TEST_TIMEOUT_MS must be an integer from 1000 to 300000.");
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "dbstudio-cli-plan-online-"));
const sqlPath = path.join(temporaryDirectory, "synthetic-query.sql");
const planPath = path.join(temporaryDirectory, "synthetic-plan.txt");
const environment = { ...process.env };
const modelEnvironmentNames = [
  "DBSTUDIO_USER_DATA_DIR",
  "MODEL_OPENAI_BASE_URL",
  "MODEL_OPENAI_MODEL",
  "MODEL_OPENAI_API_KEY",
  "MODEL_OPENAI_TEMPERATURE",
  "MODEL_OPENAI_MAX_OUTPUT_TOKENS",
  "MODEL_OPENAI_TIMEOUT_MS",
  "MODEL_OPENAI_STREAMING",
  "DBSTUDIO_AI_BASE_URL",
  "DBSTUDIO_AI_MODEL",
  "DBSTUDIO_AI_API_KEY",
  "DASHSCOPE_API_KEY",
];
for (const name of modelEnvironmentNames) delete environment[name];
const databaseEnvironmentNames = [
  "DBSTUDIO_DATABASE_TYPE", "DBSTUDIO_DATABASE_URL", "DATABASE_URL", "DBSTUDIO_SQLITE_PATH",
  "DBSTUDIO_MYSQL_URL", "DBSTUDIO_MARIADB_URL", "DBSTUDIO_SQLSERVER_URL", "DBSTUDIO_ORACLE_CONNECT_STRING",
  "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE",
  "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_CONNECT_TIMEOUT",
  "MARIADB_HOST", "MARIADB_PORT", "MARIADB_DATABASE", "MARIADB_USER", "MARIADB_PASSWORD", "MARIADB_CONNECT_TIMEOUT",
  "SQLSERVER_HOST", "SQLSERVER_PORT", "SQLSERVER_DATABASE", "SQLSERVER_USER", "SQLSERVER_PASSWORD",
  "SQLSERVER_ENCRYPT", "SQLSERVER_TRUST_SERVER_CERTIFICATE", "SQLSERVER_CONNECT_TIMEOUT", "SQLSERVER_REQUEST_TIMEOUT",
  "ORACLE_USER", "ORACLE_PASSWORD", "ORACLE_HOST", "ORACLE_PORT", "ORACLE_SERVICE_NAME",
  "ORACLE_CONNECT_STRING", "ORACLE_CONNECT_TIMEOUT", "ORACLE_CALL_TIMEOUT",
];
for (const name of databaseEnvironmentNames) delete environment[name];

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
  if (engine === "postgres") {
    Object.assign(env, {
      PGHOST: "127.0.0.1",
      PGPORT: dockerEnv.DBSTUDIO_POSTGIS_PORT || dockerEnv.DBSTUDIO_POSTGRES_PORT || "25432",
      PGDATABASE: dockerEnv.DBSTUDIO_PG_DATABASE || "dbstudio_test",
      PGUSER: dockerEnv.DBSTUDIO_PG_USER || "dbstudio",
      PGPASSWORD: dockerEnv.DBSTUDIO_PG_PASSWORD,
      PGSSLMODE: "disable",
    });
  } else if (engine === "mysql") {
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
      SQLSERVER_CONNECT_TIMEOUT: "8000", SQLSERVER_REQUEST_TIMEOUT: "8000",
    });
  } else if (engine === "oracle") {
    Object.assign(env, {
      ORACLE_USER: "SYSTEM", ORACLE_PASSWORD: dockerEnv.ORACLE_PASSWORD,
      ORACLE_HOST: "127.0.0.1", ORACLE_PORT: "21521", ORACLE_SERVICE_NAME: "FREEPDB1",
      ORACLE_CONNECT_TIMEOUT: "10", ORACLE_CALL_TIMEOUT: "8000",
    });
  } else if (engine === "sqlite") {
    env.DBSTUDIO_SQLITE_PATH = ":memory:";
  } else {
    throw new Error(`Unsupported plan matrix engine: ${engine}`);
  }
  return env;
}

function runCli(args, env = environment, timeout = 120_000) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function safeError(error) {
  let message = String(error?.message ?? error);
  for (const value of sensitiveDockerValues) message = message.split(value).join("[REDACTED]");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
    .slice(0, 800);
}

let report = {
  generatedAt: new Date().toISOString(),
  status: "failed",
  scope: realPostgresOnly
    ? "two generated PostgreSQL/PostGIS EXPLAIN JSON plans from transaction-scoped synthetic tables; no business Schema or rows sent"
    : "seven synthetic SQL and plan examples; isolated database connections read only server/schema metadata; no business Schema or rows sent",
  chatRequestTimeoutMs,
  executedUserQuerySql: false,
  explainStatementExecuted: false,
  persistentDatabaseChanges: false,
  cases: [],
};

const cases = [
  {
    name: "sqlite-table-scan",
    engine: "sqlite",
    dialects: ["sqlite"],
    sql: "SELECT COUNT(*) FROM synthetic_orders WHERE status = 'pending';\n",
    plan: "SQLite EXPLAIN QUERY PLAN: SCAN synthetic_orders; estimated rows: 12; actual rows and execution time: not collected.\n",
    focus: "a table scan and the distinction between the estimate and missing runtime measurements",
    expected: [/scan|扫描/i],
  },
  {
    name: "postgres-nested-loop-index-scans",
    engine: "postgres",
    dialects: ["postgres", "postgresql", "postgresql / postgis"],
    sql: "SELECT o.customer_id, COUNT(*) FROM synthetic_orders o JOIN synthetic_customers c ON c.id = o.customer_id WHERE c.region = 'north' GROUP BY o.customer_id;\n",
    plan: "PostgreSQL EXPLAIN (not ANALYZE): HashAggregate (cost=22.10..22.45 rows=24 width=16) -> Nested Loop (cost=0.55..18.20 rows=120 width=8) -> Index Scan using ix_customers_region on synthetic_customers c (cost=0.28..5.10 rows=12 width=4) -> Index Scan using ix_orders_customer_id on synthetic_orders o (cost=0.27..1.05 rows=10 width=8). Planning Time: 0.13 ms. Execution Time: not collected; actual rows: not collected.\n",
    focus: "the Nested Loop join and both Index Scan operations",
    expected: [/nested loop|嵌套循环/i, /index scan|索引扫描/i],
  },
  {
    name: "mysql-json-full-scan-join",
    engine: "mysql",
    dialects: ["mysql"],
    sql: "SELECT o.customer_id, COUNT(*) FROM synthetic_orders o JOIN synthetic_customers c ON c.id = o.customer_id WHERE o.status = 'pending' GROUP BY o.customer_id;\n",
    plan: "MySQL EXPLAIN FORMAT=JSON (estimated plan): nested_loop; table synthetic_orders access_type ALL, rows_examined_per_scan 10000, filtered 25.0, attached_condition status = 'pending'; table synthetic_customers access_type eq_ref, key PRIMARY, rows_examined_per_scan 1. Actual row counts and timing: not collected.\n",
    focus: "the ALL access type full table scan and the eq_ref primary-key lookup",
    expected: [/full table scan|table scan|access.?type.?all|全表扫描/i, /eq_ref|primary.?key|主键/i],
  },
  {
    name: "mariadb-filesort-and-range",
    engine: "mariadb",
    dialects: ["mariadb"],
    sql: "SELECT customer_id, created_at FROM synthetic_orders WHERE created_at >= '2026-01-01' ORDER BY created_at;\n",
    plan: "MariaDB EXPLAIN (estimated): table synthetic_orders, type range, possible_keys ix_orders_created_at, key ix_orders_created_at, rows 240, Extra Using index condition; Using filesort. Actual row counts and execution timing: not collected.\n",
    focus: "the range index access and the separate filesort operation",
    expected: [/range|范围/i, /filesort|sort|排序/i],
  },
  {
    name: "sqlserver-hash-join-estimated-plan",
    engine: "sqlserver",
    dialects: ["sqlserver", "sql server", "sql server t-sql"],
    sql: "SELECT c.region, COUNT(*) FROM synthetic_orders o JOIN synthetic_customers c ON c.id = o.customer_id GROUP BY c.region;\n",
    plan: "SQL Server estimated plan: Hash Match (Aggregate), Estimated Rows 24; child Hash Match (Inner Join), Estimated Rows 380; Index Seek IX_orders_customer_id, Estimated Rows 380; Key Lookup PK_orders, Estimated Executions 380; Index Scan IX_customers_region, Estimated Rows 120; Estimated Subtree Cost 4.72. Actual rows and elapsed time are absent.\n",
    focus: "the Hash Match join, Index Seek, Key Lookup cost, and absence of actual runtime rows",
    expected: [/hash match|hash join|哈希/i, /index seek|索引查找/i],
  },
  {
    name: "oracle-hash-join-full-scan",
    engine: "oracle",
    dialects: ["oracle"],
    sql: "SELECT c.region, COUNT(*) FROM synthetic_orders o JOIN synthetic_customers c ON c.id = o.customer_id GROUP BY c.region;\n",
    plan: "Oracle EXPLAIN PLAN: SELECT STATEMENT Cost=64 Rows=24; HASH GROUP BY; HASH JOIN Cost=61 Rows=380; TABLE ACCESS FULL SYNTHETIC_ORDERS Rows=12000; INDEX RANGE SCAN IX_CUSTOMERS_REGION Rows=120. Plan-table estimates only; actual rows and elapsed time are not present.\n",
    focus: "the HASH JOIN, full table access, and range index scan",
    expected: [/hash join|哈希连接/i, /table access full|full table scan|全表扫描/i, /index range scan|range scan|范围扫描/i],
  },
  {
    name: "postgis-spatial-index-filter",
    engine: "postgres",
    dialects: ["postgres", "postgresql", "postgresql / postgis"],
    sql: "SELECT id FROM synthetic_gis_features WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint(0, 0), 4326), 500);\n",
    plan: "PostGIS EXPLAIN (not ANALYZE): Bitmap Heap Scan on synthetic_gis_features (cost=4.10..18.30 rows=8 width=8); Recheck Cond geom && _st_expand(...); Filter ST_DWithin(geom, ...); Bitmap Index Scan using synthetic_gis_geom_gix (cost=0.00..4.10 rows=8 width=0). Actual rows and execution time: not collected.\n",
    focus: "the GiST spatial index prefilter and the exact ST_DWithin filter",
    expected: [/gist|spatial index|空间索引/i, /st_dwithin/i],
  },
];

function flattenPlanNodes(plan) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node["Node Type"] === "string") nodes.push(node);
    if (Array.isArray(node.Plans)) node.Plans.forEach(visit);
  };
  visit(Array.isArray(plan) ? plan[0]?.Plan : plan?.Plan);
  return nodes;
}

function planResponsePattern(nodeType) {
  if (/^Hash Join$/i.test(nodeType)) return /hash join|哈希连接/i;
  if (/^Nested Loop$/i.test(nodeType)) return /nested loop|嵌套循环/i;
  if (/^Merge Join$/i.test(nodeType)) return /merge join|合并连接/i;
  if (/^Index Only Scan$/i.test(nodeType)) return /index.only scan|索引仅扫描|索引扫描/i;
  if (/^Index Scan$/i.test(nodeType)) return /index scan|索引扫描/i;
  if (/^Bitmap Index Scan$/i.test(nodeType)) return /bitmap index scan|位图索引扫描|索引扫描/i;
  if (/^Bitmap Heap Scan$/i.test(nodeType)) return /bitmap heap scan|位图堆扫描|位图扫描/i;
  if (/^Seq Scan$/i.test(nodeType)) return /seq(?:uential)? scan|顺序扫描|全表扫描/i;
  return /join|scan|连接|扫描/i;
}

async function createRealPostgresPlanCases() {
  const env = databaseEnvironment("postgres");
  const client = new PostgresClient({
    host: env.PGHOST,
    port: Number(env.PGPORT),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: false,
    connectionTimeoutMillis: 8_000,
  });
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const customers = `ai_plan_customers_${suffix}`;
  const orders = `ai_plan_orders_${suffix}`;
  const features = `ai_plan_features_${suffix}`;
  const joinSql = `SELECT c.region, COUNT(*) AS open_orders
FROM ${orders} AS o
JOIN ${customers} AS c ON c.id = o.customer_id
WHERE c.region = 'north' AND o.status = 'open'
GROUP BY c.region
ORDER BY open_orders DESC`;
  const spatialSql = `SELECT id
FROM ${features}
WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint(0, 0), 4326), 0.05)`;

  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(`CREATE TEMP TABLE ${customers} (id integer PRIMARY KEY, region text NOT NULL)`);
    await client.query(`CREATE TEMP TABLE ${orders} (
      id bigint PRIMARY KEY,
      customer_id integer NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL
    )`);
    await client.query(`INSERT INTO ${customers} (id, region)
      SELECT value, CASE WHEN value % 100 = 0 THEN 'north' ELSE 'south' END
      FROM generate_series(1, 10000) AS series(value)`);
    await client.query(`INSERT INTO ${orders} (id, customer_id, status, created_at)
      SELECT value, ((value - 1) % 10000) + 1,
        CASE WHEN value % 5 = 0 THEN 'open' ELSE 'closed' END,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + value * INTERVAL '1 minute'
      FROM generate_series(1, 100000) AS series(value)`);
    await client.query(`CREATE INDEX ai_plan_customers_region_idx_${suffix} ON ${customers} (region)`);
    await client.query(`CREATE INDEX ai_plan_orders_customer_idx_${suffix} ON ${orders} (customer_id)`);
    await client.query(`CREATE INDEX ai_plan_orders_status_created_idx_${suffix} ON ${orders} (status, created_at)`);
    await client.query(`ANALYZE ${customers}`);
    await client.query(`ANALYZE ${orders}`);

    await client.query(`CREATE TEMP TABLE ${features} (
      id integer PRIMARY KEY,
      geom geometry(Point, 4326) NOT NULL
    )`);
    await client.query(`INSERT INTO ${features} (id, geom)
      SELECT value, ST_SetSRID(ST_MakePoint(
        ((value % 36000)::double precision / 100.0) - 180.0,
        (((value * 37) % 18000)::double precision / 100.0) - 90.0
      ), 4326)
      FROM generate_series(1, 50000) AS series(value)`);
    await client.query(`CREATE INDEX ai_plan_features_geom_gix_${suffix} ON ${features} USING GIST (geom)`);
    await client.query(`ANALYZE ${features}`);

    const joinResult = await client.query(`EXPLAIN (FORMAT JSON) ${joinSql}`);
    const spatialResult = await client.query(`EXPLAIN (FORMAT JSON) ${spatialSql}`);
    report.explainStatementExecuted = true;
    const joinPlan = joinResult.rows[0]?.["QUERY PLAN"];
    const spatialPlan = spatialResult.rows[0]?.["QUERY PLAN"];
    const joinNodes = flattenPlanNodes(joinPlan);
    const spatialNodes = flattenPlanNodes(spatialPlan);
    const joinType = joinNodes.find((node) => /Join$/.test(String(node["Node Type"])))?.["Node Type"];
    const scanType = joinNodes.find((node) => /Scan$/.test(String(node["Node Type"])))?.["Node Type"];
    const spatialIndexType = spatialNodes.find((node) => /Index Scan$/.test(String(node["Node Type"])))?.["Node Type"];
    assert.ok(joinType, "PostgreSQL did not produce a join node for the synthetic relational query.");
    assert.ok(scanType, "PostgreSQL did not produce a scan node for the synthetic relational query.");
    assert.ok(spatialIndexType, "PostGIS did not select the temporary GiST index for the synthetic spatial query.");
    assert.ok(JSON.stringify(spatialPlan).includes("st_dwithin"), "PostGIS plan omitted the ST_DWithin filter.");

    return [
      {
        name: "postgres-live-temp-table-join-plan",
        source: "postgresql-explain-json",
        engine: "postgres",
        dialects: ["postgres", "postgresql", "postgresql / postgis"],
        sql: `${joinSql};\n`,
        plan: `PostgreSQL EXPLAIN (FORMAT JSON), generated by the isolated test server; planner estimates only, no actual rows or timing:\n${JSON.stringify(joinPlan, null, 2)}\n`,
        planOperators: [String(joinType), String(scanType)],
        focus: `the ${joinType} join, ${scanType} access path, estimated costs and rows`,
        expected: [planResponsePattern(joinType), planResponsePattern(scanType)],
      },
      {
        name: "postgis-live-temp-table-gist-plan",
        source: "postgis-explain-json",
        engine: "postgres",
        dialects: ["postgres", "postgresql", "postgresql / postgis"],
        sql: `${spatialSql};\n`,
        plan: `PostGIS EXPLAIN (FORMAT JSON), generated by the isolated test server; planner estimates only, no actual rows or timing:\n${JSON.stringify(spatialPlan, null, 2)}\n`,
        planOperators: [String(spatialIndexType), "ST_DWithin"],
        focus: `the ${spatialIndexType} GiST access path, ST_DWithin filter, estimated costs and rows`,
        expected: [/index|索引/i, /st_dwithin/i],
      },
    ];
  } finally {
    try {
      if (transactionOpen) {
        await client.query("ROLLBACK");
        report.temporaryTablesRolledBack = true;
        report.persistentDatabaseChanges = false;
      }
    } finally {
      await client.end();
    }
  }
}

try {
  assert.ok(existsSync(cli), `Built CLI entry point is missing: ${cli}`);
  const models = JSON.parse(runCli(["ai", "models", "list"]));
  assert.equal(models.chat?.configured, true, "Encrypted desktop Chat model settings are not available to the CLI.");

  let selectedCases = cases;
  if (realPostgresOnly) {
    selectedCases = await createRealPostgresPlanCases();
    report = {
      ...report,
      explainStatementExecuted: true,
      planSource: "PostgreSQL/PostGIS EXPLAIN JSON generated from synthetic temporary tables",
      temporarySyntheticRowsCreated: 160_000,
      temporaryTablesRolledBack: true,
      persistentDatabaseChanges: false,
    };
  }

  for (const scenario of selectedCases) {
    writeFileSync(sqlPath, scenario.sql, "utf8");
    writeFileSync(planPath, scenario.plan, "utf8");
    const output = JSON.parse(runCli([
      "ai", "sql", "explain-plan",
      "--connection", "environment",
      "--file", sqlPath,
      "--plan-file", planPath,
      "--request", `Explain the supplied ${scenario.engine} plan. Identify ${scenario.focus}. Distinguish estimates from actual runtime data and do not invent measured execution time.`,
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
    assert.equal(typeof result?.explanation, "string", `${scenario.name}: missing explanation.`);
    assert.ok(result.explanation.trim().length >= 40, `${scenario.name}: explanation was too short.`);
    assert.equal(Object.hasOwn(result, "sql"), false, `${scenario.name}: output must not contain executable SQL.`);
    assert.match(result.explanation, /estimate|estimated|cost|rows|估算|估计/i, `${scenario.name}: did not discuss plan estimates.`);
    assert.match(result.explanation, /actual|runtime|execution time|measurement|实测|运行时|执行时间/i, `${scenario.name}: did not address missing runtime measurements.`);
    for (const pattern of scenario.expected) {
      assert.match(result.explanation, pattern, `${scenario.name}: omitted a key plan operator or access path.`);
    }
    report.cases.push({
      name: scenario.name,
      planSource: scenario.source ?? "synthetic-vendor-shaped-example",
      engine: scenario.engine,
      dialect: result.dialect,
      planOperators: scenario.planOperators ?? null,
      explanationLength: result.explanation.length,
      hasSqlField: Object.hasOwn(result, "sql"),
      estimateAndRuntimeCaveats: true,
      keyPlanConceptsPresent: scenario.expected.length,
    });
  }
  report = { ...report, status: "passed", configuredChatModel: models.chat.model };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = safeError(error);
  console.error(`Online explain-plan smoke failed: ${report.error}`);
  process.exitCode = 1;
} finally {
  if (path.dirname(temporaryDirectory) !== os.tmpdir() || !path.basename(temporaryDirectory).startsWith("dbstudio-cli-plan-online-")) {
    throw new Error(`Refusing to remove unexpected temporary path: ${temporaryDirectory}`);
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
  report.cleanedTemporaryFiles = !existsSync(temporaryDirectory);
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
