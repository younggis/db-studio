import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = path.join(root, "docker", ".env");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(["'])(.*)\1$/, "$2")]));
}

function required(env, name) {
  const value = env[name];
  assert.ok(value, `Set ${name} in docker/.env for the isolated database test service.`);
  return value;
}

const env = parseEnvFile(envPath);
const services = {
  postgres: CoreService.fromPostgresConfig({
    host: "127.0.0.1", port: Number(env.DBSTUDIO_POSTGIS_PORT || 25432),
    database: required(env, "DBSTUDIO_PG_DATABASE"), user: required(env, "DBSTUDIO_PG_USER"),
    password: required(env, "DBSTUDIO_PG_PASSWORD"), ssl: false, connectionTimeoutMillis: 8_000,
  }),
  mysql: CoreService.fromMySqlConfig({
    host: env.MYSQL_HOST || "127.0.0.1", port: Number(env.MYSQL_PORT || 23306),
    database: required(env, "MYSQL_DATABASE"), user: required(env, "MYSQL_USER"),
    password: required(env, "MYSQL_PASSWORD"), connectTimeout: 8_000,
  }),
  mariadb: CoreService.fromMariaDbConfig({
    host: env.MARIADB_HOST || "127.0.0.1", port: Number(env.MARIADB_PORT || 23307),
    database: required(env, "MARIADB_DATABASE"), user: required(env, "MARIADB_USER"),
    password: required(env, "MARIADB_PASSWORD"), connectTimeout: 8_000,
  }),
  sqlserver: CoreService.fromSqlServerConfig({
    server: "127.0.0.1", port: Number(env.SQLSERVER_PORT || 21433), database: "dbstudio_test",
    user: "sa", password: required(env, "SQLSERVER_SA_PASSWORD"), encrypt: true,
    trustServerCertificate: true, connectionTimeout: 15_000, requestTimeout: 30_000,
  }),
  oracle: CoreService.fromOracleConfig({
    user: (env.ORACLE_USER || "SYSTEM").toUpperCase(), password: required(env, "ORACLE_PASSWORD"),
    connectString: `//127.0.0.1:${Number(env.ORACLE_PORT || 21521)}/${env.ORACLE_SERVICE_NAME || "FREEPDB1"}`,
    connectTimeout: 15, callTimeout: 30_000,
  }),
  sqlite: CoreService.fromSqliteConfig({ path: ":memory:" }),
};

const rowCount = 900;
const batchSize = 128;
const queries = {
  postgres: `SELECT value AS id FROM generate_series(1, ${rowCount}) AS value`,
  mysql: `WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < ${rowCount}) SELECT id FROM seq`,
  mariadb: `WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < ${rowCount}) SELECT id FROM seq`,
  sqlserver: `WITH seq AS (SELECT CAST(1 AS INT) AS id UNION ALL SELECT id + 1 FROM seq WHERE id < ${rowCount}) SELECT id FROM seq OPTION (MAXRECURSION 0)`,
  oracle: `SELECT LEVEL AS id FROM dual CONNECT BY LEVEL <= ${rowCount}`,
  sqlite: `WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < ${rowCount}) SELECT id FROM seq`,
};

function idFrom(row) {
  const key = Object.keys(row).find((name) => name.toLowerCase() === "id");
  assert.ok(key, "streamed row contains the id column");
  return Number(row[key]);
}

const results = [];
for (const [engine, service] of Object.entries(services)) {
  console.error(`Checking ${engine} query stream...`);
  const batches = [];
  for await (const batch of service.queryStream(queries[engine], [], { batchSize })) {
    assert.ok(batch.rows.length <= batchSize, `${engine}: batch size is bounded`);
    assert.equal(batch.rowCount, batch.rows.length, `${engine}: batch row count is accurate`);
    assert.ok(batch.columns.some((column) => typeof column === "string" && column.toLowerCase() === "id"), `${engine}: id column metadata is present`);
    batches.push(batch);
  }
  const ids = batches.flatMap((batch) => batch.rows.map(idFrom));
  assert.equal(ids.length, rowCount, `${engine}: all generated rows are returned`);
  assert.deepEqual(ids, Array.from({ length: rowCount }, (_, index) => index + 1), `${engine}: row order is preserved`);
  assert.equal(batches.length, Math.ceil(rowCount / batchSize), `${engine}: rows are delivered in bounded batches`);

  const controller = new AbortController();
  const iterator = service.queryStream(queries[engine], [], { batchSize, signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false, `${engine}: cancellation query yields an initial batch`);
  assert.equal(first.value.rows.length, batchSize, `${engine}: initial cancellation batch has expected size`);
  controller.abort();
  await assert.rejects(iterator.next(), undefined, `${engine}: cancellation rejects the active query stream`);
  results.push({ engine, streamedRows: ids.length, batches: batches.length, cancelledAfter: first.value.rows.length });
}

console.log(JSON.stringify({ ok: true, engineCount: results.length, rowCount, batchSize, results }, null, 2));
