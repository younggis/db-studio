import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
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

const postgres = {
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
const sqlitePath = path.resolve(".cache", `table-transfer-${runId}.sqlite`);
mkdirSync(path.dirname(sqlitePath), { recursive: true });
const services = {
  postgres: CoreService.fromPostgresConfig({ ...postgres, ssl: false, connectionTimeoutMillis: 8_000 }),
  mysql: CoreService.fromMySqlConfig({ ...mysql, connectTimeout: 8_000 }),
  mariadb: CoreService.fromMariaDbConfig({ ...mariadb, connectTimeout: 8_000 }),
  sqlserver: CoreService.fromSqlServerConfig({
    server: sqlServer.host,
    port: sqlServer.port,
    database: sqlServer.database,
    user: sqlServer.user,
    password: sqlServer.password,
    encrypt: true,
    trustServerCertificate: true,
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
  }),
  oracle: CoreService.fromOracleConfig({
    user: oracle.user,
    password: oracle.password,
    connectString: `//${oracle.host}:${oracle.port}/${oracle.service}`,
    connectTimeout: 15,
    callTimeout: 30_000,
  }),
  sqlite: CoreService.fromSqliteConfig({ path: sqlitePath }),
};

const schemas = {
  postgres: "public",
  mysql: mysql.database,
  mariadb: mariadb.database,
  sqlserver: "dbo",
  oracle: oracle.user,
  sqlite: "main",
};
const expected = [
  { id: 1, label: "source-one", note: "中文", amount: "1.2500", ratio: 1.23456789012345, payload: "00ff1080", active: true, created_on: "2026-01-02", occurred_at: "2026-01-02T03:04:05.678+08:00", large_integer: "99999999999999999999999999999999999999" },
  { id: 2, label: "source-two", note: null, amount: "-34.5678", ratio: -9876.54321, payload: "ff00a55a", active: false, created_on: "2026-06-10", occurred_at: "2026-06-10T23:59:59.123-05:30", large_integer: "-99999999999999999999999999999999999999" },
  { id: 3, label: "source-three", note: "third page", amount: "0.0001", ratio: 0.000000123456789, payload: "000102fe", active: true, created_on: "2025-12-31", occurred_at: "2025-12-31T00:00:00.000Z", large_integer: "9223372036854775807" },
];
[
  "1234567890123456789012345678.1234567891",
  "-1234567890123456789012345678.9876543219",
  "0.0000000001",
].forEach((value, index) => { expected[index].large_decimal = value; });

function identifier(engine, value) {
  if (engine === "mysql" || engine === "mariadb") return `\`${value.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return `[${value.replaceAll("]", "]]" )}]`;
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(engine, schema, table) {
  return `${identifier(engine, schema)}.${identifier(engine, table)}`;
}

function columnTypes(engine) {
  if (engine === "oracle") return { id: "NUMBER(10)", text: "NVARCHAR2(120)", decimal: "NUMBER(16,4)", ratio: "BINARY_DOUBLE", binary: "RAW(16)", active: "NUMBER(1)", date: "DATE", large_integer: "NUMBER(38,0)", large_decimal: "NUMBER(38,10)" };
  if (engine === "sqlserver") return { id: "INT", text: "NVARCHAR(120)", decimal: "DECIMAL(16,4)", ratio: "FLOAT", binary: "VARBINARY(16)", active: "BIT", date: "DATE", large_integer: "DECIMAL(38,0)", large_decimal: "DECIMAL(38,10)" };
  if (engine === "sqlite") return { id: "INTEGER", text: "TEXT", decimal: "NUMERIC(16,4)", ratio: "REAL", binary: "BLOB", active: "INTEGER", date: "DATE", large_integer: "TEXT", large_decimal: "TEXT" };
  if (engine === "mysql" || engine === "mariadb") return { id: "INT", text: "VARCHAR(120)", decimal: "DECIMAL(16,4)", ratio: "DOUBLE", binary: "VARBINARY(16)", active: "BOOLEAN", date: "DATE", large_integer: "DECIMAL(38,0)", large_decimal: "DECIMAL(38,10)" };
  return { id: "INTEGER", text: "VARCHAR(120)", decimal: "NUMERIC(16,4)", ratio: "DOUBLE PRECISION", binary: "BYTEA", active: "BOOLEAN", date: "DATE", large_integer: "NUMERIC(38,0)", large_decimal: "NUMERIC(38,10)" };
}

function timestampType(engine) {
  if (engine === "oracle") return "TIMESTAMP(3) WITH TIME ZONE";
  if (engine === "sqlserver") return "DATETIMEOFFSET(3)";
  if (engine === "sqlite") return "TEXT";
  if (engine === "mysql" || engine === "mariadb") return "TIMESTAMP(3)";
  return "TIMESTAMP(3) WITH TIME ZONE";
}

function largeIntegerProjection(engine) {
  const column = identifier(engine, engine === "oracle" ? "LARGE_INTEGER" : "large_integer");
  if (engine === "oracle") return `CAST(${column} AS VARCHAR2(100)) AS ${column}`;
  if (engine === "sqlserver") return `CONVERT(varchar(100), ${column}) AS ${column}`;
  if (engine === "mysql" || engine === "mariadb") return `CAST(${column} AS CHAR) AS ${column}`;
  return `CAST(${column} AS TEXT) AS ${column}`;
}

function largeDecimalProjection(engine) {
  const column = identifier(engine, engine === "oracle" ? "LARGE_DECIMAL" : "large_decimal");
  if (engine === "oracle") return `CAST(${column} AS VARCHAR2(100)) AS ${column}`;
  if (engine === "sqlserver") return `CONVERT(varchar(100), ${column}) AS ${column}`;
  if (engine === "mysql" || engine === "mariadb") return `CAST(${column} AS CHAR) AS ${column}`;
  return `CAST(${column} AS TEXT) AS ${column}`;
}

function placeholder(engine, position) {
  if (engine === "postgres") return `$${position}`;
  if (engine === "sqlserver") return `@p${position}`;
  if (engine === "oracle") return `:${position}`;
  return "?";
}

function tableName(engine, prefix, targetEngine, direction) {
  const name = `${prefix}_${runId}_${targetEngine}_${direction}`;
  return engine === "oracle" ? name.toUpperCase() : name.toLowerCase();
}

function readField(row, name) {
  if (Object.hasOwn(row, name)) return row[name];
  return row[name.toUpperCase()];
}

function canonicalDecimalText(value) {
  return String(value).replace(/^([+-]?)\./, (_match, sign) => `${sign}0.`);
}

function readBinaryField(row, name) {
  const value = readField(row, name);
  assert.ok(Buffer.isBuffer(value) || value instanceof Uint8Array, `${name} should be returned as bytes`);
  return Buffer.from(value).toString("hex");
}

function engineDateValue(engine, value) {
  return engine === "oracle" ? new Date(`${value}T00:00:00`) : value;
}

function engineInstantValue(engine, value) {
  return engine === "sqlite" || engine === "sqlserver" ? value : new Date(value);
}

async function transfer({ sourceEngine, targetEngine, direction, explicitMapping = false }) {
  const source = services[sourceEngine];
  const destination = services[targetEngine];
  const sourceTable = tableName(sourceEngine, "dbxfer_s", targetEngine, direction);
  const targetTable = tableName(targetEngine, "dbxfer_t", sourceEngine, direction);
  const sourceSchema = schemas[sourceEngine];
  const targetSchema = schemas[targetEngine];
  const sourceName = qualified(sourceEngine, sourceSchema, sourceTable);
  const targetName = qualified(targetEngine, targetSchema, targetTable);
  const sourceTypes = columnTypes(sourceEngine);
  const targetTypes = columnTypes(targetEngine);
  const targetIdColumn = explicitMapping ? "record_id" : "id";
  const targetLabelColumn = explicitMapping ? "display_label" : "label";
  const columnMappings = explicitMapping ? [
    { sourceColumn: "id", targetColumn: targetIdColumn },
    { sourceColumn: "label", targetColumn: targetLabelColumn },
    { sourceColumn: "note", targetColumn: "note" },
    { sourceColumn: "amount", targetColumn: "amount" },
    { sourceColumn: "ratio", targetColumn: "ratio" },
    { sourceColumn: "payload", targetColumn: "payload" },
    { sourceColumn: "active", targetColumn: "active" },
    { sourceColumn: "created_on", targetColumn: "created_on" },
    { sourceColumn: "occurred_at", targetColumn: "occurred_at" },
    { sourceColumn: "large_integer", targetColumn: "large_integer" },
    { sourceColumn: "large_decimal", targetColumn: "large_decimal" },
  ] : undefined;
  let sourceCreated = false;
  let targetCreated = false;
  let failure;

  try {
    await source.query(`CREATE TABLE ${sourceName} (id ${sourceTypes.id} NOT NULL PRIMARY KEY, label ${sourceTypes.text} NOT NULL, note ${sourceTypes.text} NULL, amount ${sourceTypes.decimal} NOT NULL, ratio ${sourceTypes.ratio} NOT NULL, payload ${sourceTypes.binary} NOT NULL, active ${sourceTypes.active} NOT NULL, created_on ${sourceTypes.date} NOT NULL, occurred_at ${timestampType(sourceEngine)} NOT NULL, large_integer ${sourceTypes.large_integer} NOT NULL, large_decimal ${sourceTypes.large_decimal} NOT NULL)`);
    sourceCreated = true;
    await destination.query(`CREATE TABLE ${targetName} (${identifier(targetEngine, targetIdColumn)} ${targetTypes.id} NOT NULL PRIMARY KEY, ${identifier(targetEngine, targetLabelColumn)} ${targetTypes.text} NOT NULL, note ${targetTypes.text} NULL, amount ${targetTypes.decimal} NOT NULL, ratio ${targetTypes.ratio} NOT NULL, payload ${targetTypes.binary} NOT NULL, active ${targetTypes.active} NOT NULL, created_on ${targetTypes.date} NOT NULL, occurred_at ${timestampType(targetEngine)} NOT NULL, large_integer ${targetTypes.large_integer} NOT NULL, large_decimal ${targetTypes.large_decimal} NOT NULL)`);
    targetCreated = true;

    let position = 0;
    const tuples = expected.map(() => `(${Array.from({ length: 11 }, () => placeholder(sourceEngine, ++position)).join(", ")})`).join(", ");
    const values = expected.flatMap((row) => [
      row.id,
      row.label,
      row.note,
      row.amount,
      row.ratio,
      Buffer.from(row.payload, "hex"),
      row.active,
      engineDateValue(sourceEngine, row.created_on),
      engineInstantValue(sourceEngine, row.occurred_at),
      row.large_integer,
      row.large_decimal,
    ]);
    await source.query(`INSERT INTO ${sourceName} (id, label, note, amount, ratio, payload, active, created_on, occurred_at, large_integer, large_decimal) VALUES ${tuples}`, values);

    const result = await source.transferTableRows(destination, {
      sourceTable,
      sourceSchema,
      targetTable,
      targetSchema,
      pageSize: 2,
      columnMappings,
    });
    assert.equal(result.sourceRows, expected.length, `${direction}: source row count`);
    assert.equal(result.insertedRows, expected.length, `${direction}: inserted row count`);
    assert.deepEqual(result.columns.map((name) => name.toLowerCase()), ["id", "label", "note", "amount", "ratio", "payload", "active", "created_on", "occurred_at", "large_integer", "large_decimal"], `${direction}: transferred columns`);

    const rows = await destination.query(`SELECT ${identifier(targetEngine, targetIdColumn)}, ${identifier(targetEngine, targetLabelColumn)}, note, amount, ratio, payload, active, created_on, occurred_at, ${largeIntegerProjection(targetEngine)}, ${largeDecimalProjection(targetEngine)} FROM ${targetName} ORDER BY ${identifier(targetEngine, targetIdColumn)}`);
    assert.deepEqual(rows.rows.map((row) => ({
      id: Number(readField(row, targetIdColumn)),
      label: readField(row, targetLabelColumn),
      note: readField(row, "note"),
      amount: Number(readField(row, "amount")).toFixed(4),
      ratio: Number(readField(row, "ratio")).toPrecision(15),
      payload: readBinaryField(row, "payload"),
      active: readField(row, "active") === true || readField(row, "active") === 1 || readField(row, "active") === "1",
      created_on: readField(row, "created_on") instanceof Date
        ? `${readField(row, "created_on").getFullYear()}-${String(readField(row, "created_on").getMonth() + 1).padStart(2, "0")}-${String(readField(row, "created_on").getDate()).padStart(2, "0")}`
        : String(readField(row, "created_on")).slice(0, 10),
      occurred_at: readField(row, "occurred_at") instanceof Date
        ? readField(row, "occurred_at").toISOString()
        : new Date(String(readField(row, "occurred_at"))).toISOString(),
      large_integer: String(readField(row, "large_integer")),
      large_decimal: canonicalDecimalText(readField(row, "large_decimal")),
    })), expected.map((row) => ({ ...row, amount: Number(row.amount).toFixed(4), ratio: Number(row.ratio).toPrecision(15), occurred_at: new Date(row.occurred_at).toISOString() })), `${direction}: destination values`);
    return { direction, sourceRows: result.sourceRows, insertedRows: result.insertedRows, pageSize: 2, explicitMapping };
  } catch (error) {
    failure = error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${direction}: ${reason}`, { cause: error });
  } finally {
    const cleanupErrors = [];
    for (const [service, table, wasCreated] of [
      [destination, targetName, targetCreated],
      [source, sourceName, sourceCreated],
    ]) {
      if (!wasCreated) continue;
      try {
        await service.query(`DROP TABLE ${table}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!failure && cleanupErrors.length) throw cleanupErrors[0];
  }
}

const engines = ["postgres", "mysql", "mariadb", "sqlserver", "oracle", "sqlite"];
const shortNames = {
  postgres: "pg",
  mysql: "mysql",
  mariadb: "maria",
  sqlserver: "sql",
  oracle: "ora",
  sqlite: "sqlite",
};
const results = [];
try {
  for (let sourceIndex = 0; sourceIndex < engines.length; sourceIndex += 1) {
    for (let targetIndex = sourceIndex + 1; targetIndex < engines.length; targetIndex += 1) {
      const first = engines[sourceIndex];
      const second = engines[targetIndex];
      const pair = `${shortNames[first]}_${shortNames[second]}`;
      results.push(await transfer({ sourceEngine: first, targetEngine: second, direction: `${pair}_forward` }));
      results.push(await transfer({ sourceEngine: second, targetEngine: first, direction: `${pair}_reverse` }));
    }
  }
  results.push(await transfer({ sourceEngine: "postgres", targetEngine: "sqlite", direction: "pg_sqlite_custom_mapping", explicitMapping: true }));
  results.push(await transfer({ sourceEngine: "sqlite", targetEngine: "postgres", direction: "sqlite_pg_custom_mapping", explicitMapping: true }));
  console.log(JSON.stringify({ ok: true, engineCount: engines.length, pairCount: (engines.length * (engines.length - 1)) / 2, directionCount: results.length, results }, null, 2));
} finally {
  rmSync(sqlitePath, { force: true });
}
