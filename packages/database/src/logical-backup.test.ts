import { describe, expect, it } from "vitest";
import { buildBackupSql, buildCreateTableSql, splitSqlStatements, sqlLiteral } from "./logical-backup.js";
import type { BackupTable } from "./logical-backup.js";

const table: BackupTable = {
  name: "users",
  columns: [
    { name: "id", dataType: "BIGINT", nullable: false, defaultValue: null, primaryKey: true, ordinalPosition: 1 },
    { name: "name", dataType: "character varying(50)", nullable: true, defaultValue: null, primaryKey: false, ordinalPosition: 2 },
  ],
  foreignKeys: [],
  rows: [{ id: 1, name: "O'Brien" }, { id: 2, name: null }],
};

describe("logical backup SQL", () => {
  it("escapes literals per engine", () => {
    expect(sqlLiteral("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(sqlLiteral(null, "postgres")).toBe("NULL");
    expect(sqlLiteral(true, "postgres")).toBe("TRUE");
    expect(sqlLiteral(new Uint8Array([0, 255]), "postgres")).toBe("'\\x00ff'");
    expect(sqlLiteral(new Uint8Array([0, 255]), "mysql")).toBe("X'00ff'");
  });

  it("quotes identifiers with the engine dialect", () => {
    expect(buildCreateTableSql("mysql", "app", table)).toContain("`app`.`users`");
    expect(buildCreateTableSql("postgres", "app", table)).toContain('"app"."users"');
    expect(buildCreateTableSql("sqlserver", "dbo", table)).toContain("[dbo].[users]");
  });

  it("keeps precise types and primary keys in DDL", () => {
    const sql = buildCreateTableSql("postgres", "public", table);
    expect(sql).toContain('"id" BIGINT NOT NULL');
    expect(sql).toContain('"name" character varying(50) NULL');
    expect(sql).toContain('PRIMARY KEY ("id")');
  });

  it("emits bounded INSERT batches only when data is included", () => {
    const sql = buildBackupSql("postgres", "public", [table], { includeData: true, batchSize: 1 });
    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);
    expect(sql).toContain("'O''Brien'");
    expect(buildBackupSql("postgres", "public", [table], { includeData: false })).not.toContain("INSERT INTO");
  });

  it("splits statements without breaking quoted text or comments", () => {
    const sql = `-- header
      SELECT 'a;b' AS x;
      /* block ; comment */
      INSERT INTO t VALUES ('c'';d');
      SELECT 1`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("'a;b'");
    expect(statements[1]).toContain("'c'';d'");
    expect(statements[2]).toBe("SELECT 1");
  });
});
