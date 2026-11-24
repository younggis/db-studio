import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CoreService } from "../../packages/core/dist/index.js";

function required(name, fallback) {
  const value = process.env[name] || fallback;
  assert.ok(value, `Set ${name} before running this integration.`);
  return value;
}

function port(name, fallback) {
  const value = Number(required(name, fallback));
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 65_535, `${name} must be a valid TCP port.`);
  return value;
}

const pg = {
  host: required("DBSTUDIO_TRANSFER_PG_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_PG_PORT", "25432"),
  database: required("DBSTUDIO_TRANSFER_PG_DATABASE"),
  user: required("DBSTUDIO_TRANSFER_PG_USER"),
  password: required("DBSTUDIO_TRANSFER_PG_PASSWORD"),
};
const mysql = {
  host: required("DBSTUDIO_TRANSFER_MYSQL_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_MYSQL_PORT", "23306"),
  database: required("DBSTUDIO_TRANSFER_MYSQL_DATABASE"),
  user: required("DBSTUDIO_TRANSFER_MYSQL_USER"),
  password: required("DBSTUDIO_TRANSFER_MYSQL_PASSWORD"),
};
const mariadb = {
  host: required("DBSTUDIO_TRANSFER_MARIADB_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_MARIADB_PORT", "23307"),
  database: required("DBSTUDIO_TRANSFER_MARIADB_DATABASE"),
  user: required("DBSTUDIO_TRANSFER_MARIADB_USER"),
  password: required("DBSTUDIO_TRANSFER_MARIADB_PASSWORD"),
};
const sqlServer = {
  host: required("DBSTUDIO_TRANSFER_SQLSERVER_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_SQLSERVER_PORT", "21433"),
  database: required("DBSTUDIO_TRANSFER_SQLSERVER_DATABASE", "dbstudio_test"),
  user: required("DBSTUDIO_TRANSFER_SQLSERVER_USER", "sa"),
  password: required("DBSTUDIO_TRANSFER_SQLSERVER_PASSWORD"),
};
const oracle = {
  host: required("DBSTUDIO_TRANSFER_ORACLE_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_ORACLE_PORT", "21521"),
  service: required("DBSTUDIO_TRANSFER_ORACLE_SERVICE", "FREEPDB1"),
  user: required("DBSTUDIO_TRANSFER_ORACLE_USER", "SYSTEM").toUpperCase(),
  password: required("DBSTUDIO_TRANSFER_ORACLE_PASSWORD"),
};

const runId = randomBytes(5).toString("hex");
const sqlitePath = `.cache/table-import-${runId}.sqlite`;
const services = {
  postgres: CoreService.fromPostgresConfig({ ...pg, ssl: false, connectionTimeoutMillis: 8_000 }),
  mysql: CoreService.fromMySqlConfig({ ...mysql, connectTimeout: 8_000 }),
  mariadb: CoreService.fromMariaDbConfig({ ...mariadb, connectTimeout: 8_000 }),
  sqlite: CoreService.fromSqliteConfig({ path: sqlitePath }),
  sqlserver: CoreService.fromSqlServerConfig({
    server: sqlServer.host, port: sqlServer.port, database: sqlServer.database,
    user: sqlServer.user, password: sqlServer.password, encrypt: true,
    trustServerCertificate: true, connectionTimeout: 15_000, requestTimeout: 30_000,
  }),
  oracle: CoreService.fromOracleConfig({
    user: oracle.user, password: oracle.password,
    connectString: `//${oracle.host}:${oracle.port}/${oracle.service}`,
    connectTimeout: 15, callTimeout: 30_000,
  }),
};
const schemas = {
  postgres: "public", mysql: mysql.database, mariadb: mariadb.database,
  sqlite: "main", sqlserver: "dbo", oracle: oracle.user,
};
const quote = (engine, value) => engine === "mysql" || engine === "mariadb"
  ? `\`${value.replaceAll("`", "``")}\``
  : engine === "sqlserver"
    ? `[${value.replaceAll("]", "]]" )}]`
    : `"${value.replaceAll('"', '""')}"`;
const table = `dbstudio_import_${runId}`;
const data = {
  columns: ["id", "label", "active", "score", "metadata", "empty", "created_day", "created_at", "payload"],
  rows: [
    {
      id: 1, label: "中文测试", active: true, score: 1.25, metadata: { source: "smoke", rank: 1 }, empty: null,
      created_day: new Date("2026-01-02T00:00:00.000Z"), created_at: new Date("2026-01-02T03:04:05.000Z"), payload: new Uint8Array([0, 255, 16, 128]),
    },
    {
      id: 2, label: "second", active: false, score: 3, metadata: { source: "smoke", rank: 2 }, empty: null,
      created_day: new Date("2026-02-03T00:00:00.000Z"), created_at: new Date("2026-02-03T06:07:08.000Z"), payload: new Uint8Array([255, 0, 165, 90]),
    },
  ],
};

const completed = [];
try {
  for (const [engine, service] of Object.entries(services)) {
    const schema = schemas[engine];
    const qualified = `${quote(engine, schema)}.${quote(engine, table)}`;
    try {
      const created = await service.createTableFromRows(table, data, schema);
      assert.equal(created.insertedRows, 2, `${engine} inserted row count`);
      assert.deepEqual(Object.values(created.inferredTypes), ["integer", "text", "boolean", "real", "json", "text", "date", "datetime", "binary"]);
      const result = await service.query(`SELECT COUNT(*) AS ${quote(engine, "count_value")} FROM ${qualified}`);
      assert.equal(Number(result.rows[0]?.count_value ?? result.rows[0]?.COUNT_VALUE), 2, `${engine} stored row count`);
      const values = await service.query(`SELECT ${quote(engine, "id")}, ${quote(engine, "active")} FROM ${qualified} ORDER BY ${quote(engine, "id")}`);
      assert.equal(Number(values.rows[0]?.id), 1, `${engine} first ID`);
      assert.equal(Number(values.rows[1]?.id), 2, `${engine} second ID`);
      completed.push(engine);
    } finally {
      await service.query(`DROP TABLE ${qualified}`).catch(() => undefined);
    }
  }
} finally {
  console.log(`table import smoke passed: ${completed.length}/${Object.keys(services).length} (${completed.join(", ")})`);
}
