# DB Studio 功能改进路线图

**创建日期**: 2026-11-27  
**来源**: 用户反馈与 Navicat 功能对比分析

## 改进建议概览

基于与 Navicat Premium 的功能对比和实际使用需求，以下是优先级排序的改进建议：

---

## 1. 查询结果中渲染 geometry 字段（高优先级）

### 功能描述
参考 SQL Server Management Studio 和 Navicat，当查询结果包含矢量字段（geometry/geography）时，在结果表格中渲染前 5000 条记录的几何预览。

### 当前状态
- ✅ GIS 文件预览地图已实现（`GisPreviewMap`，MapLibre GL）
- ✅ PostGIS 导入导出识别空间字段
- ❌ 查询结果表格不渲染 geometry 字段（显示为十六进制 WKB 或 null）

### 实现方案

#### 1.1 类型定义扩展
**文件**: `packages/shared/src/query-result.ts`
```typescript
export interface QueryResultColumn {
  name: string;
  type: string;
  nullable: boolean;
  // 新增几何类型元数据
  geometryType?: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'GeometryCollection';
  srid?: number;
  coordinateDimension?: 2 | 3 | 4;
}
```

#### 1.2 适配器增强
**文件**: `packages/database/src/postgres-adapter.ts`
```typescript
// 在 executeQuery 方法中检测几何字段
async executeQuery(sql: string, params?: any[]): Promise<QueryResult> {
  const result = await this.pool.query(sql, params);
  
  const columns = result.fields.map(field => {
    const column: QueryResultColumn = {
      name: field.name,
      type: field.dataTypeID === 17 ? 'bytea' : 'unknown',
      nullable: true,
    };
    
    // 检测 PostGIS 几何类型
    if (field.dataTypeID === 25 && field.name.match(/^(geom|geometry|geography|wkb_geometry)$/i)) {
      // 查询 geometry_columns 获取详细元数据
      const metaResult = await this.pool.query(
        `SELECT type, srid, coord_dimension FROM geometry_columns 
         WHERE f_geometry_column = $1 LIMIT 1`,
        [field.name]
      );
      if (metaResult.rows[0]) {
        column.geometryType = metaResult.rows[0].type;
        column.srid = metaResult.rows[0].srid;
        column.coordinateDimension = metaResult.rows[0].coord_dimension;
      }
    }
    
    return column;
  });
  
  return { columns, rows: result.rows };
}
```

#### 1.3 WKB 解析工具
**文件**: `packages/gis/src/wkb-parser.ts`（新建）
```typescript
import { parseWkb } from './wkb-parser-impl';

/**
 * 将 PostGIS WKB 二进制数据转换为 GeoJSON Geometry
 * @param wkb Buffer 或十六进制字符串
 * @returns GeoJSON Geometry 对象
 */
export function wkbToGeojson(wkb: Buffer | string): GeoJSON.Geometry {
  const buffer = typeof wkb === 'string' ? Buffer.from(wkb, 'hex') : wkb;
  return parseWkb(buffer);
}

/**
 * 批量解析 WKB，限制数量防止内存溢出
 * @param wkbs WKB 数组
 * @param maxCount 最大解析数量（默认 5000）
 */
export function batchWkbToGeojson(
  wkbs: Array<Buffer | string | null>,
  maxCount = 5000
): Array<GeoJSON.Geometry | null> {
  return wkbs.slice(0, maxCount).map(wkb => {
    if (!wkb) return null;
    try {
      return wkbToGeojson(wkb);
    } catch {
      return null;
    }
  });
}
```

#### 1.4 UI 组件实现
**文件**: `apps/desktop/src/components/GeometryCell.tsx`（新建）
```tsx
import { Popover } from 'antd';
import { MapLibre } from 'maplibre-gl';
import { useEffect, useState } from 'react';
import { wkbToGeojson } from '@db-studio/gis';
import type { QueryResultColumn } from '@db-studio/shared';

interface GeometryCellProps {
  value: Buffer | string | null;
  column: QueryResultColumn;
  rowIndex: number;
}

export function GeometryCell({ value, column, rowIndex }: GeometryCellProps) {
  const [geometry, setGeometry] = useState<GeoJSON.Geometry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return;
    
    try {
      const geom = wkbToGeojson(value);
      setGeometry(geom);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Parse error');
    }
  }, [value]);

  if (!value) {
    return <span className="geometry-null">NULL</span>;
  }

  if (error) {
    return (
      <Popover content={error}>
        <span className="geometry-error">⚠️ {column.geometryType || 'Geometry'}</span>
      </Popover>
    );
  }

  const icon = getGeometryIcon(column.geometryType);
  
  return (
    <Popover
      content={<MiniMapPreview geometry={geometry} srid={column.srid} />}
      trigger="hover"
      placement="right"
    >
      <button
        className="geometry-cell"
        onClick={() => openFullMapView(geometry, column, rowIndex)}
      >
        {icon} {column.geometryType}
      </button>
    </Popover>
  );
}

function MiniMapPreview({ geometry, srid }: { geometry: GeoJSON.Geometry | null; srid?: number }) {
  if (!geometry) return <div>Loading...</div>;
  
  return (
    <div className="mini-map" style={{ width: 300, height: 200 }}>
      {/* 复用 GisPreviewMap，简化版本 */}
      <MapLibrePreview geometry={geometry} srid={srid} />
    </div>
  );
}

function getGeometryIcon(type?: string): string {
  const icons: Record<string, string> = {
    Point: '📍',
    LineString: '📏',
    Polygon: '🔷',
    MultiPoint: '📍📍',
    MultiLineString: '📏📏',
    MultiPolygon: '🔷🔷',
    GeometryCollection: '🗂️',
  };
  return icons[type || ''] || '🌐';
}
```

**文件**: `apps/desktop/src/components/QueryResultTable.tsx`
```tsx
// 修改现有表格，增加几何列渲染
import { GeometryCell } from './GeometryCell';

function QueryResultTable({ columns, rows }: QueryResultTableProps) {
  const renderCell = (column: QueryResultColumn, value: any, rowIndex: number) => {
    // 检测几何列
    if (column.geometryType) {
      return <GeometryCell value={value} column={column} rowIndex={rowIndex} />;
    }
    
    // 其他类型按原逻辑渲染
    return <span>{formatValue(value)}</span>;
  };

  return (
    <table>
      <thead>
        <tr>
          {columns.map(col => (
            <th key={col.name}>
              {col.name}
              {col.geometryType && <span className="geom-badge">{col.geometryType}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIdx) => (
          <tr key={rowIdx}>
            {columns.map((col, colIdx) => (
              <td key={colIdx}>
                {renderCell(col, row[col.name], rowIdx)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

#### 1.5 性能优化
- **5000 行限制**: 超过 5000 行时显示警告"数据过多，仅渲染前 5000 条"
- **虚拟滚动**: 使用 `react-window` 或 `react-virtualized` 避免渲染所有行
- **懒加载**: 只在单元格进入视口时解析 WKB
- **WebGL 聚合**: 超过 1000 个要素时使用聚合点显示

#### 1.6 测试覆盖
**新增测试**: `tests/integration/postgis-query-result-geometry-render.mjs`
```javascript
// 验证 geometry 列识别、WKB 解析和 GeoJSON 转换
const result = await core.executeQuery(
  connectionId,
  'SELECT id, name, ST_AsEWKB(geom) as geom FROM roads LIMIT 10'
);

assert(result.columns.find(c => c.name === 'geom')?.geometryType === 'LineString');
assert(result.rows[0].geom instanceof Buffer);

const geojson = wkbToGeojson(result.rows[0].geom);
assert(geojson.type === 'LineString');
```

### 预估工作量
- **WKB 解析器**: 2 天（可复用现有 `oracle-gis-wkb.ts` 逻辑）
- **适配器增强**: 1 天
- **UI 组件**: 2 天
- **集成测试**: 1 天
- **总计**: 5-6 个工作日

---

## 2. 查询结果增加执行统计信息（高优先级）

### 功能描述
在查询结果面板顶部显示执行时间、返回行数、受影响行数、执行时间戳等统计信息。

### 当前状态
- ✅ 查询执行与结果展示
- ✅ 错误信息显示
- ❌ 无执行时间显示
- ❌ 无行数统计（依赖分页加载）
- ❌ 无执行历史时间戳

### 实现方案

#### 2.1 类型定义
**文件**: `packages/shared/src/query-result.ts`
```typescript
export interface QueryExecutionMetrics {
  startTime: Date;
  endTime: Date;
  duration: number;  // 毫秒
  rowCount: number | 'unknown';  // 流式查询可能未知
  affectedRows?: number;  // DML 语句（INSERT/UPDATE/DELETE）
  status: 'success' | 'error' | 'cancelled';
  errorMessage?: string;
}

export interface QueryResult {
  columns: QueryResultColumn[];
  rows: QueryResultRow[];
  metrics: QueryExecutionMetrics;  // 新增
}
```

#### 2.2 适配器实现
**文件**: `packages/database/src/postgres-adapter.ts`
```typescript
async executeQuery(sql: string, params?: any[]): Promise<QueryResult> {
  const startTime = new Date();
  let status: 'success' | 'error' = 'success';
  let errorMessage: string | undefined;
  
  try {
    const result = await this.pool.query(sql, params);
    const endTime = new Date();
    
    return {
      columns: this.mapColumns(result.fields),
      rows: result.rows,
      metrics: {
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime(),
        rowCount: result.rows.length,
        affectedRows: result.rowCount,  // pg 自动提供
        status: 'success',
      },
    };
  } catch (error) {
    const endTime = new Date();
    status = 'error';
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    throw new QueryError(errorMessage, {
      startTime,
      endTime,
      duration: endTime.getTime() - startTime.getTime(),
      rowCount: 0,
      status,
      errorMessage,
    });
  }
}
```

**其他适配器**:
- **MySQL/MariaDB**: `mysql2` 的 `result.affectedRows` 属性
- **SQL Server**: `mssql` 的 `recordset.rowsAffected`
- **Oracle**: `oracledb` 的 `result.rowsAffected`
- **SQLite**: `node:sqlite` 的 `changes` 属性
- **MongoDB**: Document count from `cursor.toArray().length`

#### 2.3 UI 组件
**文件**: `apps/desktop/src/components/QueryMetricsBar.tsx`（新建）
```tsx
import { ClockCircleOutlined, TableOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { format } from 'date-fns';
import type { QueryExecutionMetrics } from '@db-studio/shared';

interface QueryMetricsBarProps {
  metrics: QueryExecutionMetrics;
}

export function QueryMetricsBar({ metrics }: QueryMetricsBarProps) {
  const durationFormatted = formatDuration(metrics.duration);
  
  return (
    <div className="query-metrics-bar">
      <div className="metric-group">
        <span className={`metric status-${metrics.status}`}>
          {metrics.status === 'success' ? (
            <CheckCircleOutlined style={{ color: '#52c41a' }} />
          ) : (
            <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
          )}
          {metrics.status === 'success' ? 'Success' : 'Error'}
        </span>
        
        <span className="metric duration">
          <ClockCircleOutlined /> {durationFormatted}
        </span>
        
        <span className="metric row-count">
          <TableOutlined /> 
          {typeof metrics.rowCount === 'number' 
            ? `${metrics.rowCount.toLocaleString()} rows` 
            : 'Streaming'}
        </span>
        
        {metrics.affectedRows !== undefined && (
          <span className="metric affected-rows">
            <CheckCircleOutlined /> {metrics.affectedRows} affected
          </span>
        )}
        
        <span className="metric timestamp">
          {format(metrics.endTime, 'HH:mm:ss.SSS')}
        </span>
      </div>
      
      {metrics.errorMessage && (
        <div className="metric-error">
          ⚠️ {metrics.errorMessage}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(2);
  return `${min}m ${sec}s`;
}
```

**集成到结果面板**:
```tsx
// apps/desktop/src/components/QueryResultPanel.tsx
import { QueryMetricsBar } from './QueryMetricsBar';

function QueryResultPanel({ result }: { result: QueryResult }) {
  return (
    <div className="query-result-panel">
      <QueryMetricsBar metrics={result.metrics} />
      <QueryResultTable columns={result.columns} rows={result.rows} />
    </div>
  );
}
```

#### 2.4 查询历史增强
**文件**: `packages/shared/src/query-history.ts`
```typescript
// 现有类型已有 timestamp，增加 metrics
export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  timestamp: Date;
  metrics?: QueryExecutionMetrics;  // 新增
}

// appendQueryHistory 增加 metrics 参数
export function appendQueryHistory(
  snapshot: QueryHistorySnapshot,
  entry: Omit<QueryHistoryEntry, 'id'>
): QueryHistorySnapshot {
  const newEntry: QueryHistoryEntry = {
    ...entry,
    id: randomUUID(),
  };
  
  return {
    ...snapshot,
    entries: [newEntry, ...snapshot.entries].slice(0, snapshot.maxSize),
  };
}
```

### 预估工作量
- **类型定义**: 0.5 天
- **适配器修改**（6 个引擎）: 1.5 天
- **UI 组件**: 1 天
- **查询历史集成**: 0.5 天
- **测试**: 0.5 天
- **总计**: 4 个工作日

---

## 3. 查询结果复制功能（中优先级）

### 功能描述
支持右键菜单复制单元格、行、列，支持多选（Ctrl+Click / Shift+Click），支持复制为 CSV、JSON、INSERT 语句等格式。

### 当前状态
- ✅ 结果表格显示（`LazyDataTable`）
- ❌ 无右键菜单
- ❌ 无单元格/行/列复制
- ❌ 无格式化复制选项

### 实现方案

#### 3.1 选择状态管理
**文件**: `apps/desktop/src/hooks/useTableSelection.ts`（新建）
```typescript
import { useState, useCallback } from 'react';

interface CellPosition {
  row: number;
  col: number;
}

export function useTableSelection(rowCount: number, colCount: number) {
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState<'single' | 'multi' | 'range'>('single');
  const [anchorCell, setAnchorCell] = useState<CellPosition | null>(null);

  const cellKey = (row: number, col: number) => `${row},${col}`;

  const handleCellClick = useCallback((row: number, col: number, ctrlKey: boolean, shiftKey: boolean) => {
    if (shiftKey && anchorCell) {
      // 范围选择
      const newSelection = new Set<string>();
      const minRow = Math.min(anchorCell.row, row);
      const maxRow = Math.max(anchorCell.row, row);
      const minCol = Math.min(anchorCell.col, col);
      const maxCol = Math.max(anchorCell.col, col);
      
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          newSelection.add(cellKey(r, c));
        }
      }
      setSelectedCells(newSelection);
      setSelectionMode('range');
    } else if (ctrlKey) {
      // 多选
      const key = cellKey(row, col);
      const newSelection = new Set(selectedCells);
      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }
      setSelectedCells(newSelection);
      setSelectionMode('multi');
      setAnchorCell({ row, col });
    } else {
      // 单选
      setSelectedCells(new Set([cellKey(row, col)]));
      setSelectionMode('single');
      setAnchorCell({ row, col });
    }
  }, [anchorCell, selectedCells]);

  const clearSelection = useCallback(() => {
    setSelectedCells(new Set());
    setAnchorCell(null);
  }, []);

  return {
    selectedCells,
    selectionMode,
    handleCellClick,
    clearSelection,
    isSelected: (row: number, col: number) => selectedCells.has(cellKey(row, col)),
  };
}
```

#### 3.2 复制格式化器
**文件**: `packages/shared/src/query-result-formatters.ts`（新建）
```typescript
export function formatSelectionAsPlainText(
  selectedData: Array<Array<any>>,
  delimiter = '\t'
): string {
  return selectedData
    .map(row => row.map(cell => cell === null ? 'NULL' : String(cell)).join(delimiter))
    .join('\n');
}

export function formatSelectionAsCsv(selectedData: Array<Array<any>>): string {
  return selectedData
    .map(row =>
      row
        .map(cell => {
          if (cell === null) return '';
          const str = String(cell);
          // CSV 转义规则
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(',')
    )
    .join('\n');
}

export function formatSelectionAsJson(
  selectedData: Array<Array<any>>,
  columns: string[]
): string {
  const objects = selectedData.map(row => {
    const obj: Record<string, any> = {};
    row.forEach((cell, idx) => {
      obj[columns[idx]] = cell;
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

export function formatSelectionAsInsert(
  selectedData: Array<Array<any>>,
  columns: string[],
  tableName: string
): string {
  const values = selectedData
    .map(row =>
      `  (${row.map(cell => {
        if (cell === null) return 'NULL';
        if (typeof cell === 'number') return String(cell);
        if (cell instanceof Buffer) return `'\\x${cell.toString('hex')}'`;
        return `'${String(cell).replace(/'/g, "''")}'`;
      }).join(', ')})`
    )
    .join(',\n');
  
  const columnNames = columns.map(c => `"${c}"`).join(', ');
  return `INSERT INTO "${tableName}" (${columnNames})\nVALUES\n${values};`;
}
```

#### 3.3 右键菜单
**文件**: `apps/desktop/src/components/QueryResultTable.tsx`
```tsx
import { Dropdown, Menu } from 'antd';
import { useTableSelection } from '../hooks/useTableSelection';
import { formatSelectionAsPlainText, formatSelectionAsCsv, formatSelectionAsJson, formatSelectionAsInsert } from '@db-studio/shared';

function QueryResultTable({ columns, rows, tableName }: QueryResultTableProps) {
  const { selectedCells, handleCellClick, isSelected, clearSelection } = useTableSelection(rows.length, columns.length);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, rowIndex: number, colIndex: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, row: rowIndex, col: colIndex });
  };

  const getSelectedData = (): Array<Array<any>> => {
    const data: Array<Array<any>> = [];
    selectedCells.forEach(key => {
      const [row, col] = key.split(',').map(Number);
      if (!data[row]) data[row] = [];
      data[row][col] = rows[row][columns[col].name];
    });
    return data.filter(Boolean);
  };

  const handleCopy = async (format: 'plain' | 'csv' | 'json' | 'insert') => {
    const selectedData = getSelectedData();
    if (selectedData.length === 0) return;

    let text: string;
    switch (format) {
      case 'plain':
        text = formatSelectionAsPlainText(selectedData);
        break;
      case 'csv':
        text = formatSelectionAsCsv(selectedData);
        break;
      case 'json':
        text = formatSelectionAsJson(selectedData, columns.map(c => c.name));
        break;
      case 'insert':
        text = formatSelectionAsInsert(selectedData, columns.map(c => c.name), tableName || 'table');
        break;
    }
    
    await navigator.clipboard.writeText(text);
    setContextMenu(null);
  };

  const handleCopyColumn = async () => {
    if (!contextMenu) return;
    const colData = rows.map(row => row[columns[contextMenu.col].name]);
    const text = colData.map(v => v === null ? 'NULL' : String(v)).join('\n');
    await navigator.clipboard.writeText(text);
    setContextMenu(null);
  };

  const menu = (
    <Menu>
      <Menu.Item key="copy-plain" onClick={() => handleCopy('plain')}>
        复制 (纯文本)
      </Menu.Item>
      <Menu.Item key="copy-csv" onClick={() => handleCopy('csv')}>
        复制为 CSV
      </Menu.Item>
      <Menu.Item key="copy-json" onClick={() => handleCopy('json')}>
        复制为 JSON
      </Menu.Item>
      <Menu.Item key="copy-insert" onClick={() => handleCopy('insert')}>
        复制为 INSERT 语句
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item key="copy-column" onClick={handleCopyColumn}>
        复制整列
      </Menu.Item>
      <Menu.Item key="copy-column-name" onClick={() => {
        if (contextMenu) {
          navigator.clipboard.writeText(`"${columns[contextMenu.col].name}"`);
          setContextMenu(null);
        }
      }}>
        复制列名
      </Menu.Item>
    </Menu>
  );

  return (
    <Dropdown overlay={menu} trigger={['contextMenu']} visible={!!contextMenu}>
      <table onContextMenu={e => e.preventDefault()}>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {columns.map((col, colIdx) => (
                <td
                  key={colIdx}
                  className={isSelected(rowIdx, colIdx) ? 'selected' : ''}
                  onClick={e => handleCellClick(rowIdx, colIdx, e.ctrlKey, e.shiftKey)}
                  onContextMenu={e => handleContextMenu(e, rowIdx, colIdx)}
                >
                  {renderCell(col, row[col.name], rowIdx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Dropdown>
  );
}
```

#### 3.4 样式
**文件**: `apps/desktop/src/components/QueryResultTable.css`
```css
.query-result-table td.selected {
  background-color: rgba(24, 144, 255, 0.1);
  border: 1px solid #1890ff;
}

.query-result-table td:hover {
  background-color: rgba(0, 0, 0, 0.02);
  cursor: pointer;
}
```

### 预估工作量
- **选择状态管理**: 1.5 天
- **格式化工具**: 1 天
- **右键菜单与UI**: 1.5 天
- **测试**: 0.5 天
- **总计**: 4-5 个工作日

---

## 4. GIS 交换扩展矢量数据类型（中优先级）

### 功能描述
扩展支持曲线类型（CircularString、CompoundCurve、CurvePolygon）和 3D/4D 几何类型（Z/M 坐标维度）。

### 当前状态
- ✅ 基础几何类型：Point, LineString, Polygon, Multi*, GeometryCollection
- ✅ 检测混合维度（`gis-dimensions-smoke.mjs`）
- ✅ PostGIS `geometry_columns` 读取 Z/M 维度
- ❌ 曲线类型未明确测试（依赖 OGR 能力）
- ❌ TIN/PolyhedralSurface 未文档化

### 实现方案

#### 4.1 类型定义扩展
**文件**: `packages/shared/src/gis-types.ts`
```typescript
export type OgrGeometryType =
  // 基础 2D 类型
  | 'Point' | 'LineString' | 'Polygon'
  | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon'
  | 'GeometryCollection'
  // 曲线类型
  | 'CircularString' | 'CompoundCurve' | 'CurvePolygon'
  | 'MultiCurve' | 'MultiSurface'
  // 3D 类型 (Z 维度)
  | 'PointZ' | 'LineStringZ' | 'PolygonZ'
  | 'MultiPointZ' | 'MultiLineStringZ' | 'MultiPolygonZ'
  | 'CircularStringZ' | 'CompoundCurveZ' | 'CurvePolygonZ'
  // M 维度（测量值，如里程）
  | 'PointM' | 'LineStringM' | 'PolygonM'
  // 4D 类型 (ZM 维度)
  | 'PointZM' | 'LineStringZM' | 'PolygonZM'
  | 'MultiPointZM' | 'MultiLineStringZM' | 'MultiPolygonZM'
  // 曲面类型
  | 'TIN' | 'PolyhedralSurface'
  | 'Unknown';

export interface GisLayerMetadata {
  name: string;
  geometryType: OgrGeometryType;
  coordinateDimension: 2 | 3 | 4;  // XY / XYZ / XYZM
  hasZ: boolean;  // 是否包含高程
  hasM: boolean;  // 是否包含测量值
  srid: number | null;
  extent?: [number, number, number, number];
  featureCount: number | null;
  fields: GisFieldMetadata[];
}
```

#### 4.2 OGR 解析增强
**文件**: `packages/gis/src/inspect.ts`
```typescript
function parseOgrInfoGeometry(json: any): {
  type: OgrGeometryType;
  hasZ: boolean;
  hasM: boolean;
  dimension: 2 | 3 | 4;
} {
  const rawType: string = json.geometryType || json.type || 'Unknown';
  
  // OGR 返回格式示例：
  // "3D Point" / "Point Z" / "Point ZM" / "Point M" / "Point 25D"
  // "Line String Z" / "Measured Line String"
  
  const hasZ = /\b(3D|Z|ZM|25D)\b/i.test(rawType);
  const hasM = /\b(M|ZM|Measured)\b/i.test(rawType);
  const dimension = hasZ && hasM ? 4 : hasZ ? 3 : hasM ? 3 : 2;
  
  // 规范化类型名称
  let baseType = rawType
    .replace(/\b(3D|Z|M|ZM|Measured|25D)\b/gi, '')
    .trim()
    .replace(/\s+/g, '');  // "Line String" → "LineString"
  
  // 添加维度后缀
  if (hasZ && hasM) {
    baseType += 'ZM';
  } else if (hasZ) {
    baseType += 'Z';
  } else if (hasM) {
    baseType += 'M';
  }
  
  return {
    type: normalizeGeometryType(baseType) as OgrGeometryType,
    hasZ,
    hasM,
    dimension,
  };
}

function normalizeGeometryType(type: string): string {
  const mapping: Record<string, string> = {
    'Point': 'Point',
    'LineString': 'LineString',
    'Polygon': 'Polygon',
    'MultiPoint': 'MultiPoint',
    'MultiLineString': 'MultiLineString',
    'MultiPolygon': 'MultiPolygon',
    'GeometryCollection': 'GeometryCollection',
    'CircularString': 'CircularString',
    'CompoundCurve': 'CompoundCurve',
    'CurvePolygon': 'CurvePolygon',
    'MultiCurve': 'MultiCurve',
    'MultiSurface': 'MultiSurface',
    'TIN': 'TIN',
    'PolyhedralSurface': 'PolyhedralSurface',
  };
  
  // 匹配基础类型（去除 Z/M/ZM 后缀）
  const baseType = type.replace(/(Z|M|ZM)$/, '');
  return mapping[baseType] || 'Unknown';
}
```

#### 4.3 OGR 曲线线性化选项
**文件**: `packages/gis/src/convert.ts`
```typescript
export interface GisConversionOptions {
  sourceCrs?: string;
  targetCrs?: string;
  fieldMappings?: FieldMapping[];
  // 新增：曲线线性化选项
  linearizeCurves?: boolean;  // 默认 true，转换为直线段
  linearizeTolerance?: number;  // 线性化容差（单位与 CRS 相关）
}

function buildOgr2OgrCommand(options: GisConversionOptions): string[] {
  const args = ['ogr2ogr'];
  
  // 曲线线性化
  if (options.linearizeCurves !== false) {
    args.push('-nlt', 'PROMOTE_TO_MULTI');  // 自动提升为 Multi* 类型
    if (options.linearizeTolerance) {
      args.push('-segmentize', String(options.linearizeTolerance));
    }
  } else {
    // 保留曲线类型（需要目标格式支持）
    args.push('-nlt', 'CONVERT_TO_CURVE');
  }
  
  // ... 其他选项
  
  return args;
}
```

#### 4.4 PostGIS 3D 支持
**文件**: `packages/database/src/postgres-adapter.ts`
```typescript
// 查询 geometry_columns 时读取 coord_dimension
async getPostgisGeometryMetadata(schema: string, table: string, column: string) {
  const result = await this.pool.query(
    `SELECT type, srid, coord_dimension 
     FROM geometry_columns 
     WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3`,
    [schema, table, column]
  );
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    geometryType: row.type,
    srid: row.srid,
    coordinateDimension: row.coord_dimension,  // 2, 3, 或 4
    hasZ: row.coord_dimension >= 3,
    hasM: row.type.endsWith('M') || row.type.endsWith('ZM'),
  };
}
```

#### 4.5 UI 显示增强
**文件**: `apps/desktop/src/components/GisLayerInfo.tsx`
```tsx
function GisLayerInfo({ metadata }: { metadata: GisLayerMetadata }) {
  const dimensionLabel = metadata.coordinateDimension === 4 
    ? '4D (XYZM)' 
    : metadata.coordinateDimension === 3 
      ? (metadata.hasM ? '3D (XYM)' : '3D (XYZ)')
      : '2D (XY)';
  
  return (
    <div className="gis-layer-info">
      <div className="info-row">
        <span className="label">Geometry Type:</span>
        <span className="value">{metadata.geometryType}</span>
      </div>
      <div className="info-row">
        <span className="label">Coordinate Dimension:</span>
        <span className="value">
          {dimensionLabel}
          {metadata.hasZ && <span className="badge">Z</span>}
          {metadata.hasM && <span className="badge">M</span>}
        </span>
      </div>
      <div className="info-row">
        <span className="label">SRID:</span>
        <span className="value">{metadata.srid || 'Unknown'}</span>
      </div>
    </div>
  );
}
```

#### 4.6 文档更新
**文件**: `docs/gis-format-matrix.md`
```markdown
## 曲线类型支持

| 格式 | CircularString | CompoundCurve | CurvePolygon | 线性化选项 |
|------|----------------|---------------|--------------|-----------|
| Shapefile | ❌ 自动线性化 | ❌ 自动线性化 | ❌ 自动线性化 | 强制 |
| GeoPackage | ✅ | ✅ | ✅ | 可选 |
| PostGIS | ✅ | ✅ | ✅ | 保留 |
| GeoJSON | ❌ 自动线性化 | ❌ 自动线性化 | ❌ 自动线性化 | 强制 |
| MapInfo TAB | ❌ | ❌ | ❌ | 强制 |

## 3D/4D 类型支持

| 格式 | PointZ | LineStringZ | PolygonZ | PointM | PointZM |
|------|--------|-------------|----------|--------|---------|
| Shapefile | ✅ (.shz) | ✅ | ✅ | ✅ (.shm) | ⚠️ 丢失 M 值 |
| GeoPackage | ✅ | ✅ | ✅ | ✅ | ✅ |
| PostGIS | ✅ | ✅ | ✅ | ✅ | ✅ |
| GeoJSON | ✅ | ✅ | ✅ | ❌ | ❌ |
| KML | ⚠️ 高程 | ⚠️ 高程 | ⚠️ 高程 | ❌ | ❌ |
```

#### 4.7 测试覆盖
**新增测试**: `tests/integration/postgis-curve-types-smoke.mjs`
```javascript
// 测试 CircularString 导入导出
await core.importGisFile({
  connectionId,
  filePath: 'fixtures/circular_arcs.gpkg',
  layer: 'arcs',
  targetTable: 'public.test_arcs',
  linearizeCurves: false,  // 保留曲线
});

// 验证 geometry_columns
const meta = await adapter.getPostgisGeometryMetadata('public', 'test_arcs', 'geom');
assert.equal(meta.geometryType, 'CircularString');
```

**新增测试**: `tests/integration/postgis-3d-import-export.mjs`
```javascript
// 测试 PointZ 导入导出
const result = await core.executeQuery(
  connectionId,
  'SELECT ST_AsText(geom) FROM public.mountains LIMIT 1'
);
assert(result.rows[0].st_astext.includes('POINT Z'));  // 验证 Z 维度
```

### 预估工作量
- **类型定义扩展**: 0.5 天
- **OGR 解析增强**: 1 天
- **曲线线性化选项**: 1 天
- **PostGIS 元数据读取**: 0.5 天
- **UI 显示**: 0.5 天
- **文档更新**: 0.5 天
- **集成测试**: 1.5 天
- **总计**: 5-6 个工作日

---

## 实施优先级与时间线

### Sprint 1 (Week 1-2): 高优先级
- ✅ **查询执行统计信息** (4 天)
- ✅ **几何字段渲染**（前 3 天完成类型定义和 WKB 解析，后 3 天完成 UI）

**总计**: 7-8 个工作日

### Sprint 2 (Week 3-4): 中优先级
- ✅ **结果集复制功能** (4-5 天)
- ✅ **GIS 曲线与 3D 类型** (5-6 天)

**总计**: 9-11 个工作日

### Sprint 3 (未来): 低优先级
- 查询结果图表化
- 数据生成器
- 表结构可视化编辑

---

## 技术风险与缓解

### 风险 1: 几何渲染性能
**描述**: 5000+ 要素的 Polygon 渲染可能导致浏览器卡顿  
**缓解**: 
- 使用 MapLibre GL 的 WebGL 渲染（已有基础）
- 超过 1000 要素时使用聚合点显示
- 提供"导出查看"选项，避免在结果表格中强制渲染

### 风险 2: WKB 解析复杂度
**描述**: PostGIS Extended WKB (EWKB) 格式包含 SRID 前缀，与标准 WKB 不同  
**缓解**:
- 复用现有 `oracle-gis-wkb.ts` 解析逻辑
- 使用 `ST_AsGeoJSON()` 作为备选方案（性能稍差但更可靠）

### 风险 3: 曲线类型兼容性
**描述**: 某些格式（Shapefile/GeoJSON）不支持曲线，需要线性化  
**缓解**:
- 明确文档化各格式的曲线支持情况
- 提供 `linearizeCurves` 选项，默认开启
- 在操作报告中警告曲线类型被线性化

---

## 参考资料

- [PostGIS Geometry Types](https://postgis.net/docs/using_postgis_dbmanagement.html#geometry_columns)
- [OGR Vector Formats](https://gdal.org/drivers/vector/index.html)
- [MapLibre GL JS Documentation](https://maplibre.org/maplibre-gl-js/docs/)
- [Navicat Premium Feature Comparison](https://www.navicat.com/en/products/navicat-premium-feature-matrix)
- [SQL Server Spatial Data Types](https://learn.microsoft.com/en-us/sql/relational-databases/spatial/spatial-data-types-overview)
