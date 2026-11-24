import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import { OracleAdapter, PostgresAdapter, SqlServerAdapter } from "../../packages/database/dist/index.js";
import { isQueryStreamCell } from "../../packages/shared/dist/index.js";

const dockerEnv = Object.fromEntries(readFileSync(new URL("../../docker/.env", import.meta.url), "utf8")
  .split(/\r?\n/)
  .flatMap((line) => {
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

function required(names, fallback) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    const value = process.env[name] || dockerEnv[name];
    if (value) return value;
  }
  assert.ok(fallback, `Set one of ${candidates.join(", ")} in docker/.env before running this integration.`);
  return fallback;
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema, table) {
  return `${identifier(schema)}.${identifier(table)}`;
}

function quoteSqlServer(value) {
  return `[${value.replaceAll("]", "]]" )}]`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function streamedCell(encoding, value) {
  return {
    __dbStudioQueryStreamCell: true,
    encoding,
    stream: (async function* () {
      if (encoding === "utf8") {
        for (let offset = 0; offset < value.length; offset += 64 * 1024) yield value.slice(offset, offset + 64 * 1024);
      } else {
        for (let offset = 0; offset < value.length; offset += 256 * 1024) yield value.subarray(offset, offset + 256 * 1024);
      }
    })(),
    destroy() {},
  };
}

const pgPassword = required("DBSTUDIO_PG_PASSWORD");
const oraclePassword = required("ORACLE_PASSWORD");
const pgPort = Number(required("DBSTUDIO_POSTGIS_PORT", "25432"));
const oraclePort = Number(required("ORACLE_PORT", "21521"));
const sqlServerConfig = {
  server: required(["DBSTUDIO_TRANSFER_SQLSERVER_HOST", "SQLSERVER_HOST"], "127.0.0.1"),
  port: Number(required(["DBSTUDIO_TRANSFER_SQLSERVER_PORT", "SQLSERVER_PORT"], "21433")),
  database: required(["DBSTUDIO_TRANSFER_SQLSERVER_DATABASE", "SQLSERVER_DATABASE"], "dbstudio_test"),
  user: required(["DBSTUDIO_TRANSFER_SQLSERVER_USER", "SQLSERVER_USER"], "sa"),
  password: required(["DBSTUDIO_TRANSFER_SQLSERVER_PASSWORD", "SQLSERVER_SA_PASSWORD", "SQLSERVER_PASSWORD"]),
  encrypt: true,
  trustServerCertificate: true,
  connectionTimeout: 15_000,
  requestTimeout: 120_000,
};
assert.ok(Number.isSafeInteger(pgPort) && pgPort > 0 && pgPort <= 65_535, "DBSTUDIO_POSTGIS_PORT must be a valid port.");
assert.ok(Number.isSafeInteger(oraclePort) && oraclePort > 0 && oraclePort <= 65_535, "ORACLE_PORT must be a valid port.");
assert.ok(Number.isSafeInteger(sqlServerConfig.port) && sqlServerConfig.port > 0 && sqlServerConfig.port <= 65_535, "SQLSERVER_PORT must be a valid port.");

const oracleSchema = required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase();
const pgSchema = "public";
const suffix = randomBytes(5).toString("hex").toUpperCase();
const oracleSourceTable = `DBLOB_S_${suffix}`;
const pgMiddleTable = `db_lob_m_${suffix.toLowerCase()}`;
const oracleTargetTable = `DBLOB_T_${suffix}`;
const pgVerifyTable = `db_lob_v_${suffix.toLowerCase()}`;
const sqlServerSourceTable = `DBLOB_PGSS_${suffix}`;
const pgSqlServerTargetTable = `db_lob_ss_${suffix.toLowerCase()}`;
const oracle = CoreService.fromOracleConfig({
  user: oracleSchema,
  password: oraclePassword,
  connectString: `//127.0.0.1:${oraclePort}/${required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1")}`,
  connectTimeout: 15,
  callTimeout: 60_000,
});
const sqlServer = CoreService.fromSqlServerConfig(sqlServerConfig);
const sqlServerAdapter = new SqlServerAdapter(sqlServerConfig);
const postgres = CoreService.fromPostgresConfig({
  host: "127.0.0.1",
  port: pgPort,
  database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: pgPassword,
  ssl: false,
  connectionTimeoutMillis: 8_000,
});
const postgresAdapterConfig = {
  host: "127.0.0.1",
  port: pgPort,
  database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: pgPassword,
  ssl: false,
  connectionTimeoutMillis: 8_000,
};
const postgresAdapter = new PostgresAdapter(postgresAdapterConfig);
const tables = [
  [oracle, oracleSchema, oracleSourceTable],
  [postgres, pgSchema, pgMiddleTable],
  [oracle, oracleSchema, oracleTargetTable],
  [postgres, pgSchema, pgVerifyTable],
  [postgres, pgSchema, pgSqlServerTargetTable],
];
const expectedRows = [
  { id: 1, text: `${"a".repeat(65_535)}😀中文字段与 supplementary 字符 🌏 ${"数据库长文本".repeat(350_000)}`, national: `NCLOB supplementary 字符 🐉 ${"全国字符".repeat(300_000)}`, binary: randomBytes(8 * 1024 * 1024) },
  { id: 2, text: `第二条记录 ${"跨库传输".repeat(40_000)}`, national: `NCLOB 第二条 🌏 ${"国家语种".repeat(30_000)}`, binary: randomBytes(512 * 1024) },
];
let primaryError;
let summary;
let streamedCellCount = 0;
let streamedInsertCallCount = 0;
let oracleStreamedCellCount = 0;
let oracleStreamedInsertCallCount = 0;
let sqlServerSourceStreamedCells = 0;
const postgresStreamPageProbe = [];
const originalStreamInsert = PostgresAdapter.prototype.insertRowWithStreamedLobs;
const originalOracleStreamInsert = OracleAdapter.prototype.insertRowWithStreamedLobs;
const originalPostgresReadTablePage = PostgresAdapter.prototype.readTablePage;
const originalSqlServerReadTablePage = SqlServerAdapter.prototype.readTablePage;
PostgresAdapter.prototype.readTablePage = async function (table, columns, primaryKeys, cursor, limit, schema, options) {
  const result = await originalPostgresReadTablePage.call(this, table, columns, primaryKeys, cursor, limit, schema, options);
  if (options?.streamLobColumns && Object.keys(options.streamLobColumns).length) {
    postgresStreamPageProbe.push({
      requested: Object.keys(options.streamLobColumns),
      returnedCells: result.rows.flatMap((row) => Object.entries(row).filter(([, value]) => isQueryStreamCell(value)).map(([name]) => name)),
    });
  }
  return result;
};
SqlServerAdapter.prototype.readTablePage = async function (...args) {
  const result = await originalSqlServerReadTablePage.apply(this, args);
  if (args[0] === sqlServerSourceTable) {
    for (const row of result.rows) {
      for (const value of Object.values(row)) {
        if (isQueryStreamCell(value)) sqlServerSourceStreamedCells += 1;
      }
    }
  }
  return result;
};
PostgresAdapter.prototype.insertRowWithStreamedLobs = async function (table, columns, row, schema) {
  const cells = row.filter(isQueryStreamCell);
  if (cells.length && row[0] !== 999) {
    streamedInsertCallCount += 1;
    streamedCellCount += cells.length;
  }
  return originalStreamInsert.call(this, table, columns, row, schema);
};
OracleAdapter.prototype.insertRowWithStreamedLobs = async function (table, columns, row, schema) {
  const cells = row.filter(isQueryStreamCell);
  if (cells.length && row[0] !== 999) {
    oracleStreamedInsertCallCount += 1;
    oracleStreamedCellCount += cells.length;
  }
  return originalOracleStreamInsert.call(this, table, columns, row, schema);
};

try {
  const oracleSource = qualified(oracleSchema, oracleSourceTable);
  const pgMiddle = qualified(pgSchema, pgMiddleTable);
  const oracleTarget = qualified(oracleSchema, oracleTargetTable);
  const pgVerify = qualified(pgSchema, pgVerifyTable);
  const sqlServerSource = `${quoteSqlServer("dbo")}.${quoteSqlServer(sqlServerSourceTable)}`;
  const pgSqlServerTarget = qualified(pgSchema, pgSqlServerTargetTable);

  await oracle.query(`CREATE TABLE ${oracleSource} ("id" NUMBER(10) NOT NULL PRIMARY KEY, "text_lob" CLOB, "national_lob" NCLOB, "binary_lob" BLOB)`);
  await postgres.query(`CREATE TABLE ${pgMiddle} ("id" BIGINT PRIMARY KEY, "text_lob" TEXT, "national_lob" TEXT, "binary_lob" BYTEA)`);
  await oracle.query(`CREATE TABLE ${oracleTarget} ("id" NUMBER(10) NOT NULL PRIMARY KEY, "text_lob" CLOB, "national_lob" NCLOB, "binary_lob" BLOB)`);
  await postgres.query(`CREATE TABLE ${pgVerify} ("id" BIGINT PRIMARY KEY, "text_lob" TEXT, "national_lob" TEXT, "binary_lob" BYTEA)`);
  await sqlServer.query(`CREATE TABLE ${sqlServerSource} ([id] BIGINT NOT NULL PRIMARY KEY, [text_lob] NVARCHAR(MAX), [national_lob] NVARCHAR(MAX), [binary_lob] VARBINARY(MAX))`);
  await postgres.query(`CREATE TABLE ${pgSqlServerTarget} ("id" BIGINT PRIMARY KEY, "text_lob" TEXT, "national_lob" TEXT, "binary_lob" BYTEA)`);

  await oracle.importRows(oracleSourceTable, {
    columns: ["id", "text_lob", "national_lob", "binary_lob"],
    rows: expectedRows.map((row) => ({ id: row.id, text_lob: row.text, national_lob: row.national, binary_lob: row.binary })),
  }, oracleSchema);

  const sourceProbe = new OracleAdapter({
    user: oracleSchema,
    password: oraclePassword,
    connectString: `//127.0.0.1:${oraclePort}/${required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1")}`,
    connectTimeout: 15,
    callTimeout: 60_000,
  });
  const probeSizes = [];
  try {
    let probeCursor;
    while (probeSizes.length < expectedRows.length) {
      const page = await sourceProbe.readTablePage(
        oracleSourceTable,
        ["id", "text_lob", "national_lob", "binary_lob"],
        ["id"],
        probeCursor,
        1,
        oracleSchema,
        { streamLobs: true },
      );
      if (!page.rows.length) break;
      const row = page.rows[0];
      const sizes = { id: Number(row.id), text: 0, national: 0, binary: 0 };
      for (const [column, key] of [["text_lob", "text"], ["national_lob", "national"], ["binary_lob", "binary"]]) {
        const cell = row[column];
        assert.equal(isQueryStreamCell(cell), true, `${column} must be returned as a stream`);
        for await (const chunk of cell.stream) {
          sizes[key] += typeof chunk === "string" ? chunk.length : chunk.byteLength;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        cell.destroy();
      }
      probeSizes.push(sizes);
      probeCursor = [row.id];
    }
  } finally {
    await sourceProbe.close();
  }
  assert.equal(probeSizes.length, expectedRows.length, "Oracle LOB source probe row count");
  assert.deepEqual(probeSizes.map((row) => row.id), expectedRows.map((row) => row.id), "Oracle LOB source probe key order");

  const streamedCellsBeforeForward = streamedCellCount;
  const forward = await oracle.transferTableRows(postgres, {
    sourceTable: oracleSourceTable,
    sourceSchema: oracleSchema,
    targetTable: pgMiddleTable,
    targetSchema: pgSchema,
    pageSize: 50,
  });
  assert.equal(forward.sourceRows, expectedRows.length, "Oracle to PostgreSQL row count");
  assert.equal(forward.insertedRows, expectedRows.length, "Oracle to PostgreSQL inserted count");
  assert.equal(streamedCellCount - streamedCellsBeforeForward, expectedRows.length * 3,
    "Oracle CLOB, NCLOB and BLOB cells must reach PostgreSQL as streams");

  const middleRows = await postgres.query(`SELECT "id", "text_lob", "national_lob", "binary_lob" FROM ${pgMiddle} ORDER BY "id"`);
  assert.deepEqual(middleRows.rows.map((row) => ({
    id: Number(row.id),
    text: row.text_lob,
    national: row.national_lob,
    textSha256: sha256(String(row.text_lob)),
    nationalSha256: sha256(String(row.national_lob)),
    binarySha256: sha256(Buffer.from(row.binary_lob)),
    binaryBytes: Buffer.from(row.binary_lob).length,
  })), expectedRows.map((row) => ({
    id: row.id,
    text: row.text,
    national: row.national,
    textSha256: sha256(row.text),
    nationalSha256: sha256(row.national),
    binarySha256: sha256(row.binary),
    binaryBytes: row.binary.length,
  })), "Oracle LOB values must survive transfer to PostgreSQL");

  const toOracle = await postgres.transferTableRows(oracle, {
    sourceTable: pgMiddleTable,
    sourceSchema: pgSchema,
    targetTable: oracleTargetTable,
    targetSchema: oracleSchema,
    pageSize: 50,
  });
  assert.equal(toOracle.sourceRows, expectedRows.length, "PostgreSQL to Oracle row count");
  assert.equal(toOracle.insertedRows, expectedRows.length, "PostgreSQL to Oracle inserted count");
  assert.equal(oracleStreamedInsertCallCount, expectedRows.length,
    `PostgreSQL rows with Oracle LOB targets must use streamed Oracle inserts (probe: ${JSON.stringify(postgresStreamPageProbe)})`);
  assert.equal(oracleStreamedCellCount, expectedRows.length * 3,
    "PostgreSQL text and bytea values must reach Oracle as streams");
  assert.equal(postgresStreamPageProbe.flatMap((page) => page.returnedCells).length, expectedRows.length * 3,
    "PostgreSQL text and bytea source values must be read as streams");

  let failedOracleStreamDestroyed = false;
  const failedOracleCell = {
    __dbStudioQueryStreamCell: true,
    encoding: "utf8",
    stream: {
      async *[Symbol.asyncIterator]() {
        yield "x".repeat(256 * 1024);
        throw new Error("Synthetic Oracle LOB stream failure after first write.");
      },
    },
    destroy() { failedOracleStreamDestroyed = true; },
  };
  const oracleTargetProbe = new OracleAdapter({
    user: oracleSchema,
    password: oraclePassword,
    connectString: `//127.0.0.1:${oraclePort}/${required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1")}`,
    connectTimeout: 15,
    callTimeout: 60_000,
  });
  try {
    await assert.rejects(
      oracleTargetProbe.insertRowWithStreamedLobs(
        oracleTargetTable,
        ["id", "text_lob", "national_lob", "binary_lob"],
        [999, failedOracleCell, null, null],
        oracleSchema,
      ),
      /Synthetic Oracle LOB stream failure after first write\./,
    );
  } finally {
    await oracleTargetProbe.close();
  }
  assert.equal(failedOracleStreamDestroyed, true, "failed PostgreSQL LOB streams must be destroyed");
  const oracleRolledBackRow = await oracle.query(`SELECT "id" FROM ${oracleTarget} WHERE "id" = 999`);
  assert.equal(oracleRolledBackRow.rowCount, 0, "an Oracle LOB stream failure must roll back the inserted row");

  let failedStreamDestroyed = false;
  const failedCell = {
    __dbStudioQueryStreamCell: true,
    encoding: "utf8",
    stream: {
      async *[Symbol.asyncIterator]() {
        yield "x".repeat(256 * 1024);
        throw new Error("Synthetic LOB stream failure after first append.");
      },
    },
    destroy() { failedStreamDestroyed = true; },
  };
  await assert.rejects(
    postgresAdapter.insertRowWithStreamedLobs(
      pgMiddleTable,
      ["id", "text_lob", "national_lob", "binary_lob"],
      [999, failedCell, null, null],
      pgSchema,
    ),
    /Synthetic LOB stream failure after first append\./,
  );
  assert.equal(failedStreamDestroyed, true, "failed Oracle LOB streams must be destroyed");
  const rolledBackRow = await postgres.query(`SELECT "id" FROM ${pgMiddle} WHERE "id" = 999`);
  assert.equal(rolledBackRow.rowCount, 0, "a stream failure must roll back the inserted row and prior LOB chunks");

  const streamedCellsBeforeRoundTrip = streamedCellCount;
  const roundTrip = await oracle.transferTableRows(postgres, {
    sourceTable: oracleTargetTable,
    sourceSchema: oracleSchema,
    targetTable: pgVerifyTable,
    targetSchema: pgSchema,
    pageSize: 50,
  });
  assert.equal(roundTrip.sourceRows, expectedRows.length, "Oracle LOB round-trip row count");
  assert.equal(roundTrip.insertedRows, expectedRows.length, "Oracle LOB round-trip inserted count");
  assert.equal(streamedCellCount - streamedCellsBeforeRoundTrip, expectedRows.length * 3,
    "Oracle LOB round-trip cells must also use the streamed PostgreSQL insert path");

  const verifiedRows = await postgres.query(`SELECT "id", "text_lob", "national_lob", "binary_lob" FROM ${pgVerify} ORDER BY "id"`);
  assert.deepEqual(verifiedRows.rows.map((row) => ({
    id: Number(row.id),
    textSha256: sha256(String(row.text_lob)),
    nationalSha256: sha256(String(row.national_lob)),
    binarySha256: sha256(Buffer.from(row.binary_lob)),
    binaryBytes: Buffer.from(row.binary_lob).length,
  })), expectedRows.map((row) => ({
    id: row.id,
    textSha256: sha256(row.text),
    nationalSha256: sha256(row.national),
    binarySha256: sha256(row.binary),
    binaryBytes: row.binary.length,
  })), "CLOB, NCLOB and BLOB must survive an Oracle round trip");

  for (const row of expectedRows) {
    await sqlServerAdapter.insertRowWithStreamedLobs(
      sqlServerSourceTable,
      ["id", "text_lob", "national_lob", "binary_lob"],
      [row.id, streamedCell("utf8", row.text), streamedCell("utf8", row.national), streamedCell("buffer", row.binary)],
      "dbo",
    );
  }
  const postgresStreamsBeforeSqlServerSource = streamedCellCount;
  const sqlServerSourceTransfer = await sqlServer.transferTableRows(postgres, {
    sourceTable: sqlServerSourceTable,
    sourceSchema: "dbo",
    targetTable: pgSqlServerTargetTable,
    targetSchema: pgSchema,
    pageSize: 20,
  });
  assert.equal(sqlServerSourceTransfer.sourceRows, expectedRows.length, "SQL Server LOB source row count");
  assert.equal(sqlServerSourceTransfer.insertedRows, expectedRows.length, "SQL Server LOB target row count");
  assert.equal(sqlServerSourceStreamedCells, expectedRows.length * 3, "SQL Server MAX text and binary columns must be read as streams");
  assert.equal(streamedCellCount - postgresStreamsBeforeSqlServerSource, expectedRows.length * 3,
    "SQL Server MAX text and binary columns must reach the PostgreSQL writer as streams");

  const sqlServerTargetPage = await postgresAdapter.readTablePage(
    pgSqlServerTargetTable,
    ["id", "text_lob", "national_lob", "binary_lob"],
    ["id"],
    undefined,
    expectedRows.length,
    pgSchema,
    { streamLobs: true, streamLobColumns: { text_lob: "utf8", national_lob: "utf8", binary_lob: "buffer" } },
  );
  assert.equal(sqlServerTargetPage.rows.length, expectedRows.length, "PostgreSQL streamed readback row count");
  for (const [index, row] of sqlServerTargetPage.rows.entries()) {
    const expected = expectedRows[index];
    assert.equal(Number(row.id), expected.id);
    for (const [column, value, encoding] of [
      ["text_lob", expected.text, "utf8"],
      ["national_lob", expected.national, "utf8"],
      ["binary_lob", expected.binary, "buffer"],
    ]) {
      const cell = row[column];
      assert.ok(isQueryStreamCell(cell), `PostgreSQL ${column} readback must be streamed`);
      const hash = createHash("sha256");
      let byteLength = 0;
      try {
        for await (const chunk of cell.stream) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
          hash.update(bytes);
          byteLength += bytes.byteLength;
        }
      } finally {
        cell.destroy();
      }
      const expectedBytes = encoding === "buffer" ? value : Buffer.from(value, "utf8");
      assert.equal(byteLength, expectedBytes.byteLength, `SQL Server→PostgreSQL ${column} byte length`);
      assert.equal(hash.digest("hex"), sha256(expectedBytes), `SQL Server→PostgreSQL ${column} SHA-256`);
    }
  }

  summary = {
    ok: true,
    rows: expectedRows.length,
    streamedPostgresInsertCalls: streamedInsertCallCount,
    streamedPostgresCells: streamedCellCount,
    streamedOracleInsertCalls: oracleStreamedInsertCallCount,
    streamedOracleCells: oracleStreamedCellCount,
    streamedPostgresReadCells: postgresStreamPageProbe.flatMap((page) => page.returnedCells).length,
    directOracleStreamProbeRows: probeSizes.length,
    failedStreamRolledBack: true,
    failedOracleStreamRolledBack: true,
    sqlServerSourceStreamedCells,
    sqlServerSourceTargetStreamedCells: streamedCellCount - postgresStreamsBeforeSqlServerSource,
    lobSizes: expectedRows.map((row) => ({
      clobCharacters: row.text.length,
      clobUtf8Bytes: Buffer.byteLength(row.text),
      nclobCharacters: row.national.length,
      nclobUtf8Bytes: Buffer.byteLength(row.national),
      binaryBytes: row.binary.length,
    })),
    directions: ["oracle-to-postgres", "postgres-to-oracle", "oracle-to-postgres-roundtrip", "sqlserver-to-postgres"],
    sourceDataSynthetic: true,
    sourceFilesModified: false,
    externalDataSent: false,
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  PostgresAdapter.prototype.insertRowWithStreamedLobs = originalStreamInsert;
  OracleAdapter.prototype.insertRowWithStreamedLobs = originalOracleStreamInsert;
  PostgresAdapter.prototype.readTablePage = originalPostgresReadTablePage;
  SqlServerAdapter.prototype.readTablePage = originalSqlServerReadTablePage;
  try {
    await sqlServer.query(`DROP TABLE ${quoteSqlServer("dbo")}.${quoteSqlServer(sqlServerSourceTable)}`);
  } catch (error) {
    if (!/Invalid object name|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
  }
  for (const [service, schema, table] of [...tables].reverse()) {
    try {
      await service.query(`DROP TABLE ${qualified(schema, table)}`);
    } catch (error) {
      if (!/ORA-00942|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
    }
  }
  try {
    await postgresAdapter.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await sqlServerAdapter.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!primaryError && cleanupErrors.length) throw cleanupErrors[0];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDirectory = path.join(root, ".cache");
mkdirSync(artifactDirectory, { recursive: true });
const evidencePath = path.join(artifactDirectory, `oracle-postgres-sqlserver-lob-transfer-20261120-${suffix.toLowerCase()}.json`);
assert.ok(!existsSync(evidencePath), "Refusing to overwrite an existing SQL Server/PostgreSQL LOB evidence file.");
summary.temporaryTablesCleaned = true;
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...summary, evidence: path.relative(root, evidencePath).replaceAll("\\", "/") }, null, 2));
