import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { CoreService } from "../../packages/core/dist/index.js";
import { runSqlAssistant } from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

function readDockerEnv() {
  const text = readFileSync(new URL("../../docker/.env", import.meta.url), "utf8");
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
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
}

const dockerEnv = readDockerEnv();
function required(name, fallback) {
  const value = process.env[name] || dockerEnv[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

const host = process.env.DBSTUDIO_REPAIR_HOST || "127.0.0.1";
const database = required("DBSTUDIO_PG_DATABASE", "dbstudio_test");
const port = Number(process.env.DBSTUDIO_POSTGIS_PORT || dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432");
assert.equal(host, "127.0.0.1", "Only the authorized local PostgreSQL test service is allowed.");
assert.equal(database, "dbstudio_test", "Only the project test database is allowed.");
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535);

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const suffix = randomBytes(5).toString("hex");
const regionsName = `ai_join_regions_${suffix}`;
const placesName = `ai_join_places_${suffix}`;
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const regions = `public.${q(regionsName)}`;
const places = `public.${q(placesName)}`;
const relationName = `fk_${suffix}`;
const service = CoreService.fromPostgresConfig({
  host,
  port,
  database,
  user: required("DBSTUDIO_PG_USER", "dbstudio"),
  password: required("DBSTUDIO_PG_PASSWORD"),
  ssl: false,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 8_000,
});

let regionsCreated = false;
let placesCreated = false;
let stage = "fixture-create";
let outcome;
let failure;
let guardDiagnostics;
try {
  await service.query(`CREATE TABLE ${regions} (id integer PRIMARY KEY, region_name text NOT NULL)`);
  regionsCreated = true;
  await service.query(`CREATE TABLE ${places} (
    id integer PRIMARY KEY,
    region_id integer NOT NULL CONSTRAINT ${q(relationName)} REFERENCES ${regions}(id),
    active integer NOT NULL
  )`);
  placesCreated = true;
  await service.query(`INSERT INTO ${regions} (id, region_name) VALUES (1, 'West'), (2, 'East')`);
  await service.query(`INSERT INTO ${places} (id, region_id, active) VALUES (1, 1, 1), (2, 1, 1), (3, 2, 1), (4, 2, 0)`);

  stage = "fixture-baseline";
  const baseline = await service.query(`
    SELECT r.region_name, COUNT(*) AS active_count
    FROM ${places} AS p JOIN ${regions} AS r ON p.region_id = r.id
    WHERE p.active = 1
    GROUP BY r.region_name
    HAVING COUNT(*) >= 2
  `);
  assert.equal(baseline.rows.length, 1);
  assert.ok(Object.values(baseline.rows[0]).some((value) => value === "West"));
  assert.ok(Object.values(baseline.rows[0]).some((value) => String(value) === "2"));

  const selectedSql = `
    WITH active_places AS (
      SELECT p.id, p.region_code, p.active FROM ${places} AS p WHERE p.active = 1
    )
    SELECT r.region_name, COUNT(*) AS active_count
    FROM active_places AS p JOIN ${regions} AS r ON p.region_code = r.id
    GROUP BY r.region_name
    HAVING COUNT(*) >= 2
    ORDER BY active_count DESC
  `;
  stage = "database-error";
  let databaseError;
  try {
    await service.query(selectedSql);
  } catch (error) {
    databaseError = error;
  }
  assert.ok(databaseError, "The deliberately invalid join field must fail in PostgreSQL.");
  assert.equal(databaseError.code, "42703", "Expected undefined_column from the bad foreign-key field.");

  stage = "model-repair";
  const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
    task: "repair",
    request: `修复 PostgreSQL 查询中的真实 JOIN 字段错误。外键元数据明确给出 ${placesName}.region_id -> ${regionsName}.id；必须按这对列关联，不能使用两个主键 id 互连。保留 active = 1、WITH active_places CTE、GROUP BY region_name、HAVING COUNT(*) >= 2（包含 2）、按数量降序，并只返回区域名和数量。`,
    context: {
      engine: "postgres",
      serverVersion: "16",
      database,
      schema: "public",
      tables: [
        {
          schema: "public", name: regionsName, type: "table",
          columns: [
            { name: "id", dataType: "integer", nullable: false, primaryKey: true },
            { name: "region_name", dataType: "text", nullable: false, primaryKey: false },
          ],
        },
        {
          schema: "public", name: placesName, type: "table",
          columns: [
            { name: "id", dataType: "integer", nullable: false, primaryKey: true },
            { name: "region_id", dataType: "integer", nullable: false, primaryKey: false },
            { name: "active", dataType: "integer", nullable: false, primaryKey: false },
          ],
          foreignKeys: [{
            name: relationName,
            columns: ["region_id"],
            referencedSchema: "public",
            referencedTable: regionsName,
            referencedColumns: ["id"],
          }],
        },
      ],
      selectedSql,
      error: { code: databaseError.code, message: String(databaseError.message).slice(0, 1_000) },
    },
  });

  stage = "repair-guard";
  const sql = response.result.sql ?? "";
  const normalized = sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
  const joinCondition = normalized.match(/\bon\s+([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\bhaving\b|\border\s+by\b|\bjoin\b|$)/)?.[1] ?? "";
  const references = response.validation?.referencedTables ?? [];
  const referenceNames = references.map((item) => item.name.toLowerCase()).sort();
  const functions = [...normalized.matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => name !== "as");
  guardDiagnostics = {
    taskCorrect: response.result.task === "repair",
    returnedSql: Boolean(sql),
    valid: response.validation?.valid === true,
    readOnly: response.validation?.readOnly === true,
    ctePreserved: /^\s*with\s+active_places\s+as\s*\(/.test(normalized),
    activeFilterPreserved: /\bactive\s*=\s*1\b/.test(normalized),
    groupByPreserved: /\bgroup\s+by\b[\s\S]*\bregion_name\b/.test(normalized),
    havingThresholdPreserved: /\bhaving\s+count\s*\(\s*\*\s*\)\s*>=\s*2\b/.test(normalized),
    descendingOrderPreserved: /\border\s+by\b[\s\S]*\bdesc\b/.test(normalized),
    badJoinColumnRemoved: !/\bregion_code\b/.test(normalized),
    noWriteKeywords: !/\b(?:insert|update|delete|merge|create|alter|drop|truncate|copy)\b/.test(normalized),
    foreignKeyJoinMatched: /\bregion_id\s*=\s*[a-z_][a-z0-9_$]*\s*\.\s*id\b|\b[a-z_][a-z0-9_$]*\s*\.\s*id\s*=\s*[a-z_][a-z0-9_$]*\s*\.\s*region_id\b/.test(joinCondition),
    twoSourceTables: references.length === 2,
    exactSourceNames: JSON.stringify(referenceNames) === JSON.stringify([placesName, regionsName].sort()),
    sourceSchemasPublic: references.every((item) => item.schema?.toLowerCase() === "public"),
    onlyCountFunction: functions.every((name) => name === "count"),
  };
  for (const [check, passed] of Object.entries(guardDiagnostics)) assert.equal(passed, true, `Repair guard failed: ${check}`);

  stage = "repair-execute";
  const repaired = await service.query(sql);
  assert.equal(repaired.rows.length, 1);
  assert.ok(Object.values(repaired.rows[0]).some((value) => value === "West"));
  assert.ok(Object.values(repaired.rows[0]).some((value) => String(value) === "2"));
  outcome = {
    ok: true,
    scenario: "postgres-live-fk-join-aggregate-repair",
    databaseErrorCode: "42703",
    ctePreserved: true,
    foreignKeyJoinMatched: true,
    groupByHavingPreserved: true,
    validatedReadOnly: true,
    targetTablesMatched: true,
    repairExecuted: true,
    resultRows: 1,
  };
} catch (error) {
  failure = {
    scenario: "postgres-live-fk-join-aggregate-repair",
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    failureCode: error?.code,
    providerStatus: error?.status,
    providerCode: error?.providerCode,
    guardDiagnostics,
    responseContentLogged: false,
  };
  process.exitCode = 1;
} finally {
  let fixturesRemoved = true;
  if (placesCreated) {
    try { await service.query(`DROP TABLE IF EXISTS ${places}`); }
    catch (error) { fixturesRemoved = false; failure ??= { scenario: "postgres-live-fk-join-aggregate-repair", stage: "fixture-cleanup", databaseErrorCode: error?.code }; process.exitCode = 1; }
  }
  if (regionsCreated) {
    try { await service.query(`DROP TABLE IF EXISTS ${regions}`); }
    catch (error) { fixturesRemoved = false; failure ??= { scenario: "postgres-live-fk-join-aggregate-repair", stage: "fixture-cleanup", databaseErrorCode: error?.code }; process.exitCode = 1; }
  }
  if (failure) failure.fixturesRemoved = fixturesRemoved;
  if (outcome) outcome.fixturesRemoved = fixturesRemoved;
}

if (failure) {
  process.stderr.write(`${JSON.stringify({ ok: false, ...failure })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    ...outcome,
    schemaSent: "random synthetic two-table FK schema only",
    businessRowsSent: false,
    credentialsSent: false,
    responseContentLogged: false,
  })}\n`);
}
