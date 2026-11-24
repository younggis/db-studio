# DB Studio

DB Studio 是面向数据库查询和 GIS 矢量数据 ETL 的 Windows 桌面工具与独立 CLI。桌面端和 CLI 共用 TypeScript Core；最终 Windows 安装包自带 GDAL/OGR 与 PROJ，普通桌面使用不需要 Docker、Node.js 或手动安装 GIS 依赖。

## 功能

- 连接 PostgreSQL、MySQL、MariaDB、SQLite、SQL Server、Oracle 和 MongoDB；对象浏览器可按 Schema 搜索表/视图，结果只生成受行数限制的 SQL 草稿。关系表支持按主键编辑和事务化批量保存；无主键表、视图和复杂字段保持只读。
- 使用 CSV、JSON 和 XLSX 导入、导出关系型表数据；MongoDB 支持 JSON/EJSON、GeoJSON FeatureCollection 转换、2dsphere 索引和空间查询。
- 读取、检查和转换 Shapefile、GeoJSON、KML、MapInfo TAB 与 GeoPackage。
- 在 GIS 文件与 PostgreSQL/PostGIS 之间双向导入和导出，支持图层选择、字段重命名/类型转换、CRS 设置、进度、取消和结果报告。
- SQL 编辑器按当前数据库方言格式化并提供智能补全；查询历史和收藏在本机加密保存，载入收藏只会替换编辑器内容，不会执行 SQL。
- 桌面工作区可拖动调整连接栏、SQL 编辑器与结果区大小，并只保存布局尺寸偏好。
- 连接凭据不会写入 CLI 配置文件。命名连接只保存端点和环境变量名，运行命令时再从进程环境读取密码或 MongoDB URI。

## Windows 桌面版

运行 [DB Studio Setup 0.1.0.exe](apps/desktop/release-static-gdal-liblzma-5.8.4/DB%20Studio%20Setup%200.1.0.exe) 并按安装向导操作。桌面安装包包含 GIS 运行时；连接数据库时仍需提供可访问的数据库服务。数据库测试容器只供开发集成测试使用。

当前安装包尚未代码签名，Windows 可能显示下载或发布者提示。2026-11-06 重建的静态 GDAL NSIS 包已包含查询历史、SQL 格式化、数据库对象搜索、表格事务编辑与 AI IPC 生命周期修复，自动化测试和打包通过；这次未完成安装版 GUI 交互验收，Windows 窗口捕获返回 `GetCursorPos failed: 拒绝访问 (0x80070005)`。干净 Windows 验收尚未完成。GDAL 传递依赖许可证与完整源码义务尚未解决，外部分发前请先完成审查。

## CLI

CLI 不启动 Electron。开发环境中可用 pnpm 直接运行：

```powershell
pnpm install
pnpm --filter @db-studio/cli run cli -- --help
pnpm --filter @db-studio/cli run cli -- doctor
```

添加命名连接时，配置中仅记录密码环境变量的名称；先在当前 PowerShell 会话或密钥管理器中提供对应变量：

```powershell
pnpm --filter @db-studio/cli run cli -- connections add `
  --name local-pg --engine postgres --host 127.0.0.1 --port 5432 `
  --database demo --user app --password-env DBSTUDIO_LOCAL_PG_PASSWORD

pnpm --filter @db-studio/cli run cli -- connections test --connection local-pg
pnpm --filter @db-studio/cli run cli -- query run --connection local-pg `
  --sql "SELECT current_database()" --format json
```

常见命令：

```powershell
# 导出表格数据为 Excel
pnpm --filter @db-studio/cli run cli -- data export --connection local-pg `
  --table roads --schema public --output .\roads.xlsx --format xlsx

# 将 CSV 追加到现有表
pnpm --filter @db-studio/cli run cli -- data import --connection local-pg `
  --table roads --schema public --input .\roads.csv --format csv

# 查询 MongoDB 文档
pnpm --filter @db-studio/cli run cli -- mongo find --connection local-mongo `
  --collection places --filter '{"active":true}' --limit 100

# 解释手动从数据库客户端复制的执行计划；本命令不会运行 EXPLAIN/ANALYZE
pnpm --filter @db-studio/cli run cli -- ai sql explain-plan `
  --connection local-pg --file .\query.sql --plan-file .\query-plan.txt

# 导入 GeoJSON FeatureCollection，创建空间索引并按 GeoJSON 区域查询
pnpm --filter @db-studio/cli run cli -- mongo geo-import --connection local-mongo `
  --collection places --file .\places.geojson
pnpm --filter @db-studio/cli run cli -- mongo create-2dsphere-index --connection local-mongo `
  --collection places --field geometry
pnpm --filter @db-studio/cli run cli -- mongo geo-find --connection local-mongo `
  --collection places --field geometry --relation within `
  --geometry '{"type":"Polygon","coordinates":[[[121,31],[122,31],[122,32],[121,32],[121,31]]]}'

# 检查矢量文件并选定图层导入 PostGIS
pnpm --filter @db-studio/cli run cli -- gis inspect --file .\roads.gpkg
pnpm --filter @db-studio/cli run cli -- gis import --connection local-pg `
  --file .\roads.gpkg --layer roads --target public.roads `
  --field-map 名称=name --field-type area=real

# 导出 PostGIS 表
pnpm --filter @db-studio/cli run cli -- gis export --connection local-pg `
  --table public.roads --output .\roads.geojson --target-crs EPSG:4326
```

从源码运行 CLI 的 GIS 命令时，确保 GDAL/OGR 位于 `PATH`，或指定本项目随桌面资源提供的运行时：

```powershell
$env:DBSTUDIO_GDAL_BIN = (Resolve-Path 'apps/desktop/resources/gdal/bin').Path
pnpm --filter @db-studio/cli run cli -- gis inspect --file .\roads.gpkg
```

CLI 完整命令和数据库环境变量见 [CLI 设计说明](docs/cli-design.md)。GIS 数据库功能范围见 [GIS 能力矩阵](docs/gis-database-capability-matrix.md)。

## 本地开发与测试

```powershell
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm --filter @db-studio/desktop run dev
```

桌面开发和集成测试可使用 Docker Compose 的独立数据库 profiles。先复制 `docker/.env.example` 为 `docker/.env`，设置本机测试密码，再按需启动服务；具体端口和安全说明见 [数据库容器说明](docker/README.md)。桌面软件运行本身不依赖这些容器。

## 已知限制

- GDAL/PROJ 的可选 datum-shift 网格未随包提供；需要这些网格的坐标转换应为 PROJ 配置相应数据目录。
- Shapefile、MapInfo TAB、KML 和 GeoJSON 存在字段、类型、坐标精度或 CRS 限制；操作报告会列出已知限制。
- GIS 运行时许可清单尚未覆盖全部 51 个打包 DLL；详见 [GDAL 运行时记录](docs/gdal-runtime.md)。

## 文档

- [功能筛选](docs/feature-evaluation.md)
- [架构](docs/architecture.md)
- [数据库适配器与能力](docs/database-adapters.md)、[数据库能力矩阵](docs/database-capability-matrix.md)
- [GIS 设计](docs/gis-design.md)、[GIS 格式矩阵](docs/gis-format-matrix.md)
- [GDAL 运行时](docs/gdal-runtime.md)
- [QGIS 安装研究](docs/qgis-installation-analysis.md)、[矢量格式分析](docs/qgis-vector-format-analysis.md)、[编码分析](docs/qgis-encoding-analysis.md)、[CRS 分析](docs/qgis-crs-analysis.md)、[Geometry 分析](docs/qgis-geometry-analysis.md)、[GDAL 架构](docs/qgis-gdal-architecture.md)
- [GIS 实现差异](docs/gis-implementation-gaps.md)、[GIS 兼容性测试报告](docs/gis-compatibility-test-report.md)
- [AI SQL 助手](docs/ai-sql-assistant.md)、[AI 研究与架构](docs/ai-sql-research.md)、[Provider 设计](docs/ai-provider-design.md)、[模型配置](docs/ai-model-config.md)、[Schema 上下文](docs/ai-schema-context.md)、[Embedding 与 RAG](docs/ai-embedding-rag.md)、[安全设计](docs/ai-sql-security.md)、[实现计划](docs/ai-sql-implementation-plan.md)、[测试报告](docs/ai-sql-test-report.md)
- [进度](docs/progress.md)、[测试报告](docs/test-report.md)
