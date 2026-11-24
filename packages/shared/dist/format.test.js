import { describe, expect, it } from "vitest";
import { parseTabularData, queryResultToCsv } from "./format.js";
describe("queryResultToCsv", () => {
    it("quotes commas, quotes and line breaks while preserving Unicode", () => {
        expect(queryResultToCsv({
            columns: ["名称", "note"],
            rows: [{ 名称: "甲,乙", note: 'said "hello"\nnext' }],
            rowCount: 1,
        })).toBe('名称,note\n"甲,乙","said ""hello""\nnext"');
    });
    it("neutralizes formula-like strings for spreadsheet consumers on request", () => {
        expect(queryResultToCsv({
            columns: ["value"],
            rows: [{ value: " =1+1" }, { value: -2 }],
            rowCount: 2,
        }, { spreadsheetSafe: true })).toBe("value\n' =1+1\n-2");
    });
    it("writes null values as empty cells and JSON-encodes object values", () => {
        expect(queryResultToCsv({
            columns: ["empty", "object"],
            rows: [{ empty: null, object: { ok: true } }],
            rowCount: 1,
        })).toBe('empty,object\n,"{""ok"":true}"');
    });
    it("round-trips CSV quoting, multiline values, nulls, empty strings and a literal null marker", () => {
        const result = {
            columns: ["名称", "note", "empty", "marker"],
            rows: [{ 名称: "甲,乙", note: 'line 1\r\nsaid "hello"', empty: "", marker: "\\N" },
                { 名称: "乙", note: null, empty: null, marker: null }],
            rowCount: 2,
        };
        const csv = queryResultToCsv(result, { nullValue: "\\N" });
        expect(parseTabularData(csv, "csv")).toEqual({ columns: result.columns, rows: result.rows });
    });
    it("reads query-result JSON exports and validates CSV structure", () => {
        expect(parseTabularData(JSON.stringify({ columns: ["id"], rows: [{ id: 2 }], rowCount: 1 }), "json"))
            .toEqual({ columns: ["id"], rows: [{ id: 2 }] });
        expect(() => parseTabularData("id,id\n1,2", "csv")).toThrow("duplicate column");
        expect(() => parseTabularData('id,name\n1,"open', "csv")).toThrow("unterminated");
        expect(() => parseTabularData('[{"id":1},{"name":"missing id"}]', "json"))
            .toThrow("exactly the columns");
    });
});
//# sourceMappingURL=format.test.js.map