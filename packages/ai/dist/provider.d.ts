import type { ChatModelConfig, EmbeddingModelConfig, RerankModelConfig } from "./types.js";
export declare class AiProviderError extends Error {
    readonly code: "configuration" | "network" | "timeout" | "cancelled" | "provider" | "response";
    constructor(message: string, code?: "configuration" | "network" | "timeout" | "cancelled" | "provider" | "response");
}
export declare function validateModelBaseUrl(value: string): Promise<URL>;
export declare function createChatCompletion(config: ChatModelConfig, messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
}>, options?: {
    signal?: AbortSignal;
    onDelta?: (value: string) => void;
    forceNonStreaming?: boolean;
    jsonMode?: boolean;
    disableThinking?: boolean;
}): Promise<string>;
export declare function testChatModel(config: ChatModelConfig, signal?: AbortSignal): Promise<void>;
export declare function createEmbedding(config: EmbeddingModelConfig, input: string | string[], signal?: AbortSignal): Promise<number[][]>;
export declare function rerank(config: RerankModelConfig, query: string, documents: string[], signal?: AbortSignal): Promise<Array<{
    index: number;
    relevanceScore: number;
}>>;
export declare function testEmbeddingModel(config: EmbeddingModelConfig, signal?: AbortSignal): Promise<number>;
export declare function testRerankModel(config: RerankModelConfig, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=provider.d.ts.map