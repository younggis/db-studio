import { describe, expect, it } from "vitest";
import { convertTransferValue } from "./table-transfer-conversion.js";
function column(name, dataType) {
    return { name, dataType, nullable: true, defaultValue: null, primaryKey: false, ordinalPosition: 1 };
}
describe("convertTransferValue", () => {
    it("keeps exact decimal and bigint text without converting through JavaScript number", () => {
        const big = "900719925474099312345";
        expect(convertTransferValue(big, column("value", "NUMERIC"), column("value", "NUMERIC(24, 0)"), "postgres", "postgres"))
            .toBe(big);
        expect(convertTransferValue("12345678901234567890.1200", column("value", "DECIMAL"), column("value", "DECIMAL(24, 4)"), "mysql", "postgres"))
            .toBe("12345678901234567890.1200");
        expect(convertTransferValue(".0001", column("amount", "NUMBER"), column("amount", "NUMERIC(16, 4)"), "oracle", "postgres"))
            .toBe("0.0001");
        expect(convertTransferValue("-.0001", column("amount", "NUMBER"), column("amount", "NUMERIC(16, 4)"), "oracle", "postgres"))
            .toBe("-0.0001");
    });
    it("converts only unambiguous boolean representations", () => {
        expect(convertTransferValue("1", column("active", "VARCHAR"), column("active", "BOOLEAN"))).toBe(true);
        expect(convertTransferValue(0, column("active", "INTEGER"), column("active", "BIT"), "postgres", "sqlserver")).toBe(false);
        expect(convertTransferValue(false, column("active", "BOOLEAN"), column("active", "INTEGER"), "postgres", "sqlite")).toBe(0);
        expect(() => convertTransferValue(2, column("active", "INTEGER"), column("active", "BOOLEAN")))
            .toThrow("cannot be converted to a boolean");
    });
    it("rejects fractional values and integer overflow before the destination insert", () => {
        expect(() => convertTransferValue("12.5", column("count", "NUMERIC"), column("count", "INTEGER"), "postgres", "postgres"))
            .toThrow("Fractional values");
        expect(() => convertTransferValue("0.001", column("count", "NUMERIC"), column("count", "INTEGER"), "postgres", "postgres"))
            .toThrow("Fractional values");
        expect(convertTransferValue("1.000", column("count", "NUMERIC"), column("count", "INTEGER"), "postgres", "postgres"))
            .toBe("1");
        expect(() => convertTransferValue("2147483648", column("count", "BIGINT"), column("count", "INTEGER"), "postgres", "postgres"))
            .toThrow("outside the range");
    });
    it("rejects decimal rounding and precision loss", () => {
        expect(() => convertTransferValue("1.234", column("amount", "NUMERIC"), column("amount", "DECIMAL(5, 2)"), "postgres", "mysql"))
            .toThrow("without rounding");
        expect(() => convertTransferValue("1234.00", column("amount", "NUMERIC"), column("amount", "DECIMAL(5, 2)"), "postgres", "mysql"))
            .toThrow("precision");
        expect(convertTransferValue("1200", column("amount", "NUMERIC"), column("amount", "NUMBER(5, -2)"), "postgres", "oracle"))
            .toBe("1200");
        expect(() => convertTransferValue("125", column("amount", "NUMERIC"), column("amount", "NUMBER(5, -2)"), "postgres", "oracle"))
            .toThrow("without rounding");
    });
    it("accepts finite floating-point values and rejects numeric overflow", () => {
        const target = column("ratio", "DOUBLE PRECISION");
        expect(convertTransferValue(1.25, column("ratio", "REAL"), target, "sqlite", "postgres")).toBe(1.25);
        expect(convertTransferValue("1.23456789012345", column("ratio", "NUMERIC"), target, "postgres", "postgres"))
            .toBe("1.23456789012345");
        expect(convertTransferValue(123n, column("ratio", "BIGINT"), target, "sqlite", "postgres")).toBe("123");
        expect(() => convertTransferValue("1e309", column("ratio", "NUMERIC"), target, "postgres", "postgres"))
            .toThrow("finite numeric scalar");
        expect(() => convertTransferValue(1n << 2000n, column("ratio", "BIGINT"), target, "sqlite", "postgres"))
            .toThrow("finite numeric scalar");
    });
    it("serializes JSON for text/JSON destinations and rejects invalid JSON text", () => {
        expect(convertTransferValue({ id: 4 }, column("payload", "JSONB"), column("payload", "TEXT"), "postgres", "sqlite"))
            .toBe('{"id":4}');
        expect(convertTransferValue('{"ok":true}', column("payload", "JSON"), column("payload", "JSONB"), "mysql", "postgres"))
            .toBe('{"ok":true}');
        expect(() => convertTransferValue("{oops", column("payload", "JSON"), column("payload", "TEXT"), "postgres", "sqlite"))
            .toThrow("Source JSON text is invalid");
        expect(() => convertTransferValue({ value: Number.POSITIVE_INFINITY }, column("payload", "JSON"), column("payload", "JSONB"), "sqlite", "postgres"))
            .toThrow("Non-finite numbers");
    });
    it("preserves byte arrays and refuses implicit text-to-binary encoding", () => {
        const bytes = new Uint8Array([0, 255]);
        expect(convertTransferValue(bytes, column("payload", "BYTEA"), column("payload", "BLOB"), "postgres", "mysql")).toBe(bytes);
        expect(() => convertTransferValue("00ff", column("payload", "TEXT"), column("payload", "BLOB"), "postgres", "mysql"))
            .toThrow("text encoding must be selected explicitly");
    });
    it("uses ISO text for date-to-text and keeps temporal text unchanged", () => {
        const date = new Date("2026-01-02T03:04:05.000Z");
        expect(convertTransferValue(date, column("created", "TIMESTAMP"), column("created", "TEXT"), "postgres", "sqlite"))
            .toBe("2026-01-02T03:04:05.000Z");
        expect(convertTransferValue("2026-01-02 03:04:05", column("created", "VARCHAR"), column("created", "DATETIME"), "mysql", "mysql"))
            .toBe("2026-01-02 03:04:05");
    });
    it("serializes date-only values without driver timezone shifts", () => {
        const postgresDate = new Date(2026, 0, 2);
        const sqlServerDate = new Date(Date.UTC(2026, 0, 2));
        const sqliteDate = convertTransferValue("2026-01-02", column("created_on", "DATE"), column("created_on", "DATE"), "sqlite", "oracle");
        expect(convertTransferValue(postgresDate, column("created_on", "DATE"), column("created_on", "DATE"), "postgres", "sqlserver"))
            .toBe("2026-01-02");
        expect(convertTransferValue(sqlServerDate, column("created_on", "DATE"), column("created_on", "DATE"), "sqlserver", "postgres"))
            .toBe("2026-01-02");
        expect(convertTransferValue(new Date(2026, 0, 2), column("created_on", "DATE"), column("created_on", "DATE"), "postgres", "oracle"))
            .toEqual(new Date(2026, 0, 2));
        expect(sqliteDate).toBeInstanceOf(Date);
        expect(sqliteDate.getFullYear()).toBe(2026);
        expect(sqliteDate.getMonth()).toBe(0);
        expect(sqliteDate.getDate()).toBe(2);
    });
    it("rejects dropping a non-midnight timestamp into a date-only column", () => {
        expect(() => convertTransferValue(new Date(2026, 0, 2, 0, 0, 1), column("created_on", "TIMESTAMP"), column("created_on", "DATE"), "postgres", "sqlserver"))
            .toThrow("Time-of-day would be lost");
    });
    it("preserves instants across time-zone-aware timestamp types and rejects implicit zone guesses", () => {
        const instant = new Date("2026-01-01T19:04:05.678Z");
        const pgZoned = column("occurred_at", "TIMESTAMP WITH TIME ZONE");
        const sqlServerZoned = column("occurred_at", "DATETIMEOFFSET(3)");
        const mysqlZoned = column("occurred_at", "TIMESTAMP(3)");
        const naive = column("occurred_at", "DATETIME2(3)");
        expect(convertTransferValue(instant, column("occurred_at", "TIMESTAMPTZ"), sqlServerZoned, "postgres", "sqlserver"))
            .toBe(instant.toISOString());
        expect(convertTransferValue("2026-01-02T03:04:05.678+08:00", column("occurred_at", "TEXT"), sqlServerZoned, "sqlite", "sqlserver"))
            .toBe(instant.toISOString());
        expect(convertTransferValue(instant, mysqlZoned, pgZoned, "mysql", "postgres")).toEqual(instant);
        expect(convertTransferValue("2026-01-02T03:04:05.678+08:00", column("occurred_at", "TEXT"), pgZoned, "sqlite", "postgres"))
            .toEqual(instant);
        expect(() => convertTransferValue(instant, column("occurred_at", "TIMESTAMP"), pgZoned, "postgres", "postgres"))
            .toThrow("requires a source time zone");
        expect(() => convertTransferValue(instant, pgZoned, naive, "postgres", "sqlserver"))
            .toThrow("cannot be transferred to a time-zone-naive destination");
        expect(() => convertTransferValue("2026-01-02T03:04:05", column("occurred_at", "TEXT"), pgZoned, "sqlite", "postgres"))
            .toThrow("requires an explicit offset or Z suffix");
        expect(() => convertTransferValue("2026-01-02T03:04:05+08:00", column("occurred_at", "TEXT"), naive, "sqlite", "sqlserver"))
            .toThrow("time-zone-qualified value cannot be stored");
    });
});
//# sourceMappingURL=table-transfer-conversion.test.js.map