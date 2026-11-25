import { describe, expect, it } from "vitest";
import { buildDesignerSql, type DesignerTable } from "./table-designer.js";

const table: DesignerTable = {
  name: "orders",
  columns: [
    { name: "id", dataType: "BIGINT", nullable: false, defaultValue: null, primaryKey: true },
    { name: "customer", dataType: "VARCHAR(50)", nullable: false, defaultValue: "''", primaryKey: false },
  ],
  indexes: [{ name: "idx_orders_customer", columns: ["customer"], unique: false }],
  foreignKeys: [{
    name: "fk_orders_customer", columns: ["customer"], referencedSchema: "public",
    referencedTable: "customers", referencedColumns: ["name"],
  }],
};

describe("table designer DDL", () => {
  it("generates a full create-table statement with dialect quoting", () => {
    const sql = buildDesignerSql("postgres", "public", "create", table);
    expect(sql[0]).toContain('CREATE TABLE "public"."orders"');
    expect(sql[0]).toContain('"customer" VARCHAR(50) NOT NULL DEFAULT \'\'');
    expect(sql[0]).toContain('PRIMARY KEY ("id")');
    expect(sql[0]).toContain('CONSTRAINT "fk_orders_customer" FOREIGN KEY');
    expect(sql[1]).toContain('CREATE INDEX "idx_orders_customer"');
  });

  it("uses backticks for MySQL and brackets for SQL Server", () => {
    expect(buildDesignerSql("mysql", "app", "create", table)[0]).toContain("`app`.`orders`");
    expect(buildDesignerSql("sqlserver", "dbo", "create", table)[0]).toContain("[dbo].[orders]");
  });

  it("only emits new columns in alter mode", () => {
    const sql = buildDesignerSql("postgres", "public", "alter", table, ["id"]);
    expect(sql).toHaveLength(3);
    expect(sql[0]).toContain('ADD COLUMN "customer"');
    expect(sql.some((statement) => statement.includes('ADD COLUMN "id"'))).toBe(false);
  });

  it("rejects a designer table without columns or name", () => {
    expect(() => buildDesignerSql("postgres", "public", "create", { ...table, name: "" })).toThrow("表名");
    expect(() => buildDesignerSql("postgres", "public", "create", { ...table, columns: [] })).toThrow("至少需要一列");
  });
});
