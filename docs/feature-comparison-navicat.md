# DB Studio 与 Navicat 功能对比与改进建议

**分析日期**: 2026-11-27

## 功能对比概览

### 当前 DB Studio 已实现的核心功能

#### 数据库连接与管理
- ✅ 支持 PostgreSQL、MySQL、MariaDB、SQLite、SQL Server、Oracle、MongoDB
- ✅ SSH 隧道连接（`SshTunnelManager`）
- ✅ 连接测试与元数据加载
- ✅ 加密凭据存储（Windows DPAPI / Electron safeStorage）
- ✅ 数据库/Schema/表/视图/列元数据浏览
- ✅ 对象搜索（`DatabaseObjectSearchModal`）

#### 查询与编辑
- ✅ SQL 编辑器（Monaco Editor）
- ✅ 语法格式化（`sql-formatter`）
- ✅ Schema 感知自动补全（表名、列名、CTE）
- ✅ 参数化查询执行
- ✅ 查询历史与收藏（加密存储）
- ✅ 结果集分页展示（`LazyDataTable`）
- ✅ 主键编辑与事务批量保存

#### 数据导入导出
- ✅ CSV/JSON/XLSX 表格导入导出
- ✅ Excel 文件安全性预检（ZIP bomb 防护）
- ✅ 跨数据库表传输（所有 30 个方向验证通过）
- ✅ 字段映射与类型转换

#### GIS 功能
- ✅ Shapefile/GeoJSON/KML/TAB/GeoPackage 支持
- ✅ PostGIS 双向导入导出
- ✅ OGR 子进程架构（内存高效）
- ✅ CRS 转换与验证
- ✅ 字段映射与类型转换
- ✅ MapLibre GL 预览地图（`GisPreviewMap`）
- ✅ MongoDB GeoJSON 与 2dsphere 索引

#### AI 辅助
- ✅ AI SQL 生成与修复
- ✅ Schema 语义索引（Embedding + Rerank）
- ✅ PostGIS 专用模式（空间函数与单位验证）
- ✅ MongoDB 查询助手（Find/Aggregate）
- ✅ 执行计划解释
- ✅ SQL 安全检查（AST 解析，列存在性验证）

### Navicat 功能中 DB Studio 缺失或需增强的

#### 1. ❌ 空间数据可视化渲染（优先级：高）

**Navicat 功能**:
- 查询结果中自动识别 geometry/geography 字段
- 渲染前 5000 条记录的矢量图形
- 点击单元格显示几何预览
- 支持 WKT/WKB 格式查看

**DB Studio 现状**:
- ✅ GIS 文件预览地图（`GisPreviewMap`，MapLibre GL）
- ✅ PostGIS 导入导出识别空间字段
- ❌ **查询结果表格不渲染 geometry 字段**
- ❌ 结果表格中 geometry 显示为十六进制 WKB 或 null

**改进建议**:
```typescript
// packages/shared/src/query-result.ts
export interface QueryResultColumn {
  name: string;
  type: string;
  nullable: boolean;
  geometryType?: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';  // 新增
  srid?: number;  // 新增
}

// apps/desktop/src/components/QueryResultTable.tsx
// 新增几何单元格渲染器
function GeometryCell({ value, column }: { value: Buffer | string; column: QueryResultColumn }) {
  const [preview, setPreview] = useState<GeoJSON.Geometry | null>(null);
  
  useEffect(() => {
    // 解析 WKB 为 GeoJSON
    parseWkbToGeojson(value).then(setPreview);
  }, [value]);
  
  return (
    <Popover content={<MiniMapPreview geometry={preview} />}>
      <span className="geometry-indicator">
        {column.geometryType} {/* 显示几何类型图标 */}
      </span>
    </Popover>
  );
}
```

**实现要点**:
1. 在 `PostgresAdapter.executeQuery` 中检测 `geometry`/`geography` 类型
2. 添加 WKB → GeoJSON 转换工具（复用 `packages/gis` 或调用 `ST_AsGeoJSON`）
3. 结果表格增加几何类型列标识
4. 添加 Popover 小地图预览（限制前 5000 行，超过则显示"数据过多，请导出查看"）
5. 支持点击单元格打开大地图查看（复用 `GisPreviewMap`）

---

#### 2. ❌ 查询执行统计信息（优先级：高）

**Navicat 功能**:
- 查询执行时间（毫秒级）
- 返回行数统计
- 受影响行数（INSERT/UPDATE/DELETE）
- 执行状态（成功/失败/取消）
- 执行时间戳

**DB Studio 现状**:
- ✅ 查询执行与结果展示
- ✅ 错误信息显示
- ❌ **无执行时间显示**
- ❌ **无行数统计（依赖分页加载）**
- ❌ **无执行历史时间戳**

**改进建议**:
```typescript
// packages/shared/src/query-result.ts
export interface QueryExecutionMetrics {
  startTime: Date;
  endTime: Date;
  duration: number;  // 毫秒
  rowCount: number | 'unknown';  // 流式查询可能未知
  affectedRows?: number;  // DML 语句
  status: 'success' | 'error' | 'cancelled';
  errorMessage?: string;
}

export interface QueryResult {
  columns: QueryResultColumn[];
  rows: QueryResultRow[];
  metrics: QueryExecutionMetrics;  // 新增
}

// apps/desktop/src/components/QueryResultPanel.tsx
function QueryResultHeader({ metrics }: { metrics: QueryExecutionMetrics }) {
  return (
    <div className="query-metrics-bar">
      <span className="metric">
        <ClockIcon /> {metrics.duration}ms
      </span>
      <span className="metric">
        <TableIcon /> {metrics.rowCount} rows
      </span>
      {metrics.affectedRows !== undefined && (
        <span className="metric">
          <CheckIcon /> {metrics.affectedRows} affected
        </span>
      )}
      <span className="metric timestamp">
        {format(metrics.endTime, 'HH:mm:ss')}
      </span>
    </div>
  );
}
```

**实现要点**:
1. 在所有适配器的 `executeQuery` 方法中添加计时逻辑
2. PostgreSQL 使用 `pg` 的 `RowCount` 属性
3. 流式查询（如 GIS 导出）报告 "streaming" 状态
4. 查询历史增加 metrics 字段（已有 `appendQueryHistory` 可扩展）
5. 在结果面板顶部显示统计栏

---

#### 3. ❌ 结果集复制功能（优先级：中）

**Navicat 功能**:
- 右键菜单：复制单元格、复制行、复制列
- 支持多选复制（Ctrl+Click / Shift+Click）
- 复制为 CSV、JSON、INSERT 语句
- 复制列名（带引号）

**DB Studio 现状**:
- ✅ 结果表格显示（`LazyDataTable`）
- ❌ **无右键菜单**
- ❌ **无单元格/行/列复制**
- ❌ **无格式化复制选项**

**改进建议**:
```typescript
// apps/desktop/src/components/QueryResultTable.tsx
import { Menu, Dropdown } from 'antd';

function QueryResultTable({ columns, rows }: QueryResultTableProps) {
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, rowIndex: number, colIndex: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCopy = (format: 'plain' | 'csv' | 'json' | 'insert') => {
    const selectedData = getSelectedData(selectedCells, rows, columns);
    const formatted = formatCopyData(selectedData, format);
    navigator.clipboard.writeText(formatted);
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
      <Menu.Item key="copy-column-name" onClick={handleCopyColumnName}>
        复制列名
      </Menu.Item>
    </Menu>
  );

  return (
    <Dropdown overlay={menu} trigger={['contextMenu']}>
      <div onContextMenu={handleContextMenu}>
        {/* 现有表格实现，增加选择高亮 */}
      </div>
    </Dropdown>
  );
}
```

**实现要点**:
1. 增加单元格选择状态管理（单选/多选/框选）
2. 右键菜单支持复制选项
3. 格式化函数：`queryResultToCsv`（已存在）、`queryResultToJson`、`queryResultToInsert`（新增）
4. 处理 NULL 值、geometry 字段（复制为 WKT 或十六进制）
5. 大数据集复制限制（如最多 10,000 单元格）

---

#### 4. ❌ GIS 交换扩展矢量类型（优先级：中）

**Navicat 功能**:
- 支持 Z/M 坐标维度（3D/4D）
- CircularString、CompoundCurve、CurvePolygon
- TIN、PolyhedralSurface
- GeometryCollection 嵌套

**DB Studio 现状**:
- ✅ 基础几何类型：Point, LineString, Polygon, Multi*, GeometryCollection
- ✅ 检测混合维度（`gis-dimensions-smoke.mjs`）
- ✅ PostGIS `geometry_columns` 读取 Z/M 维度
- ❌ **曲线类型未明确测试**（依赖 OGR 能力）
- ❌ **TIN/PolyhedralSurface 未文档化**

**改进建议**:

**packages/shared/src/gis-types.ts**:
```typescript
export type OgrGeometryType =
  | 'Point' | 'LineString' | 'Polygon'
  | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon'
  | 'GeometryCollection'
  // 扩展曲线类型
  | 'CircularString' | 'CompoundCurve' | 'CurvePolygon' | 'MultiCurve' | 'MultiSurface'
  // 扩展 3D 类型
  | 'PointZ' | 'LineStringZ' | 'PolygonZ' | 'MultiPointZ' | 'MultiLineStringZ' | 'MultiPolygonZ'
  | 'PointM' | 'LineStringM' | 'PolygonM'  // M 维度（测量值）
  | 'PointZM' | 'LineStringZM' | 'PolygonZM'  // 4D
  // 扩展曲面类型
  | 'TIN' | 'PolyhedralSurface'
  | 'Unknown';

export interface GisLayerMetadata {
  name: string;
  geometryType: OgrGeometryType;
  coordinateDimension: 2 | 3 | 4;  // 新增，对应 XY/XYZ/XYZM
  hasZ: boolean;  // 新增
  hasM: boolean;  // 新增
  srid: number | null;
  extent?: [number, number, number, number];
  featureCount: number | null;
  fields: GisFieldMetadata[];
}
```

**packages/gis/src/inspect.ts**:
```typescript
// 解析 ogrinfo JSON 时提取维度信息
function parseOgrInfoGeometry(json: any): { type: OgrGeometryType; hasZ: boolean; hasM: boolean } {
  const rawType = json.geometryType || json.type;
  
  // OGR 返回的类型如 "3D Point", "Point ZM", "Line String Z"
  const hasZ = /\b(3D|Z|ZM)\b/i.test(rawType);
  const hasM = /\b(M|ZM)\b/i.test(rawType);
  
  const baseType = rawType
    .replace(/\b(3D|Z|M|ZM|Measured)\b/gi, '')
    .trim()
    .replace(/\s+/g, '');  // "Line String" → "LineString"
  
  return {
    type: normalizeGeometryType(baseType),
    hasZ,
    hasM
  };
}
```

**测试覆盖**:
```powershell
# 新增集成测试
pnpm run test:integration:postgis-curve-types
pnpm run test:integration:postgis-3d-import
pnpm run test:integration:gis-tin-polyhedral
```

**文档更新**:
- `docs/gis-format-matrix.md`：增加曲线类型与 3D/4D 支持说明
- `docs/gis-design.md`：说明 OGR 曲线类型的线性化（linearization）行为

---

## 其他 Navicat 功能分析

### 已有同等或更优实现
- ✅ **数据建模/ER 图**: DB Studio 专注查询与 GIS，不提供可视化建模（可考虑未来集成 Mermaid ERD）
- ✅ **数据同步**: 已实现跨数据库表传输（30 方向验证）
- ✅ **导入向导**: CLI 和桌面都有 GIS/表格导入（字段映射、类型转换）
- ✅ **代码片段**: 查询收藏功能覆盖（`upsertQueryFavorite`）
- ✅ **自动完成**: Monaco 补全已支持表/列/CTE

### 未来可考虑但优先级较低
- **数据生成器**: 生成测试数据（Navicat 有此功能，DB Studio 无）
- **计划任务**: 定时执行 SQL（桌面端有 `AutomationPanel`，但功能未明确）
- **结果集图表**: 查询结果可视化为柱状图/折线图（当前无，AI 可建议图表但不渲染）
- **表设计器**: 可视化 DDL 编辑（当前只读元数据，无表结构编辑）
- **用户/权限管理**: Navicat 支持，DB Studio 无（依赖数据库原生工具）

---

## 优先实现路线图

### Phase 1: 高优先级（1-2 周）
1. **查询执行统计** (1-2 天)
   - 修改所有适配器增加计时
   - 增加 `QueryExecutionMetrics` 类型
   - UI 增加统计栏组件

2. **几何字段渲染** (3-5 天)
   - WKB → GeoJSON 转换工具
   - 结果表格增加几何类型检测
   - Popover 小地图预览
   - 大地图查看弹窗

### Phase 2: 中优先级（2-3 周）
3. **结果集复制功能** (3-4 天)
   - 单元格选择状态
   - 右键菜单与格式化复制
   - INSERT 语句生成器

4. **GIS 曲线与 3D 类型** (5-7 天)
   - 类型定义扩展
   - `ogrinfo` 解析增强
   - 集成测试覆盖
   - 文档更新

### Phase 3: 低优先级（未来迭代）
5. 查询结果图表化
6. 数据生成器
7. 表结构可视化编辑

---

## 技术债务与风险

### 当前技术限制
1. **SQLite 同步 API**: 长查询阻塞主线程（Node 22.13 限制）
2. **Excel 大文件**: 10 万行/2048 列上限（内存限制）
3. **流式查询统计**: 某些 GIS 操作无法提前知道总行数
4. **Oracle AST 解析**: 无列级 Schema 验证（依赖保守关键字检查）

### 建议架构调整
1. **几何渲染性能**: 超过 5000 行时使用虚拟化渲染或聚合显示
2. **复制大数据集**: 使用 Web Worker 避免 UI 阻塞
3. **曲线类型支持**: 明确 OGR 线性化策略（`-nlt PROMOTE_TO_MULTI` 等）

---

## 总结

**DB Studio 相比 Navicat 的独特优势**:
- ✅ AI SQL 助手与 PostGIS 专用模式
- ✅ GIS 文件与数据库的无缝转换（OGR 子进程架构）
- ✅ MongoDB GeoJSON 与空间索引支持
- ✅ 开源可定制（Navicat 闭源商业）

**需要补齐的核心体验**:
- ❌ 查询结果中的 geometry 可视化
- ❌ 执行时间与行数统计
- ❌ 结果集复制与导出
- ❌ 曲线与 3D 几何类型的明确支持

**推荐优先级**: 统计信息 > 几何渲染 > 复制功能 > 曲线类型
