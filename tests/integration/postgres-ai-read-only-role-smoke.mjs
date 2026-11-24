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
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteQualifiedIdentifier(value) {
  return value.split(".").map(quoteIdentifier).join(".");
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const dockerEnv = readDockerEnv();
const host = process.env.DBSTUDIO_REPAIR_HOST || "127.0.0.1";
const port = Number(process.env.DBSTUDIO_POSTGIS_PORT || dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432");
const database = required("DBSTUDIO_PG_DATABASE", "dbstudio_test");
assert.equal(host, "127.0.0.1", "This integration only permits the authorized local PostgreSQL service.");
assert.equal(port, 25432, "This integration only permits the project PostGIS test port.");
assert.equal(database, "dbstudio_test", "This integration only permits the project test database.");

const suffix = randomBytes(8).toString("hex");
const role = `ai_ro_${suffix}`;
const schema = `ai_perm_${suffix}`;
const allowedTable = `${schema}.allowed_rows`;
const deniedTable = `${schema}.private_rows`;
const rolePassword = randomBytes(24).toString("base64url");
const admin = CoreService.fromPostgresConfig({
  host,
  port,
  database,
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: required("DBSTUDIO_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 8_000,
});

let roleCreated = false;
let schemaCreated = false;
let stage = "preflight";
let failure;
let cleanupFailure;
try {
  const health = await admin.queryPostgres("SELECT current_database() AS database, current_user AS role");
  assert.equal(health.rows[0]?.database, database);

  stage = "role-create";
  await admin.queryPostgres(
    `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(rolePassword)} `
    + "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT",
  );
  roleCreated = true;

  stage = "schema-create";
  await admin.queryPostgres(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  schemaCreated = true;
  await admin.queryPostgres(`REVOKE ALL ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC`);
  await admin.queryPostgres(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`);
  await admin.queryPostgres(`CREATE TABLE ${quoteQualifiedIdentifier(allowedTable)} (id integer PRIMARY KEY, marker text NOT NULL)`);
  await admin.queryPostgres(`CREATE TABLE ${quoteQualifiedIdentifier(deniedTable)} (id integer PRIMARY KEY, secret_marker text NOT NULL)`);
  await admin.queryPostgres(`INSERT INTO ${quoteQualifiedIdentifier(allowedTable)} VALUES (1, 'allowed-sentinel')`);
  await admin.queryPostgres(`INSERT INTO ${quoteQualifiedIdentifier(deniedTable)} VALUES (1, 'private-sentinel')`);
  await admin.queryPostgres(`GRANT SELECT ON TABLE ${quoteQualifiedIdentifier(allowedTable)} TO ${quoteIdentifier(role)}`);

  stage = "role-attributes";
  const roleState = await admin.queryPostgres(
    "SELECT rolsuper AS superuser, rolcreatedb AS can_create_database, "
    + "rolcreaterole AS can_create_role, rolreplication AS can_replicate "
    + "FROM pg_roles WHERE rolname = $1",
    [role],
  );
  assert.deepEqual(roleState.rows[0], {
    superuser: false,
    can_create_database: false,
    can_create_role: false,
    can_replicate: false,
  });

  stage = "allowed-read";
  const reader = CoreService.fromPostgresConfig({
    host,
    port,
    database,
    user: role,
    password: rolePassword,
    ssl: false,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  const visible = await reader.queryPostgres(`SELECT id, marker FROM ${quoteQualifiedIdentifier(allowedTable)}`);
  assert.deepEqual(visible.rows, [{ id: 1, marker: "allowed-sentinel" }]);

  async function expectDenied(label, sql) {
    try {
      await reader.queryPostgres(sql);
    } catch (error) {
      assert.equal(error?.code, "42501", `${label} must fail with PostgreSQL insufficient_privilege.`);
      return;
    }
    assert.fail(`${label} unexpectedly succeeded for the limited role.`);
  }

  stage = "denied-read";
  await expectDenied("Reading an ungranted table", `SELECT secret_marker FROM ${quoteQualifiedIdentifier(deniedTable)}`);
  stage = "denied-write";
  await expectDenied("INSERT", `INSERT INTO ${quoteQualifiedIdentifier(allowedTable)} VALUES (2, 'must-not-write')`);
  await expectDenied("UPDATE", `UPDATE ${quoteQualifiedIdentifier(allowedTable)} SET marker = 'must-not-write' WHERE id = 1`);
  await expectDenied("DELETE", `DELETE FROM ${quoteQualifiedIdentifier(allowedTable)} WHERE id = 1`);
  stage = "denied-ddl";
  await expectDenied("CREATE TABLE", `CREATE TABLE ${quoteIdentifier(schema)}.must_not_create (id integer)`);

  stage = "unchanged-state";
  const state = await admin.queryPostgres(`SELECT id, marker FROM ${quoteQualifiedIdentifier(allowedTable)} ORDER BY id`);
  assert.deepEqual(state.rows, [{ id: 1, marker: "allowed-sentinel" }]);
} catch (error) {
  failure = {
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    databaseErrorCode: error?.code,
  };
} finally {
  if (schemaCreated) {
    try {
      await admin.queryPostgres(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } catch (error) {
      cleanupFailure ??= { stage: "drop-schema", databaseErrorCode: error?.code };
    }
  }
  if (roleCreated) {
    try {
      await admin.queryPostgres(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    } catch (error) {
      cleanupFailure ??= { stage: "drop-role", databaseErrorCode: error?.code };
    }
  }
  try {
    const cleanupState = await admin.queryPostgres(
      "SELECT to_regnamespace($1) IS NULL AS schema_removed, "
      + "NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_removed",
      [schema, role],
    );
    if (cleanupState.rows[0]?.schema_removed !== true || cleanupState.rows[0]?.role_removed !== true) {
      cleanupFailure ??= { stage: "cleanup-verify" };
    }
  } catch (error) {
    cleanupFailure ??= { stage: "cleanup-verify", databaseErrorCode: error?.code };
  }
}

if (failure || cleanupFailure) {
  process.stderr.write(`${JSON.stringify({ ok: false, failure, cleanupFailure, secretsLogged: false })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    scenario: "postgres-ai-least-privilege-boundary",
    database: "project-isolated dbstudio_test",
    roleFlags: { superuser: false, createDatabase: false, createRole: false, replication: false },
    allowed: ["SELECT on one granted synthetic table"],
    denied: ["SELECT on an ungranted table", "INSERT", "UPDATE", "DELETE", "CREATE TABLE"],
    writeFixtureUnchanged: true,
    fixtureRemoved: true,
    temporaryRoleRemoved: true,
    passwordLogged: false,
  })}\n`);
}
