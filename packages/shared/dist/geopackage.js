const GPKG_ENVELOPE_BYTES = {
    0: 0,
    1: 32,
    2: 48,
    3: 48,
    4: 64,
};
/** Extracts standard WKB and its GeoPackage SRS id from a GeoPackage geometry blob. */
export function decodeGeoPackageGeometry(value) {
    if (value === null || value === undefined)
        return null;
    if (!(value instanceof Uint8Array))
        throw new Error("GeoPackage geometry value is not a byte array.");
    const blob = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (blob.length < 13 || blob.toString("ascii", 0, 2) !== "GP") {
        throw new Error("GeoPackage geometry blob has an invalid header.");
    }
    if (blob[2] !== 0)
        throw new Error(`GeoPackage geometry version ${blob[2]} is not supported.`);
    const flags = blob[3];
    if ((flags & 0xc0) !== 0)
        throw new Error("GeoPackage geometry blob uses reserved flag bits.");
    if ((flags & 0x20) !== 0)
        throw new Error("Extended GeoPackage geometries are not supported for database import.");
    const envelopeType = (flags >> 1) & 0x07;
    const envelopeBytes = GPKG_ENVELOPE_BYTES[envelopeType];
    if (envelopeBytes === undefined)
        throw new Error(`GeoPackage geometry envelope type ${envelopeType} is invalid.`);
    const wkbOffset = 8 + envelopeBytes;
    if (blob.length - wkbOffset < 5)
        throw new Error("GeoPackage geometry blob has no complete WKB value.");
    const littleEndian = (flags & 0x01) !== 0;
    const srsId = littleEndian ? blob.readInt32LE(4) : blob.readInt32BE(4);
    const wkbByteOrder = blob[wkbOffset];
    if (wkbByteOrder !== 0 && wkbByteOrder !== 1)
        throw new Error("GeoPackage geometry contains invalid WKB byte order.");
    const geometryType = wkbByteOrder === 1
        ? blob.readUInt32LE(wkbOffset + 1)
        : blob.readUInt32BE(wkbOffset + 1);
    if ((geometryType & 0xe0000000) !== 0) {
        throw new Error("Extended WKB geometry types are not supported for database import.");
    }
    return {
        kind: "db-studio-spatial-wkb",
        spatialType: "geometry",
        wkb: Buffer.from(blob.subarray(wkbOffset)),
        srid: srsId < 0 ? null : srsId,
    };
}
/** Wraps standard WKB in the minimal GeoPackage binary header without an envelope. */
export function encodeGeoPackageGeometry(value, srsId, empty = false) {
    if (!(value instanceof Uint8Array))
        throw new Error("MySQL spatial WKB value is not a byte array.");
    if (!Number.isSafeInteger(srsId) || srsId < 0)
        throw new Error("GeoPackage SRS id must be a non-negative safe integer.");
    const wkb = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (wkb.length < 5)
        throw new Error("MySQL spatial WKB has no complete geometry header.");
    const byteOrder = wkb[0];
    if (byteOrder !== 0 && byteOrder !== 1)
        throw new Error("MySQL spatial WKB has an invalid byte order.");
    const geometryType = byteOrder === 1 ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
    if (geometryType === 0 || (geometryType & 0xe0000000) !== 0) {
        throw new Error("MySQL spatial WKB uses an unsupported or extended geometry type.");
    }
    const header = Buffer.alloc(8);
    header.write("GP", 0, "ascii");
    header[2] = 0;
    header[3] = 0x01 | (empty ? 0x10 : 0x00);
    header.writeInt32LE(srsId, 4);
    return Buffer.concat([header, wkb]);
}
export function importColumnTypeFromSqliteDeclaration(dataType) {
    const normalized = dataType.trim().toUpperCase();
    if (/BOOL/.test(normalized))
        return "boolean";
    if (/INT/.test(normalized))
        return "integer";
    if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(normalized))
        return "real";
    if (/^DATE$/.test(normalized))
        return "date";
    if (/^TIME(?:\b|\()/i.test(normalized))
        return "time";
    if (/DATETIME|TIMESTAMP/.test(normalized))
        return "datetime";
    if (/BLOB|BINARY/.test(normalized))
        return "binary";
    return "text";
}
//# sourceMappingURL=geopackage.js.map