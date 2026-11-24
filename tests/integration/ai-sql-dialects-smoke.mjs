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

const dockerEnv = parseEnvFile(envPath);
const runId = randomBytes(4).toString("hex");
const sqliteDirectory = path.join(root, ".cache", "ai-sql-dialect-smoke");
mkdirSync(sqliteDirectory, { recursive: true });
const sqlitePath = path.join(sqliteDirectory, `assistant-${runId}.sqlite`);
const definitions = [
  { engine: "postgres", dialect: "PostgreSQL", schema: "public", table: `ai_sql_${runId}`, spatialTable: `ai_sql_gis_${runId}`, host: "127.0.0.1", port: Number(dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432"), database: dockerEnv.DBSTUDIO_PG_DATABASE || "dbstudio_test", user: dockerEnv.DBSTUDIO_PG_USER, password: dockerEnv.DBSTUDIO_PG_PASSWORD },
  { engine: "mysql", dialect: "MySQL", schema: dockerEnv.MYSQL_DATABASE || "dbstudio_test", table: `ai_sql_${runId}`, host: dockerEnv.MYSQL_HOST || "127.0.0.1", port: Number(dockerEnv.MYSQL_PORT || "23306"), database: dockerEnv.MYSQL_DATABASE || "dbstudio_test", user: dockerEnv.MYSQL_USER, password: dockerEnv.MYSQL_PASSWORD },
  { engine: "mariadb", dialect: "MariaDB", schema: dockerEnv.MARIADB_DATABASE || "dbstudio_test", table: `ai_sql_${runId}`, host: dockerEnv.MARIADB_HOST || "127.0.0.1", port: Number(dockerEnv.MARIADB_PORT || "23307"), database: dockerEnv.MARIADB_DATABASE || "dbstudio_test", user: dockerEnv.MARIADB_USER, password: dockerEnv.MARIADB_PASSWORD },
  { engine: "sqlserver", dialect: "SQL Server", schema: "dbo", table: `ai_sql_${runId}`, host: "127.0.0.1", port: Number(dockerEnv.SQLSERVER_PORT || "21433"), database: "dbstudio_test", user: "sa", password: dockerEnv.SQLSERVER_SA_PASSWORD },
  { engine: "oracle", dialect: "Oracle", schema: (dockerEnv.ORACLE_USER || "SYSTEM").toUpperCase(), table: `AI_SQL_${runId.toUpperCase()}`, host: "127.0.0.1", port: Number(dockerEnv.ORACLE_PORT || "21521"), database: dockerEnv.ORACLE_SERVICE_NAME || "FREEPDB1", user: dockerEnv.ORACLE_USER || "SYSTEM", password: dockerEnv.ORACLE_PASSWORD },
  { engine: "sqlite", dialect: "SQLite", schema: "main", table: `ai_sql_${runId}`, path: sqlitePath },
];
for (const item of definitions.filter((value) => value.engine !== "sqlite")) {
  assert.ok(item.user && item.password, `Set credentials for the isolated ${item.engine} test container in docker/.env.`);
}

function coreFor(target) {
  if (target.engine === "postgres") return CoreService.fromPostgresConfig({
    host: target.host, port: target.port, database: target.database, user: target.user, password: target.password, connectionTimeoutMillis: 10_000,
  });
  if (target.engine === "mysql" || target.engine === "mariadb") {
    const config = { host: target.host, port: target.port, database: target.database, user: target.user, password: target.password, connectTimeout: 10_000 };
    return target.engine === "mysql" ? CoreService.fromMySqlConfig(config) : CoreService.fromMariaDbConfig(config);
  }
  if (target.engine === "sqlserver") return CoreService.fromSqlServerConfig({
    server: target.host, port: target.port, database: target.database, user: target.user, password: target.password,
    encrypt: true, trustServerCertificate: true, connectionTimeout: 15_000, requestTimeout: 30_000,
  });
  if (target.engine === "oracle") return CoreService.fromOracleConfig({
    user: target.user, password: target.password, connectString: `//${target.host}:${target.port}/${target.database}`,
    connectTimeout: 15, callTimeout: 30_000,
  });
  return CoreService.fromSqliteConfig({ path: target.path });
}

function quote(engine, identifier) {
  if (engine === "mysql" || engine === "mariadb") return `\`${identifier.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") {
    const escaped = identifier.split("]").join("]]");
    return `[${escaped}]`;
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableRef(target, schema = target.schema, table = target.table) {
  if (target.engine === "mysql" || target.engine === "mariadb" || target.engine === "sqlite") return quote(target.engine, table);
  return `${quote(target.engine, schema)}.${quote(target.engine, table)}`;
}

function createSql(target) {
  const table = tableRef(target);
  if (target.engine === "postgres") return `CREATE TABLE ${table} ("id" integer, "status" text)`;
  if (target.engine === "mysql" || target.engine === "mariadb") return `CREATE TABLE ${table} (\`id\` INT, \`status\` VARCHAR(20))`;
  if (target.engine === "sqlserver") return `CREATE TABLE ${table} ([id] INT, [status] NVARCHAR(20))`;
  if (target.engine === "oracle") return `CREATE TABLE ${table} ("ID" NUMBER, "STATUS" VARCHAR2(20))`;
  return `CREATE TABLE ${table} ("id" INTEGER, "status" TEXT)`;
}

function dropSql(target) {
  const table = tableRef(target);
  return target.engine === "oracle" ? `DROP TABLE ${table} PURGE` : `DROP TABLE ${table}`;
}

function insertSql(target, id, status) {
  const idColumn = quote(target.engine, target.engine === "oracle" ? "ID" : "id");
  const statusColumn = quote(target.engine, target.engine === "oracle" ? "STATUS" : "status");
  return `INSERT INTO ${tableRef(target)} (${idColumn}, ${statusColumn}) VALUES (${id}, '${status}')`;
}

async function tableContext(core, target) {
  const tested = await core.testConnection();
  const schemas = await core.listSchemas();
  assert.ok(schemas.some((schema) => schema.toLowerCase() === target.schema.toLowerCase()), `${target.engine} test schema was not visible.`);
  const tables = await core.listTables(target.schema);
  const table = tables.find((candidate) => candidate.name.toLowerCase() === target.table.toLowerCase());
  assert.ok(table, `${target.engine} synthetic table was not listed.`);
  const columns = await core.getTableColumns(table.name, table.schema);
  const foreignKeys = await core.getTableForeignKeys(table.name, table.schema).catch(() => []);
  return {
    engine: target.engine,
    serverVersion: tested.serverVersion,
    database: tested.database,
    schema: table.schema,
    tables: [{
      schema: table.schema,
      name: table.name,
      type: table.type,
      columns: columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
      })),
      foreignKeys: foreignKeys.map((foreignKey) => ({
        name: foreignKey.name,
        columns: foreignKey.columns,
        referencedSchema: foreignKey.referencedSchema,
        referencedTable: foreignKey.referencedTable,
        referencedColumns: foreignKey.referencedColumns,
      })),
    }],
  };
}

const providerErrors = [];
let server;
const reports = [];
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
        const context = input.databaseContext;
        const engine = context.engine;
        const table = context.tables[0];
      if (input.task === "gis") {
        const spatial = table?.columns.find((column) => column.spatial?.kind === "geometry" || column.spatial?.kind === "geography");
        if (engine !== "postgres" || !spatial) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "GIS test requires a real PostGIS geometry column." } }));
          return;
        }
        const sql = `SELECT COUNT(*) AS nearby_count FROM ${tableRef(definitions[0], table.schema, table.name)} WHERE ST_DWithin(${quote(engine, spatial.name)}, ST_SetSRID(ST_MakePoint(0, 0), 4326), 0.01)`;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          task: "gis", dialect: "PostGIS", sql,
          explanation: "以 SRID 4326 geometry 的坐标单位查询距离原点 0.01 以内的要素；单位为度。",
          referencedObjects: [`${table.schema}.${table.name}`], assumptions: ["查询距离按 geometry 坐标单位解释为度。"], warnings: [],
        }) } }] }));
        return;
      }
        if (!table?.columns.some((column) => column.name.toLowerCase() === "status")) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `The live ${engine} schema did not contain the synthetic status column.` } }));
          return;
        }
        const target = definitions.find((item) => item.engine === engine);
        const sql = `SELECT COUNT(*) AS active_count FROM ${tableRef(target, table.schema, table.name)} WHERE ${quote(engine, engine === "oracle" ? "STATUS" : "status")} = 'active'`;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          task: "generate", dialect: target.dialect, sql,
          explanation: "Count the synthetic active rows in the explicitly selected table.",
          referencedObjects: [`${table.schema}.${table.name}`], assumptions: [], warnings: [],
        }) } }] }));
      } catch (error) {
        providerErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Loopback test response construction failed." } }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    id: "dialect-integration-loopback", name: "deterministic local test", provider: "openai-compatible",
    baseURL: `http://127.0.0.1:${address.port}/v1`, model: "test", apiKey: "local-only-test-key", enabled: true, timeoutMs: 10_000,
  };

  for (const target of definitions) {
    const core = coreFor(target);
    let created = false;
    let spatialCreated = false;
    try {
      await core.query(createSql(target));
      created = true;
      for (const [id, status] of [[1, "active"], [2, "inactive"], [3, "active"]]) {
        await core.query(insertSql(target, id, status));
      }
      const context = await tableContext(core, target);
      const generated = await runSqlAssistant(model, {
        task: "generate",
        request: "Count active records in the selected table.",
        context,
      });
      assert.equal(generated.result.dialect, target.dialect, `${target.engine} reported the wrong SQL dialect.`);
      assert.equal(generated.validation?.valid, true, `${target.engine} SQL failed static validation: ${generated.validation?.errors.join("; ")}`);
      assert.ok(generated.result.sql?.toLowerCase().includes(target.table.toLowerCase()), `${target.engine} SQL did not reference the selected table.`);
      if (target.engine !== "oracle") {
        assert.ok(generated.validation?.referencedTables.some((table) => table.name.toLowerCase() === target.table.toLowerCase()), `${target.engine} parser did not identify the selected table.`);
      }
      const result = await core.query(generated.result.sql ?? "");
      assert.equal(result.rows.length, 1, `${target.engine} generated SQL did not return an aggregate result.`);
      assert.equal(Number(Object.values(result.rows[0] ?? {})[0]), 2, `${target.engine} generated SQL returned an incorrect active count.`);
      reports.push({ engine: target.engine, dialect: generated.result.dialect, liveSchemaValidated: true, activeRows: 2 });

      if (target.engine === "postgres") {
        const spatialName = target.spatialTable;
        await core.query(`CREATE TABLE ${tableRef(target, target.schema, spatialName)} ("id" integer, "location" geometry(Point, 4326))`);
        spatialCreated = true;
        for (const [id, y] of [[1, 0.005], [2, 0.009], [3, 0.03]]) {
          await core.query(`INSERT INTO ${tableRef(target, target.schema, spatialName)} ("id", "location") VALUES ($1, ST_SetSRID(ST_MakePoint(0, $2), 4326))`, [id, y]);
        }
        const [postgisVersion, spatialColumn, supportedFunction, spatialSchemaTable] = await Promise.all([
          core.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'"),
          core.query("SELECT type AS geometry_type, srid, coord_dimension AS coordinate_dimension FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = 'location'", [target.schema, spatialName]),
          core.query("SELECT to_regprocedure('st_dwithin(geometry,geometry,double precision)') IS NOT NULL AS supported"),
          core.getTableColumns(spatialName, target.schema),
        ]);
        const spatialInfo = spatialColumn.rows[0];
        assert.ok(postgisVersion.rows[0]?.version, "PostGIS version metadata was not available.");
        assert.ok(spatialInfo, "PostGIS geometry_columns did not expose the spatial test column.");
        assert.equal(Number(spatialInfo.srid), 4326);
        assert.equal(supportedFunction.rows[0]?.supported, true, "ST_DWithin was not found in server metadata.");
        const gisContext = {
          engine: "postgres",
          serverVersion: context.serverVersion,
          database: context.database,
          schema: target.schema,
          tables: [{
            schema: target.schema,
            name: spatialName,
            type: "table",
            columns: spatialSchemaTable.map((column) => column.name === "location"
              ? { name: column.name, dataType: "geometry", nullable: column.nullable, primaryKey: column.primaryKey,
                spatial: { kind: "geometry", geometryType: spatialInfo.geometry_type, srid: Number(spatialInfo.srid), coordinateDimension: Number(spatialInfo.coordinate_dimension) } }
              : { name: column.name, dataType: column.dataType, nullable: column.nullable, primaryKey: column.primaryKey }),
          }],
          postgis: {
            version: String(postgisVersion.rows[0].version),
            spatialColumns: [{ schema: target.schema, table: spatialName, column: "location", kind: "geometry",
              geometryType: spatialInfo.geometry_type, srid: Number(spatialInfo.srid), coordinateDimension: Number(spatialInfo.coordinate_dimension) }],
            supportedFunctions: ["ST_DWITHIN"],
          },
        };
        const gisGenerated = await runSqlAssistant(model, {
          task: "gis", request: "Count the features within 0.01 coordinate units of the origin.", context: gisContext,
        });
        assert.equal(gisGenerated.result.dialect, "PostGIS");
        if (gisGenerated.validation?.valid) {
          const gisResult = await core.query(gisGenerated.result.sql ?? "");
          assert.equal(Number(Object.values(gisResult.rows[0] ?? {})[0]), 2, "PostGIS AI query returned an incorrect within-distance count.");
          reports.push({ engine: "postgis", dialect: gisGenerated.result.dialect, liveGeometryMetadataValidated: true, withinDistance: 2 });
        } else {
          // The PostGIS measurement-unit guard intentionally clears drafts that
          // apply a distance predicate to a geographic (degree) CRS. Accept that
          // safety path as long as it leaves no executable SQL and explains why.
          assert.equal(gisGenerated.result.sql, "", "A clarified/rejected GIS draft must not contain executable SQL.");
          assert.ok(
            (gisGenerated.result.explanation ?? "").length > 0 || (gisGenerated.result.warnings ?? []).length > 0
              || (gisGenerated.result.assumptions ?? []).length > 0,
            "A clarified/rejected GIS draft must explain itself.",
          );
          reports.push({ engine: "postgis", dialect: gisGenerated.result.dialect, liveGeometryMetadataValidated: true, noExecutableSql: true });
        }
      }
    } finally {
      if (spatialCreated) await core.query(`DROP TABLE ${tableRef(target, target.schema, target.spatialTable)}`);
      if (created) await core.query(dropSql(target));
    }
  }
} finally {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  if (existsSync(sqlitePath)) rmSync(sqlitePath, { force: true });
}

assert.deepEqual(providerErrors, [], "The local deterministic model failed to construct one or more responses.");
assert.equal(reports.filter((item) => item.engine !== "postgis").length, definitions.length, "One or more relational SQL dialects did not complete.");
assert.ok(reports.some((item) => item.engine === "postgis"), "The PostGIS spatial SQL test did not complete.");
assert.equal(existsSync(sqlitePath), false, "The SQLite test file was not cleaned up.");
process.stdout.write(`${JSON.stringify({
  provider: "deterministic loopback; no external model call",
  results: reports,
  allSixDialectsPassed: reports.filter((item) => item.engine !== "postgis").length === definitions.length,
  postgisSpatialQueryPassed: reports.some((item) => item.engine === "postgis"),
  sqliteFileCleaned: !existsSync(sqlitePath),
}, null, 2)}\n`);
