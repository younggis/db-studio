import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "./sqlite.js";
describe("SqliteAdapter", () => {
    let adapter;
    beforeEach(() => {
        adapter = new SqliteAdapter({ path: ":memory:" });
    });
    afterEach(async () => {
        await adapter.close();
    });
    it("checks the local database connection and lists attached databases", async () => {
        const connection = await adapter.testConnection();
        expect(connection.database).toBe(":memory:");
        expect(connection.serverVersion).toMatch(/^\d+\.\d+/);
        expect(await adapter.listDatabases()).toContain("main");
        expect(await adapter.listSchemas()).toContain("temp");
    });
    it("binds query parameters and returns columns, rows, and modification counts", async () => {
        await adapter.query("CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
        const insert = await adapter.query("INSERT INTO places (name) VALUES (?)", ["甲"]);
        const select = await adapter.query("SELECT id, name FROM places WHERE name = ?", ["甲"]);
        expect(insert).toMatchObject({ command: "INSERT", rowCount: 1, columns: [], rows: [] });
        expect(select).toMatchObject({
            command: "SELECT",
            rowCount: 1,
            columns: ["id", "name"],
            rows: [{ id: 1, name: "甲" }],
        });
    });
    it("decodes GeoPackage geometry blobs and SpatiaLite-native blobs", async () => {
        const wkb = Buffer.from("0101000000000000000000f03f0000000000000040", "hex");
        const header = Buffer.alloc(8);
        header.write("GP", 0, "ascii");
        header[3] = 0x01;
        header.writeInt32LE(4326, 4);
        await adapter.query("CREATE TABLE places (id INTEGER PRIMARY KEY, shape GEOMETRY)");
        await adapter.query("INSERT INTO places VALUES (?, ?)", [1, Buffer.concat([header, wkb])]);
        const page = await adapter.readTablePage("places", ["id", "shape"], ["id"], undefined, 10, "main", { spatialWkbColumns: ["shape"] });
        expect(page.rows[0]).toMatchObject({ shape: { kind: "db-studio-spatial-wkb", spatialType: "geometry", srid: 4326 } });
        const spatialiteBlob = Buffer.from("0001e6100000000000000000f03f0000000000000040000000000000f03f00000000000000407c01000000000000000000f03f0000000000000040fe", "hex");
        await adapter.query("INSERT INTO places VALUES (?, ?)", [2, spatialiteBlob]);
        const both = await adapter.readTablePage("places", ["id", "shape"], ["id"], undefined, 10, "main", { spatialWkbColumns: ["shape"] });
        expect(both.rows[1]).toMatchObject({ shape: { kind: "db-studio-spatial-wkb", spatialType: "geometry", srid: 4326 } });
        expect(Buffer.from(both.rows[1].shape.wkb).toString("hex")).toBe(wkb.toString("hex"));
    });
    it("stores Date parameters as ISO-8601 text and rejects invalid dates", async () => {
        const date = new Date("2026-01-02T03:04:05.006Z");
        expect(await adapter.query("SELECT ? AS created_at", [date])).toMatchObject({
            rows: [{ created_at: "2026-01-02T03:04:05.006Z" }],
        });
        await expect(adapter.query("SELECT ? AS created_at", [new Date(Number.NaN)]))
            .rejects.toThrow("valid dates");
    });
    it("streams large query results in bounded batches and honors cancellation", async () => {
        await adapter.query("CREATE TABLE stream_rows (id INTEGER PRIMARY KEY, label TEXT)");
        for (let start = 0; start < 2500; start += 250) {
            const values = Array.from({ length: 250 }, (_, index) => `(${start + index}, 'row-${start + index}')`).join(",");
            await adapter.query(`INSERT INTO stream_rows (id, label) VALUES ${values}`);
        }
        const batches = [];
        for await (const batch of adapter.queryStream("SELECT id, label FROM stream_rows ORDER BY id", [], { batchSize: 333 })) {
            batches.push(batch);
        }
        expect(batches.map((batch) => batch.rows.length)).toEqual([333, 333, 333, 333, 333, 333, 333, 169]);
        expect(batches.every((batch) => batch.columns.join(",") === "id,label")).toBe(true);
        expect(batches.flatMap((batch) => batch.rows).at(-1)).toEqual({ id: 2499, label: "row-2499" });
        const controller = new AbortController();
        const iterator = adapter.queryStream("SELECT id FROM stream_rows ORDER BY id", [], {
            batchSize: 100,
            signal: controller.signal,
        })[Symbol.asyncIterator]();
        expect((await iterator.next()).value?.rows).toHaveLength(100);
        controller.abort();
        await expect(iterator.next()).rejects.toThrow("cancelled");
    });
    it("lists tables and views without including SQLite internal objects", async () => {
        await adapter.query('CREATE TABLE "user data" (id INTEGER PRIMARY KEY)');
        await adapter.query('CREATE VIEW "visible data" AS SELECT id FROM "user data"');
        expect(await adapter.listTables()).toEqual([
            { schema: "main", name: "user data", type: "table" },
            { schema: "main", name: "visible data", type: "view" },
        ]);
        await expect(adapter.listTables("not-attached")).rejects.toThrow("is not attached");
    });
    it("describes columns, primary keys, nullability, defaults and generated fields", async () => {
        await adapter.query(`
      CREATE TABLE "odd"" table" (
        id INTEGER PRIMARY KEY,
        "display name" TEXT NOT NULL DEFAULT '未命名',
        area INTEGER GENERATED ALWAYS AS (id * 2) STORED
      )
    `);
        expect(await adapter.getTableColumns('odd" table')).toEqual([
            {
                name: "id",
                dataType: "INTEGER",
                nullable: false,
                defaultValue: null,
                primaryKey: true,
                ordinalPosition: 1,
            },
            {
                name: "display name",
                dataType: "TEXT",
                nullable: false,
                defaultValue: "'未命名'",
                primaryKey: false,
                ordinalPosition: 2,
            },
            {
                name: "area",
                dataType: "INTEGER",
                nullable: true,
                defaultValue: null,
                primaryKey: false,
                ordinalPosition: 3,
            },
        ]);
        await expect(adapter.getTableColumns("missing")).rejects.toThrow("was not found");
    });
    it("rejects object parameters instead of passing unsupported bindings", async () => {
        await expect(adapter.query("SELECT ?", [{ unsafe: true }])).rejects.toThrow("SQLite parameters must be scalar values or binary data.");
    });
    it("reads rows and inserts imported values with safely quoted identifiers", async () => {
        await adapter.query('CREATE TABLE "odd"" table" ("display name" TEXT NOT NULL, amount INTEGER)');
        const inserted = await adapter.insertRows('odd" table', ["display name", "amount"], [["甲", 2], ["乙", null]]);
        expect(inserted).toBe(2);
        expect(await adapter.readTable('odd" table')).toMatchObject({
            columns: ["display name", "amount"],
            rowCount: 2,
            rows: [{ "display name": "甲", amount: 2 }, { "display name": "乙", amount: null }],
        });
    });
    it("rolls back the entire data import if any row violates a constraint", async () => {
        await adapter.query("CREATE TABLE unique_values (value TEXT NOT NULL UNIQUE)");
        await expect(adapter.insertRows("unique_values", ["value"], [["first"], ["first"]]))
            .rejects.toThrow();
        expect((await adapter.readTable("unique_values")).rowCount).toBe(0);
    });
});
//# sourceMappingURL=sqlite.test.js.map