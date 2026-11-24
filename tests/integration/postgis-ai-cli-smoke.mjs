import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const envPath = path.join(root, "docker", ".env");
const dockerEnv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]))
  : {};
const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "postgres",
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? dockerEnv.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? dockerEnv.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? dockerEnv.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? dockerEnv.DBSTUDIO_PG_PASSWORD,
};
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Configure the authorized project PostGIS test service first.");
assert.ok(existsSync(cli), "Build the CLI first.");

const table = "dbsa_" + Date.now().toString(36) + "_" + randomBytes(3).toString("hex");
const columnTable = "dbsa_columns_" + Date.now().toString(36) + "_" + randomBytes(3).toString("hex");
const columnName = "display_label";
const columnComment = "unique_column_note_" + randomBytes(4).toString("hex");
const core = CoreService.fromEnvironment(environment);
const sqlDraft = `SELECT id FROM public.${table}
WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326)::geography, 500)`;
const requestPayloads = [];
let primaryError;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requestPayloads.push(requestPayload);
    const isGisRequest = requestPayloads.length === 1;
    const content = JSON.stringify(isGisRequest ? {
      task: "gis", dialect: "PostGIS", sql: sqlDraft,
      explanation: "使用 geography 列执行 500 米范围查询。",
      referencedObjects: [`public.${table}`], assumptions: [], warnings: [],
    } : {
      task: "generate", dialect: "PostgreSQL",
      sql: `SELECT "${columnName}" FROM public."${columnTable}"`,
      explanation: "读取匹配的字段。",
      referencedObjects: [`public.${columnTable}`], assumptions: [], warnings: [],
    });
    response.writeHead(200, { "content-type": requestPayload.stream ? "text/event-stream" : "application/json" });
    if (requestPayload.stream) {
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid local smoke-test request." } }));
  }
});

try {
  await core.query(`CREATE TABLE public."${table}" (
    id integer PRIMARY KEY,
    geom geometry(Point, 4326),
    geog geography(Point, 4326)
  )`);
  await core.query(`CREATE TABLE public."${columnTable}" ("${columnName}" text)`);
  await core.query(`COMMENT ON COLUMN public."${columnTable}"."${columnName}" IS '${columnComment}'`);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const modelEnvironment = {
    ...environment,
    MODEL_OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    MODEL_OPENAI_API_KEY: "local-smoke-test-key",
    MODEL_OPENAI_MODEL: "local-postgis-context-smoke",
    MODEL_OPENAI_TIMEOUT_MS: "10000",
  };
  const { stdout } = await execFileAsync(process.execPath, [
    cli, "ai", "sql", "gis",
    "--connection", "environment",
    "--request", `查找距指定点 500 米内的要素，使用 ${table} 表的 geography 列`,
    "--schema", "public",
    "--table", `public.${table}`,
    "--include-schema",
    "--format", "json",
  ], { cwd: root, env: modelEnvironment, encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });

  assert.equal(requestPayloads.length, 1, "The CLI GIS command should send one request to the loopback model stub.");
  const messages = requestPayloads[0].messages;
  assert.ok(Array.isArray(messages));
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const user = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}");
  const spatialColumns = user.databaseContext?.postgis?.spatialColumns ?? [];
  assert.ok(system.includes("Geography distances use meters"));
  assert.ok(system.includes("Never assume geometry units are meters"));
  assert.deepEqual(spatialColumns.map((column) => [column.column, column.kind, column.srid]).sort(), [
    ["geog", "geography", 4326], ["geom", "geometry", 4326],
  ]);
  assert.ok(user.databaseContext.postgis.supportedFunctions.includes("ST_DWITHIN"));

  const output = JSON.parse(stdout);
  assert.equal(output.validation?.valid, true);
  assert.match(output.result.sql, /ST_DWithin/i);
  assert.equal(output.result.referencedObjects[0], `public.${table}`);

  const runColumnLookup = async (requestText) => {
    const result = await execFileAsync(process.execPath, [
      cli, "ai", "sql", "generate",
      "--connection", "environment",
      "--request", requestText,
      "--schema", "public",
      "--include-schema",
      "--format", "json",
    ], { cwd: root, env: modelEnvironment, encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const columnNameOutput = await runColumnLookup(`查询字段 ${columnName}`);
  const columnCommentOutput = await runColumnLookup(`查询说明 ${columnComment}`);
  assert.equal(requestPayloads.length, 3, "Both schema fallback requests should reach the loopback model.");
  for (const [index, expectedRequest] of [
    [1, `查询字段 ${columnName}`],
    [2, `查询说明 ${columnComment}`],
  ]) {
    const payload = requestPayloads[index];
    assert.ok(payload);
    const userMessage = JSON.parse(payload.messages.find((message) => message.role === "user")?.content ?? "{}");
    assert.equal(userMessage.request, expectedRequest);
    const matchedTable = userMessage.databaseContext?.tables?.find((item) => item.schema === "public" && item.name === columnTable);
    assert.ok(matchedTable, "Field name and field comment searches should select the matching table without --table.");
    assert.ok(matchedTable.columns.some((column) => column.name === columnName && column.comment === columnComment));
  }
  assert.equal(columnNameOutput.validation?.valid, true);
  assert.equal(columnCommentOutput.validation?.valid, true);
  process.stdout.write(`${JSON.stringify({
    cliGisCommand: true,
    modelEndpoint: "loopback mock only",
    schemaSpatialColumns: spatialColumns.length,
    geometryAndGeographySrid: 4326,
    supportedFunction: "ST_DWITHIN",
    readOnlyDraftValidated: output.validation.valid,
    cliColumnNameFallback: true,
    cliColumnCommentFallback: true,
  })}\n`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await core.query(`DROP TABLE IF EXISTS public."${table}"`);
    const cleanup = await core.query("SELECT to_regclass($1) IS NULL AS removed", [`public.${table}`]);
    if (!primaryError) assert.equal(cleanup.rows[0]?.removed, true, "The CLI GIS fixture must be removed.");
    await core.query(`DROP TABLE IF EXISTS public."${columnTable}"`);
    const columnCleanup = await core.query("SELECT to_regclass($1) IS NULL AS removed", [`public.${columnTable}`]);
    if (!primaryError) assert.equal(columnCleanup.rows[0]?.removed, true, "The CLI schema-search fixture must be removed.");
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    process.stderr.write("CLI GIS smoke cleanup also failed.\n");
  }
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
