import { describe, expect, it } from "vitest";
import { normalizeWkbForOracleSdo, oracleConfigFromEnvironment } from "./oracle.js";
function wkbHeader(typeCode) {
    const buffer = Buffer.alloc(5);
    buffer[0] = 1;
    buffer.writeUInt32LE(typeCode >>> 0, 1);
    return buffer;
}
function isoPoint(typeCode, ordinates) {
    const buffer = Buffer.alloc(5 + ordinates.length * 8);
    wkbHeader(typeCode).copy(buffer);
    ordinates.forEach((value, index) => buffer.writeDoubleLE(value, 5 + index * 8));
    return buffer;
}
describe("oracleConfigFromEnvironment", () => {
    it("builds an Easy Connect string from host, port and service", () => {
        expect(oracleConfigFromEnvironment({
            ORACLE_HOST: "127.0.0.1",
            ORACLE_PORT: "1522",
            ORACLE_SERVICE_NAME: "FREEPDB1",
            ORACLE_USER: "dbstudio",
            ORACLE_PASSWORD: "local-only",
        })).toEqual({
            user: "dbstudio",
            password: "local-only",
            connectString: "//127.0.0.1:1522/FREEPDB1",
            connectTimeout: 10,
            callTimeout: 30_000,
        });
    });
    it("accepts a supplied Oracle Net connect string", () => {
        expect(oracleConfigFromEnvironment({
            DBSTUDIO_ORACLE_CONNECT_STRING: "db.example.net:1521/prod.example",
            ORACLE_USER: "reader",
            ORACLE_PASSWORD: "local-only",
        })).toEqual({
            user: "reader",
            password: "local-only",
            connectString: "db.example.net:1521/prod.example",
            connectTimeout: 10,
            callTimeout: 30_000,
        });
    });
    it("requires connection fields and validates ports and timeouts", () => {
        expect(() => oracleConfigFromEnvironment({})).toThrow(/ORACLE_USER/);
        expect(() => oracleConfigFromEnvironment({ ORACLE_USER: "reader" })).toThrow(/ORACLE_PASSWORD/);
        expect(() => oracleConfigFromEnvironment({ ORACLE_USER: "reader", ORACLE_PASSWORD: "secret" })).toThrow(/ORACLE_CONNECT_STRING/);
        expect(() => oracleConfigFromEnvironment({ ORACLE_USER: "reader", ORACLE_PASSWORD: "secret", ORACLE_HOST: "db", ORACLE_SERVICE_NAME: "free", ORACLE_PORT: "0" })).toThrow(/ORACLE_PORT/);
        expect(() => oracleConfigFromEnvironment({ ORACLE_USER: "reader", ORACLE_PASSWORD: "secret", ORACLE_CONNECT_STRING: "db/free", ORACLE_CALL_TIMEOUT: "later" })).toThrow(/ORACLE_CALL_TIMEOUT/);
    });
});
describe("normalizeWkbForOracleSdo", () => {
    it("converts ISO Z, M, and ZM point type codes to EWKB flags without changing coordinates", () => {
        for (const [typeCode, ordinates, expectedType, expectedDimensions] of [
            [1001, [104, 30, 5], 0x80000001, 3],
            [2001, [104, 30, 7], 0x40000001, 3],
            [3001, [104, 30, 5, 7], 0xc0000001, 4],
        ]) {
            const normalized = normalizeWkbForOracleSdo(isoPoint(typeCode, [...ordinates]), 4326);
            expect(normalized.wkb.readUInt32LE(1)).toBe(expectedType >>> 0);
            expect(normalized.wkb.subarray(5)).toEqual(isoPoint(typeCode, [...ordinates]).subarray(5));
            expect(normalized.srid).toBe(4326);
            expect(normalized.dimensions).toBe(expectedDimensions);
        }
    });
    it("normalizes nested multi-geometry members and retains embedded SRID only as a bind value", () => {
        const multiPointHeader = wkbHeader(1004);
        const count = Buffer.alloc(4);
        count.writeUInt32LE(1);
        const input = Buffer.concat([multiPointHeader, count, isoPoint(1001, [104, 30, 5])]);
        const normalized = normalizeWkbForOracleSdo(input, 4326);
        expect(normalized.wkb.readUInt32LE(1)).toBe(0x80000004);
        expect(normalized.wkb.readUInt32LE(10)).toBe(0x80000001);
        expect(normalized.wkb.subarray(14)).toEqual(isoPoint(1001, [104, 30, 5]).subarray(5));
        const embedded = Buffer.alloc(5 + 4 + 3 * 8);
        embedded[0] = 1;
        embedded.writeUInt32LE(0xa0000001, 1);
        embedded.writeUInt32LE(4326, 5);
        [104, 30, 5].forEach((value, index) => embedded.writeDoubleLE(value, 9 + index * 8));
        const sridNormalized = normalizeWkbForOracleSdo(embedded, null);
        expect(sridNormalized.wkb.readUInt32LE(1)).toBe(0x80000001);
        expect(sridNormalized.srid).toBe(4326);
        expect(sridNormalized.wkb.length).toBe(29);
    });
    it("preserves big-endian coordinate payloads while rewriting dimensional headers", () => {
        const input = Buffer.alloc(5 + 3 * 8);
        input[0] = 0;
        input.writeUInt32BE(1001, 1);
        [104, 30, 5].forEach((value, index) => input.writeDoubleBE(value, 5 + index * 8));
        const normalized = normalizeWkbForOracleSdo(input, 4326);
        expect(normalized.wkb[0]).toBe(0);
        expect(normalized.wkb.readUInt32BE(1)).toBe(0x80000001);
        expect(normalized.wkb.subarray(5)).toEqual(input.subarray(5));
    });
    it("rejects conflicting SRIDs, unsupported curves, truncated input, and trailing bytes", () => {
        const embedded = Buffer.alloc(5 + 4 + 2 * 8);
        embedded[0] = 1;
        embedded.writeUInt32LE(0x20000001, 1);
        embedded.writeUInt32LE(3857, 5);
        expect(() => normalizeWkbForOracleSdo(embedded, 4326)).toThrow(/expected 4326/);
        expect(() => normalizeWkbForOracleSdo(wkbHeader(8), 4326)).toThrow(/does not support WKB geometry type 8/);
        expect(() => normalizeWkbForOracleSdo(wkbHeader(1), 4326)).toThrow(/truncated WKB point coordinates/);
        expect(() => normalizeWkbForOracleSdo(Buffer.concat([isoPoint(1, [104, 30]), Buffer.from([0])]), 4326)).toThrow(/trailing bytes/);
    });
});
//# sourceMappingURL=oracle.test.js.map