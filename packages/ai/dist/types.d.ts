import type { DatabaseEngine } from "@db-studio/shared";
export type SqlAssistantTask = "generate" | "repair" | "explain" | "explain-plan" | "optimize" | "gis";
export type MongoAssistantTask = "generate" | "repair" | "explain";
export type MongoQueryMode = "find" | "aggregate";
export interface MongoAssistantContext {
    database: string;
    collection: string;
    mode: MongoQueryMode;
    schemaHint?: string;
    query?: {
        filter?: string;
        projection?: string;
        sort?: string;
        pipeline?: string;
    };
    error?: {
        code?: string;
        message: string;
    };
}
export interface MongoAssistantRequest {
    task: MongoAssistantTask;
    request: string;
    context: MongoAssistantContext;
}
export interface MongoAssistantResult {
    task: MongoAssistantTask;
    mode: MongoQueryMode;
    filter?: Record<string, unknown>;
    projection?: Record<string, unknown>;
    sort?: Record<string, unknown>;
    pipeline?: Array<Record<string, unknown>>;
    explanation: string;
    assumptions: string[];
    warnings: string[];
}
export interface ChatModelConfig {
    id: string;
    name: string;
    provider: "openai-compatible";
    baseURL: string;
    model: string;
    apiKey: string;
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    streaming?: boolean;
    enabled: boolean;
}
export interface PublicChatModelConfig extends Omit<ChatModelConfig, "apiKey"> {
    apiKeySet: boolean;
}
export interface EmbeddingModelConfig {
    provider: "openai-compatible" | "dashscope";
    baseURL: string;
    model: string;
    apiKey: string;
    dimensions?: number;
    batchSize?: number;
    timeoutMs?: number;
    enabled: boolean;
}
export interface PublicEmbeddingModelConfig extends Omit<EmbeddingModelConfig, "apiKey"> {
    apiKeySet: boolean;
}
export interface RerankModelConfig {
    provider: "dashscope";
    baseURL: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
    enabled: boolean;
}
export interface PublicRerankModelConfig extends Omit<RerankModelConfig, "apiKey"> {
    apiKeySet: boolean;
}
export interface AiModelSettings {
    enabled: boolean;
    chatModels: ChatModelConfig[];
    defaultChatModelId?: string;
    embedding?: EmbeddingModelConfig;
    rerank?: RerankModelConfig;
}
export interface PublicAiModelSettings {
    enabled: boolean;
    chatModels: PublicChatModelConfig[];
    defaultChatModelId?: string;
    embedding?: PublicEmbeddingModelConfig;
    rerank?: PublicRerankModelConfig;
}
export interface SchemaColumn {
    name: string;
    dataType: string;
    nullable: boolean;
    primaryKey: boolean;
    comment?: string;
    spatial?: {
        kind: "geometry" | "geography";
        geometryType?: string;
        srid?: number;
        coordinateDimension?: number;
    };
}
export interface SchemaForeignKey {
    name?: string;
    columns: string[];
    referencedSchema?: string;
    referencedTable: string;
    referencedColumns: string[];
}
export interface SchemaTable {
    schema: string;
    name: string;
    type: "table" | "view";
    comment?: string;
    columns: SchemaColumn[];
    foreignKeys?: SchemaForeignKey[];
}
export interface PostgisSchemaMetadata {
    version?: string;
    spatialColumns: Array<{
        schema: string;
        table: string;
        column: string;
        kind: "geometry" | "geography";
        geometryType: string;
        srid: number;
        coordinateDimension?: number;
        coordinateUnits?: {
            kind: "angular" | "linear" | "unknown";
            name: string;
            metersPerUnit?: number;
        };
    }>;
    supportedFunctions?: string[];
}
export interface SqlAssistantContext {
    engine: DatabaseEngine;
    serverVersion: string;
    database: string;
    schema?: string;
    tables: SchemaTable[];
    postgis?: PostgisSchemaMetadata;
    metadataWarnings?: string[];
    selectedSql?: string;
    executionPlan?: string;
    error?: {
        code?: string;
        message: string;
        position?: number;
    };
}
export interface SqlAssistantRequest {
    task: SqlAssistantTask;
    request: string;
    context: SqlAssistantContext;
}
export interface SqlAssistResult {
    task: SqlAssistantTask;
    dialect: string;
    evidenceBasis?: "static-review" | "user-supplied-plan";
    sql?: string;
    explanation: string;
    referencedObjects?: string[];
    assumptions?: string[];
    warnings?: string[];
}
export interface SqlValidationResult {
    valid: boolean;
    readOnly: boolean;
    parsed: boolean;
    errors: string[];
    warnings: string[];
    referencedTables: Array<{
        schema?: string;
        name: string;
    }>;
}
export type AssistantDeltaHandler = (delta: string) => void;
//# sourceMappingURL=types.d.ts.map