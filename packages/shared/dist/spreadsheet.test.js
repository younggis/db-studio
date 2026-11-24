import { describe, expect, it } from "vitest";
import { parseExcelWorkbook, queryResultToXlsx } from "./spreadsheet.js";
describe("Excel workbook tabular data", () => {
    it("round-trips typed values, nulls, Unicode and formula-like strings", async () => {
        const date = new Date("2026-10-30T12:34:56.000Z");
        const bytes = await queryResultToXlsx({
            columns: ["名称", "count", "enabled", "empty", "created_at", "note"],
            rows: [{ 名称: "道路-上海", count: 12, enabled: true, empty: null, created_at: date, note: "=SUM(A1:A2)" }],
            rowCount: 1,
        });
        const parsed = await parseExcelWorkbook(bytes);
        expect(parsed.columns).toEqual(["名称", "count", "enabled", "empty", "created_at", "note"]);
        expect(parsed.rows).toEqual([{
                名称: "道路-上海",
                count: 12,
                enabled: true,
                empty: null,
                created_at: date,
                note: "=SUM(A1:A2)",
            }]);
    });
    it("rejects workbooks with duplicate headers", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("Data").addRow(["name", "name"]);
        const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
        await expect(parseExcelWorkbook(bytes)).rejects.toThrow("duplicate column headers");
    });
    it("rejects workbooks that exceed the supported column width", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("Data").addRow(Array.from({ length: 2_049 }, (_, index) => `column_${index + 1}`));
        const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
        await expect(parseExcelWorkbook(bytes)).rejects.toThrow("2,048 column import limit");
    });
    it("rejects archives whose declared expanded size exceeds the import budget before parsing", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("Data").addRow(["name", "value"]);
        const archive = Buffer.from(await workbook.xlsx.writeBuffer());
        const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
        const centralDirectoryEntry = archive.indexOf(centralDirectorySignature);
        expect(centralDirectoryEntry).toBeGreaterThanOrEqual(0);
        archive.writeUInt32LE(128 * 1024 * 1024 + 1, centralDirectoryEntry + 24);
        await expect(parseExcelWorkbook(archive)).rejects.toThrow("128 MiB uncompressed import limit");
    });
    it("checks actual inflated size when central-directory metadata understates it", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("Data").addRow(["name", "value"]);
        const archive = Buffer.from(await workbook.xlsx.writeBuffer());
        const endRecordOffset = archive.length - 22;
        let cursor = archive.readUInt32LE(endRecordOffset + 16);
        const entryCount = archive.readUInt16LE(endRecordOffset + 10);
        let modified = false;
        for (let index = 0; index < entryCount; index += 1) {
            const expandedSize = archive.readUInt32LE(cursor + 24);
            const fileNameLength = archive.readUInt16LE(cursor + 28);
            const extraLength = archive.readUInt16LE(cursor + 30);
            const fileCommentLength = archive.readUInt16LE(cursor + 32);
            if (expandedSize > 1) {
                archive.writeUInt32LE(1, cursor + 24);
                modified = true;
                break;
            }
            cursor += 46 + fileNameLength + extraLength + fileCommentLength;
        }
        expect(modified).toBe(true);
        await expect(parseExcelWorkbook(archive)).rejects.toThrow("size does not match its directory metadata");
    });
    it("rejects archives whose central directory exceeds the entry limit", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("Data").addRow(["name", "value"]);
        const archive = Buffer.from(await workbook.xlsx.writeBuffer());
        const endRecordOffset = archive.length - 22;
        archive.writeUInt16LE(4_097, endRecordOffset + 8);
        archive.writeUInt16LE(4_097, endRecordOffset + 10);
        await expect(parseExcelWorkbook(archive)).rejects.toThrow("4,096 ZIP entry limit");
    });
    it("bounds conversion work for wide, sparse worksheets", async () => {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Data");
        worksheet.addRow(Array.from({ length: 1_000 }, (_, index) => `column_${index + 1}`));
        for (let rowNumber = 2; rowNumber <= 1_001; rowNumber += 1) {
            worksheet.getRow(rowNumber).getCell(1_000).value = `value_${rowNumber}`;
        }
        const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
        await expect(parseExcelWorkbook(bytes)).rejects.toThrow("1,000,000-cell processing limit");
    });
    it("rejects query exports above the cell budget before creating a workbook", async () => {
        await expect(queryResultToXlsx({
            columns: Array.from({ length: 1_000 }, (_, index) => `column_${index + 1}`),
            rows: Array.from({ length: 1_000 }, () => ({})),
            rowCount: 1_000,
        })).rejects.toThrow("1,000,000-cell export limit");
    });
});
//# sourceMappingURL=spreadsheet.test.js.map