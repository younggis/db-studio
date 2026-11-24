import { describe, expect, it } from "vitest";
import { validateSql } from "./sql-validator.js";
function context(overrides = {}) {
    return {
        engine: "postgres",
        serverVersion: "16.0",
        database: "dbstudio_test",
        schema: "public",
        tables: [
            { schema: "public", name: "orders", type: "table", comment: null, columns: [
                    { name: "id", dataType: "bigint", nullable: false, primaryKey: true },
                    { name: "amount", dataType: "numeric", nullable: true, primaryKey: false },
                ] },
            { schema: "public", name: "roads", type: "table", comment: null, columns: [
                    { name: "id", dataType: "bigint", nullable: false, primaryKey: true },
                    { name: "geom", dataType: "geometry", nullable: true, primaryKey: false, spatial: { kind: "geometry", geometryType: "LineString", srid: 4326 } },
                ] },
        ],
        ...overrides,
    };
}
describe("validateSql read-only boundary", () => {
    it("accepts a single SELECT over a known table", () => {
        const result = validateSql("SELECT * FROM public.orders LIMIT 10", context());
        expect(result.valid).toBe(true);
        expect(result.readOnly).toBe(true);
        expect(result.parsed).toBe(true);
        expect(result.errors).toEqual([]);
    });
    it("accepts CTEs that reference known tables", () => {
        const result = validateSql("WITH recent AS (SELECT * FROM public.orders WHERE id > 10) SELECT * FROM recent", context());
        expect(result.valid).toBe(true);
        expect(result.readOnly).toBe(true);
    });
    it("does not flag information_schema system-catalog queries as unknown tables", () => {
        const result = validateSql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'", context());
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });
    it("accepts PostGIS spatial functions in a read-only query", () => {
        const result = validateSql("SELECT ST_AsText(geom), ST_Area(geom) FROM public.roads WHERE ST_Intersects(geom, ST_MakeEnvelope(0,0,1,1,4326))", context({ postgis: { spatialColumns: [] } }));
        expect(result.valid).toBe(true);
        expect(result.readOnly).toBe(true);
    });
    it("rejects INSERT / UPDATE / DELETE / DDL even when wrapped in a CTE", () => {
        for (const sql of [
            "INSERT INTO public.orders VALUES (1)",
            "UPDATE public.orders SET id = 1",
            "DELETE FROM public.orders",
            "DROP TABLE public.orders",
            "WITH x AS (DELETE FROM public.orders RETURNING *) SELECT * FROM x",
        ]) {
            const result = validateSql(sql, context());
            expect(result.valid, sql).toBe(false);
            expect(result.readOnly, sql).toBe(false);
        }
    });
    it("rejects multiple SQL statements", () => {
        const result = validateSql("SELECT 1; SELECT 2", context());
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toMatch(/只允许|one statement|multiple/);
    });
    it("rejects references to tables outside the schema context", () => {
        const result = validateSql("SELECT * FROM public.secret_table", context());
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toMatch(/secret_table|unknown|not in/i);
    });
    it("treats a semicolon inside a string literal as data, not a statement boundary", () => {
        const result = validateSql("SELECT 'a;b' AS label FROM public.orders", context());
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });
    it("reports engine-appropriate system catalogs for MySQL", () => {
        const result = validateSql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'dbstudio_test'", context({ engine: "mysql", schema: "dbstudio_test" }));
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });
});
//# sourceMappingURL=sql-validator.test.js.map