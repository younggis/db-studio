import { describe, expect, it } from "vitest";
import type { ColumnInfo, SpatialTransferValue } from "@db-studio/shared";
import { convertTransferValue } from "./table-transfer-conversion.js";

function column(name: string, dataType: string): ColumnInfo {
  return { name, dataType, nullable: true, defaultValue: null, primaryKey: false, ordinalPosition: 1 };
}

const geometry = column("shape", "geometry(Point,3857)");
const geography = column("location", "geography(Point,4326)");
const xyWkb = "0101000000000000000000f03f0000000000000040";

describe("spatial table transfer conversion", () => {
  it("decodes WKB and SRID into the internal typed value", () => {
    const result = convertTransferValue(`${xyWkb}:3857`, geometry, geometry, "postgres", "sqlserver") as SpatialTransferValue;

    expect(result).toEqual({
      kind: "db-studio-spatial-wkb",
      spatialType: "geometry",
      wkb: Buffer.from(xyWkb, "hex"),
      srid: 3857,
    });
  });

  it("rejects geometry/geography conversion without an explicit conversion", () => {
    expect(() => convertTransferValue(`${xyWkb}:3857`, geometry, geography, "postgres", "sqlserver"))
      .toThrow("Cannot convert geometry to geography without an explicit spatial-type conversion");
  });

  it("retags geometry as geography when conversion is explicitly allowed", () => {
    const result = convertTransferValue(`${xyWkb}:4326`, geometry, geography, "postgres", "sqlserver", {
      allowSpatialTypeConversion: true,
    }) as SpatialTransferValue;
    expect(result.spatialType).toBe("geography");
    expect(result.srid).toBe(4326);
    expect(Buffer.from(result.wkb)).toEqual(Buffer.from(xyWkb, "hex"));
    const back = convertTransferValue(`${xyWkb}:4326`, geography, geometry, "sqlserver", "postgres", {
      allowSpatialTypeConversion: true,
    }) as SpatialTransferValue;
    expect(back.spatialType).toBe("geometry");
  });

  it("decodes MySQL spatial subtype metadata as geometry", () => {
    const mysqlPoint = column("shape", "POINT");
    const result = convertTransferValue(`${xyWkb}:4326`, mysqlPoint, geometry, "mysql", "postgres") as SpatialTransferValue;

    expect(result).toEqual({
      kind: "db-studio-spatial-wkb",
      spatialType: "geometry",
      wkb: Buffer.from(xyWkb, "hex"),
      srid: 4326,
    });
  });

  it("accepts Oracle SDO_GEOMETRY and maps a null SRID to the PostGIS unknown SRID", () => {
    const oracleGeometry = column("shape", "MDSYS.SDO_GEOMETRY");
    const result = convertTransferValue({
      kind: "db-studio-spatial-wkb",
      spatialType: "geometry",
      wkb: Buffer.from(xyWkb, "hex"),
      srid: null,
    }, oracleGeometry, geometry, "oracle", "postgres") as SpatialTransferValue;

    expect(result).toEqual({
      kind: "db-studio-spatial-wkb",
      spatialType: "geometry",
      wkb: Buffer.from(xyWkb, "hex"),
      srid: 0,
    });
  });

  it("maps the PostGIS unknown SRID to Oracle's NULL SDO_SRID", () => {
    const oracleGeometry = column("shape", "SDO_GEOMETRY");
    const result = convertTransferValue(`${xyWkb}:0`, geometry, oracleGeometry, "postgres", "oracle") as SpatialTransferValue;

    expect(result.srid).toBeNull();
  });

  it("passes 3D/4D WKB through to Oracle for EWKB normalization", () => {
    const xyzWkb = "0101000080000000000000f03f00000000000000400000000000000c40";
    const result = convertTransferValue(`${xyzWkb}:4326`, geometry, column("shape", "SDO_GEOMETRY"), "postgres", "oracle") as SpatialTransferValue;
    expect(result.wkb).toEqual(Buffer.from(xyzWkb, "hex"));
    expect(result.srid).toBe(4326);
    const xyzmWkb = "01010000c0000000000000f03f00000000000000400000000000000c400000000000001440";
    const measured = convertTransferValue(`${xyzmWkb}:4326`, geometry, column("shape", "SDO_GEOMETRY"), "postgres", "oracle") as SpatialTransferValue;
    expect(measured.wkb).toEqual(Buffer.from(xyzmWkb, "hex"));
  });

  it("still rejects unrecognizable WKB for Oracle", () => {
    expect(() => convertTransferValue(`ff01000000:4326`, geometry, column("shape", "SDO_GEOMETRY"), "postgres", "oracle"))
      .toThrow("Oracle SDO_GEOMETRY row transfer requires a recognizable 2D, 3D or 4D WKB geometry.");
  });

  it("rejects dimensional WKB for MySQL-family targets with a clear reason", () => {
    const xyzWkb = "0101000080000000000000f03f00000000000000400000000000000c40";
    for (const engine of ["mysql", "mariadb"] as const) {
      expect(() => convertTransferValue(`${xyzWkb}:4326`, geometry, column("shape", "geometry"), "postgres", engine))
        .toThrow("MySQL/MariaDB geometry row transfer supports XY geometries only");
    }
  });

  it("rejects unsupported spatial types and engine pairs", () => {
    expect(() => convertTransferValue(`${xyWkb}:3857`, geometry, geometry, "postgres", "mysql"))
      .not.toThrow();
    expect(() => convertTransferValue(`${xyWkb}:3857`, geography, geography, "postgres", "mysql"))
      .toThrow("Geography row transfer supports PostgreSQL/PostGIS and SQL Server only.");
    expect(() => convertTransferValue(`${xyWkb}:3857`, geometry, column("shape", "geometry"), "postgres", "sqlite"))
      .not.toThrow();
  });

  it("rejects negative SRIDs for MySQL-family targets", () => {
    expect(() => convertTransferValue(`${xyWkb}:-1`, geometry, column("shape", "geometry"), "postgres", "mysql"))
      .toThrow("MySQL/MariaDB geometry transfer requires an SRID from 0 through 4294967295.");
  });

  it("rejects malformed WKB/SRID projections", () => {
    for (const value of ["abc:3857", "zz:3857", `${xyWkb}:1e3`, `${xyWkb}:9007199254740992`, ":3857"]) {
      expect(() => convertTransferValue(value, geometry, geometry, "postgres", "sqlserver"))
        .toThrow(/malformed WKB\/SRID|invalid SRID/);
    }
  });

  it("requires the source adapter's WKB/SRID projection", () => {
    expect(() => convertTransferValue({ wkb: Buffer.from(xyWkb, "hex"), srid: 3857 }, geometry, geometry, "postgres", "sqlserver"))
      .toThrow("Spatial transfer source did not return the WKB/SRID projection");
  });
});
