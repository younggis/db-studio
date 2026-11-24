const GEOMETRY_TYPES = new Set([1, 2, 3, 4, 5, 6, 7]);
function layoutOf(type) {
    if (!Number.isSafeInteger(type) || type < 1)
        throw new Error(`SpatiaLite geometry class ${type} is invalid.`);
    const compressed = type >= 1_000_000;
    const code = compressed ? type - 1_000_000 : type;
    const dimension = Math.floor(code / 1000);
    const baseType = code % 1000;
    if (!GEOMETRY_TYPES.has(baseType) || dimension > 3) {
        throw new Error(`SpatiaLite geometry class ${type} is not supported.`);
    }
    const hasZ = dimension === 1 || dimension === 3;
    const hasM = dimension === 2 || dimension === 3;
    return { compressed, dimension, baseType, hasZ, hasM, ordinateCount: 2 + Number(hasZ) + Number(hasM) };
}
function normalizeWkbType(type) {
    const hasZFlag = (type & 0x8000_0000) !== 0;
    const hasMFlag = (type & 0x4000_0000) !== 0;
    let baseType = type & 0x1fff_ffff;
    let dimension = 0;
    if (hasZFlag || hasMFlag) {
        dimension = hasZFlag ? (hasMFlag ? 3 : 1) : 2;
    }
    else if (baseType >= 1000 && baseType < 4000) {
        dimension = Math.floor(baseType / 1000);
        baseType -= dimension * 1000;
    }
    if (!GEOMETRY_TYPES.has(baseType))
        throw new Error(`WKB geometry type ${type} is not supported for SpatiaLite conversion.`);
    return { baseType, dimension };
}
/** Detects SpatiaLite's native geometry BLOB header. */
export function isSpatiaLiteGeometryBlob(value) {
    if (!(value instanceof Uint8Array) || value.byteLength < 44)
        return false;
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return bytes[0] === 0x00 && (bytes[1] === 0x00 || bytes[1] === 0x01) && bytes[38] === 0x7c && bytes[bytes.length - 1] === 0xfe;
}
class Reader {
    bytes;
    littleEndian;
    offset;
    constructor(bytes, start, littleEndian) {
        this.bytes = bytes;
        this.littleEndian = littleEndian;
        this.offset = start;
    }
    get position() { return this.offset; }
    need(length) {
        if (length < 0 || this.offset + length > this.bytes.byteLength) {
            throw new Error("SpatiaLite geometry BLOB is truncated.");
        }
    }
    byte() { this.need(1); return this.bytes[this.offset++]; }
    uint32() {
        this.need(4);
        const value = this.littleEndian ? this.bytes.readUInt32LE(this.offset) : this.bytes.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }
    float32() {
        this.need(4);
        const value = this.littleEndian ? this.bytes.readFloatLE(this.offset) : this.bytes.readFloatBE(this.offset);
        this.offset += 4;
        return value;
    }
    double() {
        this.need(8);
        const value = this.littleEndian ? this.bytes.readDoubleLE(this.offset) : this.bytes.readDoubleBE(this.offset);
        this.offset += 8;
        return value;
    }
}
class Writer {
    chunks = [];
    byte(value) {
        const chunk = Buffer.allocUnsafe(1);
        chunk[0] = value & 0xff;
        this.chunks.push(chunk);
    }
    uint32(value) {
        const chunk = Buffer.allocUnsafe(4);
        chunk.writeUInt32LE(value >>> 0, 0);
        this.chunks.push(chunk);
    }
    double(value) {
        const chunk = Buffer.allocUnsafe(8);
        chunk.writeDoubleLE(value, 0);
        this.chunks.push(chunk);
    }
    append(chunk) { this.chunks.push(chunk); }
    toBuffer() { return Buffer.concat(this.chunks); }
}
/**
 * Decodes a SpatiaLite-native geometry BLOB into standard WKB plus its SRID.
 * Supports the uncompressed and the lossy float32-delta compressed variants,
 * XY/XYZ/XYM/XYZM, and all seven geometry types.
 */
export function decodeSpatiaLiteGeometry(value) {
    if (value === null || value === undefined)
        return null;
    if (!isSpatiaLiteGeometryBlob(value))
        throw new Error("SpatiaLite geometry BLOB has an invalid header.");
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const littleEndian = bytes[1] === 1;
    const srid = littleEndian ? bytes.readInt32LE(2) : bytes.readInt32BE(2);
    const root = layoutOf(littleEndian ? bytes.readUInt32LE(39) : bytes.readUInt32BE(39));
    const reader = new Reader(bytes, 43, littleEndian);
    const output = new Writer();
    output.byte(1);
    output.uint32(root.baseType + root.dimension * 1000);
    function readCoordinates(count, layout, type, previous) {
        const useDelta = layout.compressed && (type === 2 || type === 3);
        const last = [...previous];
        for (let index = 0; index < count; index += 1) {
            const ordinates = [];
            for (let axis = 0; axis < layout.ordinateCount; axis += 1) {
                if (useDelta && index > 0 && index < count - 1) {
                    ordinates.push((last[axis] ?? 0) + reader.float32());
                }
                else {
                    ordinates.push(reader.double());
                }
            }
            for (const ordinate of ordinates)
                output.double(ordinate);
            for (let axis = 0; axis < ordinates.length; axis += 1)
                last[axis] = ordinates[axis];
        }
    }
    function readGeometry(type) {
        const layout = layoutOf(type);
        switch (layout.baseType) {
            case 1:
                readCoordinates(1, layout, 1, []);
                break;
            case 2: {
                const count = reader.uint32();
                if (count > Math.floor((bytes.byteLength - reader.position) / (layout.ordinateCount * 4))) {
                    throw new Error("SpatiaLite geometry BLOB declares an invalid point count.");
                }
                output.uint32(count);
                readCoordinates(count, layout, 2, []);
                break;
            }
            case 3: {
                const ringCount = reader.uint32();
                if (ringCount > Math.floor((bytes.byteLength - reader.position) / 4)) {
                    throw new Error("SpatiaLite geometry BLOB declares an invalid ring count.");
                }
                output.uint32(ringCount);
                for (let ring = 0; ring < ringCount; ring += 1) {
                    const count = reader.uint32();
                    if (count > Math.floor((bytes.byteLength - reader.position) / (layout.ordinateCount * 4))) {
                        throw new Error("SpatiaLite geometry BLOB declares an invalid ring point count.");
                    }
                    output.uint32(count);
                    readCoordinates(count, layout, 3, []);
                }
                break;
            }
            default: {
                const count = reader.uint32();
                if (count > Math.floor((bytes.byteLength - reader.position) / 5)) {
                    throw new Error("SpatiaLite geometry BLOB declares an invalid element count.");
                }
                output.uint32(count);
                for (let index = 0; index < count; index += 1) {
                    if (reader.byte() !== 0x69)
                        throw new Error("SpatiaLite geometry BLOB has an invalid element marker.");
                    const childType = reader.uint32();
                    output.byte(1);
                    output.uint32(layoutOf(childType).baseType + layoutOf(childType).dimension * 1000);
                    readGeometry(childType);
                }
            }
        }
    }
    readGeometry(littleEndian ? bytes.readUInt32LE(39) : bytes.readUInt32BE(39));
    if (reader.position !== bytes.length - 1 || bytes[reader.position] !== 0xfe) {
        throw new Error("SpatiaLite geometry BLOB has trailing data or a missing end marker.");
    }
    return {
        kind: "db-studio-spatial-wkb",
        spatialType: "geometry",
        wkb: output.toBuffer(),
        srid: srid <= 0 ? null : srid,
    };
}
/** Wraps standard WKB in an uncompressed SpatiaLite geometry BLOB. */
export function encodeSpatiaLiteGeometry(value, srid) {
    if (!(value instanceof Uint8Array))
        throw new Error("SpatiaLite geometry conversion received a non-binary WKB value.");
    if (!Number.isSafeInteger(srid) || srid < 0)
        throw new Error("SpatiaLite SRID must be a non-negative safe integer.");
    const wkb = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const body = new Writer();
    const mbr = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let rootClass = 0;
    // WKB allows a per-geometry byte order, so parse explicitly rather than via Reader.
    let cursor = 0;
    const u32 = (littleEndian) => {
        const value = littleEndian ? wkb.readUInt32LE(cursor) : wkb.readUInt32BE(cursor);
        cursor += 4;
        return value;
    };
    const f64 = (littleEndian) => {
        const value = littleEndian ? wkb.readDoubleLE(cursor) : wkb.readDoubleBE(cursor);
        cursor += 8;
        return value;
    };
    const copyDoubles = (littleEndian, count) => {
        const values = [];
        for (let index = 0; index < count; index += 1)
            values.push(f64(littleEndian));
        return values;
    };
    const track = (ordinates) => {
        const x = ordinates[0];
        const y = ordinates[1];
        mbr[0] = Math.min(mbr[0], x);
        mbr[1] = Math.min(mbr[1], y);
        mbr[2] = Math.max(mbr[2], x);
        mbr[3] = Math.max(mbr[3], y);
    };
    function walk(isRoot) {
        if (cursor >= wkb.length)
            throw new Error("SpatiaLite geometry conversion received truncated WKB.");
        const littleEndian = wkb[cursor++] === 1;
        const { baseType, dimension } = normalizeWkbType(u32(littleEndian));
        const ordinateCount = 2 + (dimension === 1 || dimension === 3 ? 1 : 0) + (dimension === 2 || dimension === 3 ? 1 : 0);
        const classType = baseType + dimension * 1000;
        if (isRoot)
            rootClass = classType;
        else {
            body.byte(0x69);
            body.uint32(classType);
        }
        if (baseType === 1) {
            const ordinates = copyDoubles(littleEndian, ordinateCount);
            for (const ordinate of ordinates)
                body.double(ordinate);
            track(ordinates);
            return;
        }
        if (baseType === 2) {
            const count = u32(littleEndian);
            body.uint32(count);
            for (let index = 0; index < count; index += 1) {
                const ordinates = copyDoubles(littleEndian, ordinateCount);
                for (const ordinate of ordinates)
                    body.double(ordinate);
                track(ordinates);
            }
            return;
        }
        if (baseType === 3) {
            const ringCount = u32(littleEndian);
            body.uint32(ringCount);
            for (let ring = 0; ring < ringCount; ring += 1) {
                const count = u32(littleEndian);
                body.uint32(count);
                for (let index = 0; index < count; index += 1) {
                    const ordinates = copyDoubles(littleEndian, ordinateCount);
                    for (const ordinate of ordinates)
                        body.double(ordinate);
                    track(ordinates);
                }
            }
            return;
        }
        const count = u32(littleEndian);
        body.uint32(count);
        for (let index = 0; index < count; index += 1)
            walk(false);
    }
    walk(true);
    if (cursor !== wkb.length)
        throw new Error("SpatiaLite geometry conversion received trailing WKB bytes.");
    const header = Buffer.alloc(43);
    header[0] = 0x00;
    header[1] = 0x01;
    header.writeInt32LE(srid, 2);
    const envelope = Number.isFinite(mbr[0]) ? mbr : [0, 0, 0, 0];
    header.writeDoubleLE(envelope[0], 6);
    header.writeDoubleLE(envelope[1], 14);
    header.writeDoubleLE(envelope[2], 22);
    header.writeDoubleLE(envelope[3], 30);
    header[38] = 0x7c;
    header.writeUInt32LE(rootClass, 39);
    const end = Buffer.from([0xfe]);
    return Buffer.concat([header, body.toBuffer(), end]);
}
//# sourceMappingURL=spatialite.js.map