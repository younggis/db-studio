// Browser-safe WKB / EWKB reader. The shared parser is Node-only (uses Buffer),
// but query results arrive in the renderer as hex strings or Uint8Array.
// Only the first two ordinates are kept — the map is a 2D viewer.

export type BrowserGeometry = { type: string; coordinates: unknown };

export type BrowserWkbResult = {
  geometry: BrowserGeometry;
  srid?: number | null;
  hasZ: boolean;
  hasM: boolean;
};

function toBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === "string") {
    const text = value.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(text) || text.length < 20 || text.length % 2 !== 0) return undefined;
    const bytes = new Uint8Array(text.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (value instanceof Uint8Array) return value;
  const wrapped = value as { type?: string; data?: number[] };
  if (wrapped && wrapped.type === "Buffer" && Array.isArray(wrapped.data)) {
    return Uint8Array.from(wrapped.data);
  }
  return undefined;
}

/** Parse OGC WKB or PostGIS EWKB without Node Buffer. */
export function parseWkbBrowser(value: unknown): BrowserWkbResult | undefined {
  const bytes = toBytes(value);
  if (!bytes || bytes.byteLength < 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let topSrid: number | null | undefined;

  function readPoint(little: boolean, dimension: number): number[] {
    const point: number[] = [];
    for (let index = 0; index < dimension; index += 1) {
      point.push(view.getFloat64(offset, little));
      offset += 8;
    }
    return point.slice(0, 2);
  }

  function readCount(little: boolean): number {
    const count = view.getUint32(offset, little);
    offset += 4;
    return count;
  }

  function readGeometry(depth: number): BrowserGeometry {
    if (depth > 24 || offset + 5 > view.byteLength) throw new Error("WKB too deep or truncated");
    const little = view.getUint8(offset++) === 1;
    const rawType = view.getUint32(offset, little);
    offset += 4;

    let hasZ = (rawType & 0x80000000) !== 0;
    let hasM = (rawType & 0x40000000) !== 0;
    const hasSrid = (rawType & 0x20000000) !== 0;
    let type = rawType & 0x1fffffff;
    if (!hasZ && !hasM) {
      if (type >= 3000 && type < 4000) { hasZ = true; hasM = true; type -= 3000; }
      else if (type >= 2000 && type < 3000) { hasM = true; type -= 2000; }
    }
    const dimension = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
    if (hasSrid) {
      const srid = view.getInt32(offset, little);
      offset += 4;
      if (topSrid === undefined) topSrid = srid;
    }

    switch (type) {
      case 1: // Point
        return { type: "Point", coordinates: readPoint(little, dimension) };
      case 2: { // LineString
        const count = readCount(little);
        const coordinates: number[][] = [];
        for (let index = 0; index < count; index += 1) coordinates.push(readPoint(little, dimension));
        return { type: "LineString", coordinates };
      }
      case 3: { // Polygon
        const rings = readCount(little);
        const coordinates: number[][][] = [];
        for (let ring = 0; ring < rings; ring += 1) {
          const count = readCount(little);
          const points: number[][] = [];
          for (let index = 0; index < count; index += 1) points.push(readPoint(little, dimension));
          coordinates.push(points);
        }
        return { type: "Polygon", coordinates };
      }
      case 4: { // MultiPoint
        const count = readCount(little);
        const coordinates: number[][] = [];
        for (let index = 0; index < count; index += 1) {
          const child = readGeometry(depth + 1);
          coordinates.push(child.coordinates as number[]);
        }
        return { type: "MultiPoint", coordinates };
      }
      case 5: { // MultiLineString
        const count = readCount(little);
        const coordinates: number[][][] = [];
        for (let index = 0; index < count; index += 1) {
          coordinates.push(readGeometry(depth + 1).coordinates as number[][]);
        }
        return { type: "MultiLineString", coordinates };
      }
      case 6: { // MultiPolygon
        const count = readCount(little);
        const coordinates: number[][][][] = [];
        for (let index = 0; index < count; index += 1) {
          coordinates.push(readGeometry(depth + 1).coordinates as number[][][]);
        }
        return { type: "MultiPolygon", coordinates };
      }
      case 7: { // GeometryCollection
        const count = readCount(little);
        const geometries: BrowserGeometry[] = [];
        for (let index = 0; index < count; index += 1) geometries.push(readGeometry(depth + 1));
        return { type: "GeometryCollection", coordinates: geometries as unknown };
      }
      default:
        throw new Error(`Unsupported WKB type ${type}`);
    }
  }

  try {
    const geometry = readGeometry(0);
    return { geometry, srid: topSrid, hasZ: false, hasM: false };
  } catch {
    return undefined;
  }
}
