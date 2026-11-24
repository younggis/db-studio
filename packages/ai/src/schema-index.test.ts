import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  emptySchemaIndex,
  findSchemaIndexTableCoverageDifferences,
  rankSchemaCandidatesByRerank,
  replaceSchemaIndexChunks,
  replaceSchemaIndexTables,
  schemaIndexScope,
  schemaMetadataFingerprint,
  schemaModelFingerprint,
  schemaTableKey,
  schemaTableDocument,
  schemaTableDocumentChunks,
  searchSchemaIndex,
} from "./schema-index.js";
import type { EmbeddingModelConfig, SchemaTable } from "./types.js";

const embedding: EmbeddingModelConfig = {
  provider: "openai-compatible", baseURL: "https://embedding.example/v1", model: "embed-v1",
  apiKey: "test-key", dimensions: 3, enabled: true,
};

const streets: SchemaTable = {
  schema: "public", name: "streets", type: "table", comment: "Road centerlines",
  columns: [
    { name: "name", dataType: "text", nullable: true, primaryKey: false, comment: "Street name" },
    { name: "geom", dataType: "geometry", nullable: false, primaryKey: false, spatial: { kind: "geometry", geometryType: "MULTILINESTRING", srid: 26910 } },
  ],
};

describe("local Schema semantic index", () => {
  it("uses rerank order for retrieved candidates but keeps explicitly selected tables first", () => {
    const candidates = [
      { key: "public.users", score: 0.8, selected: false },
      { key: "public.parcels", score: 0.4, selected: false },
      { key: "public.chosen", score: 0.1, selected: true },
      { key: "public.roads", score: 0.2, selected: false },
    ];
    const reranked = [
      { index: 2, relevanceScore: 0.1 },
      { index: 1, relevanceScore: 0.96 },
      { index: 0, relevanceScore: 0.21 },
    ];
    expect(rankSchemaCandidatesByRerank(candidates, reranked, 3).map((candidate) => candidate.key))
      .toEqual(["public.chosen", "public.parcels", "public.users"]);
  });

  it("falls back to the existing hybrid score when rerank returns no usable candidates", () => {
    const candidates = [
      { key: "public.users", score: 0.8, selected: false },
      { key: "public.parcels", score: 0.4, selected: false },
    ];
    expect(rankSchemaCandidatesByRerank(candidates, [{ index: 9, relevanceScore: 1 }]).map((candidate) => candidate.key))
      .toEqual(["public.users", "public.parcels"]);
    expect(rankSchemaCandidatesByRerank(candidates, [], 0)).toEqual([]);
  });

  it("builds a table document from schema metadata without business rows", () => {
    const document = schemaTableDocument(streets);
    expect(document).toContain("public.streets table");
    expect(document).toContain("Street name");
    expect(document).toContain("geometry MULTILINESTRING 26910");
    expect(document).not.toContain("sample row");
  });

  it("retains fields and foreign keys before a very long table comment", () => {
    const document = schemaTableDocument({
      ...streets,
      comment: "x".repeat(45_000),
      foreignKeys: [{ columns: ["name"], referencedSchema: "public", referencedTable: "names", referencedColumns: ["name"] }],
    });
    expect(document.length).toBeLessThanOrEqual(40_000);
    expect(document).toContain("geom geometry");
    expect(document).toContain("name references public.names(name)");
  });

  it("embeds every part of a wide table and deduplicates its chunks during retrieval", () => {
    const wide: SchemaTable = {
      ...streets,
      name: "wide_table",
      comment: "Table metadata after all columns",
      columns: Array.from({ length: 2_000 }, (_, index) => ({
        name: `column_${String(index).padStart(4, "0")}`,
        dataType: "varchar(64)",
        nullable: true,
        primaryKey: false,
      })),
      foreignKeys: [{ columns: ["column_1999"], referencedSchema: "public", referencedTable: "names", referencedColumns: ["name"] }],
    };
    const documents = schemaTableDocumentChunks(wide);
    const combined = documents.join("\n");
    expect(documents.length).toBeGreaterThan(1);
    expect(documents.every((document) => document.length <= 8_000 && document.startsWith("public.wide_table table"))).toBe(true);
    expect(combined).toContain("column_1999 varchar(64)");
    expect(combined).toContain("references public.names(name)");
    expect(combined).toContain("Table metadata after all columns");

    const model = schemaModelFingerprint(embedding);
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const indexed = replaceSchemaIndexChunks(emptySchemaIndex(), scope, documents.map((document, index) => ({
      table: wide,
      document,
      vector: index === documents.length - 1 ? [0, 1, 0] : [1, 0, 0],
    })), model, 40);

    expect(indexed.entries).toHaveLength(documents.length);
    expect(searchSchemaIndex(indexed, scope, "column_1999", [0, 1, 0], model).matches)
      .toEqual([{ tableKey: schemaTableKey("public", "wide_table"), score: expect.any(Number) }]);
  });

  it("detects metadata changes beyond the bounded embedding document", () => {
    const first = { ...streets, comment: "x".repeat(45_000) + "first" };
    const second = { ...streets, comment: "x".repeat(45_000) + "second" };
    expect(schemaTableDocument(first)).toBe(schemaTableDocument(second));
    expect(schemaMetadataFingerprint(first)).not.toBe(schemaMetadataFingerprint(second));
  });

  it("reports tables missing from the index and orphaned indexed tables within selected scopes", () => {
    const model = schemaModelFingerprint(embedding);
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const otherScope = schemaIndexScope("connection-b", "gis", "public");
    const removed = { ...streets, name: "removed_roads" };
    const added = { ...streets, name: "new_roads" };
    const indexed = replaceSchemaIndexTables(
      replaceSchemaIndexTables(emptySchemaIndex(), scope, [streets, removed], [[1, 0, 0], [0, 1, 0]], model),
      otherScope,
      [{ ...streets, schema: "archive" }],
      [[0, 0, 1]],
      model,
    );

    expect(findSchemaIndexTableCoverageDifferences(indexed, scope, [streets, added], model)).toEqual({
      unindexedTableKeys: [schemaTableKey("public", "new_roads")],
      orphanedTableKeys: [schemaTableKey("public", "removed_roads")],
    });
  });

  it("treats entries from other Embedding models as unavailable coverage", () => {
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const oldModel = schemaModelFingerprint({ ...embedding, model: "embed-old" });
    const indexed = replaceSchemaIndexTables(emptySchemaIndex(), scope, [streets], [[1, 0, 0]], oldModel);

    expect(findSchemaIndexTableCoverageDifferences(indexed, scope, [streets], schemaModelFingerprint(embedding)))
      .toEqual({ unindexedTableKeys: [schemaTableKey("public", "streets")], orphanedTableKeys: [] });
  });

  it("ignores object key insertion order in metadata fingerprints", () => {
    const reordered: SchemaTable = { columns: streets.columns.map((column) => ({ ...column })), type: streets.type, name: streets.name, schema: streets.schema, comment: streets.comment };
    expect(schemaMetadataFingerprint(reordered)).toBe(schemaMetadataFingerprint(streets));
  });

  it("isolates indices by connection, database and schema and replaces selected tables incrementally", () => {
    const model = schemaModelFingerprint(embedding);
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const first = replaceSchemaIndexTables(emptySchemaIndex(), scope, [streets], [[1, 0, 0]], model, 10);
    const parks = { ...streets, name: "parks" };
    const second = replaceSchemaIndexTables(first, scope, [parks], [[0, 1, 0]], model, 20);
    const third = replaceSchemaIndexTables(second, scope, [streets], [[1, 0, 0]], model, 30);
    expect(third.entries.map((entry) => entry.tableKey).sort()).toEqual([schemaTableKey("public", "parks"), schemaTableKey("public", "streets")]);
    expect(searchSchemaIndex(third, scope, "street centerline", [1, 0, 0], model).matches[0]?.tableKey).toBe(schemaTableKey("public", "streets"));
    expect(searchSchemaIndex(third, schemaIndexScope("connection-b", "gis", "public"), "street", [1, 0, 0], model).matches).toEqual([]);
    expect(searchSchemaIndex(third, schemaIndexScope("connection-a", "analytics", "public"), "street", [1, 0, 0], model).matches).toEqual([]);
    expect(searchSchemaIndex(third, schemaIndexScope("connection-a", "gis", "private"), "street", [1, 0, 0], model).matches).toEqual([]);
  });

  it("searches only the selected Schema scopes and flags a partial model rebuild", () => {
    const model = schemaModelFingerprint(embedding);
    const publicScope = schemaIndexScope("connection-a", "gis", "public");
    const privateScope = schemaIndexScope("connection-a", "gis", "private");
    const unrelatedScope = schemaIndexScope("connection-a", "gis", "archive");
    const privateRoads: SchemaTable = { ...streets, schema: "private", name: "road_segments" };
    const unrelatedRoads: SchemaTable = { ...streets, schema: "archive", name: "road_segments" };
    const publicRoads = { ...streets, name: "road_segments" };
    const indexed = replaceSchemaIndexTables(
      replaceSchemaIndexTables(
        replaceSchemaIndexTables(emptySchemaIndex(), publicScope, [publicRoads], [[1, 0, 0]], model),
        privateScope,
        [privateRoads],
        [[0.9, 0.1, 0]],
        model,
      ),
      unrelatedScope,
      [unrelatedRoads],
      [[0, 1, 0]],
      model,
    );

    const searched = searchSchemaIndex(indexed, [publicScope, privateScope], "road segments", [1, 0, 0], model);
    expect(searched.matches.map((match) => match.tableKey).sort()).toEqual([schemaTableKey("private", "road_segments"), schemaTableKey("public", "road_segments")].sort());
    expect(searched.rebuildRequired).toBe(false);

    const oldModel = schemaModelFingerprint({ ...embedding, model: "embed-old" });
    const partiallyOld = replaceSchemaIndexTables(indexed, privateScope, [privateRoads], [[0.9, 0.1, 0]], oldModel);
    const partialSearch = searchSchemaIndex(partiallyOld, [publicScope, privateScope], "road segments", [1, 0, 0], model);
    expect(partialSearch.matches.map((match) => match.tableKey)).toEqual([schemaTableKey("public", "road_segments")]);
    expect(partialSearch.rebuildRequired).toBe(true);
    expect(searchSchemaIndex(indexed, [publicScope, privateScope], "road", [1, 0, 0], model).matches)
      .not.toContainEqual(expect.objectContaining({ tableKey: schemaTableKey("archive", "road_segments") }));
    expect(schemaTableKey("a.b", "c")).not.toBe(schemaTableKey("a", "b.c"));
  });

  it("requires rebuild when the Embedding model changes and rejects incompatible vector dimensions", () => {
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const firstModel = schemaModelFingerprint(embedding);
    const first = replaceSchemaIndexTables(emptySchemaIndex(), scope, [streets], [[1, 0, 0]], firstModel);
    const nextModel = schemaModelFingerprint({ ...embedding, model: "embed-v2" });
    expect(searchSchemaIndex(first, scope, "street", [1, 0, 0], nextModel).rebuildRequired).toBe(true);
    const parks = { ...streets, name: "parks" };
    expect(() => replaceSchemaIndexTables(first, scope, [streets, parks], [[1, 0], [0, 1, 0]], nextModel)).toThrow("维度");
    const rebuilt = replaceSchemaIndexTables(first, scope, [streets], [[0, 1]], nextModel);
    expect(rebuilt.entries.every((entry) => entry.modelFingerprint === nextModel)).toBe(true);
    expect(rebuilt.entries).toHaveLength(1);
  });

  it("requires rebuilding an index made with the earlier document format", () => {
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const legacyIdentity = JSON.stringify({ provider: embedding.provider, baseURL: embedding.baseURL, model: embedding.model, dimensions: embedding.dimensions });
    const legacyFingerprint = createHash("sha256").update(legacyIdentity).digest("hex");
    const oldIndex = replaceSchemaIndexTables(emptySchemaIndex(), scope, [streets], [[1, 0, 0]], legacyFingerprint);
    expect(searchSchemaIndex(oldIndex, scope, "street", [1, 0, 0], schemaModelFingerprint(embedding)))
      .toEqual({ matches: [], rebuildRequired: true });
    const parks = { ...streets, name: "parks" };
    const withOtherScope = replaceSchemaIndexTables(oldIndex, schemaIndexScope("connection-b", "gis", "public"), [parks], [[0, 1, 0]], legacyFingerprint);
    const rebuilt = replaceSchemaIndexTables(withOtherScope, scope, [parks], [[0, 1, 0]], schemaModelFingerprint(embedding));
    expect(rebuilt.entries.filter((entry) => entry.scope === scope).map((entry) => entry.tableKey)).toEqual([schemaTableKey("public", "parks")]);
    expect(rebuilt.entries.filter((entry) => entry.scope !== scope)).toHaveLength(1);
  });

  it("clears stale vectors for an empty rebuilt scope without touching other scopes", () => {
    const model = schemaModelFingerprint(embedding);
    const scope = schemaIndexScope("connection-a", "gis", "public");
    const otherScope = schemaIndexScope("connection-b", "gis", "public");
    const indexed = replaceSchemaIndexTables(
      replaceSchemaIndexTables(emptySchemaIndex(), scope, [streets], [[1, 0, 0]], model),
      otherScope,
      [{ ...streets, name: "parks" }],
      [[0, 1, 0]],
      model,
    );

    const cleared = replaceSchemaIndexTables(indexed, scope, [], [], model);

    expect(cleared.entries.map((entry) => entry.scope)).toEqual([otherScope]);
    expect(searchSchemaIndex(cleared, scope, "street", [1, 0, 0], model)).toEqual({ matches: [], rebuildRequired: false });
    expect(searchSchemaIndex(cleared, otherScope, "parks", [0, 1, 0], model).matches[0]?.tableKey).toBe(schemaTableKey("public", "parks"));
  });
});
