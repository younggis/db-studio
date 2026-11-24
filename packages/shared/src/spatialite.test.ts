import { describe, expect, it } from "vitest";
import { decodeSpatiaLiteGeometry, encodeSpatiaLiteGeometry, isSpatiaLiteGeometryBlob } from "./spatialite.js";

const POINT_4326 = "0001e6100000000000000000f03f0000000000000040000000000000f03f00000000000000407c01000000000000000000f03f0000000000000040fe";
const POINT_WKB = "0101000000000000000000f03f0000000000000040";

describe("SpatiaLite geometry BLOB codec", () => {
  it("detects SpatiaLite BLOBs", () => {
    expect(isSpatiaLiteGeometryBlob(Buffer.from(POINT_4326, "hex"))).toBe(true);
    expect(isSpatiaLiteGeometryBlob(Buffer.concat([Buffer.from("GP"), Buffer.alloc(16)]))).toBe(false);
  });

  it("decodes a GDAL-produced POINT BLOB to standard WKB and SRID", () => {
    const result = decodeSpatiaLiteGeometry(Buffer.from(POINT_4326, "hex"));
    expect(result).toMatchObject({ kind: "db-studio-spatial-wkb", spatialType: "geometry", srid: 4326 });
    expect(Buffer.from(result!.wkb).toString("hex")).toBe(POINT_WKB);
  });

  it("round-trips POINT, LINESTRING, POLYGON and measured geometries", () => {
    const cases = [
      { wkb: POINT_WKB, srid: 4326 },
      { wkb: "01020000000300000000000000000000000000000000000000000000000000f03f000000000000f03f0000000000000040000000000000f03f", srid: 3857 },
      { wkb: "01e9030000000000000000f03f00000000000000400000000000000c40", srid: 4326 },
      { wkb: "01b90b0000000000000000f03f00000000000000400000000000000c400000000000001440", srid: 4326 },
    ];
    for (const { wkb, srid } of cases) {
      const blob = encodeSpatiaLiteGeometry(Buffer.from(wkb, "hex"), srid);
      expect(isSpatiaLiteGeometryBlob(blob)).toBe(true);
      const decoded = decodeSpatiaLiteGeometry(blob);
      expect(decoded?.srid).toBe(srid);
      expect(Buffer.from(decoded!.wkb).toString("hex")).toBe(wkb);
    }
  });

  it("rejects malformed BLOBs", () => {
    expect(() => decodeSpatiaLiteGeometry(Buffer.from([0, 1, 0]))).toThrow("invalid header");
    const original = Buffer.from(POINT_4326, "hex");
    const trailing = Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([0x00, 0xfe])]);
    expect(() => decodeSpatiaLiteGeometry(trailing)).toThrow("trailing data");
    expect(() => encodeSpatiaLiteGeometry(Buffer.from("05", "hex"), 4326)).toThrow();
  });
});
