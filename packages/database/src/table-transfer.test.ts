import { describe, expect, it } from "vitest";
import { buildTableTransferPageQuery } from "./adapter.js";

describe("buildTableTransferPageQuery", () => {
  it("uses lexicographic keyset pagination for a composite PostgreSQL key", () => {
    const result = buildTableTransferPageQuery(
      "postgres", "sales", "order lines", ["order_id", "line_id", "label"], ["order_id", "line_id"], [7, 3], 100,
    );

    expect(result).toEqual({
      sql: 'SELECT "order_id", "line_id", "label" FROM "sales"."order lines" WHERE ("order_id" > $1) OR ("order_id" = $2 AND "line_id" > $3) ORDER BY "order_id", "line_id" LIMIT $4',
      parameters: [7, 7, 3, 100],
    });
  });

  it.each(["mysql", "mariadb", "sqlite"] as const)("uses positional LIMIT paging for %s", (engine) => {
    const result = buildTableTransferPageQuery(engine, "main", "items", ["id", "label"], ["id"], undefined, 25);

    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).toMatch(/ LIMIT \?$/);
    expect(result.parameters).toEqual([25]);
  });

  it.each(["sqlserver", "oracle"] as const)("uses OFFSET/FETCH paging for %s", (engine) => {
    const result = buildTableTransferPageQuery(engine, "data", "items", ["id"], ["id"], undefined, 25);

    expect(result.sql).toMatch(/ORDER BY .* OFFSET 0 ROWS FETCH NEXT .* ROWS ONLY$/);
    expect(result.parameters).toEqual([25]);
  });

  it("projects selected SQL Server exact numerics as text without changing keyset ordering", () => {
    const result = buildTableTransferPageQuery(
      "sqlserver", "dbo", "large values", ["id", "amount"], ["id"], ["42"], 25,
      { exactNumericColumns: ["id", "amount"] },
    );

    expect(result.sql).toContain("CONVERT(varchar(100), [id]) AS [id]");
    expect(result.sql).toContain("CONVERT(varchar(100), [amount]) AS [amount]");
    expect(result.sql).toContain("WHERE ([id] > @p1) ORDER BY [id] OFFSET 0 ROWS FETCH NEXT @p2 ROWS ONLY");
    expect(result.parameters).toEqual(["42", 25]);
  });

  it.each([
    ["postgres", '"payload"::text AS "payload"'],
    ["mysql", 'CAST(`payload` AS CHAR) AS `payload`'],
    ["mariadb", 'CAST(`payload` AS CHAR) AS `payload`'],
  ] as const)("projects %s JSON values as text to retain JSON null", (engine, projection) => {
    const result = buildTableTransferPageQuery(
      engine, engine === "postgres" ? "public" : "db", "items", ["id", "payload"], ["id"], undefined, 25,
      { jsonTextColumns: ["payload"] },
    );

    expect(result.sql).toContain(projection);
    expect(result.sql).toContain("ORDER BY");
    expect(result.parameters).toEqual([25]);
  });

  it("rejects invalid and unsupported JSON text projections", () => {
    expect(() => buildTableTransferPageQuery(
      "postgres", "public", "items", ["id"], ["id"], undefined, 10,
      { jsonTextColumns: ["payload"] },
    )).toThrow("selected columns");
    expect(() => buildTableTransferPageQuery(
      "postgres", "public", "items", ["id", "payload"], ["id"], undefined, 10,
      { jsonTextColumns: ["payload", "payload"] },
    )).toThrow("unique selected columns");
    expect(() => buildTableTransferPageQuery(
      "oracle", "APP", "items", ["id", "payload"], ["id"], undefined, 10,
      { jsonTextColumns: ["payload"] },
    )).toThrow("not supported");
  });

  it("rejects exact-numeric projections outside the selected columns", () => {
    expect(() => buildTableTransferPageQuery(
      "sqlserver", "dbo", "items", ["id"], ["id"], undefined, 10,
      { exactNumericColumns: ["amount"] },
    )).toThrow("selected columns");
  });

  it("escapes metadata-derived identifiers and rejects invalid transfer bounds", () => {
    const result = buildTableTransferPageQuery("mysql", "db", "orders` x", ["id` x"], ["id` x"], undefined, 1);
    expect(result.sql).toContain("`db`.`orders`` x`");
    expect(result.sql).toContain("`id`` x`");

    expect(() => buildTableTransferPageQuery("sqlite", "main", "items", ["id"], [], undefined, 10))
      .toThrow("primary-key");
    expect(() => buildTableTransferPageQuery("sqlite", "main", "items", ["id"], ["id"], undefined, 1_001))
      .toThrow("page size");
    expect(() => buildTableTransferPageQuery("mongodb", "db", "items", ["id"], ["id"], undefined, 10))
      .toThrow("MongoDB");
  });
});
