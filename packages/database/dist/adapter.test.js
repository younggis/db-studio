import { describe, expect, it } from "vitest";
import { buildTableTransferPageQuery, groupForeignKeyRows } from "./adapter.js";
describe("groupForeignKeyRows", () => {
    it("keeps composite foreign-key column pairs in metadata order", () => {
        expect(groupForeignKeyRows([
            {
                name: "fk_order_customer",
                column_name: "tenant_id",
                referenced_schema: "public",
                referenced_table: "customer",
                referenced_column: "tenant_id",
            },
            {
                name: "fk_order_customer",
                column_name: "customer_id",
                referenced_schema: "public",
                referenced_table: "customer",
                referenced_column: "id",
            },
        ])).toEqual([{
                name: "fk_order_customer",
                columns: ["tenant_id", "customer_id"],
                referencedSchema: "public",
                referencedTable: "customer",
                referencedColumns: ["tenant_id", "id"],
            }]);
    });
    it("keeps separate foreign keys and omits absent schemas", () => {
        expect(groupForeignKeyRows([
            { name: "fk_a", column_name: "a_id", referenced_table: "a", referenced_column: "id" },
            { name: "fk_b", column_name: "b_id", referenced_schema: null, referenced_table: "b", referenced_column: "id" },
        ])).toEqual([
            { name: "fk_a", columns: ["a_id"], referencedSchema: undefined, referencedTable: "a", referencedColumns: ["id"] },
            { name: "fk_b", columns: ["b_id"], referencedSchema: undefined, referencedTable: "b", referencedColumns: ["id"] },
        ]);
    });
});
describe("buildTableTransferPageQuery spatial projections", () => {
    it("projects PostGIS geometry as WKB plus SRID without changing keyset columns", () => {
        const query = buildTableTransferPageQuery("postgres", "public", "source", ["id", "shape"], ["id"], undefined, 25, {
            spatialWkbColumns: ["shape"],
        });
        expect(query).toEqual({
            sql: `SELECT "id", CASE WHEN "shape" IS NULL THEN NULL ELSE encode(ST_AsBinary("shape"), 'hex') || ':' || ST_SRID("shape")::text END AS "shape" FROM "public"."source" ORDER BY "id" LIMIT $1`,
            parameters: [25],
        });
    });
    it("projects SQL Server geometry using OGC WKB and its explicit SRID", () => {
        const query = buildTableTransferPageQuery("sqlserver", "dbo", "source", ["id", "shape"], ["id"], undefined, 25, {
            spatialWkbColumns: ["shape"],
        });
        expect(query).toEqual({
            sql: `SELECT [id], CASE WHEN [shape] IS NULL THEN NULL ELSE CONVERT(varchar(max), [shape].AsBinaryZM(), 2) + ':' + CONVERT(varchar(10), [shape].STSrid) END AS [shape] FROM [dbo].[source] ORDER BY [id] OFFSET 0 ROWS FETCH NEXT @p1 ROWS ONLY`,
            parameters: [25],
        });
    });
    it("projects MySQL geometry with explicit long-lat WKB axis order", () => {
        const query = buildTableTransferPageQuery("mysql", "db", "source", ["id", "shape"], ["id"], undefined, 25, {
            spatialWkbColumns: ["shape"],
        });
        expect(query).toEqual({
            sql: "SELECT `id`, CASE WHEN `shape` IS NULL THEN NULL ELSE CONCAT(HEX(ST_AsWKB(`shape`, 'axis-order=long-lat')), ':', ST_SRID(`shape`)) END AS `shape` FROM `db`.`source` ORDER BY `id` LIMIT ?",
            parameters: [25],
        });
    });
    it("projects MariaDB geometry with its WKB/SRID functions", () => {
        const query = buildTableTransferPageQuery("mariadb", "db", "source", ["id", "shape"], ["id"], undefined, 25, {
            spatialWkbColumns: ["shape"],
        });
        expect(query).toEqual({
            sql: "SELECT `id`, CASE WHEN `shape` IS NULL THEN NULL ELSE CONCAT(HEX(ST_AsWKB(`shape`)), ':', ST_SRID(`shape`)) END AS `shape` FROM `db`.`source` ORDER BY `id` LIMIT ?",
            parameters: [25],
        });
    });
    it("projects Oracle SDO_GEOMETRY as a structural WKB with SRID, type and vertex columns", () => {
        const query = buildTableTransferPageQuery("oracle", "SYSTEM", "source", ["id", "shape", "__dbstudio_spatial_srid_1"], ["id"], undefined, 25, {
            spatialWkbColumns: ["shape"],
        });
        expect(query).toEqual({
            sql: `SELECT "id", CASE WHEN dbstudio_source."shape" IS NULL THEN NULL WHEN TRUNC(dbstudio_source."shape".SDO_GTYPE / 1000) = 2 THEN MDSYS.SDO_UTIL.TO_WKBGEOMETRY(dbstudio_source."shape") ELSE MDSYS.SDO_UTIL.TO_WKBGEOMETRY(MDSYS.SDO_CS.MAKE_2D(dbstudio_source."shape")) END AS "shape", CASE WHEN dbstudio_source."shape" IS NULL THEN NULL ELSE dbstudio_source."shape".SDO_SRID END AS "__dbstudio_spatial_srid_2", CASE WHEN dbstudio_source."shape" IS NULL THEN NULL ELSE dbstudio_source."shape".SDO_GTYPE END AS "__dbstudio_spatial_gtype_1", CASE WHEN dbstudio_source."shape" IS NULL OR TRUNC(dbstudio_source."shape".SDO_GTYPE / 1000) = 2 THEN NULL ELSE (SELECT JSON_ARRAYAGG(JSON_OBJECT('x' VALUE vertex.x, 'y' VALUE vertex.y, 'z' VALUE vertex.z, 'w' VALUE vertex.w) ORDER BY vertex.id RETURNING CLOB) FROM TABLE(MDSYS.SDO_UTIL.GETVERTICES(dbstudio_source."shape")) vertex) END AS "__dbstudio_spatial_vertices_1", "__dbstudio_spatial_srid_1" FROM "SYSTEM"."source" dbstudio_source ORDER BY "id" OFFSET 0 ROWS FETCH NEXT :1 ROWS ONLY`,
            parameters: [25],
            spatialSridAliases: { shape: "__dbstudio_spatial_srid_2" },
            spatialGtypeAliases: { shape: "__dbstudio_spatial_gtype_1" },
            spatialVerticesAliases: { shape: "__dbstudio_spatial_vertices_1" },
        });
    });
    it("projects a raw geometry BLOB for SQLite spatial transfer", () => {
        const query = buildTableTransferPageQuery("sqlite", "main", "source", ["id", "shape"], ["id"], undefined, 25, {
            spatialWkbColumns: ["shape"],
        });
        expect(query.sql).toBe('SELECT "id", CASE WHEN "shape" IS NULL THEN NULL ELSE "shape" END AS "shape" FROM "main"."source" ORDER BY "id" LIMIT ?');
        expect(query.parameters).toEqual([25]);
    });
    it("rejects unsupported spatial projection engines and invalid column lists", () => {
        expect(() => buildTableTransferPageQuery("postgres", "public", "source", ["id"], ["id"], undefined, 1, {
            spatialWkbColumns: ["missing"],
        })).toThrow("Spatial WKB projection columns must be unique selected columns.");
        expect(() => buildTableTransferPageQuery("sqlite", "main", "source", ["id", "shape"], ["id"], undefined, 1, {
            spatialWkbColumns: ["shape", "shape"],
        })).toThrow("Spatial WKB projection columns must be unique selected columns.");
    });
});
//# sourceMappingURL=adapter.test.js.map