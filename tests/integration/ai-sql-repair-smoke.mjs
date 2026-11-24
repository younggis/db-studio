import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSqlAssistant } from "../../packages/ai/dist/index.js";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = path.join(root, "docker", ".env");
function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]));
}

const env = parseEnvFile(envPath);
assert.ok(env.DBSTUDIO_PG_USER && env.DBSTUDIO_PG_PASSWORD, "Configure the isolated PostgreSQL test credentials in docker/.env.");
const runId = randomBytes(4).toString("hex");
const pgTarget = {
  engine: "postgres", dialect: "PostgreSQL", schema: "public", table: `ai_repair_${runId}`,
  host: "127.0.0.1", port: Number(env.DBSTUDIO_POSTGIS_PORT || "25432"),
  database: env.DBSTUDIO_PG_DATABASE || "dbstudio_test", user: env.DBSTUDIO_PG_USER, password: env.DBSTUDIO_PG_PASSWORD,
};
const sqliteDirectory = path.join(root, ".cache", "ai-sql-repair-smoke");
mkdirSync(sqliteDirectory, { recursive: true });
const sqliteTarget = { engine: "sqlite", dialect: "SQLite", schema: "main", table: `ai_repair_${runId}`, path: path.join(sqliteDirectory, `${runId}.sqlite`) };
const spatialTarget = { ...pgTarget, dialect: "PostGIS", table: `ai_repair_gis_${runId}` };

function coreFor(target) {
  if (target.engine === "postgres") return CoreService.fromPostgresConfig({
    host: target.host, port: target.port, database: target.database, user: target.user, password: target.password, connectionTimeoutMillis: 10_000,
  });
  return CoreService.fromSqliteConfig({ path: target.path });
}

function quote(engine, name) {
  if (engine === "mysql" || engine === "mariadb") return `\`${name.replaceAll("`", "``")}\``;
  return `"${name.replaceAll('"', '""')}"`;
}

function tableRef(target, schema = target.schema, table = target.table) {
  return target.engine === "sqlite" ? quote(target.engine, table) : `${quote(target.engine, schema)}.${quote(target.engine, table)}`;
}

async function getContext(core, target) {
  const tested = await core.testConnection();
  const tables = await core.listTables(target.schema);
  const found = tables.find((candidate) => candidate.name.toLowerCase() === target.table.toLowerCase());
  assert.ok(found, `${target.engine} repair fixture was not visible in the live schema.`);
  const columns = await core.getTableColumns(found.name, found.schema);
  return {
    engine: target.engine,
    serverVersion: tested.serverVersion,
    database: tested.database,
    schema: found.schema,
    tables: [{
      schema: found.schema, name: found.name, type: found.type,
      columns: columns.map((column) => ({ name: column.name, dataType: column.dataType, nullable: column.nullable, primaryKey: column.primaryKey })),
      foreignKeys: [],
    }],
  };
}

function createResponse(sql, dialect) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    task: "repair", dialect, sql,
    explanation: "根据实际错误与所选 Schema 修正为单条只读查询。",
    referencedObjects: [], assumptions: [], warnings: [],
  }) } }] });
}

const reports = [];
const providerErrors = [];
let server;
let pgCreated = false;
let sqliteCreated = false;
let spatialCreated = false;
const pg = coreFor(pgTarget);
const sqlite = coreFor(sqliteTarget);
const spatial = coreFor(spatialTarget);

try {
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const envelope = JSON.parse(body);
        const userText = envelope.messages.find((message) => message.role === "user")?.content ?? "{}";
        const input = JSON.parse(userText);
        assert.equal(input.task, "repair", "Unexpected task sent to the local repair model.");
        assert.ok(input.databaseContext?.tables?.length, "Repair input did not contain the selected live Schema.");
        assert.ok(input.databaseContext.selectedSql, "Repair input omitted the broken SQL.");
        assert.ok(input.databaseContext.error?.message, "Repair input omitted the real database error.");
        const testCase = input.request.match(/REPAIR_CASE:([a-z-]+)/)?.[1];
        assert.ok(testCase, "Missing repair case identifier.");
        const context = input.databaseContext;
        const table = context.tables[0];
        const target = testCase === "sqlite-date" ? sqliteTarget : testCase.startsWith("postgis-") ? spatialTarget : pgTarget;
        const ref = tableRef(target, table.schema, table.name);
        let sql;
        if (testCase === "case-column") sql = `SELECT COUNT(*) AS repaired_count FROM ${ref} WHERE ${quote("postgres", "CaseStatus")} = 'active'`;
        else if (testCase === "dialect-syntax") sql = `SELECT COUNT(*) AS repaired_count FROM ${ref}`;
        else if (testCase === "join-condition") sql = `SELECT COUNT(*) AS repaired_count FROM ${ref} AS left_row JOIN ${ref} AS right_row ON left_row."id" = right_row."id" WHERE left_row."status" = 'active'`;
        else if (testCase === "group-by") sql = `SELECT "status", COUNT(*) AS row_count FROM ${ref} GROUP BY "status"`;
        else if (testCase === "sqlite-date") sql = `SELECT COUNT(*) AS repaired_count FROM ${ref} WHERE date("event_date") >= date('2026-01-01')`;
        else if (testCase === "postgis-srid") sql = `SELECT COUNT(*) AS repaired_count FROM ${ref} WHERE ST_DWithin("location", ST_SetSRID(ST_MakePoint(0, 0), 4326), 0.01)`;
        else if (testCase === "postgis-geometry-type") sql = `SELECT COUNT(*) AS repaired_count FROM ${ref} WHERE ST_DWithin("location", ST_SetSRID(ST_MakePoint(0, 0), 4326), 0.01)`;
        else sql = `SELECT COUNT(*) AS repaired_count FROM ${ref} WHERE ${quote(target.engine, "status")} = 'active'`;
        response.setHeader("content-type", "application/json");
        response.end(createResponse(sql, testCase.startsWith("postgis-") ? "PostgreSQL" : target.dialect));
      } catch (error) {
        providerErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Local repair fixture construction failed." } }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    id: "repair-integration-loopback", name: "deterministic local test", provider: "openai-compatible",
    baseURL: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "local-only-test-key", enabled: true, timeoutMs: 10_000,
  };

  await pg.query(`CREATE TABLE ${tableRef(pgTarget)} ("id" integer, "status" text, "CaseStatus" text)`);
  pgCreated = true;
  for (const [id, status] of [[1, "active"], [2, "inactive"], [3, "active"]]) {
    await pg.query(`INSERT INTO ${tableRef(pgTarget)} ("id", "status", "CaseStatus") VALUES ($1, $2, $2)`, [id, status]);
  }
  await sqlite.query(`CREATE TABLE ${tableRef(sqliteTarget)} ("id" INTEGER, "status" TEXT, "event_date" TEXT)`);
  sqliteCreated = true;
  for (const [id, status] of [[1, "active"], [2, "inactive"], [3, "active"]]) {
    await sqlite.query(`INSERT INTO ${tableRef(sqliteTarget)} ("id", "status", "event_date") VALUES (?, ?, ?)`, [id, status, "2026-11-01"]);
  }
  await spatial.query(`CREATE TABLE ${tableRef(spatialTarget)} ("id" integer, "location" geometry(Point, 4326))`);
  spatialCreated = true;
  for (const [id, y] of [[1, 0.005], [2, 0.009], [3, 0.03]]) {
    await spatial.query(`INSERT INTO ${tableRef(spatialTarget)} ("id", "location") VALUES ($1, ST_SetSRID(ST_MakePoint(0, $2), 4326))`, [id, y]);
  }

  const pgContext = await getContext(pg, pgTarget);
  const sqliteContext = await getContext(sqlite, sqliteTarget);
  const spatialContext = await getContext(spatial, spatialTarget);
  const [geometryInfo, postgisVersion] = await Promise.all([
    spatial.query("SELECT type, srid, coord_dimension FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = 'location'", [spatialTarget.schema, spatialTarget.table]),
    spatial.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'"),
  ]);
  assert.ok(geometryInfo.rows[0], "The PostGIS repair fixture is missing real geometry metadata.");
  assert.ok(postgisVersion.rows[0]?.version, "The PostGIS repair fixture could not read the live extension version.");
  spatialContext.tables[0].columns = spatialContext.tables[0].columns.map((column) => column.name === "location"
    ? { ...column, spatial: { kind: "geometry", geometryType: geometryInfo.rows[0].type, srid: Number(geometryInfo.rows[0].srid), coordinateDimension: Number(geometryInfo.rows[0].coord_dimension) } }
    : column);
  spatialContext.postgis = { version: String(postgisVersion.rows[0].version), spatialColumns: [{ schema: spatialTarget.schema, table: spatialTarget.table, column: "location", kind: "geometry", geometryType: geometryInfo.rows[0].type, srid: Number(geometryInfo.rows[0].srid), coordinateDimension: Number(geometryInfo.rows[0].coord_dimension) }], supportedFunctions: ["ST_DWITHIN", "ST_DISTANCE"] };

  const cases = [
    { id: "missing-table", core: pg, context: pgContext, selectedSql: `SELECT COUNT(*) FROM ${tableRef(pgTarget, "public", `missing_${runId}`)}`, request: "Count active rows.", expected: 2 },
    { id: "missing-column", core: pg, context: pgContext, selectedSql: `SELECT "missing_column" FROM ${tableRef(pgTarget)}`, request: "Count active rows.", expected: 2 },
    { id: "case-column", core: pg, context: pgContext, selectedSql: `SELECT CaseStatus FROM ${tableRef(pgTarget)}`, request: "Count rows where the case-sensitive status equals active.", expected: 2 },
    { id: "dialect-syntax", core: pg, context: pgContext, selectedSql: `SELECT TOP 1 "id" FROM ${tableRef(pgTarget)}`, request: "Count all rows.", expected: 3 },
    { id: "join-condition", core: pg, context: pgContext, selectedSql: `SELECT left_row."id" FROM ${tableRef(pgTarget)} AS left_row JOIN ${tableRef(pgTarget)} AS right_row ON`, request: "Count active rows matched by id.", expected: 2 },
    { id: "group-by", core: pg, context: pgContext, selectedSql: `SELECT "status", COUNT(*) FROM ${tableRef(pgTarget)}`, request: "Count rows per status.", expected: 3 },
    { id: "sqlite-date", core: sqlite, context: sqliteContext, selectedSql: `SELECT DATE_TRUNC('day', "event_date") FROM ${tableRef(sqliteTarget)}`, request: "Count rows on or after 2026-01-01.", expected: 3 },
    { id: "sql-parameter", core: pg, context: pgContext, selectedSql: `SELECT COUNT(*) FROM ${tableRef(pgTarget)} WHERE "id" = $1`, request: "Count active rows.", expected: 2 },
    { id: "postgis-srid", core: spatial, context: spatialContext, selectedSql: `SELECT ST_DWithin("location", ST_SetSRID(ST_MakePoint(0, 0), 3857), 1000) FROM ${tableRef(spatialTarget)}`, request: "Count features within 0.01 degrees of origin.", expected: 2 },
    { id: "postgis-geometry-type", core: spatial, context: spatialContext, selectedSql: `SELECT ST_LineInterpolatePoint("location", 0.5) FROM ${tableRef(spatialTarget)}`, request: "Count features within 0.01 degrees of origin.", expected: 2 },
  ];

  for (const item of cases) {
    let databaseError;
    try { await item.core.query(item.selectedSql); } catch (error) { databaseError = error; }
    assert.ok(databaseError, `${item.id} fixture SQL unexpectedly succeeded; the case would not exercise repair.`);
    const context = { ...item.context, selectedSql: item.selectedSql, error: {
      code: typeof databaseError.code === "string" ? databaseError.code : undefined,
      message: databaseError instanceof Error ? databaseError.message : String(databaseError),
    } };
    const repaired = await runSqlAssistant(model, { task: "repair", request: `REPAIR_CASE:${item.id} ${item.request}`, context });
    assert.equal(repaired.result.task, "repair");
    assert.equal(repaired.validation?.valid, true, `${item.id} repair failed static validation: ${repaired.validation?.errors.join("; ")}`);
    const result = await item.core.query(repaired.result.sql ?? "");
    const countValue = item.id === "group-by"
      ? result.rows.reduce((sum, row) => sum + Number(Object.entries(row).find(([key]) => key.toLowerCase() === "row_count")?.[1] ?? 0), 0)
      : Number(Object.values(result.rows[0] ?? {})[0]);
    assert.equal(countValue, item.expected, `${item.id} repaired SQL returned the wrong expected result.`);
    reports.push({ case: item.id, engine: context.engine, databaseErrorObserved: true, staticValidationPassed: true, expectedResult: item.expected });
  }
} finally {
  if (spatialCreated) await spatial.query(`DROP TABLE ${tableRef(spatialTarget)}`).catch(() => undefined);
  if (pgCreated) await pg.query(`DROP TABLE ${tableRef(pgTarget)}`).catch(() => undefined);
  if (sqliteCreated) await sqlite.query(`DROP TABLE ${tableRef(sqliteTarget)}`).catch(() => undefined);
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  if (existsSync(sqliteTarget.path)) rmSync(sqliteTarget.path, { force: true });
}

assert.deepEqual(providerErrors, [], "The local deterministic model failed to construct one or more repair results.");
assert.equal(reports.length, 10, "A required SQL repair case did not complete.");
assert.equal(existsSync(sqliteTarget.path), false, "The SQLite repair fixture was not cleaned up.");
process.stdout.write(`${JSON.stringify({ provider: "deterministic loopback; no external model call", results: reports, allTenRepairCasesPassed: reports.length === 10, sqliteFileCleaned: !existsSync(sqliteTarget.path) }, null, 2)}\n`);
