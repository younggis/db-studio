interface OracleSdoVertex {
  x: number;
  y: number;
  z: number | null;
  w: number | null;
}

interface OracleDimensionLayout {
  coordinateDimension: 3 | 4;
  hasZ: boolean;
  hasM: boolean;
  isoOffset: 1_000 | 2_000 | 3_000;
  geometryType: number;
}

interface WkbCursor {
  offset: number;
  coordinateCount: number;
  vertexIndex: number;
  output?: Buffer;
  outputOffset: number;
  vertices: OracleSdoVertex[];
  layout: OracleDimensionLayout;
}

function readBytes(bytes: Uint8Array, cursor: WkbCursor, length: number, label: string): number {
  if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > bytes.byteLength) {
    throw new Error(`Oracle 2D WKB is truncated while reading ${label}.`);
  }
  const offset = cursor.offset;
  cursor.offset += length;
  return offset;
}

function readUInt32(bytes: Buffer, cursor: WkbCursor, littleEndian: boolean, label: string): number {
  const offset = readBytes(bytes, cursor, 4, label);
  return littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function readDouble(bytes: Buffer, cursor: WkbCursor, littleEndian: boolean, label: string): number {
  const offset = readBytes(bytes, cursor, 8, label);
  return littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
}

function writeUInt32(output: Buffer, offset: number, value: number, littleEndian: boolean): number {
  if (littleEndian) output.writeUInt32LE(value, offset);
  else output.writeUInt32BE(value, offset);
  return offset + 4;
}

function writeDouble(output: Buffer, offset: number, value: number, littleEndian: boolean): number {
  if (littleEndian) output.writeDoubleLE(value, offset);
  else output.writeDoubleBE(value, offset);
  return offset + 8;
}

/**
 * Oracle computes the 2D structural WKB through a coordinate transformation,
 * so its XY doubles can differ from GETVERTICES by one ULP. A tight relative
 * tolerance still catches reordered or substituted coordinates.
 */
function ordinatesMatch(left: number, right: number): boolean {
  if (left === right) return true;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-12;
}

function readVertexJson(value: string | null | undefined): OracleSdoVertex[] {
  if (value === null || value === undefined || value === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Oracle returned invalid JSON for SDO vertex ordinates.", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("Oracle SDO vertex JSON must be an array.");
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Oracle SDO vertex ${index + 1} is malformed.`);
    }
    const vertex = entry as Record<string, unknown>;
    const readOrdinate = (name: "x" | "y" | "z" | "w"): number | null => {
      const ordinate = vertex[name];
      if (ordinate === null || ordinate === undefined) return null;
      const number = typeof ordinate === "number" ? ordinate : Number(ordinate);
      return Number.isFinite(number) ? number : null;
    };
    const x = readOrdinate("x");
    const y = readOrdinate("y");
    if (x === null || y === null) throw new Error(`Oracle SDO vertex ${index + 1} has invalid XY ordinates.`);
    return { x, y, z: readOrdinate("z"), w: readOrdinate("w") };
  });
}

function dimensionLayout(gtype: number): OracleDimensionLayout {
  if (!Number.isSafeInteger(gtype) || gtype < 2_000) throw new Error(`Oracle returned an invalid SDO_GTYPE '${gtype}'.`);
  const coordinateDimension = Math.trunc(gtype / 1_000);
  const lrsDimension = Math.trunc(gtype / 100) % 10;
  const geometryType = gtype % 100;
  if (geometryType < 1 || geometryType > 7) {
    throw new Error(`Oracle SDO geometry type ${geometryType} cannot be encoded as standard WKB.`);
  }
  if (coordinateDimension === 3 && lrsDimension === 0) {
    return { coordinateDimension: 3, hasZ: true, hasM: false, isoOffset: 1_000, geometryType };
  }
  if (coordinateDimension === 3 && lrsDimension === 3) {
    return { coordinateDimension: 3, hasZ: false, hasM: true, isoOffset: 2_000, geometryType };
  }
  if (coordinateDimension === 4 && lrsDimension === 4) {
    return { coordinateDimension: 4, hasZ: true, hasM: true, isoOffset: 3_000, geometryType };
  }
  throw new Error(`Oracle SDO_GTYPE ${gtype} uses an unsupported Z/M dimension layout.`);
}

function copyCoordinate(bytes: Buffer, cursor: WkbCursor, littleEndian: boolean, isPoint: boolean): void {
  const x = readDouble(bytes, cursor, littleEndian, "coordinate X");
  const y = readDouble(bytes, cursor, littleEndian, "coordinate Y");
  const isEmptyPoint = isPoint && Number.isNaN(x) && Number.isNaN(y);
  if ((Number.isNaN(x) || Number.isNaN(y)) && !isEmptyPoint) {
    throw new Error("Oracle 2D WKB contains a coordinate with only one empty ordinate.");
  }
  if (!isEmptyPoint && (!Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error("Oracle 2D WKB contains a non-finite XY coordinate.");
  }
  cursor.coordinateCount += 1;
  let vertex: OracleSdoVertex | undefined;
  if (!isEmptyPoint) {
    vertex = cursor.vertices[cursor.vertexIndex];
    if (!vertex) throw new Error("Oracle returned fewer SDO vertices than the 2D WKB coordinate sequence.");
    if (!ordinatesMatch(vertex.x, x) || !ordinatesMatch(vertex.y, y)) {
      throw new Error(`Oracle SDO vertex ${cursor.vertexIndex + 1} does not match the 2D WKB coordinate order.`);
    }
    cursor.vertexIndex += 1;
  }
  if (!cursor.output) return;
  // GETVERTICES carries the original stored doubles; the 2D WKB can have a
  // one-ULP transformation error, so write the authoritative vertex ordinates.
  cursor.outputOffset = writeDouble(cursor.output, cursor.outputOffset, isEmptyPoint ? x : vertex!.x, littleEndian);
  cursor.outputOffset = writeDouble(cursor.output, cursor.outputOffset, isEmptyPoint ? y : vertex!.y, littleEndian);
  const ordinates = cursor.layout.hasZ && cursor.layout.hasM
    ? [isEmptyPoint ? Number.NaN : vertex?.z, isEmptyPoint ? Number.NaN : vertex?.w]
    : cursor.layout.hasZ
      ? [isEmptyPoint ? Number.NaN : vertex?.z]
      : cursor.layout.hasM
      ? [isEmptyPoint ? Number.NaN : vertex?.z]
      : [];
  for (const ordinate of ordinates) {
    if (typeof ordinate !== "number" || (!Number.isFinite(ordinate) && !Number.isNaN(ordinate))) {
      throw new Error(`Oracle SDO vertex ${cursor.vertexIndex} is missing a required Z/M ordinate.`);
    }
    cursor.outputOffset = writeDouble(cursor.output, cursor.outputOffset, ordinate, littleEndian);
  }
}

function visitGeometry(bytes: Buffer, cursor: WkbCursor, depth = 0, expectedType?: number): void {
  if (depth > 32) throw new Error("Oracle 2D WKB nested geometry depth exceeds the supported limit.");
  const byteOrderOffset = readBytes(bytes, cursor, 1, "byte order");
  const byteOrder = bytes[byteOrderOffset]!;
  if (byteOrder !== 0 && byteOrder !== 1) throw new Error("Oracle 2D WKB uses an invalid byte-order marker.");
  const littleEndian = byteOrder === 1;
  const inputType = readUInt32(bytes, cursor, littleEndian, "geometry type");
  if (inputType < 1 || inputType > 7) throw new Error(`Oracle 2D WKB type ${inputType} is not supported for dimensional export.`);
  if (expectedType !== undefined && inputType !== expectedType) {
    throw new Error(`Oracle 2D WKB collection child type ${inputType} does not match expected type ${expectedType}.`);
  }
  if (depth === 0 && inputType !== cursor.layout.geometryType) {
    throw new Error(`Oracle SDO_GTYPE geometry type ${cursor.layout.geometryType} does not match WKB type ${inputType}.`);
  }
  if (cursor.output) {
    cursor.output[cursor.outputOffset++] = byteOrder;
    cursor.outputOffset = writeUInt32(cursor.output, cursor.outputOffset, inputType + cursor.layout.isoOffset, littleEndian);
  }
  if (inputType === 1) {
    copyCoordinate(bytes, cursor, littleEndian, true);
    return;
  }
  if (inputType === 2) {
    const pointCount = readUInt32(bytes, cursor, littleEndian, "LineString point count");
    if (cursor.output) cursor.outputOffset = writeUInt32(cursor.output, cursor.outputOffset, pointCount, littleEndian);
    if (pointCount > Math.floor((bytes.byteLength - cursor.offset) / 16)) {
      throw new Error("Oracle 2D WKB LineString point count exceeds the remaining payload.");
    }
    for (let index = 0; index < pointCount; index += 1) copyCoordinate(bytes, cursor, littleEndian, false);
    return;
  }
  if (inputType === 3) {
    const ringCount = readUInt32(bytes, cursor, littleEndian, "Polygon ring count");
    if (cursor.output) cursor.outputOffset = writeUInt32(cursor.output, cursor.outputOffset, ringCount, littleEndian);
    if (ringCount > Math.floor((bytes.byteLength - cursor.offset) / 4)) {
      throw new Error("Oracle 2D WKB Polygon ring count exceeds the remaining payload.");
    }
    for (let ring = 0; ring < ringCount; ring += 1) {
      const pointCount = readUInt32(bytes, cursor, littleEndian, "Polygon ring point count");
      if (cursor.output) cursor.outputOffset = writeUInt32(cursor.output, cursor.outputOffset, pointCount, littleEndian);
      if (pointCount > Math.floor((bytes.byteLength - cursor.offset) / 16)) {
        throw new Error("Oracle 2D WKB Polygon point count exceeds the remaining payload.");
      }
      for (let index = 0; index < pointCount; index += 1) copyCoordinate(bytes, cursor, littleEndian, false);
    }
    return;
  }
  const geometryCount = readUInt32(bytes, cursor, littleEndian, "collection geometry count");
  if (cursor.output) cursor.outputOffset = writeUInt32(cursor.output, cursor.outputOffset, geometryCount, littleEndian);
  if (geometryCount > Math.floor((bytes.byteLength - cursor.offset) / 5)) {
    throw new Error("Oracle 2D WKB collection count exceeds the remaining payload.");
  }
  const childType = inputType === 5 ? 1 : inputType === 6 ? 2 : inputType === 7 ? 3 : undefined;
  for (let index = 0; index < geometryCount; index += 1) visitGeometry(bytes, cursor, depth + 1, childType);
}

function walkWkb(bytes: Buffer, vertices: OracleSdoVertex[], layout: OracleDimensionLayout, output?: Buffer): WkbCursor {
  const cursor: WkbCursor = { offset: 0, coordinateCount: 0, vertexIndex: 0, output, outputOffset: 0, vertices, layout };
  visitGeometry(bytes, cursor);
  if (cursor.offset !== bytes.byteLength) throw new Error("Oracle 2D WKB contains trailing bytes after its geometry.");
  return cursor;
}

/**
 * Rebuilds ISO dimensional WKB from Oracle's 2D MAKE_2D WKB plus the original
 * SDO_UTIL.GETVERTICES ordinates. It refuses reordered or structurally different
 * vertex sequences instead of exporting incomplete coordinates.
 */
export function oracleSdo2dWkbToDimensionalWkb(
  wkb: Uint8Array,
  gtype: number,
  vertexJson: string | null | undefined,
): Buffer {
  const layout = dimensionLayout(gtype);
  const bytes = Buffer.from(wkb.buffer, wkb.byteOffset, wkb.byteLength);
  const vertices = readVertexJson(vertexJson);
  const inspected = walkWkb(bytes, vertices, layout);
  if (inspected.vertexIndex !== vertices.length) {
    throw new Error(`Oracle returned ${vertices.length} SDO vertices for ${inspected.vertexIndex} non-empty WKB coordinate(s).`);
  }
  const addedDimensionCount = layout.coordinateDimension - 2;
  const output = Buffer.allocUnsafe(bytes.byteLength + inspected.coordinateCount * addedDimensionCount * 8);
  const written = walkWkb(bytes, vertices, layout, output);
  if (written.vertexIndex !== vertices.length || written.outputOffset !== output.byteLength) {
    throw new Error("Oracle dimensional WKB reconstruction did not consume the complete source geometry.");
  }
  return output;
}
