import { describe, expect, it } from "vitest";
import { oracleSdo2dWkbToDimensionalWkb } from "./oracle-gis-wkb.js";
function pointWkb(type, coordinates, littleEndian = false) {
    const bytes = Buffer.alloc(5 + coordinates.length * 8);
    bytes[0] = littleEndian ? 1 : 0;
    if (littleEndian)
        bytes.writeUInt32LE(type, 1);
    else
        bytes.writeUInt32BE(type, 1);
    coordinates.forEach((coordinate, index) => {
        const offset = 5 + index * 8;
        if (littleEndian)
            bytes.writeDoubleLE(coordinate, offset);
        else
            bytes.writeDoubleBE(coordinate, offset);
    });
    return bytes;
}
function lineStringWkb(type, coordinates, littleEndian = false) {
    const dimensionCount = coordinates[0]?.length ?? 2;
    const bytes = Buffer.alloc(9 + coordinates.length * dimensionCount * 8);
    bytes[0] = littleEndian ? 1 : 0;
    if (littleEndian) {
        bytes.writeUInt32LE(type, 1);
        bytes.writeUInt32LE(coordinates.length, 5);
    }
    else {
        bytes.writeUInt32BE(type, 1);
        bytes.writeUInt32BE(coordinates.length, 5);
    }
    let offset = 9;
    for (const coordinate of coordinates) {
        for (const ordinate of coordinate) {
            if (littleEndian)
                bytes.writeDoubleLE(ordinate, offset);
            else
                bytes.writeDoubleBE(ordinate, offset);
            offset += 8;
        }
    }
    return bytes;
}
function polygonWkb(type, rings, littleEndian = false) {
    const pointCount = rings.reduce((total, ring) => total + ring.length, 0);
    const dimensionCount = rings[0]?.[0]?.length ?? 2;
    const bytes = Buffer.alloc(9 + rings.length * 4 + pointCount * dimensionCount * 8);
    bytes[0] = littleEndian ? 1 : 0;
    if (littleEndian) {
        bytes.writeUInt32LE(type, 1);
        bytes.writeUInt32LE(rings.length, 5);
    }
    else {
        bytes.writeUInt32BE(type, 1);
        bytes.writeUInt32BE(rings.length, 5);
    }
    let offset = 9;
    for (const ring of rings) {
        if (littleEndian)
            bytes.writeUInt32LE(ring.length, offset);
        else
            bytes.writeUInt32BE(ring.length, offset);
        offset += 4;
        for (const coordinate of ring) {
            for (const ordinate of coordinate) {
                if (littleEndian)
                    bytes.writeDoubleLE(ordinate, offset);
                else
                    bytes.writeDoubleBE(ordinate, offset);
                offset += 8;
            }
        }
    }
    return bytes;
}
describe("Oracle SDO dimensional WKB reconstruction", () => {
    it.each([
        { name: "XYZ", gtype: 3_001, outputType: 1_001, vertex: { x: 104, y: 30, z: 5, w: null } },
        { name: "XYM", gtype: 3_301, outputType: 2_001, vertex: { x: 104, y: 30, z: 7, w: null } },
        { name: "XYZM", gtype: 4_401, outputType: 3_001, vertex: { x: 104, y: 30, z: 6, w: 8 } },
    ])("reconstructs $name points in big-endian WKB", ({ gtype, outputType, vertex }) => {
        const source = pointWkb(1, [104, 30]);
        const output = oracleSdo2dWkbToDimensionalWkb(source, gtype, JSON.stringify([vertex]));
        const expected = pointWkb(outputType, gtype === 4_401 ? [104, 30, 6, 8] : [104, 30, vertex.z]);
        expect(output).toEqual(expected);
    });
    it("adds XYM ordinates to each polygon ring vertex without changing ring boundaries", () => {
        const coordinates = [[104, 30], [105, 30], [105, 31], [104, 30]];
        const source = polygonWkb(3, [coordinates]);
        const vertices = coordinates.map(([x, y], index) => ({ x, y, z: 7 + index, w: null }));
        expect(oracleSdo2dWkbToDimensionalWkb(source, 3_303, JSON.stringify(vertices)))
            .toEqual(polygonWkb(2_003, [coordinates.map(([x, y], index) => [x, y, 7 + index])]));
    });
    it("adds XYZM ordinates through nested multi-geometries and preserves little endian", () => {
        const first = lineStringWkb(2, [[104, 30], [105, 31]], true);
        const second = lineStringWkb(2, [[106, 32], [107, 33]], true);
        const source = Buffer.alloc(9 + first.length + second.length);
        source[0] = 1;
        source.writeUInt32LE(6, 1);
        source.writeUInt32LE(2, 5);
        first.copy(source, 9);
        second.copy(source, 9 + first.length);
        const vertices = [
            { x: 104, y: 30, z: 5, w: 7 }, { x: 105, y: 31, z: 6, w: 8 },
            { x: 106, y: 32, z: 9, w: 11 }, { x: 107, y: 33, z: 10, w: 12 },
        ];
        const expectedFirst = lineStringWkb(3_002, [[104, 30, 5, 7], [105, 31, 6, 8]], true);
        const expectedSecond = lineStringWkb(3_002, [[106, 32, 9, 11], [107, 33, 10, 12]], true);
        const expected = Buffer.alloc(9 + expectedFirst.length + expectedSecond.length);
        expected[0] = 1;
        expected.writeUInt32LE(3_006, 1);
        expected.writeUInt32LE(2, 5);
        expectedFirst.copy(expected, 9);
        expectedSecond.copy(expected, 9 + expectedFirst.length);
        expect(oracleSdo2dWkbToDimensionalWkb(source, 4_406, JSON.stringify(vertices))).toEqual(expected);
    });
    it("preserves an empty Point and rejects mismatched vertices or unsupported LRS layouts", () => {
        const emptyPoint = pointWkb(1, [Number.NaN, Number.NaN]);
        const emptyOutput = oracleSdo2dWkbToDimensionalWkb(emptyPoint, 3_001, "[]");
        expect(emptyOutput.readUInt32BE(1)).toBe(1_001);
        expect(Number.isNaN(emptyOutput.readDoubleBE(5))).toBe(true);
        expect(Number.isNaN(emptyOutput.readDoubleBE(13))).toBe(true);
        expect(Number.isNaN(emptyOutput.readDoubleBE(21))).toBe(true);
        expect(() => oracleSdo2dWkbToDimensionalWkb(pointWkb(1, [104, 30]), 3_001, "[]"))
            .toThrow("fewer SDO vertices");
        expect(() => oracleSdo2dWkbToDimensionalWkb(pointWkb(1, [104, 30]), 3_401, "[]"))
            .toThrow("unsupported Z/M dimension layout");
    });
    it("rejects truncated or reordered coordinate streams instead of emitting partial WKB", () => {
        const source = lineStringWkb(2, [[104, 30], [105, 31]]);
        expect(() => oracleSdo2dWkbToDimensionalWkb(source.subarray(0, source.length - 1), 3_002, "[]"))
            .toThrow("exceeds the remaining payload");
        expect(() => oracleSdo2dWkbToDimensionalWkb(source, 3_002, JSON.stringify([
            { x: 105, y: 31, z: 5, w: null }, { x: 104, y: 30, z: 6, w: null },
        ]))).toThrow("coordinate order");
        expect(() => oracleSdo2dWkbToDimensionalWkb(pointWkb(1, [104, 30]), 3_001, "not-json"))
            .toThrow("invalid JSON");
    });
});
//# sourceMappingURL=oracle-gis-wkb.test.js.map