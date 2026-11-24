import type { ChatModelConfig, MongoAssistantRequest, MongoAssistantResult } from "./types.js";
export declare function validateMongoAssistantResult(result: MongoAssistantResult): string[];
export declare function runMongoAssistant(config: ChatModelConfig, request: MongoAssistantRequest, options?: {
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
}): Promise<MongoAssistantResult>;
//# sourceMappingURL=mongo-assistant.d.ts.map