// Phase 3: spatial index diagnostics. Given a table and its columns, produce
// an engine-specific suggestion SQL string. The UI shows it for review only;
// nothing here executes it.
import type { ColumnInfo, DatabaseEngine } from "@db-studio/shared";

function quote(engine: DatabaseEngine, identifier: string): string {
  if (engine === "mysql" || engine === "mariadb") return `\`${identifier.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return `[${identifier.replaceAll("]", "]]")}]`;
  return `"${identifier.replaceAll('"', '""')}"`;
}

export interface SpatialIndexDiagnostic {
  engine: DatabaseEngine;
  schema: string;
  table: string;
  spatialColumns: string[];
  hasSpatialColumn: boolean;
  severity: "info" | "warning";
  message: string;
  suggestionSql?: string;
  reasons: string[];
}

function suggestion(engine: DatabaseEngine, schema: string, table: string, column: string): string | undefined {
  const q = (value: string) => quote(engine, value);
  switch (engine) {
    case "postgres":
      return `CREATE INDEX ${q(`idx_${table}_${column}_gist`)} ON ${q(schema)}.${q(table)} USING GIST (${q(column)});`;
    case "sqlite":
      return `SELECT InitSpatialMetadata(1);\nSELECT AddGeometryColumn('${schema}', '${table}', '${column}', 4326, 'GEOMETRY', 2);\nSELECT CreateSpatialIndex('${table}', '${column}');`;
    case "mysql":
    case "mariadb":
      return `ALTER TABLE ${q(schema)}.${q(table)} ADD SPATIAL INDEX ${q(`idx_${table}_${column}`)} (${q(column)});`;
    case "sqlserver":
      return `CREATE SPATIAL INDEX ${q(`idx_${table}_${column}`)} ON ${q(schema)}.${q(table)} (${q(column)}) USING GEOMETRY_GRID\nWITH (BOUNDING_BOX = (0, 0, 10000, 10000));`;
    case "oracle":
      return `INSERT INTO USER_SDO_GEOM_METADATA (TABLE_NAME, COLUMN_NAME, DIMINFO, SRID)\nVALUES ('${table.toUpperCase()}', '${column.toUpperCase()}', SDO_DIM_ARRAY(SDO_DIM_ELEMENT('X', 0, 10000, 0.05), SDO_DIM_ELEMENT('Y', 0, 10000, 0.05)), 4326);\nCREATE INDEX ${q(`idx_${table}_${column}`)} ON ${q(schema)}.${q(table)} (${q(column)}) INDEXTYPE IS MDSYS.SPATIAL_INDEX;`;
    default:
      return undefined;
  }
}

export function diagnoseSpatialIndex(input: {
  engine: DatabaseEngine;
  schema: string;
  table: string;
  columns: ColumnInfo[];
}): SpatialIndexDiagnostic {
  const spatialColumns = input.columns
    .filter((column) => /geometry|geography|sdo_geometry/i.test(column.dataType))
    .map((column) => column.name);
  const reasons: string[] = [];
  if (!spatialColumns.length) {
    reasons.push(`表 ${input.schema}.${input.table} 未声明 geometry/geography 字段。`);
    return {
      engine: input.engine, schema: input.schema, table: input.table, spatialColumns,
      hasSpatialColumn: false, severity: "info",
      message: "未发现空间列，无需空间索引。", reasons,
    };
  }
  let sql: string | undefined;
  for (const column of spatialColumns) {
    sql = suggestion(input.engine, input.schema, input.table, column);
    if (sql) break;
  }
  if (!sql) {
    reasons.push(`${input.engine} 暂不提供自动建议 SQL，请查阅对应数据库的空间索引文档。`);
    return {
      engine: input.engine, schema: input.schema, table: input.table, spatialColumns,
      hasSpatialColumn: true, severity: "warning",
      message: "存在空间列，但当前引擎无自动生成建议。", reasons,
    };
  }
  reasons.push(`检测到空间列：${spatialColumns.join("、")}。`);
  reasons.push("建议 SQL 仅作展示，应用前请核对 SRID、范围与表权限。");
  if (input.engine === "sqlite") reasons.push("SpatiaLite 需先初始化元数据；已有表需确认几何列已登记。");
  if (input.engine === "sqlserver") reasons.push("BOUNDING_BOX 必须覆盖实际数据范围，示例值仅供占位。");
  if (input.engine === "oracle") reasons.push("USER_SDO_GEOM_METADATA 需为当前用户 schema，SRID/容差请按数据核对。");
  return {
    engine: input.engine, schema: input.schema, table: input.table, spatialColumns,
    hasSpatialColumn: true, severity: "warning",
    message: `检测到 ${spatialColumns.length} 个空间列，建议检查是否已有空间索引。`,
    suggestionSql: sql, reasons,
  };
}
