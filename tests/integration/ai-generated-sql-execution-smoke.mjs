import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
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

const env = readDockerEnv();
function required(name, fallback) {
  const value = process.env[name] || env[name] || fallback;
  assert.ok(value, `Set ${name} in docker/.env before running this integration.`);
  return value;
}

function positivePort(name, fallback) {
  const result = Number(required(name, fallback));
  assert.ok(Number.isSafeInteger(result) && result > 0 && result <= 65_535, `${name} must be a valid TCP port.`);
  return result;
}

function quote(engine, value) {
  if (engine === "mysql" || engine === "mariadb") return `\`${value.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return `[${value.replaceAll("]", "]]" )}]`;
  if (engine === "oracle") return `"${value.replaceAll('"', '""')}"`;
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(engine, schema, table) {
  return `${quote(engine, schema)}.${quote(engine, table)}`;
}

function makeService(engine, sqlitePath) {
  if (engine === "postgres" || engine === "postgis") {
    return CoreService.fromPostgresConfig({
      host: "127.0.0.1",
      port: positivePort("DBSTUDIO_POSTGIS_PORT", "25432"),
      database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"),
      user: required("DBSTUDIO_PG_USER", "dbstudio"),
      password: required("DBSTUDIO_PG_PASSWORD"),
      ssl: false,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 8_000,
    });
  }
  if (engine === "mysql" || engine === "mariadb") {
    const isMaria = engine === "mariadb";
    return isMaria
      ? CoreService.fromMariaDbConfig({
          host: "127.0.0.1", port: positivePort("MARIADB_PORT", "23307"),
          database: required("MARIADB_DATABASE", "dbstudio_test"),
          user: required("MARIADB_USER", "dbstudio"), password: required("MARIADB_PASSWORD"), connectTimeout: 8_000,
        })
      : CoreService.fromMySqlConfig({
          host: "127.0.0.1", port: positivePort("MYSQL_PORT", "23306"),
          database: required("MYSQL_DATABASE", "dbstudio_test"),
          user: required("MYSQL_USER", "dbstudio"), password: required("MYSQL_PASSWORD"), connectTimeout: 8_000,
        });
  }
  if (engine === "sqlserver") {
    return CoreService.fromSqlServerConfig({
      server: "127.0.0.1", port: positivePort("SQLSERVER_PORT", "21433"),
      database: required("SQLSERVER_DATABASE", "dbstudio_test"),
      user: "sa", password: required("SQLSERVER_SA_PASSWORD"),
      encrypt: true, trustServerCertificate: true, connectionTimeout: 8_000, requestTimeout: 8_000,
    });
  }
  if (engine === "oracle") {
    return CoreService.fromOracleConfig({
      user: required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase(),
      password: required("ORACLE_PASSWORD"),
      connectString: `//127.0.0.1:${positivePort("ORACLE_PORT", "21521")}/${required("DBSTUDIO_ORACLE_SERVICE", "FREEPDB1")}`,
      connectTimeout: 10, callTimeout: 8_000,
    });
  }
  return CoreService.fromSqliteConfig({ path: sqlitePath });
}

function makeCase(engine, suffix) {
  const tableName = engine === "oracle" ? `AIQ_${suffix.toUpperCase()}` : `aiq_${suffix.toLowerCase()}`;
  const schemas = {
    postgres: { schema: "public", database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"), version: "16" },
    postgis: { schema: "public", database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"), version: "16" },
    mysql: { schema: required("MYSQL_DATABASE", "dbstudio_test"), database: required("MYSQL_DATABASE", "dbstudio_test"), version: "8.4" },
    mariadb: { schema: required("MARIADB_DATABASE", "dbstudio_test"), database: required("MARIADB_DATABASE", "dbstudio_test"), version: "11.4" },
    sqlserver: { schema: "dbo", database: required("SQLSERVER_DATABASE", "dbstudio_test"), version: "2022" },
    oracle: { schema: required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase(), database: "FREEPDB1", version: "23ai" },
    sqlite: { schema: "main", database: "ai_dialect_smoke", version: "3" },
  }[engine];
  const spatial = engine === "postgis";
  return {
    engine,
    schema: schemas.schema,
    database: schemas.database,
    serverVersion: schemas.version,
    tableName,
    spatial,
    tableContext: {
      schema: schemas.schema,
      name: tableName,
      type: "table",
      columns: [
        { name: engine === "oracle" ? "ID" : "id", dataType: engine === "oracle" ? "NUMBER" : "integer", nullable: false, primaryKey: true },
        { name: engine === "oracle" ? "LABEL" : "label", dataType: engine === "oracle" ? "VARCHAR2" : "text", nullable: false, primaryKey: false },
        ...(spatial ? [{
          name: "location", dataType: "geography", nullable: false, primaryKey: false,
          spatial: { kind: "geography", geometryType: "POINT", srid: 4326 },
        }] : []),
      ],
    },
    request: spatial
      ? `查询距坐标经度 -122.4、纬度 37.8 不超过 2500 米的地点，只返回 id 和 label，按 id 升序。`
      : `只从 ${schemas.schema}.${tableName} 读取 id 和 label，按 id 升序返回第一条。`,
    supportedFunctions: spatial ? ["ST_DWithin", "ST_SetSRID", "ST_MakePoint"] : [],
  };
}

function makeComplexCase(engine, suffix) {
  const tableName = engine === "oracle" ? `AIW_${suffix.toUpperCase()}` : `aiw_${suffix.toLowerCase()}`;
  const regionTableName = `${tableName}${engine === "oracle" ? "_REG" : "_reg"}`;
  const schemas = {
    postgres: { schema: "public", database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"), version: "16" },
    postgis: { schema: "public", database: required("DBSTUDIO_PG_DATABASE", "dbstudio_test"), version: "16" },
    mysql: { schema: required("MYSQL_DATABASE", "dbstudio_test"), database: required("MYSQL_DATABASE", "dbstudio_test"), version: "8.4" },
    mariadb: { schema: required("MARIADB_DATABASE", "dbstudio_test"), database: required("MARIADB_DATABASE", "dbstudio_test"), version: "11.4" },
    sqlserver: { schema: "dbo", database: required("SQLSERVER_DATABASE", "dbstudio_test"), version: "2022" },
    oracle: { schema: required("DBSTUDIO_ORACLE_USER", "SYSTEM").toUpperCase(), database: "FREEPDB1", version: "23ai" },
    sqlite: { schema: "main", database: "ai_dialect_smoke", version: "3" },
  }[engine];
  const oracle = engine === "oracle";
  const integerType = oracle ? "NUMBER" : "integer";
  const textType = oracle ? "VARCHAR2" : "text";
  const id = oracle ? "ID" : "id";
  const regionId = oracle ? "REGION_ID" : "region_id";
  const active = oracle ? "ACTIVE" : "active";
  const regionName = oracle ? "REGION_NAME" : "region_name";
  const relation = {
    name: `fk_${suffix}`,
    columns: [regionId],
    referencedSchema: schemas.schema,
    referencedTable: regionTableName,
    referencedColumns: [id],
  };
  return {
    engine,
    schema: schemas.schema,
    database: schemas.database,
    serverVersion: schemas.version,
    tableName,
    regionTableName,
    complex: true,
    spatial: false,
    supportedFunctions: [],
    tableContexts: [
      {
        schema: schemas.schema,
        name: tableName,
        type: "table",
        columns: [
          { name: id, dataType: integerType, nullable: false, primaryKey: true },
          { name: regionId, dataType: integerType, nullable: false, primaryKey: false },
          { name: active, dataType: integerType, nullable: false, primaryKey: false },
        ],
        foreignKeys: [relation],
      },
      {
        schema: schemas.schema,
        name: regionTableName,
        type: "table",
        columns: [
          { name: id, dataType: integerType, nullable: false, primaryKey: true },
          { name: regionName, dataType: textType, nullable: false, primaryKey: false },
        ],
      },
    ],
    request: `使用 WITH CTE 先从 ${schemas.schema}.${tableName} 筛选 active = 1 的地点，再严格按 ${tableName}.region_id = ${regionTableName}.id 关联 ${schemas.schema}.${regionTableName}（不要把地点主键 id 与区域主键 id 关联）。GROUP BY 必须包含区域表的 region_name 字段；为兼容 Oracle 可同时分组区域表 id。用 HAVING COUNT(*) >= 2（包含 2）只保留活跃地点数至少为 2 的区域；不要写成 > 2。只返回区域名称和活跃地点数量，并按数量降序。`,
  };
}

function queryFunctionNames(sql) {
  return [...sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g)].map((match) => match[1].toUpperCase());
}

function normalizeSqlForGuard(sql) {
  return sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/["`\[\]]/g, "")
    .toLowerCase();
}

function sqlSources(normalized) {
  return [...normalized.matchAll(/\b(?:from|join)\s+((?:[a-z_][a-z0-9_$]*\s*\.\s*)*[a-z_][a-z0-9_$]*)/g)]
    .map((match) => match[1].replace(/\s/g, "").split(".").at(-1));
}

function fromClauseBodies(normalized) {
  return [...normalized.matchAll(/\bfrom\s+/g)].map((match) => {
    const start = match.index + match[0].length;
    const tail = normalized.slice(start);
    const end = tail.search(/\b(where|join|group\s+by|having|order\s+by|union|intersect|except|minus)\b/);
    return end < 0 ? tail : tail.slice(0, end);
  });
}

function hasRegionForeignKeyJoin(normalized) {
  const joinCondition = normalized.match(/\bon\s+([\s\S]*?)(?=\b(where|group\s+by|having|order\s+by|join|inner|left|right|full|cross)\b|$)/)?.[1] ?? "";
  const qualifier = "(?:[a-z_][a-z0-9_$]*\\s*\\.\\s*)*";
  return new RegExp(`\\b${qualifier}region_id\\s*=\\s*${qualifier}id\\b|\\b${qualifier}id\\s*=\\s*${qualifier}region_id\\b`).test(joinCondition);
}

function summarizeComplexSql(sql) {
  const normalized = normalizeSqlForGuard(sql);
  const threshold = normalized.match(/\b(?:count|sum)\s*\([^)]*\)\s*(>=|>|=|<=|<)\s*(\d+)/);
  const groupBy = normalized.match(/\bgroup\s+by\b([\s\S]*?)(?=\bhaving\b|\border\s+by\b|$)/)?.[1] ?? "";
  return {
    hasCte: /\bwith\b/.test(normalized),
    joinCount: (normalized.match(/\bjoin\b/g) ?? []).length,
    hasGroupBy: /\bgroup\s+by\b/.test(normalized),
    hasHaving: /\bhaving\b/.test(normalized),
    groupByRegionName: /\bregion_name\b/.test(groupBy),
    activeEqualityFilter: /\bactive\s*=\s*1\b/.test(normalized),
    foreignKeyJoinMatchesSchema: hasRegionForeignKeyJoin(normalized),
    aggregateOperator: threshold?.[1],
    aggregateThreshold: threshold ? Number(threshold[2]) : undefined,
  };
}

async function assertComplexFixture(service, testCase) {
  const table = qualified(testCase.engine, testCase.schema, testCase.tableName);
  const regions = qualified(testCase.engine, testCase.schema, testCase.regionTableName);
  const id = quote(testCase.engine, testCase.engine === "oracle" ? "ID" : "id");
  const regionId = quote(testCase.engine, testCase.engine === "oracle" ? "REGION_ID" : "region_id");
  const active = quote(testCase.engine, testCase.engine === "oracle" ? "ACTIVE" : "active");
  const regionName = quote(testCase.engine, testCase.engine === "oracle" ? "REGION_NAME" : "region_name");
  const result = await service.query(
    `SELECT r.${regionName} AS result_region, COUNT(*) AS result_count FROM ${table} p JOIN ${regions} r ON p.${regionId} = r.${id} WHERE p.${active} = 1 GROUP BY r.${regionName} HAVING COUNT(*) >= 2`,
  );
  assert.equal(result.rows.length, 1, `${testCase.engine}: complex synthetic fixture must yield one qualifying region.`);
  const values = Object.values(result.rows[0]);
  assert.ok(values.some((value) => String(value) === "West"), `${testCase.engine}: complex fixture must include West.`);
  assert.ok(values.some((value) => Number(value) === 2), `${testCase.engine}: complex fixture must contain exactly two active places in West.`);
}

function assertRuntimeSafeSql(testCase, sql, validation) {
  activeStage = "draft-length-check";
  assert.ok(sql.length > 0 && sql.length <= 8_000, `${testCase.engine}: SQL draft length is invalid.`);
  activeStage = "static-read-only-validation";
  assert.equal(validation?.valid, true, `${testCase.engine}: SQL failed static validation.`);
  activeStage = "read-only-classification";
  assert.equal(validation?.readOnly, true, `${testCase.engine}: SQL is not classified read-only.`);
  if (testCase.complex) {
    activeStage = "complex-query-shape";
    const normalized = normalizeSqlForGuard(sql);
    const queryShape = summarizeComplexSql(sql);
    activeDiagnostic = { queryShape };
    activeStage = "complex-requires-cte";
    assert.ok(/\bwith\b/i.test(normalized), `${testCase.engine}: expected a CTE.`);
    activeStage = "complex-requires-join";
    assert.ok(/\bjoin\b/i.test(normalized), `${testCase.engine}: expected the region join.`);
    activeStage = "complex-requires-group-by";
    assert.ok(/\bgroup\s+by\b/i.test(normalized), `${testCase.engine}: expected grouped aggregation.`);
    activeStage = "complex-requires-having";
    assert.ok(/\bhaving\b/i.test(normalized), `${testCase.engine}: expected the aggregate threshold.`);
    activeStage = "complex-requires-ordering";
    assert.ok(/\border\s+by\b/i.test(normalized), `${testCase.engine}: expected deterministic ordering.`);
    activeStage = "complex-source-count";
    assert.equal((normalized.match(/\bjoin\b/g) ?? []).length, 1, `${testCase.engine}: only the synthetic region join is allowed.`);
    assert.equal((normalized.match(/\bfrom\b/g) ?? []).length, 2, `${testCase.engine}: only the CTE and final result sources are allowed.`);
    activeStage = "complex-no-set-operations";
    assert.ok(!/\b(union|intersect|except|minus)\b/i.test(normalized), `${testCase.engine}: set operations are outside this runtime test.`);
    activeStage = "complex-exact-table-names";
    assert.ok(normalized.includes(testCase.tableName.toLowerCase()), `${testCase.engine}: SQL must reference the exact synthetic fact table.`);
    assert.ok(normalized.includes(testCase.regionTableName.toLowerCase()), `${testCase.engine}: SQL must reference the exact synthetic region table.`);
    activeStage = "complex-foreign-key-join";
    assert.ok(hasRegionForeignKeyJoin(normalized), `${testCase.engine}: JOIN must follow the supplied region_id to id foreign key.`);
    activeStage = "complex-cte-name";
    const cteName = normalized.match(/\bwith\s+([a-z_][a-z0-9_$]*)\s+as\s*\(/)?.[1];
    assert.ok(cteName, `${testCase.engine}: a single named CTE is required.`);
    activeStage = "complex-query-source-whitelist";
    const sources = sqlSources(normalized);
    activeDiagnostic = {
      queryShape,
      sourceCount: sources.length,
      uniqueSourceCount: new Set(sources).size,
      factSourceMatches: sources.includes(testCase.tableName.toLowerCase()),
      regionSourceMatches: sources.includes(testCase.regionTableName.toLowerCase()),
      cteSourceMatches: sources.includes(cteName),
    };
    assert.equal(sources.length, 3, `${testCase.engine}: unexpected query source shape.`);
    assert.deepEqual(new Set(sources), new Set([testCase.tableName.toLowerCase(), testCase.regionTableName.toLowerCase(), cteName]));
    activeStage = "complex-no-implicit-cross-joins";
    const fromClauses = fromClauseBodies(normalized);
    assert.ok(fromClauses.every((clause) => !clause.includes(",")), `${testCase.engine}: comma-separated sources are not allowed.`);
    activeDiagnostic = { queryShape };
    activeStage = "complex-active-filter";
    assert.ok(queryShape.activeEqualityFilter, `${testCase.engine}: the active = 1 filter is required.`);
    assert.equal(queryShape.aggregateOperator, ">=", `${testCase.engine}: the aggregate threshold must be inclusive.`);
    assert.equal(queryShape.aggregateThreshold, 2, `${testCase.engine}: the aggregate threshold must be two.`);
    assert.ok(queryShape.groupByRegionName, `${testCase.engine}: grouping must include the region name.`);
    if (testCase.engine !== "oracle" && testCase.engine !== "postgis") {
      activeStage = "complex-table-reference-check";
      const references = validation?.referencedTables ?? [];
      assert.equal(references.length, 2, `${testCase.engine}: SQL must reference exactly the two supplied tables.`);
      assert.deepEqual(new Set(references.map((table) => table.name.toLowerCase())), new Set([testCase.tableName.toLowerCase(), testCase.regionTableName.toLowerCase()]));
    }
  } else if (testCase.engine === "oracle" || testCase.engine === "postgis") {
    activeStage = "conservative-target-check";
    const normalized = normalizeSqlForGuard(sql);
    const qualifiedName = `${testCase.schema}.${testCase.tableName}`.toLowerCase();
    const expectedName = testCase.engine === "oracle" ? qualifiedName : testCase.tableName.toLowerCase();
    const targetFound = normalized.includes(expectedName);
    const sources = sqlSources(normalized);
    const cteName = normalized.match(/\bwith\s+([a-z_][a-z0-9_$]*)\s+as\s*\(/)?.[1];
    const expectedSources = [testCase.tableName.toLowerCase(), ...(cteName ? [cteName] : [])];
    const expectedSourceShape = sources.length === expectedSources.length
      && new Set(sources).size === expectedSources.length
      && expectedSources.every((source) => sources.includes(source));
    activeDiagnostic = {
      qualifiedSourceFound: normalized.includes(qualifiedName),
      expectedTableFound: targetFound,
      hasCte: Boolean(cteName),
      sourceCount: sources.length,
      expectedSourceShape,
    };
    assert.ok(targetFound, `${testCase.engine}: SQL must reference the exact synthetic table${testCase.engine === "oracle" ? " and schema" : ""}.`);
    assert.equal((normalized.match(/\bfrom\b/g) ?? []).length, expectedSources.length, `${testCase.engine}: SQL must have only its test table and optional CTE source.`);
    assert.ok(!/\b(join|union|intersect|minus)\b/i.test(normalized), `${testCase.engine}: SQL must not add another source or set operation.`);
    assert.ok(expectedSourceShape, `${testCase.engine}: SQL must read only the synthetic table and optional CTE.`);
    assert.ok(fromClauseBodies(normalized).every((clause) => !clause.includes(",")), `${testCase.engine}: comma-separated sources are not allowed.`);
  } else {
    activeStage = "single-table-reference";
    activeDiagnostic = { referenceCount: validation?.referencedTables.length ?? -1 };
    assert.equal(validation?.referencedTables.length, 1, `${testCase.engine}: SQL must reference exactly one table.`);
    activeStage = "expected-table-reference";
    activeDiagnostic = {
      referenceCount: validation.referencedTables.length,
      expectedTableMatched: validation.referencedTables[0]?.name.toLowerCase() === testCase.tableName.toLowerCase(),
    };
    assert.equal(validation.referencedTables[0]?.name.toLowerCase(), testCase.tableName.toLowerCase(), `${testCase.engine}: wrong test table reference.`);
  }
  const allowedFunctions = new Set(["TOP", "CAST", "AS", ...(testCase.complex ? ["COUNT", "SUM"] : []), ...testCase.supportedFunctions].map((name) => name.toUpperCase()));
  for (const functionName of queryFunctionNames(normalizeSqlForGuard(sql))) {
    activeStage = "function-allowlist";
    activeDiagnostic = { functionName };
    assert.ok(allowedFunctions.has(functionName), `${testCase.engine}: function is outside the runtime test allowlist.`);
  }
  activeDiagnostic = undefined;
}

function createTableSql(testCase) {
  const table = qualified(testCase.engine, testCase.schema, testCase.tableName);
  if (testCase.complex) {
    const regions = qualified(testCase.engine, testCase.schema, testCase.regionTableName);
    const id = quote(testCase.engine, testCase.engine === "oracle" ? "ID" : "id");
    const regionId = quote(testCase.engine, testCase.engine === "oracle" ? "REGION_ID" : "region_id");
    const active = quote(testCase.engine, testCase.engine === "oracle" ? "ACTIVE" : "active");
    const regionName = quote(testCase.engine, testCase.engine === "oracle" ? "REGION_NAME" : "region_name");
    if (testCase.engine === "oracle") {
      return [
        `CREATE TABLE ${regions} (${id} NUMBER(10) NOT NULL PRIMARY KEY, ${regionName} VARCHAR2(80) NOT NULL)`,
        `CREATE TABLE ${table} (${id} NUMBER(10) NOT NULL PRIMARY KEY, ${regionId} NUMBER(10) NOT NULL, ${active} NUMBER(1) NOT NULL)`,
      ];
    }
    if (testCase.engine === "sqlserver") {
      return [
        `CREATE TABLE ${regions} (${id} INT NOT NULL PRIMARY KEY, ${regionName} NVARCHAR(80) NOT NULL)`,
        `CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${regionId} INT NOT NULL, ${active} INT NOT NULL)`,
      ];
    }
    if (testCase.engine === "mysql" || testCase.engine === "mariadb") {
      return [
        `CREATE TABLE ${regions} (${id} INT NOT NULL PRIMARY KEY, ${regionName} VARCHAR(80) NOT NULL)`,
        `CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${regionId} INT NOT NULL, ${active} INT NOT NULL)`,
      ];
    }
    return [
      `CREATE TABLE ${regions} (${id} INTEGER NOT NULL PRIMARY KEY, ${regionName} TEXT NOT NULL)`,
      `CREATE TABLE ${table} (${id} INTEGER NOT NULL PRIMARY KEY, ${regionId} INTEGER NOT NULL, ${active} INTEGER NOT NULL)`,
    ];
  }
  const id = quote(testCase.engine, testCase.engine === "oracle" ? "ID" : "id");
  const label = quote(testCase.engine, testCase.engine === "oracle" ? "LABEL" : "label");
  if (testCase.engine === "oracle") return [`CREATE TABLE ${table} (${id} NUMBER(10) NOT NULL PRIMARY KEY, ${label} VARCHAR2(120) NOT NULL)`];
  if (testCase.engine === "sqlserver") return [`CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${label} NVARCHAR(120) NOT NULL)`];
  if (testCase.engine === "mysql" || testCase.engine === "mariadb") return [`CREATE TABLE ${table} (${id} INT NOT NULL PRIMARY KEY, ${label} VARCHAR(120) NOT NULL)`];
  return [`CREATE TABLE ${table} (${id} INTEGER NOT NULL PRIMARY KEY, ${label} TEXT NOT NULL${testCase.spatial ? `, ${quote(testCase.engine, "location")} geography(Point,4326) NOT NULL` : ""})`];
}

async function assertSeedCount(service, testCase, expected) {
  const table = qualified(testCase.engine, testCase.schema, testCase.tableName);
  const result = await service.query(`SELECT COUNT(*) AS ${quote(testCase.engine, "seed_count")} FROM ${table}`);
  const actual = Number(Object.values(result.rows[0] ?? {})[0]);
  assert.equal(actual, expected, `${testCase.engine}: synthetic setup row count is incorrect.`);
}

const settings = await readDesktopAiModelSettings().catch(() => undefined);
const chat = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
assert.ok(chat, "An enabled Chat model is required in encrypted desktop settings.");

const sqlitePath = path.resolve(".cache", `ai-generated-sql-${randomBytes(5).toString("hex")}.sqlite`);
mkdirSync(path.dirname(sqlitePath), { recursive: true });
const supportedEngines = ["postgres", "mysql", "mariadb", "sqlserver", "oracle", "sqlite", "postgis"];
const requestedEngines = (process.argv[2] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
assert.ok(requestedEngines.every((engine) => supportedEngines.includes(engine)), "Unknown SQL execution smoke engine.");
const engines = requestedEngines.length ? requestedEngines : supportedEngines;
const requestedScenario = process.argv[3] ?? "all";
assert.ok(["all", "simple", "complex"].includes(requestedScenario), "Scenario must be all, simple, or complex.");
const services = new Map();
const testCases = engines.flatMap((engine) => [
  makeCase(engine, randomBytes(5).toString("hex")),
  makeComplexCase(engine, randomBytes(5).toString("hex")),
]).filter((testCase) => requestedScenario === "all" || (requestedScenario === "complex") === Boolean(testCase.complex));
const created = [];
let activeCase = "setup";
let activeStage = "setup";
let activeDiagnostic;

try {
  for (const testCase of testCases) {
    activeCase = testCase.engine;
    activeStage = "create-table";
    const service = services.get(testCase.engine) ?? makeService(testCase.engine, sqlitePath);
    services.set(testCase.engine, service);
    for (const [index, statement] of createTableSql(testCase).entries()) {
      await service.query(statement);
      created.push({ engine: testCase.engine, schema: testCase.schema, table: testCase.complex && index === 0 ? testCase.regionTableName : testCase.tableName });
    }
    const table = qualified(testCase.engine, testCase.schema, testCase.tableName);
    if (testCase.complex) {
      activeStage = "seed-related-tables";
      const regions = qualified(testCase.engine, testCase.schema, testCase.regionTableName);
      const regionId = quote(testCase.engine, testCase.engine === "oracle" ? "ID" : "id");
      const regionName = quote(testCase.engine, testCase.engine === "oracle" ? "REGION_NAME" : "region_name");
      const id = quote(testCase.engine, testCase.engine === "oracle" ? "ID" : "id");
      const sourceRegionId = quote(testCase.engine, testCase.engine === "oracle" ? "REGION_ID" : "region_id");
      const activeColumn = quote(testCase.engine, testCase.engine === "oracle" ? "ACTIVE" : "active");
      for (const [regionKey, name] of [[10, "West"], [20, "East"]]) {
        await service.query(`INSERT INTO ${regions} (${regionId}, ${regionName}) VALUES (${regionKey}, '${name}')`);
      }
      for (const [placeId, regionKey, isActive] of [[1, 10, 1], [2, 10, 1], [3, 20, 1], [4, 20, 0]]) {
        await service.query(`INSERT INTO ${table} (${id}, ${sourceRegionId}, ${activeColumn}) VALUES (${placeId}, ${regionKey}, ${isActive})`);
      }
      await assertSeedCount(service, testCase, 4);
      await assertComplexFixture(service, testCase);
    } else if (testCase.spatial) {
      activeStage = "seed-spatial-row";
      await service.query(`INSERT INTO ${table} (${quote(testCase.engine, "id")}, ${quote(testCase.engine, "label")}, ${quote(testCase.engine, "location")}) VALUES (1, 'synthetic-one', ST_SetSRID(ST_MakePoint(-122.4,37.8),4326)::geography)`);
      await assertSeedCount(service, testCase, 1);
    } else {
      activeStage = "seed-rows";
      await service.importRows(testCase.tableName, {
        columns: [testCase.engine === "oracle" ? "ID" : "id", testCase.engine === "oracle" ? "LABEL" : "label"],
        rows: [
          testCase.engine === "oracle" ? { ID: 1, LABEL: "synthetic-one" } : { id: 1, label: "synthetic-one" },
          testCase.engine === "oracle" ? { ID: 2, LABEL: "synthetic-two" } : { id: 2, label: "synthetic-two" },
        ],
      }, testCase.schema);
      await assertSeedCount(service, testCase, 2);
    }
  }

  const results = [];
  for (const testCase of testCases) {
    activeCase = testCase.engine;
    activeStage = "model-request";
    const context = {
      engine: testCase.engine === "postgis" ? "postgres" : testCase.engine,
      serverVersion: testCase.serverVersion,
      database: testCase.database,
      schema: testCase.schema,
      tables: testCase.tableContexts ?? [testCase.tableContext],
      ...(testCase.spatial ? { postgis: {
        version: "3.6.4",
        spatialColumns: [{ schema: testCase.schema, table: testCase.tableName, column: "location", kind: "geography", geometryType: "POINT", srid: 4326 }],
        supportedFunctions: testCase.supportedFunctions,
      } } : {}),
    };
    const response = await runSqlAssistant({ ...chat, timeoutMs: 45_000 }, {
      task: testCase.spatial ? "gis" : "generate",
      request: testCase.request,
      context,
    });
    const sql = response.result.sql ?? "";
    activeStage = "static-validation-and-runtime-guard";
    assertRuntimeSafeSql(testCase, sql, response.validation);
    activeStage = "database-execution";
    const executed = await services.get(testCase.engine).query(sql);
    activeStage = "result-assertion";
    activeDiagnostic = {
      resultRows: executed.rows.length,
      resultColumns: Object.keys(executed.rows[0] ?? {}),
      ...(testCase.complex ? { queryShape: summarizeComplexSql(sql) } : {}),
    };
    assert.equal(executed.rows.length, 1, `${testCase.engine}: expected exactly one matching synthetic row.`);
    const row = executed.rows[0];
    if (testCase.complex) {
      activeStage = "aggregate-result-assertion";
      const values = Object.values(row);
      activeDiagnostic = {
        resultColumns: Object.keys(row),
        expectedRegionPresent: values.some((value) => String(value) === "West"),
        expectedAggregatePresent: values.some((value) => Number(value) === 2),
      };
      assert.equal(Object.keys(row).length, 2, `${testCase.engine}: complex query must return only name and aggregate.`);
      assert.ok(values.some((value) => String(value) === "West"), `${testCase.engine}: expected West to qualify.`);
      assert.ok(values.some((value) => Number(value) === 2), `${testCase.engine}: expected two active places in West.`);
    } else {
      const idValue = row.id ?? row.ID;
      const labelValue = row.label ?? row.LABEL;
      assert.equal(Number(idValue), 1, `${testCase.engine}: result must be the first ordered row.`);
      assert.equal(labelValue, "synthetic-one", `${testCase.engine}: selected label did not match the synthetic row.`);
    }
    activeDiagnostic = undefined;
    const item = { engine: testCase.engine, scenario: testCase.complex ? "cte-join-aggregate" : (testCase.spatial ? "postgis-distance" : "single-table"), sqlValidatedReadOnly: true, databaseAccepted: true, resultRows: 1 };
    results.push(item);
    process.stdout.write(`${JSON.stringify({ event: "case", ...item })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    engines: results,
    schemaSent: "random synthetic table metadata only",
    businessRowsSent: false,
    credentialsSent: false,
    responseContentLogged: false,
  })}\n`);
} catch (error) {
  const providerCode = error?.name === "AiProviderError" && ["configuration", "network", "timeout", "cancelled", "provider", "response"].includes(error.code)
    ? error.code
    : undefined;
  const providerStatus = providerCode === "provider" && typeof error.message === "string"
    ? error.message.match(/\bHTTP (\d{3})\b/)?.[1]
    : undefined;
  const databaseCodeValue = error && typeof error === "object"
    ? (error.code ?? error.errorNum ?? error.number)
    : undefined;
  const databaseCode = typeof databaseCodeValue === "string" && /^[A-Z0-9_-]{2,32}$/i.test(databaseCodeValue)
    ? databaseCodeValue
    : Number.isSafeInteger(databaseCodeValue) ? databaseCodeValue : undefined;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    failedEngine: activeCase,
    stage: activeStage,
    ...(activeDiagnostic ? { diagnostic: activeDiagnostic } : {}),
    failure: error instanceof Error ? error.name : "UnknownError",
    ...(providerCode ? { providerCode } : {}),
    ...(providerStatus ? { providerStatus: Number(providerStatus) } : {}),
    ...(databaseCode !== undefined ? { databaseCode } : {}),
    responseContentLogged: false,
  })}\n`);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const item of created.reverse()) {
    try {
      await services.get(item.engine).query(`DROP TABLE ${qualified(item.engine, item.schema, item.table)}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  rmSync(sqlitePath, { force: true });
  if (cleanupErrors.length && process.exitCode !== 1) {
    process.stderr.write(`${JSON.stringify({ cleanupFailed: cleanupErrors.length })}\n`);
    process.exitCode = 1;
  }
}
