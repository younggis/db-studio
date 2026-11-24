import type { QueryResult } from "./index.js";
export declare function queryResultToCsv(result: QueryResult, options?: {
    spreadsheetSafe?: boolean;
    nullValue?: string;
}): string;
export interface TabularData {
    columns: string[];
    rows: Record<string, unknown>[];
}
export declare function parseTabularData(content: string, format: "csv" | "json", options?: {
    nullValue?: string;
}): TabularData;
//# sourceMappingURL=format.d.ts.map