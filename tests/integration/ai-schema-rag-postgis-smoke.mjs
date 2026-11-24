import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import {
  applyPostgisSpatialMetadata,
  createEmbedding,
  findStaleSchemaIndexTableKeys,
  loadPostgisSchemaMetadata,
  rankSchemaCandidatesByRerank,
  rerank,
  runSqlAssistant,
  schemaIndexScope,
  schemaMetadataFingerprint,
  schemaModelFingerprint,
  schemaTableDocument,
  schemaTableDocumentChunks,
  schemaTableKey,
  searchSchemaIndex,
  emptySchemaIndex,
  replaceSchemaIndexChunks,
} from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD,
  "Configure the authorized project PostGIS test service first.");
assert.equal(environment.PGDATABASE, "dbstudio_test", "This smoke test is restricted to the project test database.");
assert.ok(["localhost", "127.0.0.1", "::1"].includes(environment.PGHOST), "The PostGIS test host must be loopback.");

const modelSettings = await readDesktopAiModelSettings();
const chatConfig = modelSettings?.chatModels.find((model) => model.id === modelSettings.defaultChatModelId && model.enabled)
  ?? modelSettings?.chatModels.find((model) => model.enabled);
const embeddingConfig = modelSettings?.embedding;
const rerankConfig = modelSettings?.rerank;
assert.ok(modelSettings?.enabled && chatConfig?.apiKey, "Enable the encrypted desktop Chat settings first.");
assert.ok(embeddingConfig?.enabled && embeddingConfig.apiKey, "Enable the encrypted desktop Embedding settings first.");
assert.ok(rerankConfig?.enabled && rerankConfig.apiKey, "Enable the encrypted desktop Rerank settings first.");
for (const config of [chatConfig, embeddingConfig, rerankConfig]) {
  const url = new URL(config.baseURL);
  assert.equal(url.protocol, "https:", "This test sends synthetic schema metadata only to HTTPS.");
  assert.equal(url.hostname, "dashscope.aliyuncs.com", "Only the previously authorized DashScope endpoint is allowed.");
}

const token = `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const schemas = {
  roads: `ai_rag_${token}_roads`,
  parks: `ai_rag_${token}_parks`,
  transit: `ai_rag_${token}_transit`,
  excluded: `ai_rag_${token}_excluded`,
};
const tableNames = {
  roads: "road_segments",
  parks: "park_areas",
  transit: "transit_stops",
  excluded: "private_sentinel",
};
const core = CoreService.fromEnvironment(environment);
const createdSchemas = [];
let primaryError;
let stage = "verify-postgis-test-database";

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlShapeSummary(sql) {
  const { Parser } = createRequire(path.join(root, "packages/ai/package.json"))("node-sql-parser");
  const parsed = new Parser().astify(sql, { database: "Postgresql" });
  const ast = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  const name = (value) => {
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.value === "string") return value.value;
    if (typeof value.as === "string") return value.as;
    if (value.expr !== undefined) return name(value.expr);
    if (value.type === "column_ref") return name(value.column);
    return undefined;
  };
  const unqualifiedReferences = (value, output = [], root = true) => {
    if (Array.isArray(value)) {
      for (const item of value) unqualifiedReferences(item, output, false);
    } else if (value && typeof value === "object") {
      if (value.type === "select" && !root) return output;
      if (value.type === "column_ref") {
        if (value.table == null && value.db == null) output.push(name(value));
      } else {
        for (const child of Object.values(value)) unqualifiedReferences(child, output, false);
      }
    }
    return output.filter(Boolean);
  };
  return {
    ctes: (Array.isArray(ast.with) ? ast.with : []).map((cte) => ({
      name: name(cte.name),
      outputColumns: (Array.isArray(cte.stmt?.columns) ? cte.stmt.columns : []).map(name).filter(Boolean),
      sourceTables: (Array.isArray(cte.stmt?.from) ? cte.stmt.from : []).map((relation) => ({
        schema: typeof relation.db === "string" ? relation.db : undefined,
        table: typeof relation.table === "string" ? relation.table : "derived",
        alias: typeof relation.as === "string" ? relation.as : undefined,
      })),
      unqualifiedReferences: unqualifiedReferences(cte.stmt),
    })),
    outerRelations: (Array.isArray(ast.from) ? ast.from : []).map((relation) => ({
      table: typeof relation.table === "string" ? relation.table : "derived",
      alias: typeof relation.as === "string" ? relation.as : undefined,
    })),
    outerUnqualifiedReferences: unqualifiedReferences({
      columns: ast.columns,
      where: ast.where,
      groupby: ast.groupby,
      having: ast.having,
    }),
  };
}

async function loadSchemaTables(schema, postgisVersion) {
  const listed = await core.listTables(schema);
  assert.equal(listed.length, 1, `Expected one synthetic table in ${schema}.`);
  const listedTable = listed[0];
  const [columns, foreignKeys] = await Promise.all([
    core.getTableColumns(listedTable.name, schema),
    core.getTableForeignKeys(listedTable.name, schema),
  ]);
  const table = {
    schema: listedTable.schema,
    name: listedTable.name,
    type: listedTable.type,
    comment: listedTable.comment ?? undefined,
    columns: columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      primaryKey: column.primaryKey,
      comment: column.comment ?? undefined,
    })),
    foreignKeys: foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns,
      referencedSchema: foreignKey.referencedSchema,
      referencedTable: foreignKey.referencedTable,
      referencedColumns: foreignKey.referencedColumns,
    })),
  };
  assert.ok(table.columns.length >= 3, `Expected live columns from ${schema}.${table.name}.`);
  assert.ok(postgisVersion);
  return table;
}

try {
  stage = "confirm-isolated-postgis";
  const tested = await core.testConnection();
  assert.equal(tested.database, "dbstudio_test");
  const health = await core.query("SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname = 'postgis'");
  assert.equal(health.rows.length, 1, "The project test database must have PostGIS installed.");

  stage = "create-synthetic-schemas";
  for (const schema of Object.values(schemas)) {
    await core.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    createdSchemas.push(schema);
  }
  await core.query(`CREATE TABLE ${quoteIdentifier(schemas.roads)}.${quoteIdentifier(tableNames.roads)} (
    id integer PRIMARY KEY,
    road_class text NOT NULL,
    length_m numeric NOT NULL,
    geom geometry(MultiLineString, 3857) NOT NULL
  )`);
  await core.query(`COMMENT ON TABLE ${quoteIdentifier(schemas.roads)}.${quoteIdentifier(tableNames.roads)} IS 'Synthetic road segment metadata'`);
  await core.query(`COMMENT ON COLUMN ${quoteIdentifier(schemas.roads)}.${quoteIdentifier(tableNames.roads)}.road_class IS 'Synthetic road category'`);
  await core.query(`CREATE TABLE ${quoteIdentifier(schemas.parks)}.${quoteIdentifier(tableNames.parks)} (
    id integer PRIMARY KEY,
    park_name text NOT NULL,
    geom geometry(MultiPolygon, 3857) NOT NULL
  )`);
  await core.query(`COMMENT ON TABLE ${quoteIdentifier(schemas.parks)}.${quoteIdentifier(tableNames.parks)} IS 'Synthetic park area metadata'`);
  await core.query(`COMMENT ON COLUMN ${quoteIdentifier(schemas.parks)}.${quoteIdentifier(tableNames.parks)}.park_name IS 'Synthetic park display name'`);
  await core.query(`CREATE TABLE ${quoteIdentifier(schemas.transit)}.${quoteIdentifier(tableNames.transit)} (
    id integer PRIMARY KEY,
    stop_name text NOT NULL,
    geom geometry(Point, 3857) NOT NULL
  )`);
  await core.query(`COMMENT ON TABLE ${quoteIdentifier(schemas.transit)}.${quoteIdentifier(tableNames.transit)} IS 'Synthetic transit stop metadata'`);
  await core.query(`COMMENT ON COLUMN ${quoteIdentifier(schemas.transit)}.${quoteIdentifier(tableNames.transit)}.stop_name IS 'Synthetic transit stop display name'`);
  await core.query(`CREATE TABLE ${quoteIdentifier(schemas.excluded)}.${quoteIdentifier(tableNames.excluded)} (
    id integer PRIMARY KEY,
    excluded_marker text NOT NULL
  )`);
  await core.query(`COMMENT ON TABLE ${quoteIdentifier(schemas.excluded)}.${quoteIdentifier(tableNames.excluded)} IS 'UNSELECTED_SYNTHETIC_SENTINEL'`);

  stage = "load-live-metadata-through-core";
  const visibleSchemas = await core.listSchemas();
  for (const schema of Object.values(schemas)) assert.ok(visibleSchemas.includes(schema), `Core did not list ${schema}.`);
  const loaded = [];
  for (const schema of [schemas.roads, schemas.parks, schemas.transit]) {
    const table = await loadSchemaTables(schema, health.rows[0].version);
    const spatial = await loadPostgisSchemaMetadata(
      (sql, parameters) => core.query(sql, parameters),
      schema,
      [table],
    );
    assert.equal(spatial.metadata.version, health.rows[0].version);
    assert.deepEqual(spatial.warnings, []);
    assert.equal(spatial.metadata.spatialColumns.length, 1);
    assert.equal(spatial.metadata.spatialColumns[0].srid, 3857);
    const spatialColumn = spatial.metadata.spatialColumns.find((column) => column.table === table.name);
    assert.ok(spatialColumn, `Expected a live spatial column in ${schema}.${table.name}.`);
    const rawSpatialColumn = table.columns.find((column) => column.name === spatialColumn.column);
    // The adapter normalizes PostGIS UDT names to "geometry" at read time.
    assert.equal(rawSpatialColumn?.dataType, "geometry");
    const [indexedTable] = applyPostgisSpatialMetadata([table], spatial.metadata.spatialColumns);
    const [generationTable] = applyPostgisSpatialMetadata([table], spatial.metadata.spatialColumns);
    assert.ok(indexedTable && generationTable, "Both PostGIS normalization paths must retain the selected table.");
    assert.equal(schemaMetadataFingerprint(indexedTable), schemaMetadataFingerprint(generationTable),
      "Index-build and SQL-generation normalization must produce the same fingerprint.");
    assert.notEqual(schemaMetadataFingerprint(indexedTable), schemaMetadataFingerprint(table),
      "The enriched PostGIS geometry metadata must be represented in the index fingerprint.");
    assert.equal(rawSpatialColumn?.dataType, "geometry", "Normalization must not mutate the source metadata.");
    assert.ok(indexedTable.columns.some((column) => column.spatial?.srid === 3857));
    assert.ok(indexedTable.comment?.startsWith("Synthetic"));
    assert.ok(indexedTable.columns.some((column) => column.comment?.startsWith("Synthetic")));
    loaded.push(indexedTable);
  }
  assert.deepEqual(new Set(loaded.map((table) => table.schema)), new Set([schemas.roads, schemas.parks, schemas.transit]));
  assert.ok(!JSON.stringify(loaded).includes("UNSELECTED_SYNTHETIC_SENTINEL"), "Unselected Schema metadata must not enter the request.");

  stage = "embedding-and-local-multi-schema-retrieval";
  const timeoutMs = 60_000;
  const embedding = { ...embeddingConfig, timeoutMs };
  const documents = loaded.flatMap((table) => schemaTableDocumentChunks(table).map((document) => ({ table, document })));
  const vectors = [];
  for (let offset = 0; offset < documents.length; offset += 10) {
    vectors.push(...await createEmbedding(embedding, documents.slice(offset, offset + 10).map(({ document }) => document)));
  }
  assert.equal(vectors.length, documents.length);
  const chunks = documents.map((item, index) => ({ ...item, vector: vectors[index] }));
  assert.ok(vectors.every((vector) => vector.length === vectors[0].length));
  const query = `Using only these three synthetic tables: ${schemas.parks}.${tableNames.parks}(id, park_name, geom), ${schemas.roads}.${tableNames.roads}(id, road_class, length_m, geom), and ${schemas.transit}.${tableNames.transit}(id, stop_name, geom). Write one read-only PostgreSQL query with CTEs named road_agg and stop_agg. The exact physical table references are "${schemas.parks}"."${tableNames.parks}" AS p, "${schemas.roads}"."${tableNames.roads}" AS r, and "${schemas.transit}"."${tableNames.transit}" AS s. Keep each full schema.table pair intact; aliases p, r, and s may follow the table name but must never replace it or appear after a dot. First aggregate roads by park and road_class, counting distinct road IDs and summing the stored length_m, and separately count distinct transit stop IDs by park. Relate park polygons to road lines and stop points with ST_Intersects. Join the two per-park aggregates only after they are computed to avoid road-stop fan-out. Return one row per park and road_class, including parks with at least two stops even if they have no roads (use a NULL road_class and zero road count/length for those parks). Keep only parks with at least two distinct stops. Order by park_name ascending, then total road length descending. Use clear aliases for each table and CTE, and qualify every column reference in the CTEs, final SELECT, and ORDER BY. Do not use any other Schema or table.`;
  const [queryVector] = await createEmbedding(embedding, query);
  assert.equal(queryVector.length, vectors[0].length);
  const modelFingerprint = schemaModelFingerprint(embedding);
  const connectionId = "isolated-postgis-rag-smoke";
  const scopes = loaded.map((table) => schemaIndexScope(connectionId, tested.database, table.schema));
  const snapshot = loaded.reduce((current, table) => replaceSchemaIndexChunks(
    current,
    schemaIndexScope(connectionId, tested.database, table.schema),
    chunks.filter((item) => item.table === table),
    modelFingerprint,
  ), emptySchemaIndex());
  assert.deepEqual(findStaleSchemaIndexTableKeys(snapshot, scopes, loaded, modelFingerprint), [],
    "PostGIS metadata normalized for the existing index must not be reported stale.");
  const changedSpatialTables = loaded.map((table) => ({
    ...table,
    columns: table.columns.map((column) => column.spatial
      ? { ...column, spatial: { ...column.spatial, srid: column.spatial.srid + 1 } }
      : column),
  }));
  assert.deepEqual(
    findStaleSchemaIndexTableKeys(snapshot, scopes, changedSpatialTables, modelFingerprint).sort(),
    loaded.map((table) => schemaTableKey(table.schema, table.name)).sort(),
    "Changing the live spatial reference must mark every selected indexed table stale.",
  );
  const retrieved = searchSchemaIndex(snapshot, scopes, query, queryVector, modelFingerprint, 8);
  assert.equal(retrieved.rebuildRequired, false);
  assert.deepEqual(new Set(retrieved.matches.map((match) => match.tableKey)),
    new Set(loaded.map((table) => schemaTableKey(table.schema, table.name))));

  stage = "dashscope-rerank-and-chat";
  const documentsByKey = new Map(loaded.map((table) => [schemaTableKey(table.schema, table.name), schemaTableDocument(table).slice(0, 1_200)]));
  const candidateDocuments = retrieved.matches.map((match) => documentsByKey.get(match.tableKey));
  assert.ok(candidateDocuments.every(Boolean));
  const reranked = await rerank({ ...rerankConfig, timeoutMs }, query, candidateDocuments);
  const ranked = rankSchemaCandidatesByRerank(
    retrieved.matches.map((match) => ({ key: match.tableKey, score: match.score, selected: false })),
    reranked,
    8,
  );
  assert.deepEqual(new Set(ranked.map((candidate) => candidate.key)),
    new Set(loaded.map((table) => schemaTableKey(table.schema, table.name))));
  const tablesByKey = new Map(loaded.map((table) => [schemaTableKey(table.schema, table.name), table]));
  const assistantTables = ranked.map((candidate) => tablesByKey.get(candidate.key));
  const generated = await runSqlAssistant({ ...chatConfig, timeoutMs }, {
    task: "generate",
    request: query,
    context: {
      engine: "postgres",
      serverVersion: tested.serverVersion,
      database: tested.database,
      schema: schemas.roads,
      tables: assistantTables,
    },
  });
  assert.equal(generated.result.task, "generate");
  assert.ok(generated.result.sql, "Chat should return a multi-Schema read-only draft.");
  assert.equal(generated.validation?.valid, true,
    `Generated SQL must pass the local read-only and schema validator: ${(generated.validation?.errors ?? []).join("; ")}; shape=${JSON.stringify(sqlShapeSummary(generated.result.sql))}`);
  const referenced = generated.validation.referencedTables.map((table) => schemaTableKey(table.schema ?? "", table.name));
  assert.deepEqual(new Set(referenced), new Set(loaded.map((table) => schemaTableKey(table.schema, table.name))));
  assert.ok(!referenced.some((key) => key.includes(schemas.excluded)));
  const normalizedSql = generated.result.sql.toLowerCase();
  assert.match(normalizedSql, /^\s*(with|select)\b/, "The draft must be a single CTE or SELECT query.");
  assert.match(normalizedSql, /\broad_agg\s+as\s*\(/, "Road metrics must be aggregated in their own CTE.");
  assert.match(normalizedSql, /\bstop_agg\s+as\s*\(/, "Transit stops must be aggregated separately before joining.");
  assert.ok((normalizedSql.match(/\bst_intersects\s*\(/g) ?? []).length >= 2,
    "The draft must spatially relate parks to both roads and transit stops.");
  assert.ok((normalizedSql.match(/\bcount\s*\(\s*distinct\b/g) ?? []).length >= 2,
    "Road and transit aggregates must count distinct entity IDs separately.");
  assert.match(normalizedSql, /\bsum\s*\(/, "The road aggregate must sum the stored length.");
  assert.match(normalizedSql, /\blength_m\b/, "The road aggregate must use the supplied stored length column.");
  assert.match(normalizedSql, /\bleft\s+(outer\s+)?join\b/,
    "The final query must preserve parks without matching road aggregates.");
  assert.match(normalizedSql, /\bcoalesce\s*\(/,
    "The final query must return zero road counts or length for parks without roads.");
  assert.ok((normalizedSql.match(/\bgroup\s+by\b/g) ?? []).length >= 2,
    "Road category and stop-count metrics must be grouped separately by park.");
  assert.match(normalizedSql, />=\s*2\b/, "The query must retain only parks with at least two distinct stops.");
  assert.match(normalizedSql, /\border\s+by\b[\s\S]*\bpark_name\b[\s\S]*\basc\b[\s\S]*\bdesc\b/,
    "The query must include the requested park-name and descending road-length ordering.");

  process.stdout.write(`${JSON.stringify({
    database: "dbstudio_test",
    postgisVersion: health.rows[0].version,
    selectedSyntheticSchemas: loaded.length,
    loadedTables: loaded.length,
    loadedSpatialColumns: loaded.reduce((sum, table) => sum + table.columns.filter((column) => column.spatial).length, 0),
    livePostgisFingerprintParityChecks: loaded.length,
    postgisNormalizedSchemasReportedFresh: true,
    changedSpatialReferencesReportedStale: true,
    rawSpatialTypePreservedDuringNormalization: true,
    embeddingDimensions: vectors[0].length,
    retrievedSchemas: new Set(retrieved.matches.map((match) => tablesByKey.get(match.tableKey)?.schema)).size,
    rerankedTables: ranked.length,
    generatedTablesValidated: referenced.length,
    complexSpatialAggregationChecksPassed: true,
    readOnlyAndSchemaValidationPassed: generated.validation.valid,
    generatedSqlExecuted: false,
    businessRowsRead: false,
    unselectedSchemaSent: false,
    externalPayload: "synthetic schema metadata and synthetic intent only",
  })}\n`);
} catch (error) {
  primaryError = error;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ stage, error: message.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]") })}\n`);
  process.exitCode = 1;
} finally {
  let cleanupError;
  for (const schema of [...createdSchemas].reverse()) {
    try {
      await core.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (createdSchemas.length) {
    const remaining = await core.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])",
      [createdSchemas],
    ).catch(() => ({ rows: createdSchemas }));
    if (remaining.rows.length && !cleanupError) cleanupError = new Error("Synthetic Schema cleanup verification failed.");
  }
  if (cleanupError) {
    if (!primaryError) throw cleanupError;
    process.stderr.write("Synthetic PostGIS Schema cleanup failed.\n");
    process.exitCode = 1;
  }
}
