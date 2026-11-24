import type { ColumnInfo, DatabaseEngine, TableRowChange } from "@db-studio/shared";

const nonEditableDataType = /(?:array|binary|blob|bytea|clob|geography|geometry|image|json|large\s+object|object|raster|raw|variant|xml)/i;
const booleanDataType = /(?:^|\b)(?:bool(?:ean)?|bit)(?:\b|$)/i;
const numericDataType = /(?:int|decimal|numeric|real|float|double|number|money)/i;

export function isEditableColumn(column: ColumnInfo): boolean {
  return !column.primaryKey && !nonEditableDataType.test(column.dataType);
}

export function isSupportedPrimaryKey(column: ColumnInfo): boolean {
  return !nonEditableDataType.test(column.dataType);
}

export function quoteIdentifier(engine: DatabaseEngine, identifier: string): string {
  if (engine === "mysql" || engine === "mariadb") {
    return `\`${identifier.replaceAll("`", "``")}\``;
  }
  if (engine === "sqlserver") {
    const escapedIdentifier = identifier.replaceAll("]", "]]");
    return `[${escapedIdentifier}]`;
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quoteQualifiedTable(engine: DatabaseEngine, schema: string, table: string): string {
  return `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`;
}

export function buildTablePreviewSql(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  limit = 100,
): string {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const qualifiedTable = quoteQualifiedTable(engine, schema, table);
  if (engine === "sqlserver") return `SELECT TOP (${safeLimit}) *\nFROM ${qualifiedTable};`;
  if (engine === "oracle") return `SELECT *\nFROM ${qualifiedTable}\nFETCH FIRST ${safeLimit} ROWS ONLY;`;
  return `SELECT *\nFROM ${qualifiedTable}\nLIMIT ${safeLimit};`;
}

function compareValue(value: unknown, column: ColumnInfo): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (booleanDataType.test(column.dataType)) {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLocaleLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  if (numericDataType.test(column.dataType) && typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function valuesEqual(left: unknown, right: unknown, column: ColumnInfo): boolean {
  const normalizedLeft = compareValue(left, column);
  const normalizedRight = compareValue(right, column);
  if (Object.is(normalizedLeft, normalizedRight)) return true;
  if (numericDataType.test(column.dataType)) {
    const leftText = String(normalizedLeft ?? "").trim();
    const rightText = String(normalizedRight ?? "").trim();
    if (leftText === rightText) return true;
    if (typeof left === "number" && typeof right === "string") {
      return Number.isFinite(Number(rightText)) && left === Number(rightText);
    }
    if (typeof right === "number" && typeof left === "string") {
      return Number.isFinite(Number(leftText)) && right === Number(leftText);
    }
  }
  return false;
}

export function changedEditableColumns(
  columns: ColumnInfo[],
  originalRow: Record<string, unknown>,
  editedRow: Record<string, unknown>,
): ColumnInfo[] {
  return columns.filter((column) => isEditableColumn(column)
    && Object.hasOwn(editedRow, column.name)
    && !valuesEqual(originalRow[column.name], editedRow[column.name], column));
}

export function serializeEditedValue(value: unknown, column: ColumnInfo): unknown {
  if (value === null || value === undefined) {
    if (!column.nullable) throw new Error(`${column.name} 不允许为空`);
    return null;
  }
  if (typeof value !== "string") return value;

  if (booleanDataType.test(column.dataType)) {
    const normalized = value.trim().toLocaleLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
    throw new Error(`${column.name} 请输入 true/false 或 1/0`);
  }
  if (numericDataType.test(column.dataType)) {
    const normalized = value.trim();
    if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(normalized)) {
      throw new Error(`${column.name} 需要有效的数值`);
    }
    return normalized;
  }
  return value;
}

export function buildTableRowChange(
  columns: ColumnInfo[],
  originalRow: Record<string, unknown>,
  editedRow: Record<string, unknown>,
): TableRowChange | undefined {
  const primaryKeys = columns.filter((column) => column.primaryKey);
  if (!primaryKeys.length) throw new Error("此表没有主键，无法安全定位要更新的行");
  for (const key of primaryKeys) {
    if (!Object.hasOwn(originalRow, key.name) || originalRow[key.name] === undefined) {
      throw new Error(`查询结果缺少主键字段 ${key.name}`);
    }
  }

  const changed = changedEditableColumns(columns, originalRow, editedRow);
  if (!changed.length) return undefined;

  return {
    primaryKeyValues: Object.fromEntries(primaryKeys.map((column) => [column.name, originalRow[column.name]])),
    values: Object.fromEntries(changed.map((column) => [column.name, serializeEditedValue(editedRow[column.name], column)])),
  };
}