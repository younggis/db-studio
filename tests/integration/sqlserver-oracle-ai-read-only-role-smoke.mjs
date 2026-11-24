import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { CoreService } from "../../packages/core/dist/index.js";

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

function quoteSqlServerIdentifier(value) {
  return `[${value.replaceAll(']', ']]')}]`;
}

function quoteOracleIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sanitizedFailure(stage, error) {
  return {
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    databaseErrorCode: error?.code ?? error?.errorNum,
  };
}

async function expectDenied(service, engine, label, sql) {
  try {
    await service.query(sql);
  } catch (error) {
    if (engine === "sqlserver") assert.equal(error?.code, "EREQUEST", `${label} must fail with a SQL Server error.`);
    else assert.match(String(error?.code ?? ""), /^ORA-\d+$/, `${label} must fail with an Oracle server error.`);
    return;
  }
  assert.fail(`${label} unexpectedly succeeded for the limited ${engine} role.`);
}

async function verifySqlServer() {
  const host = process.env.SQLSERVER_HOST || dockerEnv.SQLSERVER_HOST || "127.0.0.1";
  const port = Number(process.env.SQLSERVER_PORT || dockerEnv.SQLSERVER_PORT || "21433");
  const database = required("SQLSERVER_DATABASE", "dbstudio_test");
  assert.equal(host, "127.0.0.1", "SQL Server must use the authorized local test service.");
  assert.equal(port, 21433, "SQL Server must use its project test port.");
  assert.equal(database, "dbstudio_test", "SQL Server must use the project test database.");

  const suffix = randomBytes(8).toString("hex").toUpperCase();
  const login = `DBS_AR_${suffix}`;
  const user = login;
  const allowedTable = `AI_RO_ALLOW_${suffix}`;
  const deniedTable = `AI_RO_PRIVATE_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const config = {
    server: host,
    port,
    database,
    user: "sa",
    password: required("SQLSERVER_SA_PASSWORD"),
    encrypt: true,
    trustServerCertificate: true,
    connectionTimeout: 8_000,
    requestTimeout: 8_000,
  };
  const admin = CoreService.fromSqlServerConfig(config);
  let loginCreated = false;
  let userCreated = false;
  let allowedCreated = false;
  let deniedCreated = false;
  let stage = "preflight";
  let failure;
  let cleanupFailure;

  try {
    const health = await admin.query("SELECT DB_NAME() AS database_name");
    assert.equal(health.rows[0]?.database_name, database);

    stage = "create-login";
    await admin.query(`CREATE LOGIN ${quoteSqlServerIdentifier(login)} WITH PASSWORD = ${quoteLiteral(password)}`);
    loginCreated = true;
    stage = "create-user";
    await admin.query(`CREATE USER ${quoteSqlServerIdentifier(user)} FOR LOGIN ${quoteSqlServerIdentifier(login)}`);
    userCreated = true;

    const allowed = `${quoteSqlServerIdentifier("dbo")}.${quoteSqlServerIdentifier(allowedTable)}`;
    const denied = `${quoteSqlServerIdentifier("dbo")}.${quoteSqlServerIdentifier(deniedTable)}`;
    stage = "create-fixtures";
    await admin.query(`CREATE TABLE ${allowed} (id int PRIMARY KEY, marker nvarchar(64) NOT NULL)`);
    allowedCreated = true;
    await admin.query(`CREATE TABLE ${denied} (id int PRIMARY KEY, secret_marker nvarchar(64) NOT NULL)`);
    deniedCreated = true;
    await admin.query(`INSERT INTO ${allowed} VALUES (1, N'allowed-sentinel')`);
    await admin.query(`INSERT INTO ${denied} VALUES (1, N'private-sentinel')`);
    await admin.query(`GRANT SELECT ON OBJECT::${allowed} TO ${quoteSqlServerIdentifier(user)}`);

    const reader = CoreService.fromSqlServerConfig({ ...config, user, password });
    stage = "allowed-read";
    const visible = await reader.query(`SELECT id AS [id], marker AS [marker] FROM ${allowed}`);
    assert.deepEqual(visible.rows, [{ id: 1, marker: "allowed-sentinel" }]);

    stage = "denied-read";
    await expectDenied(reader, "sqlserver", "Reading an ungranted table", `SELECT secret_marker FROM ${denied}`);
    stage = "denied-write";
    await expectDenied(reader, "sqlserver", "INSERT", `INSERT INTO ${allowed} VALUES (2, N'must-not-write')`);
    await expectDenied(reader, "sqlserver", "UPDATE", `UPDATE ${allowed} SET marker = N'must-not-write' WHERE id = 1`);
    await expectDenied(reader, "sqlserver", "DELETE", `DELETE FROM ${allowed} WHERE id = 1`);
    stage = "denied-ddl";
    await expectDenied(reader, "sqlserver", "CREATE TABLE", "CREATE TABLE dbo.must_not_create (id int)");

    stage = "unchanged-state";
    const visibleState = await admin.query(`SELECT id AS [id], marker AS [marker] FROM ${allowed} ORDER BY id`);
    const privateState = await admin.query(`SELECT id AS [id], secret_marker AS [secret_marker] FROM ${denied} ORDER BY id`);
    assert.deepEqual(visibleState.rows, [{ id: 1, marker: "allowed-sentinel" }]);
    assert.deepEqual(privateState.rows, [{ id: 1, secret_marker: "private-sentinel" }]);
  } catch (error) {
    failure = sanitizedFailure(stage, error);
  } finally {
    const allowed = `${quoteSqlServerIdentifier("dbo")}.${quoteSqlServerIdentifier(allowedTable)}`;
    const denied = `${quoteSqlServerIdentifier("dbo")}.${quoteSqlServerIdentifier(deniedTable)}`;
    if (allowedCreated) {
      try { await admin.query(`DROP TABLE IF EXISTS ${allowed}`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-allowed-table", error); }
    }
    if (deniedCreated) {
      try { await admin.query(`DROP TABLE IF EXISTS ${denied}`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-denied-table", error); }
    }
    if (userCreated) {
      try { await admin.query(`DROP USER ${quoteSqlServerIdentifier(user)}`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-user", error); }
    }
    if (loginCreated) {
      try { await admin.query(`DROP LOGIN ${quoteSqlServerIdentifier(login)}`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-login", error); }
    }
    try {
      const tables = await admin.query(
        "SELECT COUNT(*) AS remaining_tables FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME IN (@p1, @p2)",
        [allowedTable, deniedTable],
      );
      if (Number(tables.rows[0]?.remaining_tables) !== 0) cleanupFailure ??= { stage: "verify-tables-removed" };
      const principals = await admin.query(
        "SELECT COUNT(*) AS remaining_users FROM sys.database_principals WHERE name = @p1",
        [user],
      );
      if (Number(principals.rows[0]?.remaining_users) !== 0) cleanupFailure ??= { stage: "verify-user-removed" };
      const logins = await admin.query("SELECT COUNT(*) AS remaining_logins FROM sys.server_principals WHERE name = @p1", [login]);
      if (Number(logins.rows[0]?.remaining_logins) !== 0) cleanupFailure ??= { stage: "verify-login-removed" };
    } catch (error) {
      cleanupFailure ??= sanitizedFailure("cleanup-verify", error);
    }
  }

  return failure || cleanupFailure
    ? { ok: false, engine: "sqlserver", failure, cleanupFailure, secretsLogged: false }
    : {
      ok: true,
      engine: "sqlserver",
      database: "project-isolated dbstudio_test",
      allowed: ["SELECT on one granted synthetic table"],
      denied: ["SELECT on an ungranted table", "INSERT", "UPDATE", "DELETE", "CREATE TABLE"],
      fixturesUnchanged: true,
      fixturesRemoved: true,
      temporaryLoginAndUserRemoved: true,
      passwordLogged: false,
    };
}

async function verifyOracle() {
  const host = process.env.ORACLE_HOST || dockerEnv.ORACLE_HOST || "127.0.0.1";
  const port = Number(process.env.ORACLE_PORT || dockerEnv.ORACLE_PORT || "21521");
  const serviceName = required("ORACLE_SERVICE_NAME", process.env.DBSTUDIO_ORACLE_SERVICE || dockerEnv.DBSTUDIO_ORACLE_SERVICE || "FREEPDB1");
  const adminUser = required("ORACLE_USER", process.env.DBSTUDIO_ORACLE_USER || dockerEnv.DBSTUDIO_ORACLE_USER || "SYSTEM").toUpperCase();
  assert.equal(host, "127.0.0.1", "Oracle must use the authorized local test service.");
  assert.equal(port, 21521, "Oracle must use its project test port.");
  assert.equal(serviceName.toUpperCase(), "FREEPDB1", "Oracle must use the project test PDB.");

  const suffix = randomBytes(8).toString("hex").toUpperCase();
  const user = `DBS_AR_${suffix}`;
  const allowedTable = `AI_RO_ALLOW_${suffix}`;
  const deniedTable = `AI_RO_PRIVATE_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const connectString = `//${host}:${port}/${serviceName}`;
  const admin = CoreService.fromOracleConfig({
    user: adminUser,
    password: required("ORACLE_PASSWORD"),
    connectString,
    connectTimeout: 10,
    callTimeout: 8_000,
  });
  let userCreated = false;
  let allowedCreated = false;
  let deniedCreated = false;
  let stage = "preflight";
  let failure;
  let cleanupFailure;

  try {
    await admin.query("SELECT 1 AS health FROM dual");
    stage = "create-user";
    await admin.query(`CREATE USER ${quoteOracleIdentifier(user)} IDENTIFIED BY ${quoteOracleIdentifier(password)}`);
    userCreated = true;
    await admin.query(`GRANT CREATE SESSION TO ${quoteOracleIdentifier(user)}`);

    const allowed = `${quoteOracleIdentifier(adminUser)}.${quoteOracleIdentifier(allowedTable)}`;
    const denied = `${quoteOracleIdentifier(adminUser)}.${quoteOracleIdentifier(deniedTable)}`;
    stage = "create-fixtures";
    await admin.query(`CREATE TABLE ${allowed} (id NUMBER PRIMARY KEY, marker VARCHAR2(64) NOT NULL)`);
    allowedCreated = true;
    await admin.query(`CREATE TABLE ${denied} (id NUMBER PRIMARY KEY, secret_marker VARCHAR2(64) NOT NULL)`);
    deniedCreated = true;
    await admin.query(`INSERT INTO ${allowed} VALUES (1, 'allowed-sentinel')`);
    await admin.query(`INSERT INTO ${denied} VALUES (1, 'private-sentinel')`);
    await admin.query(`GRANT SELECT ON ${allowed} TO ${quoteOracleIdentifier(user)}`);

    const reader = CoreService.fromOracleConfig({ user, password, connectString, connectTimeout: 10, callTimeout: 8_000 });
    stage = "allowed-read";
    const visible = await reader.query(`SELECT id AS "id", marker AS "marker" FROM ${allowed}`);
    assert.deepEqual(visible.rows, [{ id: 1, marker: "allowed-sentinel" }]);

    stage = "denied-read";
    await expectDenied(reader, "oracle", "Reading an ungranted table", `SELECT secret_marker FROM ${denied}`);
    stage = "denied-write";
    await expectDenied(reader, "oracle", "INSERT", `INSERT INTO ${allowed} VALUES (2, 'must-not-write')`);
    await expectDenied(reader, "oracle", "UPDATE", `UPDATE ${allowed} SET marker = 'must-not-write' WHERE id = 1`);
    await expectDenied(reader, "oracle", "DELETE", `DELETE FROM ${allowed} WHERE id = 1`);
    stage = "denied-ddl";
    await expectDenied(reader, "oracle", "CREATE TABLE", "CREATE TABLE MUST_NOT_CREATE (id NUMBER)");

    stage = "unchanged-state";
    const visibleState = await admin.query(`SELECT id AS "id", marker AS "marker" FROM ${allowed} ORDER BY id`);
    const privateState = await admin.query(`SELECT id AS "id", secret_marker AS "secret_marker" FROM ${denied} ORDER BY id`);
    assert.deepEqual(visibleState.rows, [{ id: 1, marker: "allowed-sentinel" }]);
    assert.deepEqual(privateState.rows, [{ id: 1, secret_marker: "private-sentinel" }]);
  } catch (error) {
    failure = sanitizedFailure(stage, error);
  } finally {
    const allowed = `${quoteOracleIdentifier(adminUser)}.${quoteOracleIdentifier(allowedTable)}`;
    const denied = `${quoteOracleIdentifier(adminUser)}.${quoteOracleIdentifier(deniedTable)}`;
    if (allowedCreated) {
      try { await admin.query(`DROP TABLE ${allowed} PURGE`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-allowed-table", error); }
    }
    if (deniedCreated) {
      try { await admin.query(`DROP TABLE ${denied} PURGE`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-denied-table", error); }
    }
    if (userCreated) {
      try { await admin.query(`DROP USER ${quoteOracleIdentifier(user)} CASCADE`); }
      catch (error) { cleanupFailure ??= sanitizedFailure("drop-user", error); }
    }
    try {
      const users = await admin.query(
        'SELECT COUNT(*) AS "remaining_users" FROM all_users WHERE username = :1',
        [user],
      );
      if (Number(users.rows[0]?.remaining_users) !== 0) cleanupFailure ??= { stage: "verify-user-removed" };
      const tables = await admin.query(
        'SELECT COUNT(*) AS "remaining_tables" FROM all_tables WHERE owner = :1 AND table_name IN (:2, :3)',
        [adminUser, allowedTable, deniedTable],
      );
      if (Number(tables.rows[0]?.remaining_tables) !== 0) cleanupFailure ??= { stage: "verify-tables-removed" };
    } catch (error) {
      cleanupFailure ??= sanitizedFailure("cleanup-verify", error);
    }
  }

  return failure || cleanupFailure
    ? { ok: false, engine: "oracle", failure, cleanupFailure, secretsLogged: false }
    : {
      ok: true,
      engine: "oracle",
      pdb: "project-isolated FREEPDB1",
      allowed: ["SELECT on one granted synthetic table"],
      denied: ["SELECT on an ungranted table", "INSERT", "UPDATE", "DELETE", "CREATE TABLE"],
      fixturesUnchanged: true,
      fixturesRemoved: true,
      temporaryUserRemoved: true,
      passwordLogged: false,
    };
}

const results = [await verifySqlServer(), await verifyOracle()];
const failed = results.filter((result) => !result.ok);
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, scenario: "sqlserver-oracle-ai-least-privilege-boundary", results })}\n`);
if (failed.length) process.exitCode = 1;
