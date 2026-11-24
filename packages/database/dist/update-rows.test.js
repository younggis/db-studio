import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "./sqlite.js";
import { buildTableUpdateStatements, validateUpdateStatements } from "./adapter.js";
let adapter;
afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
});
async function createTestAdapter() {
    adapter = new SqliteAdapter({ path: ":memory:" });
    await adapter.query("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)");
    await adapter.query("INSERT INTO items (id, label) VALUES (?, ?)", [1, "one"]);
    await adapter.query("INSERT INTO items (id, label) VALUES (?, ?)", [2, "two"]);
    return adapter;
}
const columns = [
    { name: "id", dataType: "integer", nullable: false, defaultValue: null, primaryKey: true, ordinalPosition: 1 },
    { name: "tenant_id", dataType: "integer", nullable: false, defaultValue: null, primaryKey: true, ordinalPosition: 2 },
    { name: "label", dataType: "varchar", nullable: false, defaultValue: null, primaryKey: false, ordinalPosition: 3 },
    { name: "shape", dataType: "geometry", nullable: true, defaultValue: null, primaryKey: false, ordinalPosition: 4 },
];
describe("buildTableUpdateStatements", () => {
    it.each([
        ["postgres", '"label" = $1', '"id" = $2', '"tenant_id" = $3'],
        ["mysql", "`label` = ?", "`id` = ?", "`tenant_id` = ?"],
        ["mariadb", "`label` = ?", "`id` = ?", "`tenant_id` = ?"],
        ["sqlite", '"label" = ?', '"id" = ?', '"tenant_id" = ?'],
        ["sqlserver", "[label] = @p1", "[id] = @p2", "[tenant_id] = @p3"],
        ["oracle", '"label" = :1', '"id" = :2', '"tenant_id" = :3'],
    ])("builds quoted, parameterized updates for %s", (engine, setClause, firstKey, secondKey) => {
        const [statement] = buildTableUpdateStatements(engine, "odd schema", "odd table", columns, [{
                primaryKeyValues: { id: 7, tenant_id: 3 },
                values: { label: "edited'; DROP TABLE items; --" },
            }]);
        expect(statement?.sql).toContain(setClause);
        expect(statement?.sql).toContain(firstKey);
        expect(statement?.sql).toContain(secondKey);
        expect(statement?.sql).not.toContain("DROP TABLE");
        expect(statement?.parameters).toEqual(["edited'; DROP TABLE items; --", 7, 3]);
    });
    it("only uses actual primary keys and simple editable columns from metadata", () => {
        expect(() => buildTableUpdateStatements("sqlite", "main", "items", columns, [{
                primaryKeyValues: { id: 1 }, values: { label: "new" },
            }])).toThrow("exactly match");
        expect(() => buildTableUpdateStatements("sqlite", "main", "items", columns, [{
                primaryKeyValues: { id: 1, tenant_id: 1 }, values: { id: 2 },
            }])).toThrow("not editable");
        expect(() => buildTableUpdateStatements("sqlite", "main", "items", columns, [{
                primaryKeyValues: { id: 1, tenant_id: 1 }, values: { "label; DROP TABLE items": "new" },
            }])).toThrow("not editable");
        expect(() => buildTableUpdateStatements("sqlite", "main", "items", columns, [{
                primaryKeyValues: { id: 1, tenant_id: 1 }, values: { label: { nested: true } },
            }])).toThrow("scalar or NULL");
        expect(() => buildTableUpdateStatements("sqlite", "main", "items", [columns[2]], [{
                primaryKeyValues: {}, values: { label: "new" },
            }])).toThrow("no primary key");
    });
});
describe("validateUpdateStatements", () => {
    it("accepts bounded parameterized UPDATE statements and rejects other SQL verbs", () => {
        expect(validateUpdateStatements([{ sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["safe", 1] }]))
            .toHaveLength(1);
        expect(() => validateUpdateStatements([{ sql: "DELETE FROM items", parameters: [] }]))
            .toThrow("parameterized UPDATE");
        expect(() => validateUpdateStatements(Array.from({ length: 101 }, () => ({ sql: "UPDATE items SET label = ?", parameters: ["x"] }))))
            .toThrow("100 statements");
    });
});
describe("SqliteAdapter.updateRows", () => {
    it("commits all parameterized row updates in one transaction", async () => {
        const database = await createTestAdapter();
        const results = await database.updateRows([
            { sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["first", 1] },
            { sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["second", 2] },
        ]);
        const rows = await database.query("SELECT id, label FROM items ORDER BY id");
        expect(results.map((result) => result.rowCount)).toEqual([1, 1]);
        expect(rows.rows).toEqual([{ id: 1, label: "first" }, { id: 2, label: "second" }]);
    });
    it("rolls back every earlier row when a later update fails", async () => {
        const database = await createTestAdapter();
        await expect(database.updateRows([
            { sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["temporary", 1] },
            { sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["temporary", 2] },
        ])).rejects.toThrow();
        const rows = await database.query("SELECT id, label FROM items ORDER BY id");
        expect(rows.rows).toEqual([{ id: 1, label: "one" }, { id: 2, label: "two" }]);
    });
    it("rolls back when a primary-key target no longer exists", async () => {
        const database = await createTestAdapter();
        await expect(database.updateRows([
            { sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["temporary", 1] },
            { sql: "UPDATE items SET label = ? WHERE id = ?", parameters: ["missing", 99] },
        ])).rejects.toThrow("affected 0");
        const rows = await database.query("SELECT id, label FROM items ORDER BY id");
        expect(rows.rows).toEqual([{ id: 1, label: "one" }, { id: 2, label: "two" }]);
    });
});
//# sourceMappingURL=update-rows.test.js.map