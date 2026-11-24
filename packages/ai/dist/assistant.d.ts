import type { ChatModelConfig, SchemaTable, SqlAssistResult, SqlAssistantRequest, SqlValidationResult } from "./types.js";
export interface SqlAssistantResponse {
    result: SqlAssistResult;
    validation?: SqlValidationResult;
}
export declare function runSqlAssistant(config: ChatModelConfig, request: SqlAssistantRequest, options?: {
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
}): Promise<SqlAssistantResponse>;
export declare function selectRelevantTables(request: string, tables: SchemaTable[], selectedKeys?: string[], maxTables?: number): SchemaTable[];
export declare function loadSchemaCandidateMetadata(candidates: SchemaTable[], load: (candidate: SchemaTable) => Promise<SchemaTable>, options?: {
    concurrency?: number;
    signal?: AbortSignal;
}): Promise<{
    tables: SchemaTable[];
    failedCount: number;
}>;
export declare function compactSchemaText(tables: SchemaTable[]): string;
//# sourceMappingURL=assistant.d.ts.map