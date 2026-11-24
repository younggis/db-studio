import { describe, expect, it } from "vitest";
import { diagnoseSpatialIndex } from "./spatial-index-diagnostic.js";
import type { ColumnInfo, DatabaseEngine } from "@db-studio/shared";

function column(name: string, dataType: string): ColumnInfo {
  return { name, dataType, nullable: true, primaryKey: false, defaultValue: null, ordinalPosition: 1 };
}

function run(engine: DatabaseEngine, dataType = "geometry") {
  return diagnoseSpatialIndex({
    engine, schema: "public", table: "roads", columns: [column("id", "bigint"), column("geom", dataType)],
  });
}

describe("spatial index diagnostics", () => {
  it("reports no index needed when no spatial column exists", () => {
    const result = diagnoseSpatialIndex({ engine: "postgres", schema: "public", table: "logs", columns: [column("id", "bigint")] });
    expect(result.hasSpatialColumn).toBe(false);
    expect(result.severity).toBe("info");
    expect(result.suggestionSql).toBeUndefined();
  });

  it("produces engine-specific suggestion SQL (review-only)", () => {
    expect(run("postgres").suggestionSql).toContain("USING GIST");
    expect(run("mysql").suggestionSql).toContain("ADD SPATIAL INDEX");
    expect(run("mariadb").suggestionSql).toContain("ADD SPATIAL INDEX");
    expect(run("sqlserver").suggestionSql).toContain("CREATE SPATIAL INDEX");
    expect(run("sqlite").suggestionSql).toContain("CreateSpatialIndex");
    expect(run("oracle").suggestionSql).toContain("MDSYS.SPATIAL_INDEX");
  });

  it("escapes identifiers per engine dialect", () => {
    const result = diagnoseSpatialIndex({
      engine: "postgres", schema: "public", table: 'ro"ads', columns: [column('ge"om', "geometry")],
    });
    expect(result.suggestionSql).toContain('"ro""ads"');
    expect(result.suggestionSql).toContain('"ge""om"');
  });

  it("emits review caveats for dangerous defaults", () => {
    expect(run("sqlserver").reasons.join(" ")).toMatch(/BOUNDING_BOX/);
    expect(run("oracle").reasons.join(" ")).toMatch(/USER_SDO_GEOM_METADATA/);
    expect(run("postgres").reasons.join(" ")).toMatch(/仅作展示/);
  });

  it("handles MongoDB (no relational spatial index suggestion)", () => {
    const result = run("mongodb");
    expect(result.hasSpatialColumn).toBe(true);
    expect(result.suggestionSql).toBeUndefined();
    expect(result.severity).toBe("warning");
  });
});
