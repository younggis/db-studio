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

const postgres = CoreService.fromPostgresConfig({
  host: required("DBSTUDIO_TRANSFER_PG_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_PG_PORT", "25432"),
  database: required("DBSTUDIO_TRANSFER_PG_DATABASE"),
  user: required("DBSTUDIO_TRANSFER_PG_USER"),
  password: required("DBSTUDIO_TRANSFER_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
});
const targetEngine = process.argv.includes("--mariadb") ? "mariadb" : "mysql";
const targetPrefix = `DBSTUDIO_TRANSFER_${targetEngine.toUpperCase()}`;
const targetDatabase = required(`${targetPrefix}_DATABASE`);
const targetConfig = {
  host: required(`${targetPrefix}_HOST`, "127.0.0.1"),
  port: port(`${targetPrefix}_PORT`, targetEngine === "mariadb" ? "23307" : "23306"),
  database: targetDatabase,
  user: required(`${targetPrefix}_USER`),
  password: required(`${targetPrefix}_PASSWORD`),
  connectTimeout: 8_000,
};
const targetService = targetEngine === "mariadb"
  ? CoreService.fromMariaDbConfig(targetConfig)
  : CoreService.fromMySqlConfig(targetConfig);

const suffix = randomBytes(6).toString("hex");
const postgresSource = `json_transfer_source_${suffix}`;
const postgresTarget = `json_transfer_target_${suffix}`;
const postgresPrecisionSource = `json_precision_source_${suffix}`;
const postgresPrecisionTarget = `json_precision_target_${suffix}`;
const targetTable = `json_transfer_${suffix}`;
const targetPrecisionTable = `json_precision_${suffix}`;
let createdPostgresSource = false;
let createdPostgresTarget = false;
let createdPostgresPrecisionSource = false;
let createdPostgresPrecisionTarget = false;
let createdTargetTable = false;
let createdTargetPrecisionTable = false;
let failure;

function quotePostgres(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteMysql(value) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function json(value) {
  return JSON.parse(value);
}

try {
  await postgres.query(`CREATE TABLE public.${quotePostgres(postgresSource)} (id INTEGER PRIMARY KEY, payload JSONB NULL)`);
  createdPostgresSource = true;
  await postgres.query(`CREATE TABLE public.${quotePostgres(postgresTarget)} (id INTEGER PRIMARY KEY, payload JSONB NULL)`);
  createdPostgresTarget = true;
  await postgres.query(`CREATE TABLE public.${quotePostgres(postgresPrecisionSource)} (id INTEGER PRIMARY KEY, payload JSONB NULL)`);
  createdPostgresPrecisionSource = true;
  await postgres.query(`CREATE TABLE public.${quotePostgres(postgresPrecisionTarget)} (id INTEGER PRIMARY KEY, payload JSONB NULL)`);
  createdPostgresPrecisionTarget = true;
  await targetService.query(`CREATE TABLE ${quoteMysql(targetTable)} (id INTEGER PRIMARY KEY, payload JSON NULL)`);
  createdTargetTable = true;
  await targetService.query(`CREATE TABLE ${quoteMysql(targetPrecisionTable)} (id INTEGER PRIMARY KEY, payload JSON NULL)`);
  createdTargetPrecisionTable = true;

  await postgres.query(
    `INSERT INTO public.${quotePostgres(postgresSource)} (id, payload) VALUES ` +
    `(1, 'null'::jsonb), (2, NULL), (3, '{"city":"成都","nested":[1,{"ok":true}],"fraction":0.125}'::jsonb)`,
  );
  await postgres.query(
    `INSERT INTO public.${quotePostgres(postgresPrecisionSource)} (id, payload) VALUES ` +
    `(1, '{"large":1234567890123456789012345678901234567890,"fraction":0.12345678901234567890123456789012345}'::jsonb)`,
  );

  const forward = await postgres.transferTableRows(targetService, {
    sourceTable: postgresSource,
    sourceSchema: "public",
    targetTable,
    targetSchema: targetDatabase,
    pageSize: 2,
  });
  assert.equal(forward.sourceRows, 3);
  assert.equal(forward.insertedRows, 3);

  const targetRows = (await targetService.query(
    `SELECT id, payload IS NULL AS is_sql_null, CAST(payload AS CHAR) AS payload_text, JSON_TYPE(payload) AS json_type ` +
    `FROM ${quoteMysql(targetTable)} ORDER BY id`,
  )).rows;
  assert.deepEqual(targetRows.map((row) => Number(row.id)), [1, 2, 3]);
  assert.equal(Number(targetRows[0].is_sql_null), 0);
  assert.equal(targetRows[0].payload_text, "null");
  assert.equal(targetRows[0].json_type, "NULL");
  assert.equal(Number(targetRows[1].is_sql_null), 1);
  assert.equal(targetRows[1].payload_text, null);
  assert.equal(targetRows[1].json_type, null);
  assert.deepEqual(json(targetRows[2].payload_text), { city: "成都", nested: [1, { ok: true }], fraction: 0.125 });

  let largeJsonNumbersPreserved = false;
  let mysqlUnsafeNumbersRejectedBeforeInsert = false;
  if (targetEngine === "mariadb") {
    const precisionForward = await postgres.transferTableRows(targetService, {
      sourceTable: postgresPrecisionSource,
      sourceSchema: "public",
      targetTable: targetPrecisionTable,
      targetSchema: targetDatabase,
      pageSize: 2,
    });
    assert.equal(precisionForward.sourceRows, 1);
    assert.equal(precisionForward.insertedRows, 1);
    const precisionTarget = (await targetService.query(
      `SELECT CAST(payload AS CHAR) AS payload_text FROM ${quoteMysql(targetPrecisionTable)}`,
    )).rows[0];
    assert.match(String(precisionTarget.payload_text), /"large"\s*:\s*1234567890123456789012345678901234567890/);
    assert.match(String(precisionTarget.payload_text), /"fraction"\s*:\s*0\.12345678901234567890123456789012345/);

    const precisionReverse = await targetService.transferTableRows(postgres, {
      sourceTable: targetPrecisionTable,
      sourceSchema: targetDatabase,
      targetTable: postgresPrecisionTarget,
      targetSchema: "public",
      pageSize: 2,
    });
    assert.equal(precisionReverse.sourceRows, 1);
    assert.equal(precisionReverse.insertedRows, 1);
    const precisionPostgres = (await postgres.query(
      `SELECT payload::text AS payload_text FROM public.${quotePostgres(postgresPrecisionTarget)}`,
    )).rows[0];
    assert.match(String(precisionPostgres.payload_text), /"large"\s*:\s*1234567890123456789012345678901234567890/);
    assert.match(String(precisionPostgres.payload_text), /"fraction"\s*:\s*0\.12345678901234567890123456789012345/);
    largeJsonNumbersPreserved = true;
  } else {
    await assert.rejects(
      postgres.transferTableRows(targetService, {
        sourceTable: postgresPrecisionSource,
        sourceSchema: "public",
        targetTable: targetPrecisionTable,
        targetSchema: targetDatabase,
        pageSize: 2,
      }),
      /MySQL JSON would change this number/,
    );
    const precisionTarget = (await targetService.query(
      `SELECT COUNT(*) AS row_count FROM ${quoteMysql(targetPrecisionTable)}`,
    )).rows[0];
    assert.equal(Number(precisionTarget.row_count), 0);
    mysqlUnsafeNumbersRejectedBeforeInsert = true;
  }

  const reverse = await targetService.transferTableRows(postgres, {
    sourceTable: targetTable,
    sourceSchema: targetDatabase,
    targetTable: postgresTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(reverse.sourceRows, 3);
  assert.equal(reverse.insertedRows, 3);

  const postgresRows = (await postgres.query(
    `SELECT id, payload IS NULL AS is_sql_null, payload::text AS payload_text ` +
    `FROM public.${quotePostgres(postgresTarget)} ORDER BY id`,
  )).rows;
  assert.deepEqual(postgresRows.map((row) => Number(row.id)), [1, 2, 3]);
  assert.equal(postgresRows[0].is_sql_null, false);
  assert.equal(postgresRows[0].payload_text, "null");
  assert.equal(postgresRows[1].is_sql_null, true);
  assert.equal(postgresRows[1].payload_text, null);
  assert.deepEqual(json(postgresRows[2].payload_text), { city: "成都", nested: [1, { ok: true }], fraction: 0.125 });

  process.stdout.write(JSON.stringify({
    ok: true,
    targetEngine,
    directionCount: 2,
    sourceRowsPerDirection: 3,
    jsonNullPreservedAsJson: true,
    sqlNullPreservedAsSqlNull: true,
    nestedUnicodeJsonPreserved: true,
    largeJsonNumbersPreserved,
    mysqlUnsafeNumbersRejectedBeforeInsert,
  }, null, 2));
} catch (error) {
  failure = error;
  throw error;
} finally {
  const cleanupErrors = [];
  for (const [service, schema, table, created] of [
    [targetService, undefined, targetTable, createdTargetTable],
    [targetService, undefined, targetPrecisionTable, createdTargetPrecisionTable],
    [postgres, "public", postgresTarget, createdPostgresTarget],
    [postgres, "public", postgresPrecisionTarget, createdPostgresPrecisionTarget],
    [postgres, "public", postgresSource, createdPostgresSource],
    [postgres, "public", postgresPrecisionSource, createdPostgresPrecisionSource],
  ]) {
    if (!created) continue;
    const name = schema ? `${quotePostgres(schema)}.${quotePostgres(table)}` : quoteMysql(table);
    try {
      await service.query(`DROP TABLE ${name}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!failure && cleanupErrors.length) throw cleanupErrors[0];
}
