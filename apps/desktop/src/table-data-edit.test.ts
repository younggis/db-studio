import { describe, expect, it } from "vitest";
import type { ColumnInfo, DatabaseEngine } from "@db-studio/shared";
import {
  buildTablePreviewSql,
  buildTableRowChange,
  changedEditableColumns,
  isEditableColumn,
  isSupportedPrimaryKey,
  quoteIdentifier,
  quoteQualifiedTable,
  serializeEditedValue,
} from "./table-data-edit";

function column(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    dataType: "varchar(50)",
    maximumLength: null,
    nullable: true,
    defaultValue: null,
    primaryKey: false,
    ordinalPosition: 1,
    ...overrides,
  };
}

describe("identifier quoting", () => {
  it("uses the engine-specific identifier syntax and escapes embedded quotes", () => {
    expect(quoteIdentifier("postgres", "my table")).toBe('"my table"');
    expect(quoteIdentifier("sqlite", 'a"b')).toBe('"a""b"');
    expect(quoteIdentifier("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdentifier("mariadb", "col")).toBe("`col`");
    expect(quoteIdentifier("sqlserver", "a]b")).toBe("[a]]b]");
    expect(quoteIdentifier("oracle", "COL")).toBe('"COL"');
    expect(quoteQualifiedTable("postgres", "public", "roads")).toBe('"public"."roads"');
    expect(quoteQualifiedTable("sqlserver", "dbo", "roads")).toBe("[dbo].[roads]");
  });
});

describe("buildTablePreviewSql", () => {
  const engines: DatabaseEngine[] = ["postgres", "sqlite", "mysql", "mariadb", "sqlserver", "oracle"];

  it("generates a bounded preview for every desktop engine", () => {
    for (const engine of engines) {
      const sql = buildTablePreviewSql(engine, "public", "roads");
      expect(sql).toContain("roads");
      expect(sql).toContain("100");
      expect(sql.toUpperCase()).toContain("SELECT");
    }
    expect(buildTablePreviewSql("sqlserver", "dbo", "roads")).toContain("TOP (100)");
    expect(buildTablePreviewSql("oracle", "HR", "ROADS")).toContain("FETCH FIRST 100 ROWS ONLY");
    expect(buildTablePreviewSql("postgres", "public", "roads")).toContain("LIMIT 100");
  });

  it("clamps the limit to 1..1000 and truncates fractions", () => {
    expect(buildTablePreviewSql("postgres", "public", "roads", 0)).toContain("LIMIT 1");
    expect(buildTablePreviewSql("postgres", "public", "roads", 5000)).toContain("LIMIT 1000");
    expect(buildTablePreviewSql("postgres", "public", "roads", 12.9)).toContain("LIMIT 12");
  });
});

describe("editable columns", () => {
  it("rejects primary keys and non-editable data types", () => {
    expect(isEditableColumn(column({ name: "id", primaryKey: true }))).toBe(false);
    expect(isEditableColumn(column({ name: "geom", dataType: "geometry" }))).toBe(false);
    expect(isEditableColumn(column({ name: "payload", dataType: "json" }))).toBe(false);
    expect(isEditableColumn(column({ name: "name" }))).toBe(true);
    expect(isSupportedPrimaryKey(column({ name: "id", primaryKey: true, dataType: "int" }))).toBe(true);
    expect(isSupportedPrimaryKey(column({ name: "id", primaryKey: true, dataType: "geometry" }))).toBe(false);
  });

  it("detects real changes only, including numeric string equivalence", () => {
    const name = column({ name: "name" });
    const amount = column({ name: "amount", dataType: "numeric(10,2)" });
    const geom = column({ name: "geom", dataType: "geometry" });
    const columns = [name, amount, geom];
    expect(changedEditableColumns(columns, { name: "a", amount: 1 }, { name: "a", amount: 1 })).toEqual([]);
    expect(changedEditableColumns(columns, { name: "a", amount: 1 }, { name: "b", amount: 1 })).toEqual([name]);
    expect(changedEditableColumns(columns, { amount: 1 }, { amount: "1" })).toEqual([]);
    expect(changedEditableColumns(columns, { amount: 1 }, { amount: 2 })).toEqual([amount]);
    // non-editable columns are never reported
    expect(changedEditableColumns(columns, { geom: "old" }, { geom: "new" })).toEqual([]);
  });
});

describe("serializeEditedValue", () => {
  it("rejects null for non-nullable columns", () => {
    expect(() => serializeEditedValue(null, column({ name: "name", nullable: false }))).toThrow(/不允许为空/);
    expect(serializeEditedValue(null, column({ name: "name" }))).toBeNull();
    expect(serializeEditedValue(undefined, column({ name: "name" }))).toBeNull();
  });

  it("normalizes booleans", () => {
    const flag = column({ name: "flag", dataType: "boolean" });
    expect(serializeEditedValue("YES", flag)).toBe(true);
    expect(serializeEditedValue("0", flag)).toBe(false);
    expect(() => serializeEditedValue("maybe", flag)).toThrow(/true\/false/);
  });

  it("validates numeric strings without coercing them", () => {
    const amount = column({ name: "amount", dataType: "decimal(10,2)" });
    expect(serializeEditedValue("  -12.5e2 ", amount)).toBe("-12.5e2");
    expect(() => serializeEditedValue("NaN", amount)).toThrow(/有效的数值/);
    expect(serializeEditedValue(7, amount)).toBe(7);
  });
});

describe("buildTableRowChange", () => {
  const id = column({ name: "id", dataType: "int", primaryKey: true, nullable: false, ordinalPosition: 0 });
  const name = column({ name: "name", ordinalPosition: 2 });
  const columns = [id, name];

  it("requires a primary key and its presence in the original row", () => {
    expect(() => buildTableRowChange([name], {}, { name: "x" })).toThrow(/没有主键/);
    expect(() => buildTableRowChange(columns, { name: "old" }, { name: "new" })).toThrow(/缺少主键字段/);
  });

  it("returns undefined when nothing changed", () => {
    expect(buildTableRowChange(columns, { id: 1, name: "a" }, { id: 1, name: "a" })).toBeUndefined();
  });

  it("builds a change with original key values and serialized edits", () => {
    expect(buildTableRowChange(columns, { id: 1, name: "a" }, { id: 1, name: "b" })).toEqual({
      primaryKeyValues: { id: 1 },
      values: { name: "b" },
    });
  });
});
