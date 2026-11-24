import type { Writable } from "node:stream";
import { type QueryResult, type QueryResultBatch } from "@db-studio/shared";
export type OutputFormat = "table" | "json" | "csv" | "ndjson";
export declare function formatQueryResult(result: QueryResult, format: OutputFormat): string;
export declare function writeQueryResultNdjsonStream(batches: AsyncIterable<QueryResultBatch>, output: Writable, signal?: AbortSignal): Promise<number>;
//# sourceMappingURL=format.d.ts.map