import type { QueryResult } from "./index.js";
import type { TabularData } from "./format.js";
export declare function parseExcelWorkbook(content: Uint8Array): Promise<TabularData>;
export declare function queryResultToXlsx(result: QueryResult): Promise<Uint8Array>;
//# sourceMappingURL=spreadsheet.d.ts.map