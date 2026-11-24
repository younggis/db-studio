// Phase 1.1: shared DatabaseAdapter contract exercised against every relational
// engine available in the local Docker Compose test environment. Each engine
// runs the same behavioural cases (connection, query, bind parameters, schema
// discovery, create/columns/read, error classification, cleanup).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerEnv = existsSync(path.join(root, "docker", ".env"))
  ? Object.fromEntries(readFileSync(path.join(root, "docker", ".env"), "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]))
  : {};

const token = randomBytes(4).toString("hex");
const sqliteDir = path.join(os.tmpdir(), `dbstudio-contract-${token}`);
mkdirSync(sqliteDir, { recursive: true });
const sqlitePath = path.join(sqliteDir, "contract.sqlite");

const definitions = [
  {
    engine: "postgres",
    label: "PostGIS (PostgreSQL)",
    schema: "public",
    placeholder: (index) => `$${index}`,
    env: {
      DBSTUDIO_DATABASE_TYPE: "postgres",
      PGHOST: "127.0.0.1", PGPORT: dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432",
      PGDATABASE: dockerEnv.DBSTUDIO_PG_DATABASE || "dbstudio_test",
      PGUSER: dockerEnv.DBSTUDIO_PG_USER || "dbstudio", PGPASSWORD: dockerEnv.DBSTUDIO_PG_PASSWORD || "",
    },
  },
  {
    engine: "mysql",
    label: "MySQL",
    schema: dockerEnv.MYSQL_DATABASE || "dbstudio_test",
    placeholder: () => "?",
    env: {
      DBSTUDIO_DATABASE_TYPE: "mysql",
      MYSQL_HOST: "127.0.0.1", MYSQL_PORT: dockerEnv.MYSQL_PORT || "23306",
      MYSQL_DATABASE: dockerEnv.MYSQL_DATABASE || "dbstudio_test",
      MYSQL_USER: dockerEnv.MYSQL_USER || "dbstudio", MYSQL_PASSWORD: dockerEnv.MYSQL_PASSWORD || "",
    },
  },
  {
    engine: "mariadb",
    label: "MariaDB",
    schema: dockerEnv.MARIADB_DATABASE || "dbstudio_test",
    placeholder: () => "?",
    env: {
      DBSTUDIO_DATABASE_TYPE: "mariadb",
      MARIADB_HOST: "127.0.0.1", MARIADB_PORT: dockerEnv.MARIADB_PORT || "23307",
      MARIADB_DATABASE: dockerEnv.MARIADB_DATABASE || "dbstudio_test",
      MARIADB_USER: dockerEnv.MARIADB_USER || "dbstudio", MARIADB_PASSWORD: dockerEnv.MARIADB_PASSWORD || "",
    },
  },
  {
    engine: "sqlserver",
    label: "SQL Server",
    schema: "dbo",
    placeholder: (index) => `@p${index}`,
    env: {
      DBSTUDIO_DATABASE_TYPE: "sqlserver",
      SERVER_HOST: "127.0.0.1", SQLSERVER_HOST: "127.0.0.1",
      SQLSERVER_PORT: dockerEnv.SQLSERVER_PORT || "21433",
      SQLSERVER_DATABASE: "dbstudio_test", SQLSERVER_USER: "sa",
      SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD || "",
      SQLSERVER_ENCRYPT: "false", SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
    },
  },
  {
    engine: "oracle",
    label: "Oracle Free",
    schema: (dockerEnv.ORACLE_USER || "SYSTEM").toUpperCase(),
    placeholder: (index) => `:${index}`,
    env: {
      DBSTUDIO_DATABASE_TYPE: "oracle",
      ORACLE_HOST: "127.0.0.1", ORACLE_PORT: dockerEnv.ORACLE_PORT || "21521",
      ORACLE_SERVICE_NAME: dockerEnv.ORACLE_SERVICE_NAME || "FREEPDB1",
      ORACLE_USER: dockerEnv.ORACLE_USER || "SYSTEM", ORACLE_PASSWORD: dockerEnv.ORACLE_PASSWORD || "",
    },
  },
  {
    engine: "sqlite",
    label: "SQLite",
    schema: undefined,
    placeholder: () => "?",
    env: { DBSTUDIO_DATABASE_TYPE: "sqlite", DBSTUDIO_SQLITE_PATH: sqlitePath },
  },
];

function quote(engine, identifier) {
  if (engine === "mysql" || engine === "mariadb") return `\`${identifier}\``;
  if (engine === "sqlserver") return `[${identifier}]`;
  return `"${identifier}"`;
}

async function runContract(definition) {
  const env = { ...process.env, ...definition.env };
  for (const key of ["DBSTUDIO_DATABASE_URL", "DBSTUDIO_MYSQL_URL", "DBSTUDIO_MARIADB_URL", "DBSTUDIO_SQLSERVER_URL", "DBSTUDIO_ORACLE_CONNECT_STRING", "DATABASE_URL"]) delete env[key];
  const core = CoreService.fromEnvironment(env);
  const table = `contract_${token}`;
  const cases = [];
  let tableCreated = false;
  const record = (name, detail) => cases.push({ name, detail });
  try {
    const info = await core.testConnection();
    assert.ok(info.database, "testConnection must report a database");
    assert.ok(info.serverVersion, "testConnection must report a server version");
    record("testConnection", { database: info.database, serverVersion: info.serverVersion });

    const literal = await core.query("SELECT 1 AS n");
    assert.equal(literal.rows.length, 1);
    assert.equal(Number(Object.values(literal.rows[0])[0]), 1);
    record("query", { rows: literal.rows.length });

    const bindSql = `SELECT ${definition.placeholder(1)} AS v`;
    const bind = await core.query(bindSql, ["bound-value"]);
    assert.equal(String(Object.values(bind.rows[0])[0]), "bound-value");
    record("bind-parameters", { placeholder: definition.placeholder(1) });

    const schemas = await core.listSchemas();
    assert.ok(Array.isArray(schemas));
    record("listSchemas", { count: schemas.length });

    const tables = await core.listTables(definition.schema);
    assert.ok(Array.isArray(tables));
    record("listTables", { count: tables.length });

    const created = await core.createTableFromRows(table, {
      columns: ["id", "label", "amount"],
      rows: [
        { id: 1, label: "alpha", amount: 1.5 },
        { id: 2, label: "beta", amount: 2.5 },
      ],
    }, definition.schema);
    tableCreated = true;
    assert.equal(created.insertedRows, 2);
    assert.deepEqual([...created.columns].sort(), ["amount", "id", "label"]);
    record("createTableFromRows", { insertedRows: created.insertedRows, inferredTypes: created.inferredTypes });

    const columns = await core.getTableColumns(table, definition.schema);
    assert.deepEqual(columns.map((column) => column.name).sort(), ["amount", "id", "label"]);
    record("getTableColumns", { count: columns.length });

    const exported = await core.exportTable(table, definition.schema);
    assert.equal(exported.rows.length, 2);
    record("exportTable", { rows: exported.rows.length });

    await assert.rejects(() => core.query("SELECT * FROM __dbstudio_contract_table_that_does_not_exist"),
      "Invalid SQL must reject with a classified error");
    record("error-classification", { invalidSqlRejected: true });
  } finally {
    if (tableCreated) {
      const schemaPrefix = definition.schema ? `${quote(definition.engine, definition.schema)}.` : "";
      try { await core.query(`DROP TABLE ${schemaPrefix}${quote(definition.engine, table)}`); } catch { /* best effort */ }
    }
  }
  return { engine: definition.engine, label: definition.label, status: "passed", cases };
}

const results = [];
for (const definition of definitions) {
  try {
    results.push(await runContract(definition));
    process.stdout.write(`[contract] ${definition.label}: passed\n`);
  } catch (error) {
    results.push({ engine: definition.engine, label: definition.label, status: "failed", error: error instanceof Error ? error.message : String(error) });
    process.stdout.write(`[contract] ${definition.label}: FAILED - ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const reportPath = path.join(root, ".cache", `adapter-contract-${token}.json`);
writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
rmSync(sqliteDir, { recursive: true, force: true });

const failed = results.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  engines: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  reportPath: path.relative(root, reportPath),
}, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
