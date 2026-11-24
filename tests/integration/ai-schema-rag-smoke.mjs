import assert from "node:assert/strict";
import {
  createEmbedding,
  emptySchemaIndex,
  runSqlAssistant,
  rankSchemaCandidatesByRerank,
  rerank,
  replaceSchemaIndexChunks,
  schemaIndexScope,
  schemaModelFingerprint,
  schemaTableKey,
  schemaTableDocument,
  schemaTableDocumentChunks,
  searchSchemaIndex,
} from "../../packages/ai/dist/index.js";
import { readDesktopAiModelSettings } from "../../apps/cli/dist/model-settings.js";

const settings = await readDesktopAiModelSettings();
const chatConfig = settings?.chatModels.find((model) => model.id === settings.defaultChatModelId && model.enabled)
  ?? settings?.chatModels.find((model) => model.enabled);
const embeddingConfig = settings?.embedding;
const rerankConfig = settings?.rerank;
assert.ok(settings?.enabled, "Enable the encrypted desktop AI settings first.");
assert.ok(chatConfig?.apiKey, "Enable a Chat model first.");
assert.ok(embeddingConfig?.enabled && embeddingConfig.apiKey, "Enable an Embedding model first.");
assert.ok(rerankConfig?.enabled && rerankConfig.apiKey, "Enable a Rerank model first.");

const tables = [
  {
    schema: "public", name: "road_segments", type: "table", comment: "Synthetic road centerline segments",
    columns: [
      { name: "road_class", dataType: "text", nullable: false, primaryKey: false, comment: "Synthetic road category" },
      { name: "segment_length_m", dataType: "numeric", nullable: true, primaryKey: false, comment: "Synthetic segment length in meters" },
      { name: "geom", dataType: "geometry", nullable: false, primaryKey: false, spatial: { kind: "geometry", geometryType: "MULTILINESTRING", srid: 3857 } },
    ],
  },
  {
    schema: "parks", name: "park_areas", type: "table", comment: "Synthetic public park boundaries",
    columns: [
      { name: "park_name", dataType: "text", nullable: false, primaryKey: false },
      { name: "area_m2", dataType: "numeric", nullable: true, primaryKey: false },
      { name: "geom", dataType: "geometry", nullable: false, primaryKey: false, spatial: { kind: "geometry", geometryType: "MULTIPOLYGON", srid: 3857 } },
    ],
  },
  {
    schema: "crm", name: "customer_accounts", type: "table", comment: "Synthetic account profile metadata",
    columns: [
      { name: "account_type", dataType: "text", nullable: false, primaryKey: false },
      { name: "created_at", dataType: "timestamp with time zone", nullable: false, primaryKey: false },
    ],
  },
];
const documents = tables.flatMap((table) => schemaTableDocumentChunks(table).map((document) => ({ table, document })));
const query = "Find the table for major road categories and line-shaped street segments.";
const timeoutMs = 45_000;
const stage = { value: "embedding-schema-documents" };

try {
  const vectors = [];
  for (let offset = 0; offset < documents.length; offset += 10) {
    vectors.push(...await createEmbedding({ ...embeddingConfig, timeoutMs }, documents.slice(offset, offset + 10).map(({ document }) => document)));
  }
  assert.equal(vectors.length, documents.length);
  const chunks = documents.map((item, index) => ({ ...item, vector: vectors[index] }));
  assert.ok(vectors.every((vector) => vector.length === vectors[0].length));

  stage.value = "embedding-query";
  const [queryVector] = await createEmbedding({ ...embeddingConfig, timeoutMs }, query);
  assert.equal(queryVector.length, vectors[0].length);

  const scopes = [...new Set(tables.map((table) => schemaIndexScope("synthetic-connection", "synthetic-database", table.schema)))];
  const otherScope = schemaIndexScope("another-synthetic-connection", "synthetic-database", "public");
  const modelFingerprint = schemaModelFingerprint(embeddingConfig);
  const snapshot = tables.reduce((current, table) => replaceSchemaIndexChunks(
    current,
    schemaIndexScope("synthetic-connection", "synthetic-database", table.schema),
    chunks.filter((item) => item.table === table),
    modelFingerprint,
  ), emptySchemaIndex());
  const otherChunks = chunks.filter((item) => item.table === tables[1]);
  const otherSnapshot = replaceSchemaIndexChunks(snapshot, otherScope, otherChunks, modelFingerprint);

  stage.value = "semantic-retrieval";
  const retrieved = searchSchemaIndex(otherSnapshot, scopes, query, queryVector, modelFingerprint, tables.length);
  assert.equal(retrieved.rebuildRequired, false);
  assert.equal(retrieved.matches.length, tables.length);
  const unrelatedScopes = tables.map((table) => schemaIndexScope("unrelated-connection", "synthetic-database", table.schema));
  assert.equal(searchSchemaIndex(otherSnapshot, unrelatedScopes, query, queryVector, modelFingerprint).matches.length, 0);

  stage.value = "rerank";
  const documentsByKey = new Map(tables.map((table) => [schemaTableKey(table.schema, table.name), schemaTableDocument(table).slice(0, 1_200)]));
  const retrievedDocuments = retrieved.matches.map((match) => {
    const document = documentsByKey.get(match.tableKey);
    assert.ok(document, `Expected a document for retrieved table ${match.tableKey}.`);
    return document;
  });
  const reranked = await rerank(
    { ...rerankConfig, timeoutMs },
    query,
    retrievedDocuments,
  );
  const ordered = rankSchemaCandidatesByRerank(
    retrieved.matches.map((match) => ({ key: match.tableKey, score: match.score, selected: false })),
    reranked,
    tables.length,
  );
  assert.equal(ordered[0]?.key, schemaTableKey("public", "road_segments"), "Rerank should put the synthetic road Schema first.");

  const crossSchemaQuery = "For each synthetic park polygon, list each road category whose line intersects it. Return one row per distinct park name and road category. Use ST_Intersects and fully qualify both table names with their Schema names.";
  const selectedScopes = [
    schemaIndexScope("synthetic-connection", "synthetic-database", "public"),
    schemaIndexScope("synthetic-connection", "synthetic-database", "parks"),
  ];
  stage.value = "cross-schema-retrieval";
  const [crossSchemaQueryVector] = await createEmbedding({ ...embeddingConfig, timeoutMs }, crossSchemaQuery);
  assert.equal(crossSchemaQueryVector.length, vectors[0].length);
  const crossSchemaRetrieved = searchSchemaIndex(
    otherSnapshot,
    selectedScopes,
    crossSchemaQuery,
    crossSchemaQueryVector,
    modelFingerprint,
    tables.length,
  );
  assert.equal(crossSchemaRetrieved.rebuildRequired, false);
  const crossSchemaDocuments = crossSchemaRetrieved.matches.map((match) => {
    const document = documentsByKey.get(match.tableKey);
    assert.ok(document, `Expected a cross-Schema document for ${match.tableKey}.`);
    return document;
  });
  stage.value = "cross-schema-rerank";
  const crossSchemaReranked = await rerank(
    { ...rerankConfig, timeoutMs },
    crossSchemaQuery,
    crossSchemaDocuments,
  );
  const crossSchemaOrdered = rankSchemaCandidatesByRerank(
    crossSchemaRetrieved.matches.map((match) => ({ key: match.tableKey, score: match.score, selected: false })),
    crossSchemaReranked,
    2,
  );
  const expectedCrossSchemaKeys = [schemaTableKey("parks", "park_areas"), schemaTableKey("public", "road_segments")];
  assert.deepEqual(new Set(crossSchemaOrdered.map((candidate) => candidate.key)), new Set(expectedCrossSchemaKeys));

  stage.value = "cross-schema-chat";
  const tablesByKey = new Map(tables.map((table) => [schemaTableKey(table.schema, table.name), table]));
  const assistantTables = crossSchemaOrdered.map((candidate) => {
    const table = tablesByKey.get(candidate.key);
    assert.ok(table, `Expected complete synthetic Schema metadata for ${candidate.key}.`);
    return table;
  });
  const generated = await runSqlAssistant({ ...chatConfig, timeoutMs }, {
    task: "generate",
    request: crossSchemaQuery + " Use only the supplied synthetic columns and do not reference CRM tables.",
    context: {
      engine: "postgres",
      serverVersion: "16 synthetic",
      database: "synthetic-database",
      schema: "public",
      tables: assistantTables,
    },
  });
  assert.equal(generated.result.task, "generate");
  assert.ok(generated.result.sql, "Chat should return a cross-Schema SQL draft.");
  assert.equal(generated.validation?.valid, true, "The cross-Schema SQL must pass read-only/schema validation.");
  const referencedKeys = generated.validation?.referencedTables.map((table) => schemaTableKey(table.schema ?? "", table.name)) ?? [];
  assert.deepEqual(new Set(referencedKeys), new Set(expectedCrossSchemaKeys), "The draft should reference both selected synthetic Schemas and no other tables.");

  const cleared = scopes.reduce((current, scope) => replaceSchemaIndexChunks(current, scope, [], modelFingerprint), otherSnapshot);
  assert.equal(cleared.entries.filter((entry) => scopes.includes(entry.scope)).length, 0);
  assert.equal(cleared.entries.filter((entry) => entry.scope === otherScope).length, otherChunks.length);

  stage.value = "wide-schema-embedding";
  const lateField = "stormwater_inspection_status";
  const wide = {
    schema: "wide_test", name: "synthetic_assets", type: "table",
    columns: Array.from({ length: 1_500 }, (_, index) => ({
      name: index === 1_499 ? lateField : `synthetic_asset_field_${index}`,
      dataType: "text", nullable: true, primaryKey: false,
    })),
  };
  assert.ok(!schemaTableDocument(wide).includes(lateField));
  const wideDocuments = schemaTableDocumentChunks(wide);
  assert.ok(wideDocuments.length > 1 && wideDocuments.at(-1).includes(lateField));
  const wideVectors = [];
  for (let offset = 0; offset < wideDocuments.length; offset += 10) {
    wideVectors.push(...await createEmbedding({ ...embeddingConfig, timeoutMs }, wideDocuments.slice(offset, offset + 10)));
  }
  const wideScope = schemaIndexScope("synthetic-connection", "synthetic-database", wide.schema);
  const wideChunks = wideDocuments.map((document, index) => ({ table: wide, document, vector: wideVectors[index] }));
  const wideSnapshot = replaceSchemaIndexChunks(cleared, wideScope, wideChunks, modelFingerprint);
  const prefixSnapshot = replaceSchemaIndexChunks(cleared, wideScope, wideChunks.slice(0, -1), modelFingerprint);
  // Use the returned tail vector to make the storage and scoring check deterministic.
  const tailVector = wideVectors.at(-1);
  const wideMatch = searchSchemaIndex(wideSnapshot, wideScope, lateField, tailVector, modelFingerprint).matches;
  const prefixMatch = searchSchemaIndex(prefixSnapshot, wideScope, lateField, tailVector, modelFingerprint).matches;
  assert.equal(wideMatch.length, 1);
  assert.equal(wideMatch[0].tableKey, schemaTableKey(wide.schema, wide.name));
  assert.ok(wideMatch[0].score > prefixMatch[0].score);
  const replaced = replaceSchemaIndexChunks(wideSnapshot, wideScope, wideChunks.slice(0, 1), modelFingerprint);
  assert.equal(replaced.entries.filter((entry) => entry.scope === wideScope).length, 1);

  process.stdout.write(`${JSON.stringify({
    embeddingDimensions: vectors[0].length,
    indexedSyntheticTables: tables.length,
    indexedDocuments: documents.length,
    wideTable: { columns: wide.columns.length, documents: wideDocuments.length, lateFieldScoreImproved: true, replacedAllChunks: true },
    indexedSyntheticSchemas: tables.map((table) => table.schema),
    retrievedCandidates: retrieved.matches.length,
    rerankedFirst: ordered[0].key,
    crossSchemaChat: {
      retrievedTables: crossSchemaRetrieved.matches.length,
      rerankedSchemas: [...new Set(crossSchemaOrdered.map((candidate) => tablesByKey.get(candidate.key)?.schema))],
      referencedTables: referencedKeys,
      validatedReadOnly: generated.validation.valid,
    },
    unrelatedConnectionMatches: 0,
    scopedClearPreservedOtherScope: true,
    schemaSent: "synthetic only",
  })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ stage: stage.value, error: message.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]") })}\n`);
  process.exitCode = 1;
}
