/**
 * WKB (Well-Known Binary) to GeoJSON converter
 *
 * Supports standard OGC WKB and PostGIS Extended WKB (EWKB) formats.
 * Handles 2D, 3D (Z), M, and 4D (ZM) geometries.
 */
/** WKB byte order */
var ByteOrder;
(function (ByteOrder) {
    ByteOrder[ByteOrder["BigEndian"] = 0] = "BigEndian";
    ByteOrder[ByteOrder["LittleEndian"] = 1] = "LittleEndian";
})(ByteOrder || (ByteOrder = {}));
/** OGC geometry type codes */
var WkbGeometryType;
(function (WkbGeometryType) {
    WkbGeometryType[WkbGeometryType["Point"] = 1] = "Point";
    WkbGeometryType[WkbGeometryType["LineString"] = 2] = "LineString";
    WkbGeometryType[WkbGeometryType["Polygon"] = 3] = "Polygon";
    WkbGeometryType[WkbGeometryType["MultiPoint"] = 4] = "MultiPoint";
    WkbGeometryType[WkbGeometryType["MultiLineString"] = 5] = "MultiLineString";
    WkbGeometryType[WkbGeometryType["MultiPolygon"] = 6] = "MultiPolygon";
    WkbGeometryType[WkbGeometryType["GeometryCollection"] = 7] = "GeometryCollection";
})(WkbGeometryType || (WkbGeometryType = {}));
class WkbCursor {
    buffer;
    maxDepth;
    offset = 0;
    constructor(buffer, maxDepth = 32) {
        this.buffer = buffer;
        this.maxDepth = maxDepth;
    }
    get position() {
        return this.offset;
    }
    hasBytes(length) {
        return this.offset + length <= this.buffer.length;
    }
    readUInt8() {
        if (!this.hasBytes(1))
            throw new Error('WKB buffer truncated while reading byte');
        return this.buffer.readUInt8(this.offset++);
    }
    readUInt32(littleEndian) {
        if (!this.hasBytes(4))
            throw new Error('WKB buffer truncated while reading uint32');
        const value = littleEndian
            ? this.buffer.readUInt32LE(this.offset)
            : this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }
    readDouble(littleEndian) {
        if (!this.hasBytes(8))
            throw new Error('WKB buffer truncated while reading double');
        const value = littleEndian
            ? this.buffer.readDoubleLE(this.offset)
            : this.buffer.readDoubleBE(this.offset);
        this.offset += 8;
        return value;
    }
    skip(bytes) {
        if (!this.hasBytes(bytes))
            throw new Error(`WKB buffer truncated while skipping ${bytes} bytes`);
        this.offset += bytes;
    }
}
/**
 * Parse WKB geometry type code and extract dimension flags
 */
function parseGeometryType(rawType) {
    // EWKB flag bits (PostGIS extension)
    const hasZ = (rawType & 0x80000000) !== 0;
    const hasM = (rawType & 0x40000000) !== 0;
    const hasSrid = (rawType & 0x20000000) !== 0;
    let baseType = rawType & 0x1fffffff;
    let dimensionZ = hasZ;
    let dimensionM = hasM;
    // ISO SQL/MM dimension codes (alternative to bit flags)
    if (!hasZ && !hasM) {
        if (baseType >= 3000 && baseType < 4000) {
            // ZM geometry (4D)
            dimensionZ = true;
            dimensionM = true;
            baseType -= 3000;
        }
        else if (baseType >= 2000 && baseType < 3000) {
            // M geometry (3D with measure)
            dimensionM = true;
            baseType -= 2000;
        }
        else if (baseType >= 1000 && baseType < 2000) {
            // Z geometry (3D with elevation)
            dimensionZ = true;
            baseType -= 1000;
        }
    }
    const coordinateDimension = (2 + (dimensionZ ? 1 : 0) + (dimensionM ? 1 : 0));
    return {
        baseType,
        hasZ: dimensionZ,
        hasM: dimensionM,
        hasSrid,
        coordinateDimension,
    };
}
/**
 * Read a single coordinate (point) based on dimension
 */
function readCoordinate(cursor, littleEndian, hasZ, hasM) {
    const x = cursor.readDouble(littleEndian);
    const y = cursor.readDouble(littleEndian);
    const coord = [x, y];
    if (hasZ) {
        coord.push(cursor.readDouble(littleEndian));
    }
    if (hasM) {
        coord.push(cursor.readDouble(littleEndian));
    }
    return coord;
}
/**
 * Read an array of coordinates
 */
function readCoordinates(cursor, count, littleEndian, hasZ, hasM) {
    const coordinates = [];
    for (let i = 0; i < count; i++) {
        coordinates.push(readCoordinate(cursor, littleEndian, hasZ, hasM));
    }
    return coordinates;
}
/**
 * Parse a Point geometry
 */
function parsePoint(cursor, littleEndian, hasZ, hasM) {
    const coordinates = readCoordinate(cursor, littleEndian, hasZ, hasM);
    return { type: 'Point', coordinates };
}
/**
 * Parse a LineString geometry
 */
function parseLineString(cursor, littleEndian, hasZ, hasM) {
    const numPoints = cursor.readUInt32(littleEndian);
    if (numPoints < 2)
        throw new Error('LineString must have at least 2 points');
    const coordinates = readCoordinates(cursor, numPoints, littleEndian, hasZ, hasM);
    return { type: 'LineString', coordinates };
}
/**
 * Parse a Polygon geometry
 */
function parsePolygon(cursor, littleEndian, hasZ, hasM) {
    const numRings = cursor.readUInt32(littleEndian);
    if (numRings < 1)
        throw new Error('Polygon must have at least 1 ring');
    const coordinates = [];
    for (let i = 0; i < numRings; i++) {
        const numPoints = cursor.readUInt32(littleEndian);
        if (numPoints < 4)
            throw new Error('Polygon ring must have at least 4 points');
        coordinates.push(readCoordinates(cursor, numPoints, littleEndian, hasZ, hasM));
    }
    return { type: 'Polygon', coordinates };
}
/**
 * Parse a Multi* or GeometryCollection
 */
function parseCollection(cursor, collectionType, depth, maxDepth) {
    if (depth > maxDepth) {
        throw new Error(`Geometry nested too deeply (max depth: ${maxDepth})`);
    }
    const numGeometries = cursor.readUInt32(cursor.readUInt8() === ByteOrder.LittleEndian);
    const geometries = [];
    for (let i = 0; i < numGeometries; i++) {
        geometries.push(parseGeometry(cursor, depth + 1, maxDepth).geometry);
    }
    if (collectionType === 'GeometryCollection') {
        return { type: 'GeometryCollection', coordinates: geometries };
    }
    // For Multi* types, extract coordinates arrays
    const coordinates = geometries.map(g => g.coordinates);
    return { type: collectionType, coordinates };
}
/**
 * Parse a geometry from WKB cursor
 */
function parseGeometry(cursor, depth = 0, maxDepth = 32) {
    // Read byte order
    const byteOrder = cursor.readUInt8();
    if (byteOrder !== ByteOrder.BigEndian && byteOrder !== ByteOrder.LittleEndian) {
        throw new Error(`Invalid WKB byte order: ${byteOrder}`);
    }
    const littleEndian = byteOrder === ByteOrder.LittleEndian;
    // Read geometry type
    const rawType = cursor.readUInt32(littleEndian);
    const { baseType, hasZ, hasM, hasSrid, coordinateDimension } = parseGeometryType(rawType);
    // Read SRID if present (EWKB extension)
    let srid = null;
    if (hasSrid) {
        srid = cursor.readUInt32(littleEndian);
    }
    let geometry;
    switch (baseType) {
        case WkbGeometryType.Point:
            geometry = parsePoint(cursor, littleEndian, hasZ, hasM);
            break;
        case WkbGeometryType.LineString:
            geometry = parseLineString(cursor, littleEndian, hasZ, hasM);
            break;
        case WkbGeometryType.Polygon:
            geometry = parsePolygon(cursor, littleEndian, hasZ, hasM);
            break;
        case WkbGeometryType.MultiPoint:
            geometry = parseCollection(cursor, 'MultiPoint', depth, maxDepth);
            break;
        case WkbGeometryType.MultiLineString:
            geometry = parseCollection(cursor, 'MultiLineString', depth, maxDepth);
            break;
        case WkbGeometryType.MultiPolygon:
            geometry = parseCollection(cursor, 'MultiPolygon', depth, maxDepth);
            break;
        case WkbGeometryType.GeometryCollection:
            geometry = parseCollection(cursor, 'GeometryCollection', depth, maxDepth);
            break;
        default:
            throw new Error(`Unsupported WKB geometry type: ${baseType}`);
    }
    return { geometry, srid, hasZ, hasM, coordinateDimension };
}
/**
 * Parse WKB (Well-Known Binary) to GeoJSON
 *
 * @param wkb - WKB data as Buffer or hex string
 * @param options - Parse options
 * @returns Parsed geometry with metadata
 *
 * @example
 * ```typescript
 * const result = parseWkbToGeojson(buffer);
 * console.log(result.geometry); // GeoJSON geometry
 * console.log(result.srid);     // SRID if present
 * console.log(result.hasZ);     // true if 3D
 * ```
 */
export function parseWkbToGeojson(wkb, options = {}) {
    const buffer = typeof wkb === 'string' ? Buffer.from(wkb, 'hex') : wkb;
    if (buffer.length === 0) {
        throw new Error('WKB buffer is empty');
    }
    const maxDepth = options.maxDepth ?? 32;
    const cursor = new WkbCursor(buffer, maxDepth);
    try {
        const result = parseGeometry(cursor, 0, maxDepth);
        return {
            geometry: result.geometry,
            srid: options.includeSrid !== false ? result.srid : undefined,
            hasZ: result.hasZ,
            hasM: result.hasM,
            coordinateDimension: result.coordinateDimension,
        };
    }
    catch (error) {
        throw new Error(`Failed to parse WKB geometry: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
}
/**
 * Batch parse multiple WKB values, skipping nulls and errors
 *
 * @param wkbs - Array of WKB values (Buffer, hex string, or null)
 * @param maxCount - Maximum number to parse (default: 5000)
 * @returns Array of parse results or null for failed/null inputs
 */
export function batchParseWkb(wkbs, maxCount = 5000) {
    return wkbs.slice(0, maxCount).map((wkb, index) => {
        if (wkb === null || wkb === undefined)
            return null;
        try {
            return parseWkbToGeojson(wkb);
        }
        catch (error) {
            console.warn(`Failed to parse WKB at index ${index}:`, error);
            return null;
        }
    });
}
/**
 * Extract geometry type name from WKB without full parsing
 *
 * @param wkb - WKB data
 * @returns Geometry type name or null if parsing fails
 */
export function getWkbGeometryType(wkb) {
    try {
        const buffer = typeof wkb === 'string' ? Buffer.from(wkb, 'hex') : wkb;
        if (buffer.length < 5)
            return null;
        const byteOrder = buffer.readUInt8(0);
        const littleEndian = byteOrder === ByteOrder.LittleEndian;
        const rawType = littleEndian ? buffer.readUInt32LE(1) : buffer.readUInt32BE(1);
        const { baseType } = parseGeometryType(rawType);
        const typeNames = {
            [WkbGeometryType.Point]: 'Point',
            [WkbGeometryType.LineString]: 'LineString',
            [WkbGeometryType.Polygon]: 'Polygon',
            [WkbGeometryType.MultiPoint]: 'MultiPoint',
            [WkbGeometryType.MultiLineString]: 'MultiLineString',
            [WkbGeometryType.MultiPolygon]: 'MultiPolygon',
            [WkbGeometryType.GeometryCollection]: 'GeometryCollection',
        };
        return typeNames[baseType] ?? 'Unknown';
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=wkb-geojson.js.map