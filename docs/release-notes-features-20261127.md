# DB Studio 新功能发布说明 (2026-11-27)

本次更新实现了四个用户请求的功能增强，并修复了一个关键的 UI bug。

## 新功能

### 1. 查询执行时间和统计信息显示

**功能描述：** 在查询结果区域底部显示查询执行的详细统计信息。

**实现细节：**
- 新增 `QueryExecutionMetrics` 接口，包含：
  - `startTime`, `endTime`: 查询开始和结束时间
  - `duration`: 执行耗时（毫秒）
  - `rowCount`: 返回行数（SELECT 查询）
  - `affectedRows`: 影响行数（INSERT/UPDATE/DELETE）
  - `status`: 查询状态（success/error/cancelled）
  - `errorMessage`: 错误信息（失败时）

- 新增 `QueryMetricsBar` 组件显示：
  - ✓ 状态图标（成功/失败）
  - ⏱ 执行时长（自动格式化为 ms/s/min）
  - 📊 行数统计
  - 🕐 执行时间戳

- 数据库适配器增强：
  - PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, Oracle 全部支持
  - 自动计时，无需手动配置
  - 错误时也记录 metrics

**测试：** `tests/integration/query-execution-metrics-smoke.mjs`

**UI 位置：** SQL 查询页面，结果表格上方

---

### 2. 矢量字段（Geometry）渲染支持

**功能描述：** 参考 SQL Server 渲染前 5000 条的做法，查询结果中的 geometry 字段自动解析并渲染为可视化预览。

**实现细节：**
- 新增 `wkb-geojson.ts` 模块：
  - 完整的 WKB/EWKB 到 GeoJSON 转换器
  - 支持 OGC WKB 标准格式
  - 支持 PostGIS EWKB 扩展（SRID 标记）
  - 支持 ISO SQL/MM 维度编码（1000/2000/3000）
  - 支持 2D, 3D(Z), M, 4D(ZM) 坐标
  - 支持全部 7 种 OGC 几何类型：Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, GeometryCollection
  - 零依赖，纯 TypeScript 实现

- 新增 `GeometryCell` 组件：
  - 显示几何类型图标（📍 Point, 📏 LineString, ⬜ Polygon）
  - Popover 显示详细信息：类型、SRID、坐标维度
  - 惰性加载 WKB 解析器（代码分割）
  - 支持点击查看完整地图（预留接口）

- PostgreSQL 适配器增强：
  - 启发式几何列检测：检查列名是否匹配 `['geom','geometry','wkb_geometry','the_geom','shape']`
  - 采样第一个非空值验证是否为 WKB 格式
  - 在 `QueryResult.columnMetadata` 中标记几何列的类型、SRID、维度
  - 只在检测到几何列时附加 metadata（不影响普通查询性能）

**测试：** `packages/shared/src/wkb-geojson.test.ts`（46 个单元测试）

**UI 效果：**
- 普通数据列：正常显示文本/数字
- 几何列：显示图标 + 类型名称，悬停查看详情

**限制：**
- 当前仅 PostgreSQL/PostGIS 支持自动检测
- MySQL/MariaDB 的 GEOMETRY 类型需要后续添加检测逻辑
- SQL Server 的 GEOMETRY/GEOGRAPHY 类型需要适配（使用不同的二进制格式）

---

### 3. 查询结果复制功能

**功能描述：** 允许用户选择单元格、行、列或任意矩形区域，并以多种格式复制数据。

**实现细节：**
- 新增 `useTableSelection` Hook：
  - 单击选择单个单元格
  - Ctrl + 单击：多选单元格
  - Shift + 单击：范围选择（矩形区域）
  - 鼠标拖拽：连续选择
  - `selectAll()`: 全选
  - `selectRow(rowIndex)`: 选择整行
  - `selectColumn(colIndex)`: 选择整列
  - `getSelectedData()`: 提取选中数据为二维数组

- 新增 `result-formatters.ts` 模块：
  - `formatSelectionAsPlainText()`: 制表符分隔的纯文本
  - `formatSelectionWithHeaders()`: 带列名的文本
  - `formatSelectionAsCsv()`: RFC 4180 标准 CSV，正确处理引号和换行
  - `formatSelectionAsJson()`: JSON 对象数组，支持 pretty print
  - `formatSelectionAsInsert()`: SQL INSERT 语句，支持 schema 前缀
  - `calculateSelectionStats()`: 计算选区统计（行数、列数、估计大小）
  - `isSelectionTooLarge()`: 检查选区是否超出限制（防止内存溢出）

- 新增 `CopyContextMenu` 组件：
  - 右键菜单显示复制选项
  - 显示选区大小（N 行 × M 列）
  - 支持复制整行/整列（从右键位置）
  - 支持复制列名

- SQL Workbench 集成：
  - 表格单元格高亮选中状态
  - Ctrl+C 快捷键复制选区（默认纯文本格式）
  - 右键上下文菜单
  - 底部状态栏显示选区统计

**测试：** `packages/shared/src/result-formatters.test.ts`（24 个单元测试）

**支持的格式：**
1. **纯文本**：`值1\t值2\t值3`（默认，适合粘贴到 Excel/表格）
2. **带表头**：`列1\t列2\n值1\t值2`
3. **CSV**：`"值1","值2","值3"`（符合 RFC 4180，处理特殊字符）
4. **JSON**：`[{"列1": "值1", "列2": "值2"}]`
5. **SQL INSERT**：`INSERT INTO "schema"."table" ("列1", "列2") VALUES ('值1', '值2');`

**使用场景：**
- 复制部分查询结果到 Excel
- 生成 INSERT 语句用于数据迁移
- 导出 JSON 用于 API 测试
- 快速复制单行/单列数据

---

### 4. GIS 交换时矢量数据类型扩展

**功能描述：** 增强 GIS 图层信息，支持更详细的坐标维度和几何类型识别。

**实现细节：**
- `GisLayerInfo` 接口扩展：
  - `hasZ?: boolean`: 是否包含 Z 坐标（高程）
  - `hasM?: boolean`: 是否包含 M 坐标（测量值）
  - `coordinateDimension?: 2 | 3 | 4`: 坐标维度（XY/XYZ/XYZM）
  - `baseGeometryType?: string`: 基础几何类型（去除维度标记）

- 新增 `normalizeBaseGeometryType()` 函数：
  - 去除 OGR 维度标记：`Point Z` → `Point`, `Polygon 25D` → `Polygon`
  - 去除测量标记：`Measured LineString` → `LineString`
  - 规范化多词名称：`Line String` → `LineString`
  - 支持曲线类型：`CircularString`, `CompoundCurve`, `CurvePolygon`
  - 支持 3D 类型：`TIN`, `PolyhedralSurface`

- `normalizeLayer()` 函数增强：
  - 自动检测并填充 `hasZ`, `hasM`, `coordinateDimension`
  - 计算 `baseGeometryType`
  - 支持所有 OGR 维度编码变体

**测试：** `packages/gis/src/index.test.ts`（新增 15 个测试用例）

**文档更新：** `docs/gis-format-matrix.md`
- 添加坐标维度支持说明
- 添加各格式 Z/M 坐标保留表
- 添加曲线类型支持表

**应用场景：**
- GIS 导入前预览：显示数据是否包含高程信息
- 格式转换：了解源数据维度，选择合适的目标格式
- PostGIS 导入：自动选择正确的几何类型（POINT vs POINTZ）

---

## Bug 修复

### 修复图表弹窗无法关闭的问题

**问题描述：** 用户点击"图表"按钮打开 BI 图表弹窗后，无法通过 ESC 键或点击遮罩层关闭弹窗。

**根本原因：** Ant Design `Drawer` 组件的 `maskClosable` 和 `keyboard` 属性未显式设置，某些情况下默认值未生效。

**修复范围：** 为所有 Panel 组件的 Drawer 显式添加：
- `maskClosable={true}`: 允许点击遮罩层关闭
- `keyboard={true}`: 允许 ESC 键关闭

**修复的组件：**
- `BiPanel.tsx` - BI 图表 / 仪表盘
- `AutomationPanel.tsx` - 自动化调度
- `BackupPanel.tsx` - 备份 / 恢复
- `DataSyncPanel.tsx` - 数据同步
- `SchemaSyncPanel.tsx` - 结构同步
- `TableDesignerPanel.tsx` - 表设计器
- `LayerHealthPanel.tsx` - 图层体检
- `SpatialIndexPanel.tsx` - 空间索引诊断

**验证方式：**
1. 打开任意 Panel（如"图表"）
2. 按 ESC 键，应该关闭
3. 重新打开，点击弹窗外的灰色遮罩层，应该关闭
4. 点击右上角的 ✕ 按钮，应该关闭

---

## 技术亮点

### 零依赖的 WKB 解析器

`wkb-geojson.ts` 是一个完全自包含的 WKB/EWKB 解析器：
- **零外部依赖**：不依赖 `wkx`, `wellknown` 等第三方库
- **完整支持**：OGC WKB + PostGIS EWKB + ISO SQL/MM
- **高性能**：直接操作 Buffer，无中间格式转换
- **类型安全**：完整 TypeScript 类型定义
- **递归解析**：正确处理嵌套的 GeometryCollection
- **错误处理**：解析失败返回详细错误信息，不抛异常

### 灵活的选区管理

`useTableSelection` Hook 提供了电子表格级别的选区功能：
- **非矩形选区支持**：用户可以 Ctrl+点击任意单元格
- **自动边界计算**：`getSelectedData()` 自动找到最小包围矩形
- **空洞填充**：非矩形选区的空白单元格自动填充 `null`
- **性能优化**：使用 Set<string> 存储选区（"row,col" 格式）
- **React 友好**：所有状态变更触发重渲染

### 安全的数据格式化

`result-formatters.ts` 对用户数据进行了严格的转义和验证：
- **CSV 转义**：正确处理引号、换行、逗号（RFC 4180 标准）
- **SQL 注入防护**：INSERT 语句使用单引号转义，标识符使用双引号
- **NULL 处理**：统一将 `null`/`undefined` 转换为 `NULL`（SQL）或空字符串（CSV）
- **大小检查**：`isSelectionTooLarge()` 防止内存溢出（默认限制 1M 单元格 / 100MB）

---

## 兼容性说明

### 数据库引擎支持

| 功能 | PostgreSQL | MySQL | MariaDB | SQLite | SQL Server | Oracle | MongoDB |
|------|------------|-------|---------|--------|------------|--------|---------|
| 查询执行统计 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N/A |
| Geometry 渲染 | ✓ (PostGIS) | 未实现 | 未实现 | 未实现 | 未实现 | N/A | N/A |
| 结果复制 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N/A |

**说明：**
- **Geometry 渲染**：当前仅 PostgreSQL + PostGIS 自动检测。其他数据库需要后续适配：
  - MySQL/MariaDB: 需要检测 `GEOMETRY`, `POINT`, `LINESTRING` 等类型列
  - SQL Server: 需要适配 CLR 二进制格式（非标准 WKB）
  - SQLite: 需要检测 SpatiaLite 的 BLOB 格式
- **MongoDB**: 文档数据库不适用 SQL 查询结果表格，使用独立的文档视图

### 浏览器兼容性

所有新功能使用标准 Web API，兼容：
- Chrome 90+
- Edge 90+
- Firefox 88+

**使用的 API：**
- `navigator.clipboard.writeText()` - 复制到剪贴板
- `Popover` (Ant Design) - 几何信息提示
- `Dropdown` (Ant Design v6) - 右键菜单
- CSS `user-select: none` - 防止文本选择冲突

---

## 已知限制

1. **Geometry 渲染**：
   - 大型 Geometry（>1MB WKB）可能导致界面卡顿
   - 不支持预览完整地图（`onOpenFullMap` 预留但未实现）
   - 多几何类型（MultiPoint 等）只显示类型，不渲染预览图

2. **结果复制**：
   - 大选区（>100K 单元格）可能导致浏览器无响应
   - JSON 格式不支持 BigInt（转换为字符串）
   - INSERT 语句不支持 UPSERT / ON CONFLICT

3. **GIS 维度检测**：
   - 依赖 OGR 的几何类型字符串，非标准命名可能识别失败
   - M 坐标（测量值）在某些格式中会丢失（如 Shapefile）

---

## 测试覆盖

### 单元测试
- `packages/shared/src/wkb-geojson.test.ts` - 46 tests ✓
- `packages/shared/src/result-formatters.test.ts` - 24 tests ✓
- `packages/gis/src/index.test.ts` - 15 tests (new) ✓

### 集成测试
- `tests/integration/query-execution-metrics-smoke.mjs` - PostgreSQL, MySQL, SQLite ✓

### 手动测试检查清单
- [ ] PostgreSQL: 执行 SELECT 查询，查看 QueryMetricsBar
- [ ] PostGIS: 查询 geometry 列，查看 GeometryCell 渲染
- [ ] 选择单元格，右键查看复制选项
- [ ] Ctrl+C 复制选区，粘贴到 Excel
- [ ] CSV 格式复制，包含特殊字符（引号、换行、逗号）
- [ ] JSON 格式复制，验证 JSON 合法性
- [ ] INSERT 格式复制，在 SQL 编辑器中执行验证
- [ ] 打开"图表"弹窗，按 ESC 关闭
- [ ] 打开"图表"弹窗，点击遮罩层关闭
- [ ] GIS 导入预览，查看 hasZ/hasM 标记

---

## 升级说明

### 从 0.1.0 升级

本次更新为纯功能增强，无破坏性变更：
- 数据库连接配置无需更改
- 现有查询历史完全兼容
- GIS 文件格式支持保持不变

### 数据库驱动版本

无变更，继续使用：
- `pg@8.13.1` - PostgreSQL
- `mysql2@3.11.5` - MySQL/MariaDB
- `node:sqlite` (Node.js 内置) - SQLite
- `mssql@11.0.1` - SQL Server
- `oracledb@6.6.0` - Oracle
- `mongodb@6.11.0` - MongoDB

---

## 未来计划

### 短期（下个版本）
- [ ] MySQL/MariaDB Geometry 列检测和渲染
- [ ] SQL Server GEOMETRY/GEOGRAPHY 支持（需要适配 CLR 格式）
- [ ] 完整地图预览（点击 GeometryCell 打开交互式地图）
- [ ] 复制选项保存为用户偏好（记住上次选择的格式）

### 中期
- [ ] 查询结果导出为文件（CSV/JSON/Excel）
- [ ] 结果表格内编辑（UPDATE 操作）
- [ ] 自定义列格式化（日期格式、数字精度）
- [ ] 结果集分页（大查询只加载可见行）

### 长期
- [ ] 查询结果可视化（图表/热力图）
- [ ] 空间查询构建器（可视化构建 ST_* 函数）
- [ ] 结果集对比（diff 两次查询结果）

---

## 致谢

感谢用户提出的功能建议，特别是：
1. 参考 SQL Server 渲染矢量字段的建议
2. 查询时间显示的需求
3. 结果复制功能的详细描述
4. GIS 数据类型扩展的反馈

这些建议极大地提升了 DB Studio 的可用性和专业性。

---

**构建版本：** `release-static-gdal-geos-msi-features-20261127`  
**发布日期：** 2026-11-27  
**构建工具：** electron-builder 25.1.8  
**目标平台：** Windows x64  
**安装包：** `DB Studio 0.1.0.msi` (约 191 MB)
