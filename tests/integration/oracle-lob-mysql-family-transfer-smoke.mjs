import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import { MariaDbAdapter, MySqlAdapter, SqlServerAdapter } from "../../packages/database/dist/index.js";

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

function quoteMySql(identifier) {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function quoteOracle(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlServer(identifier) {
  return `[${identifier.replaceAll("]", "]]" )}]`;
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
const mysqlConfig = {
  host: required(["DBSTUDIO_TRANSFER_MYSQL_HOST", "MYSQL_HOST"], "127.0.0.1"),
  port: port(["DBSTUDIO_TRANSFER_MYSQL_PORT", "MYSQL_PORT"], "23306"),
  database: required(["DBSTUDIO_TRANSFER_MYSQL_DATABASE", "MYSQL_DATABASE"]),
  user: required(["DBSTUDIO_TRANSFER_MYSQL_USER", "MYSQL_USER"]),
  password: required(["DBSTUDIO_TRANSFER_MYSQL_PASSWORD", "MYSQL_PASSWORD"]),
  connectTimeout: 15_000,
};
const mariaDbConfig = {
  host: required(["DBSTUDIO_TRANSFER_MARIADB_HOST", "MARIADB_HOST"], "127.0.0.1"),
  port: port(["DBSTUDIO_TRANSFER_MARIADB_PORT", "MARIADB_PORT"], "23307"),
  database: required(["DBSTUDIO_TRANSFER_MARIADB_DATABASE", "MARIADB_DATABASE"]),
  user: required(["DBSTUDIO_TRANSFER_MARIADB_USER", "MARIADB_USER"]),
  password: required(["DBSTUDIO_TRANSFER_MARIADB_PASSWORD", "MARIADB_PASSWORD"]),
  connectTimeout: 15_000,
};
const sqlServerConfig = {
  server: required(["DBSTUDIO_TRANSFER_SQLSERVER_HOST", "SQLSERVER_HOST"], "127.0.0.1"),
  port: port(["DBSTUDIO_TRANSFER_SQLSERVER_PORT", "SQLSERVER_PORT"], "21433"),
  database: required(["DBSTUDIO_TRANSFER_SQLSERVER_DATABASE", "SQLSERVER_DATABASE"], "dbstudio_test"),
  user: required(["DBSTUDIO_TRANSFER_SQLSERVER_USER", "SQLSERVER_USER"], "sa"),
  password: required(["DBSTUDIO_TRANSFER_SQLSERVER_PASSWORD", "SQLSERVER_SA_PASSWORD"]),
  encrypt: true,
  trustServerCertificate: true,
  connectionTimeout: 15_000,
  requestTimeout: 120_000,
};

const oracleSchema = oracleUser;
const suffix = randomBytes(5).toString("hex").toUpperCase();
const oracleSourceTable = `DBLOB_M_${suffix}`;
const mysqlTargetTable = `db_lob_mysql_${suffix.toLowerCase()}`;
const mariaDbTargetTable = `db_lob_maria_${suffix.toLowerCase()}`;
const mysqlSqlServerTargetTable = `db_lob_sqlserver_mysql_${suffix.toLowerCase()}`;
const mariaDbSqlServerTargetTable = `db_lob_sqlserver_maria_${suffix.toLowerCase()}`;
const sqlServerSourceTable = `DBLOB_MYSS_${suffix}`;
const oracleSource = `${quoteOracle(oracleSchema)}.${quoteOracle(oracleSourceTable)}`;
const mysqlTarget = `${quoteMySql(mysqlConfig.database)}.${quoteMySql(mysqlTargetTable)}`;
const mariaDbTarget = `${quoteMySql(mariaDbConfig.database)}.${quoteMySql(mariaDbTargetTable)}`;
const mysqlSqlServerTarget = `${quoteMySql(mysqlConfig.database)}.${quoteMySql(mysqlSqlServerTargetTable)}`;
const mariaDbSqlServerTarget = `${quoteMySql(mariaDbConfig.database)}.${quoteMySql(mariaDbSqlServerTargetTable)}`;
const sqlServerSource = `${quoteSqlServer("dbo")}.${quoteSqlServer(sqlServerSourceTable)}`;
const oracle = CoreService.fromOracleConfig({
  user: oracleUser,
  password: oraclePassword,
  connectString: `//127.0.0.1:${oraclePort}/${oracleServiceName}`,
  connectTimeout: 15,
  callTimeout: 120_000,
});
const mysql = CoreService.fromMySqlConfig(mysqlConfig);
const mariaDb = CoreService.fromMariaDbConfig(mariaDbConfig);
const sqlServer = CoreService.fromSqlServerConfig(sqlServerConfig);
const mysqlAdapter = new MySqlAdapter(mysqlConfig);
const mariaDbAdapter = new MariaDbAdapter(mariaDbConfig);
const sqlServerAdapter = new SqlServerAdapter(sqlServerConfig);
const expectedRows = [
  {
    id: 1,
    text: `${"a".repeat(65_535)}😀中文与补充字符 🌏 ${"数据库长文本".repeat(90_000)}`,
    national: `NCLOB 字符 🐉 ${"全国字符".repeat(70_000)}`,
    binary: randomBytes(3 * 1024 * 1024),
  },
  {
    id: 2,
    text: `第二条长记录 ${"跨库传输".repeat(25_000)}`,
    national: `第二条 NCLOB 🌏 ${"国家语种".repeat(18_000)}`,
    binary: randomBytes(256 * 1024),
  },
];
const originalStreamInsert = MySqlAdapter.prototype.insertRowWithStreamedLobs;
const originalReadPage = SqlServerAdapter.prototype.readTablePage;
let streamedRowCount = 0;
let streamedCellCount = 0;
let sqlServerStreamedCells = 0;
let primaryError;
let summary;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDirectory = path.join(root, ".cache");
mkdirSync(artifactDirectory, { recursive: true });
const evidencePath = path.join(artifactDirectory, `oracle-lob-mysql-family-transfer-20261120-${suffix.toLowerCase()}.json`);
assert.ok(!existsSync(evidencePath), "Refusing to overwrite an existing Oracle/MySQL-family LOB evidence file.");
MySqlAdapter.prototype.insertRowWithStreamedLobs = async function (table, columns, row, schema) {
  const cells = row.filter((value) => value?.__dbStudioQueryStreamCell === true);
  if (cells.length) {
    streamedRowCount += 1;
    streamedCellCount += cells.length;
  }
  return originalStreamInsert.call(this, table, columns, row, schema);
};
SqlServerAdapter.prototype.readTablePage = async function (...args) {
  const result = await originalReadPage.apply(this, args);
  if (args[0] === sqlServerSourceTable) {
    for (const row of result.rows) {
      for (const value of Object.values(row)) {
        if (value?.__dbStudioQueryStreamCell === true) sqlServerStreamedCells += 1;
      }
    }
  }
  return result;
};

try {
  await oracle.query(`CREATE TABLE ${oracleSource} ("id" NUMBER(10) NOT NULL PRIMARY KEY, "text_lob" CLOB, "national_lob" NCLOB, "binary_lob" BLOB)`);
  await mysql.query(`CREATE TABLE ${mysqlTarget} (id BIGINT NOT NULL PRIMARY KEY, text_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, national_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, binary_lob LONGBLOB NULL)`);
  await mariaDb.query(`CREATE TABLE ${mariaDbTarget} (id BIGINT NOT NULL PRIMARY KEY, text_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, national_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, binary_lob LONGBLOB NULL)`);
  await mysql.query(`CREATE TABLE ${mysqlSqlServerTarget} (id BIGINT NOT NULL PRIMARY KEY, text_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, national_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, binary_lob LONGBLOB NULL)`);
  await mariaDb.query(`CREATE TABLE ${mariaDbSqlServerTarget} (id BIGINT NOT NULL PRIMARY KEY, text_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, national_lob LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, binary_lob LONGBLOB NULL)`);
  await sqlServer.query(`CREATE TABLE ${sqlServerSource} ([id] BIGINT NOT NULL PRIMARY KEY, [text_lob] NVARCHAR(MAX) NULL, [national_lob] NVARCHAR(MAX) NULL, [binary_lob] VARBINARY(MAX) NULL)`);
  await oracle.importRows(oracleSourceTable, {
    columns: ["id", "text_lob", "national_lob", "binary_lob"],
    rows: expectedRows.map((row) => ({ id: row.id, text_lob: row.text, national_lob: row.national, binary_lob: row.binary })),
  }, oracleSchema);

  const targets = [
    { name: "mysql", service: mysql, adapter: mysqlAdapter, table: mysqlTargetTable, schema: mysqlConfig.database },
    { name: "mariadb", service: mariaDb, adapter: mariaDbAdapter, table: mariaDbTargetTable, schema: mariaDbConfig.database },
  ];
  for (const target of targets) {
    const rowsBefore = streamedRowCount;
    const cellsBefore = streamedCellCount;
    const transfer = await oracle.transferTableRows(target.service, {
      sourceTable: oracleSourceTable,
      sourceSchema: oracleSchema,
      targetTable: target.table,
      targetSchema: target.schema,
      pageSize: 50,
    });
    assert.equal(transfer.sourceRows, expectedRows.length, `${target.name} Oracle LOB source count`);
    assert.equal(transfer.insertedRows, expectedRows.length, `${target.name} Oracle LOB target count`);
    assert.equal(streamedRowCount - rowsBefore, expectedRows.length, `${target.name} rows must use the streamed insert path`);
    assert.equal(streamedCellCount - cellsBefore, expectedRows.length * 3, `${target.name} CLOB, NCLOB and BLOB cells must stream`);

    const qualifiedTarget = `${quoteMySql(target.schema)}.${quoteMySql(target.table)}`;
    const verified = await target.service.query(
      `SELECT id, OCTET_LENGTH(text_lob) AS text_bytes, SHA2(text_lob, 256) AS text_hash,
              OCTET_LENGTH(national_lob) AS national_bytes, SHA2(national_lob, 256) AS national_hash,
              OCTET_LENGTH(binary_lob) AS binary_bytes, SHA2(binary_lob, 256) AS binary_hash
       FROM ${qualifiedTarget} ORDER BY id`,
    );
    assert.deepEqual(verified.rows.map((row) => ({
      id: Number(row.id),
      textBytes: Number(row.text_bytes),
      textHash: String(row.text_hash).toLowerCase(),
      nationalBytes: Number(row.national_bytes),
      nationalHash: String(row.national_hash).toLowerCase(),
      binaryBytes: Number(row.binary_bytes),
      binaryHash: String(row.binary_hash).toLowerCase(),
    })), expectedRows.map((row) => ({
      id: row.id,
      textBytes: Buffer.byteLength(row.text, "utf8"),
      textHash: sha256(Buffer.from(row.text, "utf8")),
      nationalBytes: Buffer.byteLength(row.national, "utf8"),
      nationalHash: sha256(Buffer.from(row.national, "utf8")),
      binaryBytes: row.binary.length,
      binaryHash: sha256(row.binary),
    })), `${target.name} LOB byte lengths and SHA-256 hashes must match expected values`);
  }
  const transferStreamedRowCount = streamedRowCount;
  const transferStreamedCellCount = streamedCellCount;

  for (const row of expectedRows) {
    await sqlServerAdapter.insertRowWithStreamedLobs(
      sqlServerSourceTable,
      ["id", "text_lob", "national_lob", "binary_lob"],
      [row.id, streamedCell("utf8", row.text), streamedCell("utf8", row.national), streamedCell("buffer", row.binary)],
      "dbo",
    );
  }
  const targetsFromSqlServer = [
    { name: "mysql", service: mysql, table: mysqlSqlServerTargetTable, schema: mysqlConfig.database },
    { name: "mariadb", service: mariaDb, table: mariaDbSqlServerTargetTable, schema: mariaDbConfig.database },
  ];
  let sqlServerTargetRows = 0;
  let sqlServerTargetCells = 0;
  for (const target of targetsFromSqlServer) {
    const rowsBefore = streamedRowCount;
    const cellsBefore = streamedCellCount;
    const sourceCellsBefore = sqlServerStreamedCells;
    const transfer = await sqlServer.transferTableRows(target.service, {
      sourceTable: sqlServerSourceTable,
      sourceSchema: "dbo",
      targetTable: target.table,
      targetSchema: target.schema,
      pageSize: 50,
    });
    assert.equal(transfer.sourceRows, expectedRows.length, `${target.name} SQL Server LOB source count`);
    assert.equal(transfer.insertedRows, expectedRows.length, `${target.name} SQL Server LOB target count`);
    assert.equal(streamedRowCount - rowsBefore, expectedRows.length, `${target.name} SQL Server rows must use the streamed insert path`);
    assert.equal(streamedCellCount - cellsBefore, expectedRows.length * 3, `${target.name} SQL Server MAX text/binary cells must stream`);
    assert.equal(sqlServerStreamedCells - sourceCellsBefore, expectedRows.length * 3, `${target.name} SQL Server source page must contain bounded LOB cells`);
    sqlServerTargetRows += expectedRows.length;
    sqlServerTargetCells += expectedRows.length * 3;

    const qualifiedTarget = `${quoteMySql(target.schema)}.${quoteMySql(target.table)}`;
    const verified = await target.service.query(
      `SELECT id, OCTET_LENGTH(text_lob) AS text_bytes, SHA2(text_lob, 256) AS text_hash,
              OCTET_LENGTH(national_lob) AS national_bytes, SHA2(national_lob, 256) AS national_hash,
              OCTET_LENGTH(binary_lob) AS binary_bytes, SHA2(binary_lob, 256) AS binary_hash
       FROM ${qualifiedTarget} ORDER BY id`,
    );
    assert.deepEqual(verified.rows.map((row) => ({
      id: Number(row.id),
      textBytes: Number(row.text_bytes),
      textHash: String(row.text_hash).toLowerCase(),
      nationalBytes: Number(row.national_bytes),
      nationalHash: String(row.national_hash).toLowerCase(),
      binaryBytes: Number(row.binary_bytes),
      binaryHash: String(row.binary_hash).toLowerCase(),
    })), expectedRows.map((row) => ({
      id: row.id,
      textBytes: Buffer.byteLength(row.text, "utf8"),
      textHash: sha256(Buffer.from(row.text, "utf8")),
      nationalBytes: Buffer.byteLength(row.national, "utf8"),
      nationalHash: sha256(Buffer.from(row.national, "utf8")),
      binaryBytes: row.binary.length,
      binaryHash: sha256(row.binary),
    })), `${target.name} SQL Server-source LOB byte lengths and SHA-256 hashes must match`);
  }

  const rollbackResults = [];
  for (const target of targets) {
    let failedCellDestroyed = false;
    const failedCell = {
      __dbStudioQueryStreamCell: true,
      encoding: "utf8",
      stream: {
        async *[Symbol.asyncIterator]() {
          yield "x".repeat(140_000);
          throw new Error(`Synthetic ${target.name} LOB stream failure after first append.`);
        },
      },
      destroy() { failedCellDestroyed = true; },
    };
    await assert.rejects(
      target.adapter.insertRowWithStreamedLobs(
        target.table,
        ["id", "text_lob", "national_lob", "binary_lob"],
        [999, failedCell, null, null],
        target.schema,
      ),
      (error) => error instanceof Error && error.message.includes(`Synthetic ${target.name} LOB stream failure after first append.`),
    );
    assert.equal(failedCellDestroyed, true, `${target.name} failed stream must be destroyed`);
    const rolledBack = await target.service.query(
      `SELECT COUNT(*) AS count FROM ${quoteMySql(target.schema)}.${quoteMySql(target.table)} WHERE id = ?`,
      [999],
    );
    assert.equal(Number(rolledBack.rows[0]?.count), 0, `${target.name} stream failure must roll back the inserted row`);
    rollbackResults.push({ target: target.name, rolledBack: true, streamDestroyed: true });
  }

  summary = {
    ok: true,
    targets: ["mysql", "mariadb"],
    rowsPerTarget: expectedRows.length,
    streamedRows: transferStreamedRowCount,
    streamedCells: transferStreamedCellCount,
    sqlServerSource: {
      rowsPerTarget: expectedRows.length,
      targets: ["mysql", "mariadb"],
      streamedRows: sqlServerTargetRows,
      streamedCells: sqlServerTargetCells,
      hashesAndByteLengthsMatched: true,
      utf16SurrogateBoundaryPreserved: true,
    },
    lobSizes: expectedRows.map((row) => ({
      clobCharacters: row.text.length,
      clobUtf8Bytes: Buffer.byteLength(row.text, "utf8"),
      nclobCharacters: row.national.length,
      nclobUtf8Bytes: Buffer.byteLength(row.national, "utf8"),
      binaryBytes: row.binary.length,
    })),
    hashesAndByteLengthsMatched: true,
    rollbackResults,
    sourceDataSynthetic: true,
    sourceFilesModified: false,
    externalDataSent: false,
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  MySqlAdapter.prototype.insertRowWithStreamedLobs = originalStreamInsert;
  SqlServerAdapter.prototype.readTablePage = originalReadPage;
  for (const [service, qualified] of [[mariaDb, mariaDbTarget], [mysql, mysqlTarget], [oracle, oracleSource]]) {
    try {
      await service.query(`DROP TABLE ${qualified}`);
    } catch (error) {
      if (!/does not exist|doesn't exist|Unknown table|ORA-00942/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
    }
  }
  for (const [service, qualified] of [
    [mariaDb, mariaDbSqlServerTarget],
    [mysql, mysqlSqlServerTarget],
    [sqlServer, sqlServerSource],
  ]) {
    try {
      await service.query(`DROP TABLE ${qualified}`);
    } catch (error) {
      if (!/does not exist|doesn't exist|Unknown table|Invalid object name/i.test(error instanceof Error ? error.message : String(error))) cleanupErrors.push(error);
    }
  }
  for (const adapter of [mariaDbAdapter, mysqlAdapter]) {
    try {
      await adapter.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await sqlServerAdapter.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!primaryError && cleanupErrors.length) throw cleanupErrors[0];
}

summary.temporaryTablesCleaned = true;
writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...summary, evidence: path.relative(root, evidencePath).replaceAll("\\", "/") }, null, 2));
