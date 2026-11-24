import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreService } from "../../packages/core/dist/index.js";

const suffix = randomBytes(8).toString("hex");
const directory = mkdtempSync(join(tmpdir(), "dbstudio-sqlite-readonly-"));
const path = join(directory, `ai_permissions_${suffix}.sqlite`);
const table = `ai_ro_allow_${suffix}`;
const admin = CoreService.fromSqliteConfig({ path });
const reader = CoreService.fromSqliteConfig({ path, readOnly: true });
let stage = "create-fixture";
let failure;
let cleanupFailure;

async function expectReadOnly(label, sql) {
  try {
    await reader.query(sql);
  } catch (error) {
    assert.ok(
      error?.errcode === 8 || /readonly|read-only/i.test(String(error?.message ?? "")),
      `${label} must fail with SQLite's read-only database error.`,
    );
    return;
  }
  assert.fail(`${label} unexpectedly succeeded on a read-only SQLite connection.`);
}

try {
  await admin.query(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`);
  await admin.query(`INSERT INTO "${table}" VALUES (1, 'allowed-sentinel')`);

  stage = "allowed-read";
  const visible = await reader.query(`SELECT id, marker FROM "${table}"`);
  assert.equal(visible.rows.length, 1);
  assert.equal(visible.rows[0]?.id, 1);
  assert.equal(visible.rows[0]?.marker, "allowed-sentinel");

  stage = "denied-insert";
  await expectReadOnly("INSERT", `INSERT INTO "${table}" VALUES (2, 'must-not-write')`);
  stage = "denied-update";
  await expectReadOnly("UPDATE", `UPDATE "${table}" SET marker = 'must-not-write' WHERE id = 1`);
  stage = "denied-delete";
  await expectReadOnly("DELETE", `DELETE FROM "${table}" WHERE id = 1`);
  stage = "denied-ddl";
  await expectReadOnly("CREATE TABLE", "CREATE TABLE must_not_create (id INTEGER)");

  stage = "unchanged-state";
  const state = await admin.query(`SELECT id, marker FROM "${table}" ORDER BY id`);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]?.id, 1);
  assert.equal(state.rows[0]?.marker, "allowed-sentinel");
} catch (error) {
  failure = {
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    databaseErrorCode: error?.code,
    sqliteErrorCode: error?.errcode,
  };
} finally {
  try { rmSync(path, { force: true }); }
  catch (error) { cleanupFailure ??= { stage: "remove-database-file", errorName: error instanceof Error ? error.name : "UnknownError" }; }
  for (const suffixName of ["-journal", "-wal", "-shm"]) {
    try { rmSync(`${path}${suffixName}`, { force: true }); }
    catch (error) { cleanupFailure ??= { stage: "remove-sqlite-sidecar", errorName: error instanceof Error ? error.name : "UnknownError" }; }
  }
  try { rmdirSync(directory); }
  catch (error) { cleanupFailure ??= { stage: "remove-temp-directory", errorName: error instanceof Error ? error.name : "UnknownError" }; }
}

if (failure || cleanupFailure) {
  process.stdout.write(`${JSON.stringify({ ok: false, scenario: "sqlite-ai-read-only-file-boundary", failure, cleanupFailure })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    scenario: "sqlite-ai-read-only-file-boundary",
    allowed: ["SELECT from the authorized temporary database file"],
    denied: ["INSERT", "UPDATE", "DELETE", "CREATE TABLE"],
    fixtureUnchanged: true,
    temporaryDatabaseRemoved: true,
  })}\n`);
}
