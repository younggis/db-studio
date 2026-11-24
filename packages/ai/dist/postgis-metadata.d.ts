import type { PostgisSchemaMetadata, SchemaTable } from "./types.js";
export type PostgisMetadataQuery = (sql: string, parameters?: unknown[]) => Promise<{
    rows: Array<Record<string, unknown>>;
}>;
export declare function applyPostgisSpatialMetadata(tables: SchemaTable[], spatialColumns: PostgisSchemaMetadata["spatialColumns"]): SchemaTable[];
export declare function loadPostgisSchemaMetadata(query: PostgisMetadataQuery, schema: string, tables: SchemaTable[]): Promise<{
    metadata: PostgisSchemaMetadata;
    warnings: string[];
}>;
//# sourceMappingURL=postgis-metadata.d.ts.map