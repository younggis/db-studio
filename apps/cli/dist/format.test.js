import { describe, expect, it } from "vitest";
import { formatQueryResult } from "./format.js";
const result = {
    columns: ["id", "name", "active"],
    rows: [
        { id: 1, name: 'A,"B"', active: true },
        { id: 2, name: "second line\ncontinued", active: null },
    ],
    rowCount: 2,
};
describe("formatQueryResult", () => {
    it("escapes CSV values and preserves nulls as empty cells", () => {
        expect(formatQueryResult(result, "csv")).toBe('id,name,active\n1,"A,""B""",true\n2,"second line\ncontinued",');
    });
    it("renders one JSON document with column and row metadata", () => {
        expect(JSON.parse(formatQueryResult(result, "json"))).toEqual(result);
    });
    it("renders one JSON value per line for NDJSON", () => {
        expect(formatQueryResult(result, "ndjson").split("\n").map((line) => JSON.parse(line))).toEqual(result.rows);
    });
    it("renders a readable table", () => {
        expect(formatQueryResult(result, "table")).toContain("(2 rows)");
        expect(formatQueryResult(result, "table")).toContain("| id | name  | active |");
    });
});
//# sourceMappingURL=format.test.js.map