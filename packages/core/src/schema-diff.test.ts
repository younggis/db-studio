import { describe, expect, it } from "vitest";
import { diffSchemaSnapshots, type SchemaSnapshot } from "./schema-diff.js";

const column = (name: string, dataType = "INTEGER") => ({
  name, dataType, nullable: true, defaultValue: null, primaryKey: name === "id", ordinalPosition: name === "id" ? 1 : 2,
});

const source: SchemaSnapshot = {
  engine: "postgres",
  schema: "public",
  tables: [{
    name: "users",
    columns: [column("id"), column("email", "TEXT")],
    foreignKeys: [{ name: "fk_users_city", columns: ["city_id"], referencedTable: "cities", referencedColumns: ["id"] }],
    indexes: [{ name: "idx_users_email", columns: ["email"], unique: false }],
  }],
};

const target: SchemaSnapshot = {
  engine: "postgres",
  schema: "public",
  tables: [{
    name: "users",
    columns: [column("id"), column("legacy", "TEXT")],
    foreignKeys: [],
    indexes: [],
  }, {
    name: "obsolete",
    columns: [column("id")],
    foreignKeys: [],
    indexes: [],
  }],
};

describe("schema diff", () => {
  it("creates statements for added columns, foreign keys and indexes", () => {
    const statements = diffSchemaSnapshots(source, target);
    const kinds = statements.map((statement) => statement.kind);
    expect(kinds).toContain("add-column");
    expect(kinds).toContain("add-foreign-key");
    expect(kinds).toContain("create-index");
    expect(statements.find((s) => s.kind === "add-column")?.sql).toContain('"email" TEXT');
  });

  it("omits destructive statements unless explicitly enabled", () => {
    const safe = diffSchemaSnapshots(source, target);
    expect(safe.some((statement) => statement.kind === "drop-table")).toBe(false);
    expect(safe.some((statement) => statement.kind === "drop-column")).toBe(false);

    const full = diffSchemaSnapshots(source, target, { includeDrops: true });
    expect(full.some((statement) => statement.kind === "drop-table" && statement.table === "obsolete")).toBe(true);
    expect(full.some((statement) => statement.kind === "drop-column" && statement.sql.includes("legacy"))).toBe(true);
  });

  it("qualifies generated DDL with the target schema and dialect", () => {
    const mysqlTarget: SchemaSnapshot = { engine: "mysql", schema: "targetdb", tables: [] };
    const statements = diffSchemaSnapshots(source, mysqlTarget);
    expect(statements[0]?.sql).toContain("`targetdb`.`users`");
    expect(statements[0]?.sql).toContain("`email` TEXT");
  });

  it("creates a whole table when it only exists in the source", () => {
    const empty: SchemaSnapshot = { engine: "postgres", schema: "public", tables: [] };
    const statements = diffSchemaSnapshots(source, empty);
    expect(statements[0]?.kind).toBe("create-table");
    expect(statements[0]?.sql).toContain('"users"');
    expect(statements.some((s) => s.kind === "create-index")).toBe(true);
  });
});
