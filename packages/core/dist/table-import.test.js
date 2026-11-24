import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "@db-studio/database";
import { queryResultToXlsx } from "@db-studio/shared";
import { CoreService } from "./index.js";
let directory;
afterEach(async () => {
    if (directory)
        await rm(directory, { recursive: true, force: true });
    directory = undefined;
});
async function createService() {
    directory = await mkdtemp(join(tmpdir(), "db-studio-table-import-"));
    const path = join(directory, "test.sqlite");
    return { path, service: new CoreService(() => new SqliteAdapter({ path }), {}, false) };
}
describe("CoreService.createTableFromRows", () => {
    it("infers conservative SQLite column types and imports typed JSON rows", async () => {
        const { path, service } = await createService();
        const result = await service.createTableFromRows("imported_features", {
            columns: ["id", "label", "active", "score", "properties", "empty"],
            rows: [
                { id: 1, label: "北岸", active: true, score: 1.25, properties: { source: "fixture" }, empty: null },
                { id: 2, label: "South", active: false, score: 3, properties: { source: "fixture", rank: 2 }, empty: null },
            ],
        });
        const database = new SqliteAdapter({ path });
        const columns = await database.getTableColumns("imported_features");
        const rows = await database.readTable("imported_features");
        await database.close();
        expect(result).toEqual({
            table: "imported_features",
            insertedRows: 2,
            columns: ["id", "label", "active", "score", "properties", "empty"],
            inferredTypes: {
                id: "integer", label: "text", active: "boolean", score: "real", properties: "json", empty: "text",
            },
        });
        expect(columns.map((column) => [column.name, column.dataType])).toEqual([
            ["id", "INTEGER"], ["label", "TEXT"], ["active", "INTEGER"], ["score", "REAL"],
            ["properties", "TEXT"], ["empty", "TEXT"],
        ]);
        expect(rows.rows).toEqual([
            { id: 1, label: "北岸", active: 1, score: 1.25, properties: '{"source":"fixture"}', empty: null },
            { id: 2, label: "South", active: 0, score: 3, properties: '{"source":"fixture","rank":2}', empty: null },
        ]);
    });
    it("does not overwrite an existing table and rejects malformed source rows before DDL", async () => {
        const { path, service } = await createService();
        const seed = new SqliteAdapter({ path });
        await seed.query("CREATE TABLE Existing (value TEXT)");
        await seed.close();
        await expect(service.createTableFromRows("existing", { columns: ["value"], rows: [{ value: "new" }] }))
            .rejects.toThrow();
        await expect(service.createTableFromRows("broken", { columns: ["value"], rows: [{}] }))
            .rejects.toThrow("missing column");
        const verify = new SqliteAdapter({ path });
        const existing = await verify.readTable("Existing");
        expect((await verify.listTables()).some((table) => table.name === "broken")).toBe(false);
        await verify.close();
        expect(existing.rows).toEqual([]);
    });
    it("creates a table from the first worksheet of an Excel workbook", async () => {
        const { path, service } = await createService();
        const workbook = await queryResultToXlsx({
            columns: ["code", "description"],
            rows: [{ code: 7, description: "工作簿" }],
            rowCount: 1,
            command: "SELECT",
        });
        const imported = await service.importWorkbookToNewTable("excel_import", workbook);
        const database = new SqliteAdapter({ path });
        const rows = await database.readTable("excel_import");
        await database.close();
        expect(imported).toMatchObject({ table: "excel_import", insertedRows: 1, columns: ["code", "description"] });
        expect(rows.rows).toEqual([{ code: 7, description: "工作簿" }]);
    });
});
//# sourceMappingURL=table-import.test.js.map