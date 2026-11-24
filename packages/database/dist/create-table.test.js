import { describe, expect, it } from "vitest";
import { buildCreateTableStatement } from "./adapter.js";
const columns = [
    { name: "display name", type: "text" },
    { name: "feature_id", type: "integer" },
    { name: "delivery_time", type: "time" },
    { name: "shape", type: "json" },
    { name: "payload", type: "binary" },
];
describe("buildCreateTableStatement", () => {
    it.each([
        ["postgres", 'CREATE TABLE "public"."imported" ("display name" TEXT NULL, "feature_id" BIGINT NULL, "delivery_time" TIME NULL, "shape" JSONB NULL, "payload" BYTEA NULL)'],
        ["mysql", "CREATE TABLE `app`.`imported` (`display name` LONGTEXT NULL, `feature_id` BIGINT NULL, `delivery_time` TIME(3) NULL, `shape` JSON NULL, `payload` LONGBLOB NULL)"],
        ["mariadb", "CREATE TABLE `app`.`imported` (`display name` LONGTEXT NULL, `feature_id` BIGINT NULL, `delivery_time` TIME(3) NULL, `shape` JSON NULL, `payload` LONGBLOB NULL)"],
        ["sqlite", 'CREATE TABLE "main"."imported" ("display name" TEXT NULL, "feature_id" INTEGER NULL, "delivery_time" TEXT NULL, "shape" TEXT NULL, "payload" BLOB NULL)'],
        ["sqlserver", "CREATE TABLE [dbo].[imported] ([display name] NVARCHAR(MAX) NULL, [feature_id] BIGINT NULL, [delivery_time] TIME(3) NULL, [shape] NVARCHAR(MAX) NULL, [payload] VARBINARY(MAX) NULL)"],
        ["oracle", 'CREATE TABLE "APP"."imported" ("display name" CLOB NULL, "feature_id" NUMBER(19) NULL, "delivery_time" VARCHAR2(32) NULL, "shape" CLOB NULL, "payload" BLOB NULL)'],
    ])("builds safe %s DDL with native types", (engine, expected) => {
        const schema = engine === "postgres" ? "public" : engine === "sqlite" ? "main" : engine === "sqlserver" ? "dbo" : engine === "oracle" ? "APP" : "app";
        expect(buildCreateTableStatement(engine, "imported", columns, schema)).toBe(expected);
    });
    it("quotes hostile identifiers and rejects duplicate or document-engine columns", () => {
        expect(buildCreateTableStatement("postgres", 'x"; DROP TABLE t; --', [{ name: "a;b", type: "text" }], "public"))
            .toContain('"x""; DROP TABLE t; --"');
        expect(() => buildCreateTableStatement("sqlite", "items", [
            { name: "same", type: "text" }, { name: "same", type: "integer" },
        ], "main")).toThrow("unique");
        expect(() => buildCreateTableStatement("mongodb", "items", columns, "main"))
            .toThrow("relational table importer");
    });
});
//# sourceMappingURL=create-table.test.js.map