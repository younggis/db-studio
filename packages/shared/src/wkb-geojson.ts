/**
 * WKB (Well-Known Binary) to GeoJSON converter
 *
 * Supports standard OGC WKB and PostGIS Extended WKB (EWKB) formats.
 * Handles 2D, 3D (Z), M, and 4D (ZM) geometries.
 */

export interface GeoJSONGeometry {
  type: string;
  coordinates: any;
  bbox?: [number, number, number, number];
}

export interface WkbParseOptions {
  /** Maximum recursion depth for nested geometries (default: 32) */
  maxDepth?: number;
  /** Include SRID in output metadata (default: true) */
  includeSrid?: boolean;
}

export interface WkbParseResult {
  geometry: GeoJSONGeometry;
  srid?: number | null;
  hasZ: boolean;
  hasM: boolean;
  coordinateDimension: 2 | 3 | 4;
}

/** WKB byte order */
enum ByteOrder {
  BigEndian = 0,
  LittleEndian = 1,
}

/** OGC geometry type codes */
enum WkbGeometryType {
  Point = 1,
  LineString = 2,
  Polygon = 3,
  MultiPoint = 4,
  MultiLineString = 5,
  MultiPolygon = 6,
  GeometryCollection = 7,
}

class WkbCursor {
  private offset = 0;

  constructor(
    private readonly buffer: Buffer,
    private readonly maxDepth: number = 32
  ) {}

  get position(): number {
    return this.offset;
  }

  hasBytes(length: number): boolean {
    return this.offset + length <= this.buffer.length;
  }

  readUInt8(): number {
    if (!this.hasBytes(1)) throw new Error('WKB buffer truncated while reading byte');
    return this.buffer.readUInt8(this.offset++);
  }

  readUInt32(littleEndian: boolean): number {
    if (!this.hasBytes(4)) throw new Error('WKB buffer truncated while reading uint32');
    const value = littleEndian
      ? this.buffer.readUInt32LE(this.offset)
      : this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readDouble(littleEndian: boolean): number {
    if (!this.hasBytes(8)) throw new Error('WKB buffer truncated while reading double');
    const value = littleEndian
      ? this.buffer.readDoubleLE(this.offset)
      : this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  skip(bytes: number): void {
    if (!this.hasBytes(bytes)) throw new Error(`WKB buffer truncated while skipping ${bytes} bytes`);
    this.offset += bytes;
  }
}

/**
 * Parse WKB geometry type code and extract dimension flags
 */
function parseGeometryType(rawType: number): {
  baseType: number;
  hasZ: boolean;
  hasM: boolean;
  hasSrid: boolean;
  coordinateDimension: 2 | 3 | 4;
} {
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
    } else if (baseType >= 2000 && baseType < 3000) {
      // M geometry (3D with measure)
      dimensionM = true;
      baseType -= 2000;
    } else if (baseType >= 1000 && baseType < 2000) {
      // Z geometry (3D with elevation)
      dimensionZ = true;
      baseType -= 1000;
    }
  }

  const coordinateDimension = (2 + (dimensionZ ? 1 : 0) + (dimensionM ? 1 : 0)) as 2 | 3 | 4;

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
function readCoordinate(
  cursor: WkbCursor,
  littleEndian: boolean,
  hasZ: boolean,
  hasM: boolean
): number[] {
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
function readCoordinates(
  cursor: WkbCursor,
  count: number,
  littleEndian: boolean,
  hasZ: boolean,
  hasM: boolean
): number[][] {
  const coordinates: number[][] = [];
  for (let i = 0; i < count; i++) {
    coordinates.push(readCoordinate(cursor, littleEndian, hasZ, hasM));
  }
  return coordinates;
}

/**
 * Parse a Point geometry
 */
function parsePoint(
  cursor: WkbCursor,
  littleEndian: boolean,
  hasZ: boolean,
  hasM: boolean
): GeoJSONGeometry {
  const coordinates = readCoordinate(cursor, littleEndian, hasZ, hasM);
  return { type: 'Point', coordinates };
}

/**
 * Parse a LineString geometry
 */
function parseLineString(
  cursor: WkbCursor,
  littleEndian: boolean,
  hasZ: boolean,
  hasM: boolean
): GeoJSONGeometry {
  const numPoints = cursor.readUInt32(littleEndian);
  if (numPoints < 2) throw new Error('LineString must have at least 2 points');

  const coordinates = readCoordinates(cursor, numPoints, littleEndian, hasZ, hasM);
  return { type: 'LineString', coordinates };
}

/**
 * Parse a Polygon geometry
 */
function parsePolygon(
  cursor: WkbCursor,
  littleEndian: boolean,
  hasZ: boolean,
  hasM: boolean
): GeoJSONGeometry {
  const numRings = cursor.readUInt32(littleEndian);
  if (numRings < 1) throw new Error('Polygon must have at least 1 ring');

  const coordinates: number[][][] = [];
  for (let i = 0; i < numRings; i++) {
    const numPoints = cursor.readUInt32(littleEndian);
    if (numPoints < 4) throw new Error('Polygon ring must have at least 4 points');

    coordinates.push(readCoordinates(cursor, numPoints, littleEndian, hasZ, hasM));
  }

  return { type: 'Polygon', coordinates };
}

/**
 * Parse a Multi* or GeometryCollection
 */
function parseCollection(
  cursor: WkbCursor,
  collectionType: string,
  depth: number,
  maxDepth: number
): GeoJSONGeometry {
  if (depth > maxDepth) {
    throw new Error(`Geometry nested too deeply (max depth: ${maxDepth})`);
  }

  const numGeometries = cursor.readUInt32(cursor.readUInt8() === ByteOrder.LittleEndian);
  const geometries: GeoJSONGeometry[] = [];

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
function parseGeometry(
  cursor: WkbCursor,
  depth: number = 0,
  maxDepth: number = 32
): {
  geometry: GeoJSONGeometry;
  srid?: number | null;
  hasZ: boolean;
  hasM: boolean;
  coordinateDimension: 2 | 3 | 4;
} {
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
  let srid: number | null = null;
  if (hasSrid) {
    srid = cursor.readUInt32(littleEndian);
  }

  let geometry: GeoJSONGeometry;

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
export function parseWkbToGeojson(
  wkb: Buffer | string,
  options: WkbParseOptions = {}
): WkbParseResult {
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
  } catch (error) {
    throw new Error(
      `Failed to parse WKB geometry: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error }
    );
  }
}

/**
 * Batch parse multiple WKB values, skipping nulls and errors
 *
 * @param wkbs - Array of WKB values (Buffer, hex string, or null)
 * @param maxCount - Maximum number to parse (default: 5000)
 * @returns Array of parse results or null for failed/null inputs
 */
export function batchParseWkb(
  wkbs: Array<Buffer | string | null>,
  maxCount: number = 5000
): Array<WkbParseResult | null> {
  return wkbs.slice(0, maxCount).map((wkb, index) => {
    if (wkb === null || wkb === undefined) return null;

    try {
      return parseWkbToGeojson(wkb);
    } catch (error) {
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
export function getWkbGeometryType(wkb: Buffer | string): string | null {
  try {
    const buffer = typeof wkb === 'string' ? Buffer.from(wkb, 'hex') : wkb;
    if (buffer.length < 5) return null;

    const byteOrder = buffer.readUInt8(0);
    const littleEndian = byteOrder === ByteOrder.LittleEndian;
    const rawType = littleEndian ? buffer.readUInt32LE(1) : buffer.readUInt32BE(1);
    const { baseType } = parseGeometryType(rawType);

    const typeNames: Record<number, string> = {
      [WkbGeometryType.Point]: 'Point',
      [WkbGeometryType.LineString]: 'LineString',
      [WkbGeometryType.Polygon]: 'Polygon',
      [WkbGeometryType.MultiPoint]: 'MultiPoint',
      [WkbGeometryType.MultiLineString]: 'MultiLineString',
      [WkbGeometryType.MultiPolygon]: 'MultiPolygon',
      [WkbGeometryType.GeometryCollection]: 'GeometryCollection',
    };

    return typeNames[baseType] ?? 'Unknown';
  } catch {
    return null;
  }
}
