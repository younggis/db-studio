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
export declare function rankSchemaCandidatesByRerank<T extends SchemaCandidateRank>(candidates: T[], reranked: Array<{
    index: number;
    relevanceScore: number;
}>, limit?: number): T[];
export declare function emptySchemaIndex(): SchemaIndexSnapshot;
export declare function schemaIndexScope(connectionId: string, database: string, schema: string): string;
export declare function schemaModelFingerprint(config: EmbeddingModelConfig): string;
export declare function schemaTableDocument(table: SchemaTable): string;
export declare function schemaTableDocumentChunks(table: SchemaTable): string[];
export declare function schemaMetadataFingerprint(table: SchemaTable): string;
export declare function findStaleSchemaIndexTableKeys(snapshot: SchemaIndexSnapshot, scopes: string | readonly string[], tables: SchemaTable[], modelFingerprint: string): string[];
export declare function findSchemaIndexTableCoverageDifferences(snapshot: SchemaIndexSnapshot, scopes: string | readonly string[], tables: SchemaTable[], modelFingerprint: string): SchemaIndexTableCoverageDifference;
export declare function replaceSchemaIndexTables(snapshot: SchemaIndexSnapshot, scope: string, tables: SchemaTable[], vectors: number[][], modelFingerprint: string, now?: number): SchemaIndexSnapshot;
export declare function replaceSchemaIndexChunks(snapshot: SchemaIndexSnapshot, scope: string, chunks: SchemaIndexDocumentChunk[], modelFingerprint: string, now?: number): SchemaIndexSnapshot;
export declare function searchSchemaIndex(snapshot: SchemaIndexSnapshot, scope: string | readonly string[], query: string, queryVector: number[], modelFingerprint: string, limit?: number): {
    matches: SchemaIndexMatch[];
    rebuildRequired: boolean;
};
export declare function isSchemaIndexSnapshot(value: unknown): value is SchemaIndexSnapshot;
//# sourceMappingURL=schema-index.d.ts.map