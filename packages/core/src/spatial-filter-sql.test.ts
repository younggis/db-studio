import { describe, expect, it } from "vitest";
import { spatialFilterPredicate, validateExtent } from "./spatial-filter-sql.js";

const extent = { minX: 1, minY: 2, maxX: 3, maxY: 4 };

describe("spatial filter SQL predicates", () => {
  it("uses engine-specific predicates with bounded parameters", () => {
    const pg = spatialFilterPredicate("postgres", "geom", extent);
    expect(pg.sql).toContain("&& ST_MakeEnvelope");
    expect(pg.parameters).toEqual([1, 2, 3, 4]);

    const mysql = spatialFilterPredicate("mysql", "g", extent);
    expect(mysql.sql).toContain("MBRIntersects");
    expect(mysql.parameters[0]).toContain("POLYGON");

    const mssql = spatialFilterPredicate("sqlserver", "g", extent);
    expect(mssql.sql).toContain(".STIntersects");

    const oracle = spatialFilterPredicate("oracle", "g", extent);
    expect(oracle.sql).toContain("SDO_FILTER");
    expect(oracle.parameters).toHaveLength(8);
  });

  it("escapes quoted identifiers", () => {
    expect(spatialFilterPredicate("postgres", 'ge"om', extent).sql).toContain('"ge""om"');
    expect(spatialFilterPredicate("sqlserver", "ge]om", extent).sql).toContain("[ge]]om]");
  });

  it("returns a harmless predicate for engines without spatial SQL", () => {
    expect(spatialFilterPredicate("mongodb", "geom", extent).sql).toBe("1 = 1");
  });

  it("rejects invalid rectangles", () => {
    expect(() => validateExtent({ minX: 3, minY: 2, maxX: 1, maxY: 4 })).toThrow(/小于/);
    expect(() => validateExtent({ minX: Number.NaN, minY: 2, maxX: 3, maxY: 4 })).toThrow(/有限/);
    expect(() => validateExtent(extent)).not.toThrow();
  });
});
