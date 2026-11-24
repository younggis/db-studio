import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import { OracleAdapter, SqlServerAdapter } from "../../packages/database/dist/index.js";

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
  for (const name of names) {
    const value = process.env[name] || dockerEnv[name];
    if (value) return value;
  }
  assert.ok(fallback, `Set one of ${names.join(", ")} in docker/.env before running this integration.`);
  return fallback;
}

function port(names, fallback) {
  const value = Number(required(names, fallback));
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 65_535, `${names[0]} must be a valid port.`);
  return value;
}

function quoteSqlServer(identifier) {
  return `[${identifier.replaceAll("]", "]]" )}]`;
}

function quoteOracle(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
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

const oracleUser = required(["DBSTUDIO_TRANSFER_ORACLE_USER", "DBSTUDIO_ORACLE_USER"], "SYSTEM").toUpperCase();
const oracleServiceName = required(["DBSTUDIO_TRANSFER_ORACLE_SERVICE", "DBSTUDIO_ORACLE_SERVICE"], "FREEPDB1");
const oraclePassword = required(["DBSTUDIO_TRANSFER_ORACLE_PASSWORD", "ORACLE_PASSWORD"]);
const oraclePort = port(["DBSTUDIO_TRANSFER_ORACLE_PORT", "ORACLE_PORT"], "21521");
const sqlServerHost = required(["DBSTUDIO_TRANSFER_SQLSERVER_HOST", "SQLSERVER_HOST"], "127.0.0.1");
const sqlServerPort = port(["DBSTUDIO_TRANSFER_SQLSERVER_PORT", "SQLSERVER_PORT"], "21433");
const sqlServerDatabase = required(["DBSTUDIO_TRANSFER_SQLSERVER_DATABASE", "SQLSERVER_DATABASE"], "dbstudio_test");
const sqlServerUser = required(["DBSTUDIO_TRANSFER_SQLSERVER_USER", "SQLSERVER_USER"], "sa");
const sqlServerPassword = required(["DBSTUDIO_TRANSFER_SQLSERVER_PASSWORD", "SQLSERVER_SA_PASSWORD"]);

const oracleSchema = oracleUser;
const sqlServerSchema = "dbo";
const suffix = randomBytes(5).toString("hex").toUpperCase();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDirectory = path.join(root, ".cache");
mkdirSync(artifactDirectory, { recursive: true });
const evidencePath = path.join(artifactDirectory, `oracle-sqlserver-lob-transfer-20261120-${suffix.toLowerCase()}.json`);
assert.ok(!existsSync(evidencePath), "Refusing to overwrite an existing Oracle/SQL Server LOB evidence file.");
const oracleSourceTable = `DBLOB_S_${suffix}`;
const sqlServerTargetTable = `DBLOB_T_${suffix}`;
const sqlServerSourceTable = `DBLOB_SS_${suffix}`;
const sqlServerSelfTargetTable = `DBLOB_ST_${suffix}`;
const oracleTargetTable = `DBLOB_OT_${suffix}`;
const oracleFailureTargetTable = `DBLOB_OF_${suffix}`;
const oracleSource = `${quoteOracle(oracleSchema)}.${quoteOracle(oracleSourceTable)}`;
const sqlServerTarget = `${quoteSqlServer(sqlServerSchema)}.${quoteSqlServer(sqlServerTargetTable)}`;
const sqlServerSource = `${quoteSqlServer(sqlServerSchema)}.${quoteSqlServer(sqlServerSourceTable)}`;
const sqlServerSelfTarget = `${quoteSqlServer(sqlServerSchema)}.${quoteSqlServer(sqlServerSelfTargetTable)}`;
const oracleTarget = `${quoteOracle(oracleSchema)}.${quoteOracle(oracleTargetTable)}`;
const oracleFailureTarget = `${quoteOracle(oracleSchema)}.${quoteOracle(oracleFailureTargetTable)}`;
const oracleConfig = {
  user: oracleUser,
  password: oraclePassword,
  connectString: `//127.0.0.1:${oraclePort}/${oracleServiceName}`,
  connectTimeout: 15,
  callTimeout: 120_000,
};
const oracle = CoreService.fromOracleConfig(oracleConfig);
const oracleAdapter = new OracleAdapter(oracleConfig);
const sqlServerConfig = {
  server: sqlServerHost,
  port: sqlServerPort,
  database: sqlServerDatabase,
  user: sqlServerUser,
  password: sqlServerPassword,
  encrypt: true,
  trustServerCertificate: true,
  connectionTimeout: 15_000,
  requestTimeout: 120_000,
};
const sqlServer = CoreService.fromSqlServerConfig(sqlServerConfig);
const sqlServerAdapter = new SqlServerAdapter(sqlServerConfig);
const expectedRows = [
  {
    id: 1,
    text: `中文与补充字符 😀🌏 ${"数据库长文本".repeat(220_000)}`,
    national: `NCLOB 字符 🐉 ${"全国字符".repeat(180_000)}`,
    binary: randomBytes(6 * 1024 * 1024),
  },
  {
    id: 2,
    text: `第二条长记录 ${"跨库传输".repeat(45_000)}`,
    national: `第二条 NCLOB 🌏 ${"国家语种".repeat(35_000)}`,
    binary: randomBytes(512 * 1024),
  },
];
const originalStreamInsert = SqlServerAdapter.prototype.insertRowWithStreamedLobs;
const originalReadPage = SqlServerAdapter.prototype.readTablePage;
let streamedRowCount = 0;
let streamedCellCount = 0;
let sqlServerSourceStreamedCells = 0;
let failedSourceStreamDestroyed = false;
let injectSourceStreamFailure = false;
let primaryError;
let summary;
SqlServerAdapter.prototype.insertRowWithStreamedLobs = async function (table, columns, row, schema) {
  const cells = row.filter((value) => value?.__dbStudioQueryStreamCell === true);
  if (cells.length) {
    streamedRowCount += 1;
    streamedCellCount += cells.length;
  }
  return originalStreamInsert.call(this, table, columns, row, schema);
};
SqlServerAdapter.prototype.readTablePage = async function (...args) {
  const result = await originalReadPage.apply(this, args);
  if (args[0] !== sqlServerSourceTable) return result;
  for (const row of result.rows) {
    for (const value of Object.values(row)) {
      if (value?.__dbStudioQueryStreamCell === true) sqlServerSourceStreamedCells += 1;
    }
  }
  if (!injectSourceStreamFailure) return result;
  injectSourceStreamFailure = false;
  const row = result.rows[0];
  const originalCell = row?.text_lob;
  assert.ok(originalCell?.__dbStudioQueryStreamCell, "the SQL Server text LOB must arrive as a stream before failure injection");
  row.text_lob = {
    ...originalCell,
    stream: (async function* () {
      for await (const chunk of originalCell.stream) {
        yield chunk;
        throw new Error("Synthetic SQL Server source LOB stream failure after the first chunk.");
      }
    })(),
    destroy() {
      failedSourceStreamDestroyed = true;
      originalCell.destroy();
    },
  };
  return result;
};

try {
  await oracle.query(`CREATE TABLE ${oracleSource} ("id" NUMBER(10) NOT NULL PRIMARY KEY, "text_lob" CLOB, "national_lob" NCLOB, "binary_lob" BLOB)`);
  await sqlServer.query(`CREATE TABLE ${sqlServerTarget} ([id] BIGINT NOT NULL PRIMARY KEY, [text_lob] NVARCHAR(MAX) NULL, [national_lob] NVARCHAR(MAX) NULL, [binary_lob] VARBINARY(MAX) NULL)`);
  await sqlServer.query(`CREATE TABLE ${sqlServerSource} ([id] BIGINT NOT NULL PRIMARY KEY, [text_lob] NVARCHAR(MAX) NULL, [national_lob] NVARCHAR(MAX) NULL, [binary_lob] VARBINARY(MAX) NULL)`);
  await sqlServer.query(`CREATE TABLE ${sqlServerSelfTarget} ([id] BIGINT NOT NULL PRIMARY KEY, [text_lob] NVARCHAR(MAX) NULL, [national_lob] NVARCHAR(MAX) NULL, [binary_lob] VARBINARY(MAX) NULL)`);
  await oracle.query(`CREATE TABLE ${oracleTarget} ("id" NUMBER(10) NOT NULL PRIMARY KEY, "text_lob" CLOB, "national_lob" NCLOB, "binary_lob" BLOB)`);
  await oracle.query(`CREATE TABLE ${oracleFailureTarget} ("id" NUMBER(10) NOT NULL PRIMARY KEY, "text_lob" CLOB, "national_lob" NCLOB, "binary_lob" BLOB)`);
  await oracle.importRows(oracleSourceTable, {
    columns: ["id", "text_lob", "national_lob", "binary_lob"],
    rows: expectedRows.map((row) => ({ id: row.id, text_lob: row.text, national_lob: row.national, binary_lob: row.binary })),
  }, oracleSchema);

  const transfer = await oracle.transferTableRows(sqlServer, {
    sourceTable: oracleSourceTable,
    sourceSchema: oracleSchema,
    targetTable: sqlServerTargetTable,
    targetSchema: sqlServerSchema,
    pageSize: 50,
  });
  assert.equal(transfer.sourceRows, expectedRows.length, "Oracle to SQL Server row count");
  assert.equal(transfer.insertedRows, expectedRows.length, "Oracle to SQL Server inserted row count");
  assert.equal(streamedRowCount, expectedRows.length, "every Oracle row with LOBs must use the SQL Server streaming writer");
  assert.equal(streamedCellCount, expectedRows.length * 3, "CLOB, NCLOB and BLOB cells must reach SQL Server as streams");
  const transferStreamedRowCount = streamedRowCount;
  const transferStreamedCellCount = streamedCellCount;

  const verified = await sqlServer.query(
    `SELECT [id], DATALENGTH([text_lob]) AS text_bytes, HASHBYTES('SHA2_256', [text_lob]) AS text_hash,
            DATALENGTH([national_lob]) AS national_bytes, HASHBYTES('SHA2_256', [national_lob]) AS national_hash,
            DATALENGTH([binary_lob]) AS binary_bytes, HASHBYTES('SHA2_256', [binary_lob]) AS binary_hash
     FROM ${sqlServerTarget} ORDER BY [id]`,
  );
  assert.deepEqual(verified.rows.map((row) => ({
    id: Number(row.id),
    textBytes: Number(row.text_bytes),
    textHash: Buffer.from(row.text_hash).toString("hex"),
    nationalBytes: Number(row.national_bytes),
    nationalHash: Buffer.from(row.national_hash).toString("hex"),
    binaryBytes: Number(row.binary_bytes),
    binaryHash: Buffer.from(row.binary_hash).toString("hex"),
  })), expectedRows.map((row) => ({
    id: row.id,
    textBytes: Buffer.byteLength(row.text, "utf16le"),
    textHash: sha256(Buffer.from(row.text, "utf16le")),
    nationalBytes: Buffer.byteLength(row.national, "utf16le"),
    nationalHash: sha256(Buffer.from(row.national, "utf16le")),
    binaryBytes: row.binary.length,
    binaryHash: sha256(row.binary),
  })), "SQL Server LOB byte lengths and SHA-256 hashes must match the Oracle source values");

  let failedCellDestroyed = false;
  const failedCell = {
    __dbStudioQueryStreamCell: true,
    encoding: "utf8",
    stream: {
      async *[Symbol.asyncIterator]() {
        yield "x".repeat(140_000);
        throw new Error("Synthetic SQL Server LOB stream failure after first append.");
      },
    },
    destroy() { failedCellDestroyed = true; },
  };
  await assert.rejects(
    sqlServerAdapter.insertRowWithStreamedLobs(
      sqlServerTargetTable,
      ["id", "text_lob", "national_lob", "binary_lob"],
      [999, failedCell, null, null],
      sqlServerSchema,
    ),
    /Synthetic SQL Server LOB stream failure after first append\./,
  );
  assert.equal(failedCellDestroyed, true, "a failed streamed SQL Server cell must be destroyed");
  const rolledBack = await sqlServer.query(`SELECT COUNT_BIG(*) AS count FROM ${sqlServerTarget} WHERE [id] = 999`);
  assert.equal(Number(rolledBack.rows[0]?.count), 0, "a failed LOB stream must roll back the inserted row and prior chunks");

  for (const row of expectedRows) {
    await sqlServerAdapter.insertRowWithStreamedLobs(
      sqlServerSourceTable,
      ["id", "text_lob", "national_lob", "binary_lob"],
      [row.id, streamedCell("utf8", row.text), streamedCell("utf8", row.national), streamedCell("buffer", row.binary)],
      sqlServerSchema,
    );
  }
  const sourceStreamingStart = sqlServerSourceStreamedCells;
  const reverseTransfer = await sqlServer.transferTableRows(oracle, {
    sourceTable: sqlServerSourceTable,
    sourceSchema: sqlServerSchema,
    targetTable: oracleTargetTable,
    targetSchema: oracleSchema,
    pageSize: 50,
  });
  assert.equal(reverseTransfer.sourceRows, expectedRows.length, "SQL Server to Oracle row count");
  assert.equal(reverseTransfer.insertedRows, expectedRows.length, "SQL Server to Oracle inserted row count");
  const reverseStreamedCellCount = sqlServerSourceStreamedCells - sourceStreamingStart;
  assert.equal(reverseStreamedCellCount, expectedRows.length * 3, "SQL Server MAX LOBs must reach Core as bounded streams");

  const targetPage = await oracleAdapter.readTablePage(
    oracleTargetTable,
    ["id", "text_lob", "national_lob", "binary_lob"],
    ["id"],
    undefined,
    expectedRows.length,
    oracleSchema,
    { streamLobs: true, streamLobColumns: { text_lob: "utf8", national_lob: "utf8", binary_lob: "buffer" } },
  );
  assert.equal(targetPage.rows.length, expectedRows.length, "Oracle streamed LOB readback row count");
  for (const [index, row] of targetPage.rows.entries()) {
    const expected = expectedRows[index];
    assert.equal(Number(row.id), expected.id);
    for (const [column, value, encoding] of [
      ["text_lob", expected.text, "utf8"],
      ["national_lob", expected.national, "utf8"],
      ["binary_lob", expected.binary, "buffer"],
    ]) {
      const cell = row[column];
      assert.ok(cell?.__dbStudioQueryStreamCell, `Oracle ${column} readback must be streamed`);
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
      assert.equal(byteLength, expectedBytes.byteLength, `SQL Server→Oracle ${column} byte length`);
      assert.equal(hash.digest("hex"), sha256(expectedBytes), `SQL Server→Oracle ${column} SHA-256`);
    }
  }

  const selfSourceCellsBefore = sqlServerSourceStreamedCells;
  const selfTargetCellsBefore = streamedCellCount;
  const selfTargetRowsBefore = streamedRowCount;
  const selfTransfer = await sqlServer.transferTableRows(sqlServer, {
    sourceTable: sqlServerSourceTable,
    sourceSchema: sqlServerSchema,
    targetTable: sqlServerSelfTargetTable,
    targetSchema: sqlServerSchema,
    pageSize: 50,
  });
  assert.equal(selfTransfer.sourceRows, expectedRows.length, "SQL Server to SQL Server row count");
  assert.equal(selfTransfer.insertedRows, expectedRows.length, "SQL Server to SQL Server inserted row count");
  const selfStreamedCells = sqlServerSourceStreamedCells - selfSourceCellsBefore;
  assert.equal(selfStreamedCells, expectedRows.length * 3, "SQL Server same-engine MAX LOB cells must stream");
  assert.equal(streamedCellCount - selfTargetCellsBefore, expectedRows.length * 3, "SQL Server same-engine LOB cells must use streamed writes");
  assert.equal(streamedRowCount - selfTargetRowsBefore, expectedRows.length, "SQL Server same-engine rows must use streamed writes");
  const selfVerified = await sqlServer.query(
    `SELECT [id], DATALENGTH([text_lob]) AS text_bytes, HASHBYTES('SHA2_256', [text_lob]) AS text_hash,
            DATALENGTH([national_lob]) AS national_bytes, HASHBYTES('SHA2_256', [national_lob]) AS national_hash,
            DATALENGTH([binary_lob]) AS binary_bytes, HASHBYTES('SHA2_256', [binary_lob]) AS binary_hash
     FROM ${sqlServerSelfTarget} ORDER BY [id]`,
  );
  assert.deepEqual(selfVerified.rows.map((row) => ({
    id: Number(row.id),
    textBytes: Number(row.text_bytes),
    textHash: Buffer.from(row.text_hash).toString("hex"),
    nationalBytes: Number(row.national_bytes),
    nationalHash: Buffer.from(row.national_hash).toString("hex"),
    binaryBytes: Number(row.binary_bytes),
    binaryHash: Buffer.from(row.binary_hash).toString("hex"),
  })), expectedRows.map((row) => ({
    id: row.id,
    textBytes: Buffer.byteLength(row.text, "utf16le"),
    textHash: sha256(Buffer.from(row.text, "utf16le")),
    nationalBytes: Buffer.byteLength(row.national, "utf16le"),
    nationalHash: sha256(Buffer.from(row.national, "utf16le")),
    binaryBytes: row.binary.length,
    binaryHash: sha256(row.binary),
  })), "SQL Server same-engine LOB byte lengths and SHA-256 hashes must match source values");

  injectSourceStreamFailure = true;
  await assert.rejects(
    sqlServer.transferTableRows(oracle, {
      sourceTable: sqlServerSourceTable,
      sourceSchema: sqlServerSchema,
      targetTable: oracleFailureTargetTable,
      targetSchema: oracleSchema,
      pageSize: 50,
    }),
    /Synthetic SQL Server source LOB stream failure after the first chunk\./,
  );
  assert.equal(failedSourceStreamDestroyed, true, "Core must destroy a failed SQL Server source LOB stream");
  const reverseRolledBack = await oracle.query(`SELECT COUNT(*) AS count FROM ${oracleFailureTarget}`);
  assert.equal(Number(Object.values(reverseRolledBack.rows[0] ?? {})[0]), 0, "an Oracle streamed insert must roll back after a SQL Server source-stream failure");

  summary = {
    ok: true,
    rows: transfer.sourceRows,
    streamedRows: transferStreamedRowCount,
    streamedCells: transferStreamedCellCount,
    lobSizes: expectedRows.map((row) => ({
      clobCharacters: row.text.length,
      clobUtf16Bytes: Buffer.byteLength(row.text, "utf16le"),
      nclobCharacters: row.national.length,
      nclobUtf16Bytes: Buffer.byteLength(row.national, "utf16le"),
      binaryBytes: row.binary.length,
    })),
    hashesAndByteLengthsMatched: true,
    failedStreamRolledBack: true,
    reverseStreamedCells: reverseStreamedCellCount,
    reverseFailureRolledBack: true,
    sqlServerSelfTargetStreamedCells: selfStreamedCells,
    directions: ["oracle-to-sqlserver", "sqlserver-to-oracle", "sqlserver-to-sqlserver"],
    sourceDataSynthetic: true,
    sourceFilesModified: false,
    externalDataSent: false,
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  SqlServerAdapter.prototype.insertRowWithStreamedLobs = originalStreamInsert;
  SqlServerAdapter.prototype.readTablePage = originalReadPage;
  try {
    await sqlServer.query(`DROP TABLE ${sqlServerTarget}`);
  } catch (error) {
    if (!/Invalid object name|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
  }
  try {
    await sqlServer.query(`DROP TABLE ${sqlServerSource}`);
  } catch (error) {
    if (!/Invalid object name|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
  }
  try {
    await sqlServer.query(`DROP TABLE ${sqlServerSelfTarget}`);
  } catch (error) {
    if (!/Invalid object name|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
  }
  try {
    await oracle.query(`DROP TABLE ${oracleSource}`);
  } catch (error) {
    if (!/ORA-00942|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
  }
  for (const table of [oracleTarget, oracleFailureTarget]) {
    try {
      await oracle.query(`DROP TABLE ${table}`);
    } catch (error) {
      if (!/ORA-00942|does not exist/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
    }
  }
  try {
    await sqlServerAdapter.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await oracleAdapter.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!primaryError && cleanupErrors.length) throw cleanupErrors[0];
}

summary.temporaryTablesCleaned = true;
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...summary, evidence: path.relative(root, evidencePath).replaceAll("\\", "/") }, null, 2));
