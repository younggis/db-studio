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

function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

function quoteIdentifier(value) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const dockerEnv = readDockerEnv();
const engines = [
  {
    name: "mysql",
    envPrefix: "MYSQL",
    defaultPort: 23_306,
    createService: (config) => CoreService.fromMySqlConfig(config),
  },
  {
    name: "mariadb",
    envPrefix: "MARIADB",
    defaultPort: 23_307,
    createService: (config) => CoreService.fromMariaDbConfig(config),
  },
];

async function verifyEngine(engine) {
  const prefix = engine.envPrefix;
  const host = process.env[`${prefix}_HOST`] || dockerEnv[`${prefix}_HOST`] || "127.0.0.1";
  const port = Number(process.env[`${prefix}_PORT`] || dockerEnv[`${prefix}_PORT`] || engine.defaultPort);
  const database = required(`${prefix}_DATABASE`, "dbstudio_test");
  assert.equal(host, "127.0.0.1", `${engine.name} must use the authorized local test service.`);
  assert.equal(port, engine.defaultPort, `${engine.name} must use its project test port.`);
  assert.equal(database, "dbstudio_test", `${engine.name} must use the project test database.`);

  const suffix = randomBytes(8).toString("hex");
  const role = `dbs_ar_${suffix}`;
  const allowedTable = `ai_ro_allow_${suffix}`;
  const deniedTable = `ai_ro_private_${suffix}`;
  const rolePassword = randomBytes(24).toString("base64url");
  const admin = engine.createService({
    host,
    port,
    database,
    user: required(`${prefix}_ROOT_USER`, "root"),
    password: required(`${prefix}_ROOT_PASSWORD`),
    connectTimeout: 8_000,
  });
  let roleCreated = false;
  let allowedTableCreated = false;
  let deniedTableCreated = false;
  let stage = "preflight";
  let failure;
  let cleanupFailure;

  try {
    const health = await admin.query("SELECT DATABASE() AS database_name, CURRENT_USER() AS account_name");
    assert.equal(health.rows[0]?.database_name, database);

    stage = "create-role";
    await admin.query(
      `CREATE USER ${quoteLiteral(role)}@'%' IDENTIFIED BY ${quoteLiteral(rolePassword)}`,
    );
    roleCreated = true;

    stage = "create-fixtures";
    await admin.query(
      `CREATE TABLE ${quoteIdentifier(allowedTable)} (id integer PRIMARY KEY, marker varchar(64) NOT NULL)`,
    );
    allowedTableCreated = true;
    await admin.query(
      `CREATE TABLE ${quoteIdentifier(deniedTable)} (id integer PRIMARY KEY, secret_marker varchar(64) NOT NULL)`,
    );
    deniedTableCreated = true;
    await admin.query(`INSERT INTO ${quoteIdentifier(allowedTable)} VALUES (1, 'allowed-sentinel')`);
    await admin.query(`INSERT INTO ${quoteIdentifier(deniedTable)} VALUES (1, 'private-sentinel')`);
    await admin.query(
      `GRANT SELECT ON ${quoteIdentifier(database)}.${quoteIdentifier(allowedTable)} `
      + `TO ${quoteLiteral(role)}@'%'`,
    );

    const reader = engine.createService({
      host,
      port,
      database,
      user: role,
      password: rolePassword,
      connectTimeout: 8_000,
    });
    stage = "allowed-read";
    const visible = await reader.query(`SELECT id, marker FROM ${quoteIdentifier(allowedTable)}`);
    assert.deepEqual(visible.rows, [{ id: 1, marker: "allowed-sentinel" }]);

    async function expectDenied(label, sql) {
      try {
        await reader.query(sql);
      } catch (error) {
        assert.ok(error?.code, `${label} must fail with a server permission error.`);
        return;
      }
      assert.fail(`${label} unexpectedly succeeded for the limited ${engine.name} role.`);
    }

    stage = "denied-read";
    await expectDenied("Reading an ungranted table", `SELECT secret_marker FROM ${quoteIdentifier(deniedTable)}`);
    stage = "denied-write";
    await expectDenied("INSERT", `INSERT INTO ${quoteIdentifier(allowedTable)} VALUES (2, 'must-not-write')`);
    await expectDenied("UPDATE", `UPDATE ${quoteIdentifier(allowedTable)} SET marker = 'must-not-write' WHERE id = 1`);
    await expectDenied("DELETE", `DELETE FROM ${quoteIdentifier(allowedTable)} WHERE id = 1`);
    stage = "denied-ddl";
    await expectDenied("CREATE TABLE", "CREATE TABLE must_not_create (id integer)");

    stage = "unchanged-state";
    const allowedState = await admin.query(`SELECT id, marker FROM ${quoteIdentifier(allowedTable)} ORDER BY id`);
    const deniedState = await admin.query(`SELECT id, secret_marker FROM ${quoteIdentifier(deniedTable)} ORDER BY id`);
    assert.deepEqual(allowedState.rows, [{ id: 1, marker: "allowed-sentinel" }]);
    assert.deepEqual(deniedState.rows, [{ id: 1, secret_marker: "private-sentinel" }]);
  } catch (error) {
    failure = {
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      databaseErrorCode: error?.code,
    };
  } finally {
    if (allowedTableCreated) {
      try { await admin.query(`DROP TABLE IF EXISTS ${quoteIdentifier(allowedTable)}`); }
      catch (error) { cleanupFailure ??= { stage: "drop-allowed-table", databaseErrorCode: error?.code }; }
    }
    if (deniedTableCreated) {
      try { await admin.query(`DROP TABLE IF EXISTS ${quoteIdentifier(deniedTable)}`); }
      catch (error) { cleanupFailure ??= { stage: "drop-denied-table", databaseErrorCode: error?.code }; }
    }
    if (roleCreated) {
      try { await admin.query(`DROP USER IF EXISTS ${quoteLiteral(role)}@'%'`); }
      catch (error) { cleanupFailure ??= { stage: "drop-role", databaseErrorCode: error?.code }; }
    }
    try {
      const remaining = await admin.query(
        "SELECT COUNT(*) AS remaining_tables FROM information_schema.tables "
        + "WHERE table_schema = ? AND table_name IN (?, ?)",
        [database, allowedTable, deniedTable],
      );
      if (Number(remaining.rows[0]?.remaining_tables) !== 0) cleanupFailure ??= { stage: "verify-tables-removed" };
      const users = await admin.query(
        "SELECT COUNT(*) AS remaining_users FROM mysql.user WHERE user = ?",
        [role],
      );
      if (Number(users.rows[0]?.remaining_users) !== 0) cleanupFailure ??= { stage: "verify-role-removed" };
    } catch (error) {
      cleanupFailure ??= { stage: "cleanup-verify", databaseErrorCode: error?.code };
    }
  }

  return failure || cleanupFailure
    ? { ok: false, engine: engine.name, failure, cleanupFailure, secretsLogged: false }
    : {
      ok: true,
      engine: engine.name,
      database: "project-isolated dbstudio_test",
      allowed: ["SELECT on one granted synthetic table"],
      denied: ["SELECT on an ungranted table", "INSERT", "UPDATE", "DELETE", "CREATE TABLE"],
      fixturesUnchanged: true,
      fixturesRemoved: true,
      temporaryRoleRemoved: true,
      passwordLogged: false,
    };
}

const results = [];
for (const engine of engines) results.push(await verifyEngine(engine));
const failed = results.filter((result) => !result.ok);
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, scenario: "mysql-family-ai-least-privilege-boundary", results })}\n`);
if (failed.length) process.exitCode = 1;
