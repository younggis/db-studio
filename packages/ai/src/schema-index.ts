import { createHash } from "node:crypto";
import { schemaTableKey } from "@db-studio/shared/schema-table-key";
import type { EmbeddingModelConfig, SchemaTable } from "./types.js";

export { schemaTableKey } from "@db-studio/shared/schema-table-key";

export interface SchemaIndexEntry {
  scope: string;
  tableKey: string;
  document: string;
  metadataFingerprint: string;
  modelFingerprint: string;
  dimensions: number;
  vector: number[];
  updatedAt: number;
}

export interface SchemaIndexSnapshot {
  version: 1;
  entries: SchemaIndexEntry[];
}

export interface SchemaIndexDocumentChunk {
  table: SchemaTable;
  document: string;
  vector: number[];
}

const MAX_SCHEMA_DOCUMENT_CHARS = 8_000;
const MAX_SCHEMA_DOCUMENT_CHUNKS_PER_TABLE = 32;
const MAX_SCHEMA_INDEX_ENTRIES = 20_000;

export interface SchemaIndexMatch {
  tableKey: string;
  score: number;
}

export interface SchemaIndexTableCoverageDifference {
  unindexedTableKeys: string[];
  orphanedTableKeys: string[];
}

export interface SchemaCandidateRank {
  key: string;
  score: number;
  selected: boolean;
}

export function rankSchemaCandidatesByRerank<T extends SchemaCandidateRank>(
  candidates: T[],
  reranked: Array<{ index: number; relevanceScore: number }>,
  limit = 8,
): T[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const order = new Map<number, number>();
  reranked
    .filter((result) => Number.isInteger(result.index) && result.index >= 0 && result.index < candidates.length
      && Number.isFinite(result.relevanceScore))
    .sort((left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index)
    .forEach((result, rank) => {
      if (!order.has(result.index)) order.set(result.index, rank);
    });
  return candidates.map((candidate, index) => ({ candidate, index, rerankPosition: order.get(index) }))
    .sort((left, right) => {
      if (left.candidate.selected !== right.candidate.selected) return Number(right.candidate.selected) - Number(left.candidate.selected);
      if (left.candidate.selected) return left.index - right.index;
      if (left.rerankPosition !== undefined && right.rerankPosition !== undefined && left.rerankPosition !== right.rerankPosition) {
        return left.rerankPosition - right.rerankPosition;
      }
      if (left.rerankPosition !== undefined && right.rerankPosition === undefined) return -1;
      if (left.rerankPosition === undefined && right.rerankPosition !== undefined) return 1;
      return right.candidate.score - left.candidate.score || left.index - right.index;
    })
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function emptySchemaIndex(): SchemaIndexSnapshot {
  return { version: 1, entries: [] };
}

export function schemaIndexScope(connectionId: string, database: string, schema: string): string {
  return [connectionId, database, schema].join("\0");
}

export function schemaModelFingerprint(config: EmbeddingModelConfig): string {
  const modelIdentity = JSON.stringify({
    schemaDocumentVersion: 5,
    provider: config.provider,
    baseURL: config.baseURL.trim().replace(/\/+$/, ""),
    model: config.model.trim(),
    dimensions: config.dimensions ?? null,
  });
  return createHash("sha256").update(modelIdentity).digest("hex");
}

function schemaTableDocumentLines(table: SchemaTable): string[] {
  const columns = table.columns.map((column) => [
    column.name,
    column.dataType,
    column.primaryKey ? "primary key" : "",
    column.nullable ? "nullable" : "not null",
    column.spatial ? [column.spatial.kind, column.spatial.geometryType ?? "", column.spatial.srid ?? ""].join(" ") : "",
  ].filter(Boolean).join(" "));
  const relations = (table.foreignKeys ?? []).map((key) =>
    key.columns.join(",") + " references " + [key.referencedSchema, key.referencedTable].filter(Boolean).join(".")
      + "(" + key.referencedColumns.join(",") + ")",
  );
  return [
    table.schema + "." + table.name + " " + table.type,
    ...columns,
    ...relations,
    table.comment ? `table comment: ${table.comment}` : "",
    ...table.columns.filter((column) => column.comment).map((column) => `${column.name} comment: ${column.comment}`),
  ].filter(Boolean);
}

export function schemaTableDocument(table: SchemaTable): string {
  return schemaTableDocumentLines(table).join("\n").slice(0, 40_000);
}

export function schemaTableDocumentChunks(table: SchemaTable): string[] {
  const [header, ...lines] = schemaTableDocumentLines(table);
  if (!header || header.length > MAX_SCHEMA_DOCUMENT_CHARS - 3) {
    throw new Error("Schema 表名超过单个 Embedding 文档长度上限。");
  }
  const chunks: string[] = [];
  const append = (document: string) => {
    if (chunks.length >= MAX_SCHEMA_DOCUMENT_CHUNKS_PER_TABLE) {
      throw new Error(`表 ${table.schema}.${table.name} 的结构过大，超过 ${MAX_SCHEMA_DOCUMENT_CHUNKS_PER_TABLE} 个 Embedding 文档上限。`);
    }
    chunks.push(document);
  };
  let current = header;
  const flush = () => {
    if (current.length > header.length) append(current);
    current = header;
  };

  for (const line of lines) {
    if (current.length + 1 + line.length <= MAX_SCHEMA_DOCUMENT_CHARS) {
      current += "\n" + line;
      continue;
    }
    flush();
    if (header.length + 1 + line.length <= MAX_SCHEMA_DOCUMENT_CHARS) {
      current += "\n" + line;
      continue;
    }
    const labelEnd = line.indexOf(": ");
    const label = labelEnd >= 0 && labelEnd < Math.min(256, MAX_SCHEMA_DOCUMENT_CHARS - header.length - 4)
      ? line.slice(0, labelEnd + 2) : "";
    let remainder = line.slice(label.length);
    const bodyLimit = MAX_SCHEMA_DOCUMENT_CHARS - header.length - 1 - label.length;
    while (remainder.length) {
      let end = Math.min(bodyLimit, remainder.length);
      if (end < remainder.length && end > 0) {
        const lastCodeUnit = remainder.charCodeAt(end - 1);
        if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
      }
      append(header + "\n" + label + remainder.slice(0, end));
      remainder = remainder.slice(end);
    }
  }
  flush();
  if (!chunks.length) append(header);
  return chunks;
}

export function schemaMetadataFingerprint(table: SchemaTable): string {
  const canonical = JSON.stringify(table, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")));
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function findStaleSchemaIndexTableKeys(
  snapshot: SchemaIndexSnapshot,
  scopes: string | readonly string[],
  tables: SchemaTable[],
  modelFingerprint: string,
): string[] {
  const scopeSet = new Set(typeof scopes === "string" ? [scopes] : scopes);
  const indexedByTable = new Map(snapshot.entries
    .filter((entry) => scopeSet.has(entry.scope) && entry.modelFingerprint === modelFingerprint)
    .map((entry) => [entry.tableKey, entry]));
  return tables.flatMap((table) => {
    const tableKey = schemaTableKey(table.schema, table.name);
    const indexed = indexedByTable.get(tableKey);
    return indexed && indexed.metadataFingerprint !== schemaMetadataFingerprint(table) ? [tableKey] : [];
  });
}

export function findSchemaIndexTableCoverageDifferences(
  snapshot: SchemaIndexSnapshot,
  scopes: string | readonly string[],
  tables: SchemaTable[],
  modelFingerprint: string,
): SchemaIndexTableCoverageDifference {
  const scopeSet = new Set(typeof scopes === "string" ? [scopes] : scopes);
  const indexedTableKeys = new Set(snapshot.entries
    .filter((entry) => scopeSet.has(entry.scope) && entry.modelFingerprint === modelFingerprint)
    .map((entry) => entry.tableKey));
  const currentTableKeys = new Set(tables.map((table) => schemaTableKey(table.schema, table.name)));
  return {
    unindexedTableKeys: [...currentTableKeys].filter((key) => !indexedTableKeys.has(key)).sort((left, right) => left.localeCompare(right, "en")),
    orphanedTableKeys: [...indexedTableKeys].filter((key) => !currentTableKeys.has(key)).sort((left, right) => left.localeCompare(right, "en")),
  };
}

export function replaceSchemaIndexTables(
  snapshot: SchemaIndexSnapshot,
  scope: string,
  tables: SchemaTable[],
  vectors: number[][],
  modelFingerprint: string,
  now = Date.now(),
): SchemaIndexSnapshot {
  if (tables.length !== vectors.length) throw new Error("Schema 索引文档和向量数量不匹配。");
  if (new Set(tables.map((table) => schemaTableKey(table.schema, table.name))).size !== tables.length) {
    throw new Error("Schema 索引包含重复表。");
  }
  if (!tables.length) {
    return { version: 1, entries: snapshot.entries.filter((entry) => entry.scope !== scope) };
  }
  return replaceSchemaIndexChunks(snapshot, scope, tables.map((table, index) => ({
    table,
    document: schemaTableDocument(table),
    vector: vectors[index]!,
  })), modelFingerprint, now);
}

export function replaceSchemaIndexChunks(
  snapshot: SchemaIndexSnapshot,
  scope: string,
  chunks: SchemaIndexDocumentChunk[],
  modelFingerprint: string,
  now = Date.now(),
): SchemaIndexSnapshot {
  if (!chunks.length) {
    return { version: 1, entries: snapshot.entries.filter((entry) => entry.scope !== scope) };
  }
  const dimensions = chunks[0]?.vector.length ?? 0;
  if (!dimensions || chunks.some(({ vector }) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error("Schema Embedding 向量维度或数值无效。");
  }
  const tableFingerprints = new Map<string, string>();
  const fingerprintsByTable = new Map<SchemaTable, string>();
  for (const { table, document } of chunks) {
    if (!document || document.length > 40_000) throw new Error("Schema 索引文档长度无效。");
    const key = schemaTableKey(table.schema, table.name);
    const fingerprint = fingerprintsByTable.get(table) ?? schemaMetadataFingerprint(table);
    fingerprintsByTable.set(table, fingerprint);
    const previous = tableFingerprints.get(key);
    if (previous && previous !== fingerprint) throw new Error("同一张表的 Schema 索引分块元数据不一致。");
    tableFingerprints.set(key, fingerprint);
  }
  const tableKeys = new Set(tableFingerprints.keys());
  const existingScope = snapshot.entries.filter((entry) => entry.scope === scope);
  const switchedModel = existingScope.some((entry) => entry.modelFingerprint !== modelFingerprint || entry.dimensions !== dimensions);
  const retained = snapshot.entries.filter((entry) => entry.scope !== scope || (!switchedModel && !tableKeys.has(entry.tableKey)));
  const entries = chunks.map(({ table, document, vector }): SchemaIndexEntry => ({
    scope,
    tableKey: schemaTableKey(table.schema, table.name),
    document,
    metadataFingerprint: tableFingerprints.get(schemaTableKey(table.schema, table.name))!,
    modelFingerprint,
    dimensions,
    vector: [...vector],
    updatedAt: now,
  }));
  const nextEntries = [...retained, ...entries];
  if (nextEntries.length > MAX_SCHEMA_INDEX_ENTRIES) {
    throw new Error("本机 Schema 索引条目超过上限；请先清理不再使用的 Schema 索引。");
  }
  return { version: 1, entries: nextEntries };
}

export function searchSchemaIndex(
  snapshot: SchemaIndexSnapshot,
  scope: string | readonly string[],
  query: string,
  queryVector: number[],
  modelFingerprint: string,
  limit = 8,
): { matches: SchemaIndexMatch[]; rebuildRequired: boolean } {
  const scopes = new Set(typeof scope === "string" ? [scope] : scope);
  const inScope = snapshot.entries.filter((entry) => scopes.has(entry.scope));
  const compatible = inScope.filter((entry) => entry.modelFingerprint === modelFingerprint);
  if (!compatible.length) return { matches: [], rebuildRequired: inScope.length > 0 };
  const rebuildRequired = compatible.length !== inScope.length;
  const dimensions = compatible[0]!.dimensions;
  if (queryVector.length !== dimensions || compatible.some((entry) => entry.dimensions !== dimensions || entry.vector.length !== dimensions)) {
    return { matches: [], rebuildRequired: true };
  }
  const queryTokens = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? []);
  const matches = compatible.map((entry) => {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const left = queryVector[index]!;
      const right = entry.vector[index]!;
      dot += left * right;
      leftNorm += left * left;
      rightNorm += right * right;
    }
    const cosine = leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
    const documentTokens = new Set(entry.document.toLocaleLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? []);
    let common = 0;
    for (const token of queryTokens) if (documentTokens.has(token)) common += 1;
    const lexical = queryTokens.size ? common / queryTokens.size : 0;
    return { tableKey: entry.tableKey, score: 0.8 * ((cosine + 1) / 2) + 0.2 * lexical };
  }).sort((left, right) => right.score - left.score || left.tableKey.localeCompare(right.tableKey));
  const bestByTable = new Map<string, SchemaIndexMatch>();
  for (const match of matches) {
    const previous = bestByTable.get(match.tableKey);
    if (!previous || match.score > previous.score) bestByTable.set(match.tableKey, match);
  }
  return {
    matches: [...bestByTable.values()].sort((left, right) => right.score - left.score || left.tableKey.localeCompare(right.tableKey)).slice(0, Math.max(1, limit)),
    rebuildRequired,
  };
}

export function isSchemaIndexSnapshot(value: unknown): value is SchemaIndexSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SchemaIndexSnapshot>;
  return candidate.version === 1 && Array.isArray(candidate.entries) && candidate.entries.length <= MAX_SCHEMA_INDEX_ENTRIES
    && candidate.entries.every((entry) => entry && typeof entry.scope === "string" && typeof entry.tableKey === "string"
      && typeof entry.document === "string" && typeof entry.metadataFingerprint === "string"
      && typeof entry.modelFingerprint === "string" && Number.isInteger(entry.dimensions)
      && Array.isArray(entry.vector) && entry.vector.length === entry.dimensions
      && entry.vector.every((number) => typeof number === "number" && Number.isFinite(number))
      && Number.isFinite(entry.updatedAt));
}

