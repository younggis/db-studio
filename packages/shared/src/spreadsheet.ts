import ExcelJS from "exceljs";
import type { QueryResult } from "./index.js";
import type { TabularData } from "./format.js";

const MAX_SPREADSHEET_BYTES = 50 * 1024 * 1024;
const MAX_SPREADSHEET_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_SPREADSHEET_ZIP_ENTRIES = 4_096;
const MAX_SPREADSHEET_ROWS = 100_000;
const MAX_SPREADSHEET_COLUMNS = 2_048;
const MAX_SPREADSHEET_CELLS = 1_000_000;

export async function parseExcelWorkbook(content: Uint8Array): Promise<TabularData> {
  if (content.byteLength === 0) throw new Error("Excel workbook is empty.");
  if (content.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new Error(`Excel workbook exceeds the ${MAX_SPREADSHEET_BYTES / 1024 / 1024} MB import limit.`);
  }

  const archive = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await assertSpreadsheetZipExpansionWithinLimit(archive);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(archive as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel workbook has no worksheets.");
  if (worksheet.rowCount > MAX_SPREADSHEET_ROWS + 1) {
    throw new Error(`Excel worksheet exceeds the ${MAX_SPREADSHEET_ROWS.toLocaleString()} row import limit.`);
  }

  const headerRow = worksheet.getRow(1);
  if (headerRow.cellCount > MAX_SPREADSHEET_COLUMNS) {
    throw new Error(`Excel worksheet exceeds the ${MAX_SPREADSHEET_COLUMNS.toLocaleString()} column import limit.`);
  }
  const columns = Array.from({ length: headerRow.cellCount }, (_, index) => {
    const cell = headerRow.getCell(index + 1);
    const value = normalizeCellValue(cell.value);
    return value === null || value === undefined ? "" : String(value);
  });
  validateColumns(columns);

  const rows: Record<string, unknown>[] = [];
  let processedCellCount = columns.length;
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (row.cellCount === 0) continue;
    if (row.cellCount > MAX_SPREADSHEET_COLUMNS) {
      throw new Error(
        `Excel row ${rowNumber} exceeds the ${MAX_SPREADSHEET_COLUMNS.toLocaleString()} column import limit.`,
      );
    }
    processedCellCount += Math.max(columns.length, row.cellCount);
    if (processedCellCount > MAX_SPREADSHEET_CELLS) {
      throw new Error(
        `Excel worksheet exceeds the ${MAX_SPREADSHEET_CELLS.toLocaleString()}-cell processing limit.`,
      );
    }

    const values = columns.map((_, index) => normalizeCellValue(row.getCell(index + 1).value) ?? null);
    if (values.every((value) => value === null || value === "")) continue;
    const hasExtraData = Array.from(
      { length: Math.max(0, row.cellCount - columns.length) },
      (_, index) => normalizeCellValue(row.getCell(columns.length + index + 1).value),
    ).some((value) => value !== null && value !== undefined && value !== "");
    if (hasExtraData) {
      throw new Error(`Excel row ${rowNumber} contains data beyond the ${columns.length} header columns.`);
    }
    rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
  }

  return { columns, rows };
}

async function assertSpreadsheetZipExpansionWithinLimit(archive: Buffer): Promise<void> {
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localFileHeaderSignature = 0x04034b50;
  const minimumEndRecordSize = 22;
  const maxCommentBytes = 0xffff;

  if (archive.byteLength < minimumEndRecordSize) {
    throw new Error("Excel workbook ZIP directory is invalid.");
  }

  let endRecordOffset = -1;
  const searchStart = Math.max(0, archive.byteLength - minimumEndRecordSize - maxCommentBytes);
  for (let offset = archive.byteLength - minimumEndRecordSize; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) !== endOfCentralDirectorySignature) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + minimumEndRecordSize + commentLength === archive.byteLength) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) throw new Error("Excel workbook ZIP directory is invalid.");

  const diskNumber = archive.readUInt16LE(endRecordOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endRecordOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endRecordOffset + 8);
  const entryCount = archive.readUInt16LE(endRecordOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endRecordOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endRecordOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("Excel workbook uses an unsupported multi-disk or ZIP64 archive.");
  }
  if (entryCount > MAX_SPREADSHEET_ZIP_ENTRIES) {
    throw new Error(`Excel workbook exceeds the ${MAX_SPREADSHEET_ZIP_ENTRIES.toLocaleString()} ZIP entry limit.`);
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd !== endRecordOffset || centralDirectoryEnd > archive.byteLength) {
    throw new Error("Excel workbook ZIP directory is invalid.");
  }

  let cursor = centralDirectoryOffset;
  let expandedBytes = 0n;
  const maxExpandedBytes = BigInt(MAX_SPREADSHEET_EXPANDED_BYTES);
  const entries: Array<{
    compressedSize: number;
    compressionMethod: number;
    localHeaderOffset: number;
    uncompressedSize: number;
  }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralDirectoryEnd || archive.readUInt32LE(cursor) !== centralDirectorySignature) {
      throw new Error("Excel workbook ZIP directory is invalid.");
    }

    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const fileCommentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const flags = archive.readUInt16LE(cursor + 8);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + fileNameLength + extraLength + fileCommentLength;
    if (entryEnd > centralDirectoryEnd) throw new Error("Excel workbook ZIP directory is invalid.");
    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart !== 0
    ) {
      throw new Error("Excel workbook uses an unsupported multi-disk or ZIP64 archive.");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new Error("Encrypted Excel workbooks are not supported.");
    }

    expandedBytes += BigInt(uncompressedSize);
    if (expandedBytes > maxExpandedBytes) {
      throw new Error(
        `Excel workbook expands beyond the ${MAX_SPREADSHEET_EXPANDED_BYTES / 1024 / 1024} MiB uncompressed import limit.`,
      );
    }
    entries.push({ compressedSize, compressionMethod, localHeaderOffset, uncompressedSize });
    cursor = entryEnd;
  }
  if (cursor !== centralDirectoryEnd) throw new Error("Excel workbook ZIP directory is invalid.");

  expandedBytes = 0n;
  for (const entry of entries) {
    const { compressedSize, compressionMethod, localHeaderOffset, uncompressedSize } = entry;
    if (localHeaderOffset + 30 > centralDirectoryOffset) throw new Error("Excel workbook ZIP directory is invalid.");
    if (archive.readUInt32LE(localHeaderOffset) !== localFileHeaderSignature) {
      throw new Error("Excel workbook ZIP directory is invalid.");
    }

    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    if ((localFlags & 0x0001) !== 0 || (localFlags & 0x0040) !== 0) {
      throw new Error("Encrypted Excel workbooks are not supported.");
    }
    if (localCompressionMethod !== compressionMethod) throw new Error("Excel workbook ZIP directory is invalid.");

    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralDirectoryOffset) throw new Error("Excel workbook ZIP directory is invalid.");
    const compressedData = archive.subarray(dataStart, dataEnd);
    const remainingBudget = Number(maxExpandedBytes - expandedBytes);
    let actualEntrySize: number;
    if (compressionMethod === 0) {
      actualEntrySize = compressedData.byteLength;
    } else if (compressionMethod === 8) {
      actualEntrySize = await inflateEntrySizeWithinBudget(compressedData, remainingBudget);
    } else {
      throw new Error(`Excel workbook ZIP compression method ${compressionMethod} is not supported.`);
    }
    if (actualEntrySize !== uncompressedSize) {
      throw new Error("Excel workbook ZIP entry size does not match its directory metadata.");
    }

    expandedBytes += BigInt(actualEntrySize);
    if (expandedBytes > maxExpandedBytes) {
      throw new Error(
        `Excel workbook expands beyond the ${MAX_SPREADSHEET_EXPANDED_BYTES / 1024 / 1024} MiB uncompressed import limit.`,
      );
    }
  }
}

async function inflateEntrySizeWithinBudget(compressedData: Buffer, remainingBudget: number): Promise<number> {
  const [{ Readable }, { createInflateRaw }] = await Promise.all([import("node:stream"), import("node:zlib")]);
  return new Promise((resolve, reject) => {
    const input = Readable.from([compressedData]);
    const inflater = createInflateRaw();
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      input.destroy();
      inflater.destroy();
      reject(error);
    };

    inflater.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > remainingBudget) {
        fail(
          new Error(
            `Excel workbook expands beyond the ${MAX_SPREADSHEET_EXPANDED_BYTES / 1024 / 1024} MiB uncompressed import limit.`,
          ),
        );
      }
    });
    input.once("error", fail);
    inflater.once("error", fail);
    inflater.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(outputBytes);
    });
    input.pipe(inflater);
  });
}

export async function queryResultToXlsx(result: QueryResult): Promise<Uint8Array> {
  validateSpreadsheetShape(result.columns.length, result.rows.length, "export");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DB Studio";
  const worksheet = workbook.addWorksheet("Data");
  worksheet.addRow(result.columns);
  for (const row of result.rows) {
    worksheet.addRow(result.columns.map((column) => toExcelValue(row[column])));
  }
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns = result.columns.map((header) => ({
    header,
    key: header,
    width: Math.min(48, Math.max(12, header.length + 2)),
  }));
  const output = await workbook.xlsx.writeBuffer();
  return new Uint8Array(output);
}

function validateSpreadsheetShape(columnCount: number, dataRowCount: number, operation: "export"): void {
  if (columnCount > MAX_SPREADSHEET_COLUMNS) {
    throw new Error(`Excel worksheet exceeds the ${MAX_SPREADSHEET_COLUMNS.toLocaleString()} column ${operation} limit.`);
  }
  if (dataRowCount > MAX_SPREADSHEET_ROWS) {
    throw new Error(`Excel worksheet exceeds the ${MAX_SPREADSHEET_ROWS.toLocaleString()} row ${operation} limit.`);
  }
  const cellCount = columnCount * (dataRowCount + 1);
  if (cellCount > MAX_SPREADSHEET_CELLS) {
    throw new Error(`Excel worksheet exceeds the ${MAX_SPREADSHEET_CELLS.toLocaleString()}-cell ${operation} limit.`);
  }
}

function normalizeCellValue(value: ExcelJS.CellValue | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if ("result" in value) return normalizeCellValue(value.result as ExcelJS.CellValue | null | undefined);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  if ("error" in value) return value.error;
  return JSON.stringify(value);
}

function toExcelValue(value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return JSON.stringify(value);
}

function validateColumns(columns: string[]): void {
  if (columns.length === 0 || columns.some((column) => !column.trim())) {
    throw new Error("Excel worksheet must have non-empty column headers in row 1.");
  }
  if (new Set(columns).size !== columns.length) {
    throw new Error("Excel worksheet contains duplicate column headers.");
  }
}
