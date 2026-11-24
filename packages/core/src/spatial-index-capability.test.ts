import { describe, expect, it } from "vitest";
import { spatialIndexCapability, assertSpatialIndexSupported } from "./spatial-index-capability.js";

describe("spatial index capability matrix", () => {
  it("documents create/append/overwrite support per engine", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(spatialIndexCapability(engine)).toMatchObject({ create: true, append: true, overwrite: true });
    }
    const sqlite = spatialIndexCapability("sqlite");
    expect(sqlite.create).toBe(true);
    expect(sqlite.append).toBe(false);
    expect(sqlite.overwrite).toBe(false);
    expect(sqlite.notes.join(" ")).toContain("RTree");
  });

  it("rejects unsupported combinations with an explanatory error", () => {
    expect(() => assertSpatialIndexSupported("sqlite", "append")).toThrow(/不支持 append/);
    expect(() => assertSpatialIndexSupported("mongodb", "create")).toThrow(/2dsphere/);
    expect(() => assertSpatialIndexSupported("postgres", "overwrite")).not.toThrow();
  });

  it("does not leak internal matrix object through mutation", () => {
    const first = spatialIndexCapability("postgres");
    first.create = false;
    expect(spatialIndexCapability("postgres").create).toBe(true);
  });
});
