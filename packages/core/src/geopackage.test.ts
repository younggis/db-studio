import { describe, expect, it } from "vitest";
import { decodeGeoPackageGeometry, encodeGeoPackageGeometry, importColumnTypeFromSqliteDeclaration } from "./geopackage.js";

function makePointBlob(options: { srsId?: number; envelope?: boolean } = {}): Buffer {
  const envelopeBytes = options.envelope ? 32 : 0;
  const blob = Buffer.alloc(8 + envelopeBytes + 21);
  blob.write("GP", 0, "ascii");
  blob[2] = 0;
  blob[3] = 0x01 | (options.envelope ? 0x02 : 0x00);
  blob.writeInt32LE(options.srsId ?? 4326, 4);
  let offset = 8;
  if (options.envelope) {
    for (let index = 0; index < 4; index += 1) blob.writeDoubleLE(index + 1, offset + index * 8);
    offset += envelopeBytes;
  }
  blob[offset] = 1;
  blob.writeUInt32LE(1, offset + 1);
  blob.writeDoubleLE(121.5, offset + 5);
  blob.writeDoubleLE(31.2, offset + 13);
  return blob;
}

describe("GeoPackage geometry bridge", () => {
  it("extracts little-endian WKB, SRS id, and XY envelope", () => {
    const blob = makePointBlob({ envelope: true });
    const result = decodeGeoPackageGeometry(blob);
    expect(result).toMatchObject({
      kind: "db-studio-spatial-wkb",
      spatialType: "geometry",
      srid: 4326,
    });
    expect(Buffer.from(result!.wkb)).toEqual(blob.subarray(40));
    expect(result!.wkb.length).toBe(21);
  });

  it("preserves an undefined source SRS as null for the caller to handle explicitly", () => {
    expect(decodeGeoPackageGeometry(makePointBlob({ srsId: -1 }))?.srid).toBeNull();
  });

  it("wraps standard WKB in a minimal GeoPackage header and round-trips it", () => {
    const source = makePointBlob().subarray(8);
    const encoded = encodeGeoPackageGeometry(source, 4326);
    expect(encoded.subarray(0, 8)).toEqual(Buffer.from([0x47, 0x50, 0, 1, 0xe6, 0x10, 0, 0]));
    expect(decodeGeoPackageGeometry(encoded)).toMatchObject({ srid: 4326, spatialType: "geometry" });
    expect(Buffer.from(decodeGeoPackageGeometry(encoded)!.wkb)).toEqual(source);
  });

  it("marks empty geometries and rejects unsupported WKB headers", () => {
    const empty = encodeGeoPackageGeometry(makePointBlob().subarray(8), 4326, true);
    expect(empty[3]).toBe(0x11);
    expect(() => encodeGeoPackageGeometry(Buffer.from([0, 0, 0, 0, 0]), 4326)).toThrow("unsupported or extended");
    expect(() => encodeGeoPackageGeometry(Buffer.from([3, 0, 0, 0, 1]), 4326)).toThrow("invalid byte order");
    expect(() => encodeGeoPackageGeometry(makePointBlob().subarray(8), -1)).toThrow("non-negative");
  });

  it("rejects malformed and extended geometry blobs", () => {
    expect(() => decodeGeoPackageGeometry(Buffer.from("bad"))).toThrow("invalid header");
    const extended = makePointBlob();
    extended[3] = extended[3]! | 0x20;
    expect(() => decodeGeoPackageGeometry(extended)).toThrow("Extended GeoPackage");
  });

  it("maps GeoPackage SQLite declarations to portable import types", () => {
    expect(importColumnTypeFromSqliteDeclaration("INTEGER")).toBe("integer");
    expect(importColumnTypeFromSqliteDeclaration("REAL")).toBe("real");
    expect(importColumnTypeFromSqliteDeclaration("DATETIME")).toBe("datetime");
    expect(importColumnTypeFromSqliteDeclaration("TIME(3)")).toBe("time");
    expect(importColumnTypeFromSqliteDeclaration("BLOB")).toBe("binary");
    expect(importColumnTypeFromSqliteDeclaration("TEXT")).toBe("text");
  });
});
