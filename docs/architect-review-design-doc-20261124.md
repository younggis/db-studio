# DB Studio 架构与设计说明书（架构师评审版）

> 版本：v0.1.0 Preview · 文档日期：2026-11-24
> 用途：供架构师评审现有设计、功能覆盖、技术债与后续优化方向。
> 说明：本文事实来源于 `README.md`、`docs/architecture.md`、`docs/feature-evaluation.md`、`docs/progress.md`、各能力矩阵与专项报告，以及当前工作区实际产物核查。标注「⚠️」的为需要架构师重点决策的风险项。

---

## 1. 产品定位与范围

### 1.1 一句话定位

DB Studio 是面向**数据库查询与 GIS 矢量数据 ETL** 的 Windows 桌面工具 + 独立 CLI；桌面端与 CLI 共用 TypeScript Core，安装包自带 GDAL/OGR/PROJ 运行时，普通桌面使用不依赖 Docker、Node.js 或手工安装 GIS 依赖。

### 1.2 明确的范围边界（来自 `docs/feature-evaluation.md`）

| 层级 | 范围 | 决策 |
|---|---|---|
| P0 | 连接管理、对象浏览、SQL 编辑执行、关系型/MongoDB 工作流 | 核心日常能力 |
| P0 | CSV/Excel/JSON 导入导出 | 与 GIS 共用传输服务 |
| P0 | SHP/GeoJSON/KML/TAB/GPKG 五种矢量格式 | 复用 GDAL/OGR，不自研格式解析 |
| P0 | PostGIS 双向交换（参考实现）、Electron+React 桌面 + 独立 CLI + 共享 Core | 双入口必须 |
| P1 | 表数据编辑、SQL 补全、查询历史、SSH、对象搜索、轻量地图预览、范围导入 | 已实现大部分 |
| P2 | ER 模型编辑器、可视化 SQL 构建、schema/data 同步、定时备份、BI 仪表盘、监控与服务器管理 | **明确不做**，不建占位页面 |
| 不做 | 完整 QGIS 桌面、任意 provider 对齐、WMS/WFS、3D GIS、QGIS Processing 全目录 | QGIS/GDAL 只作为参考与运行时依据 |

**架构含义**：产品是有明确边界的"数据库客户端 + GIS 管道"，不是 Navicat/QGIS 的复刻。评审优化建议时应守住这条边界，避免范围蔓延。

---

## 2. 架构总览

### 2.1 Workspace 与分层

```text
pnpm workspace (pnpm 10.33, Node >=22.13, TypeScript 7, Vitest 5)
├─ apps/desktop   Electron + React + Ant Design（渲染进程 / 主进程 / preload）
│                 └─ Electron IPC ──┐
├─ apps/cli       Commander CLI      │
│                 └─ 直接调用 ────────┤
├─ packages/core  与 Electron 无关的编排层（共享业务逻辑）
├─ packages/database  数据库适配器（pg / mysql2 / better-sqlite3 / mssql / oracledb / mongodb / ssh2）
├─ packages/gis    GDAL/OGR 子进程边界、元数据归一化、矢量转换/传输
├─ packages/ai     Provider、Schema 索引与 RAG、SQL 生成/修复/校验
└─ packages/shared 公共类型、查询历史、GeoPackage/SpatiaLite BLOB 编解码、电子表格工具
```

设计原则（来自 `docs/architecture.md`）：

- 业务操作归 packages，入口只负责调用；Core 不依赖 Electron。
- 适配器在边界构造、在 `finally` 关闭；SQL 使用绑定参数。
- GIS 格式驱动与数据库驱动分离；PostGIS 传输走 OGR 的 PostgreSQL driver。
- CRS 变换交由 GDAL/PROJ；缺源 CRS 必须先补齐再变换。
- GIS 转换/传输在 OGR 子进程执行，要素数据不在 Node 进程堆积；Core 接受 `AbortSignal` + 进度回调；CLI 把 Ctrl+C 接到取消、进度写 stderr；Electron 经 IPC 转发并把取消限定在发起的渲染进程。
- 文件导出先暂存到目标旁、OGR 成功后原子移动；取消/失败清理暂存目录；PostGIS 导入使用数据集事务，取消可回滚。

### 2.2 桌面端运行时拓扑

- 主进程：连接配置（Windows DPAPI 加密）、AI 配置、Schema 索引、GIS 任务生命周期、IPC 路由与取消。
- preload：`contextBridge` 暴露 `window.dbStudio` API；生产配置 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`、`onlyLoadAppFromAsar=true`、ASAR 完整性校验开启；Inspector fuse 关闭。
- 渲染进程：React 单页 —— 侧栏（连接 + 对象树）+ 工作区（SQL / Mongo / GIS 三个 page）+ AI 助手抽屉 + 各类 Modal/Drawer。
- 打包：electron-builder → MSI / NSIS，自带静态 GDAL 3.12.2 / PROJ 9.7.1 / GEOS 3.14.1，最终产物约 199 MB。

### 2.3 数据与安全边界

- 连接凭据：桌面端 DPAPI 加密落盘（`connections.enc`）；查询历史/收藏（`query-history.enc`）与 AI 模型配置同样加密；CLI **不保存密码**，配置只记录密码环境变量名，运行时从进程环境读取。
- AI 出站：只发送合成/选中 Schema 元数据与用户意图；SQL 草稿必须经过只读校验（禁止 DML/DDL 等）后才进入编辑器，载入收藏只替换内容不执行。
- GIS 诊断脱敏：失败日志省略要素字段值与 WKB，长行截断；错误原因保留。
- 数据库权限边界：各引擎只读角色冒烟测试覆盖（Postgres/MySQL 家族/SQL Server/Oracle/Mongo/SQLite）。

---

## 3. 功能清单（按模块）

### 3.1 连接管理

- 七引擎连接：PostgreSQL（PostGIS）、MySQL、MariaDB、SQLite/SpatiaLite/GeoPackage、SQL Server、Oracle、MongoDB。
- 连接测试、增删改、按引擎默认端口；SSH 隧道。
- 桌面：`connections:save/remove` 串行事务队列；删除前先清理 AI Schema 索引并关闭 SSH 隧道，失败不提交；旧格式密文重加密在队列内重读最新文件，避免并发覆盖。
- CLI：`connections add/update/remove/list/test`，配置仅存端点与环境变量名。

### 3.2 对象浏览器与导航

- 按连接 → 数据库 → Schema → 表/视图的树形浏览；按方言生成受限行数的 SQL 草稿（不取全表）。
- 最近迭代（编译产物层）：Navicat 风格 `Tables` 分组与子层级（Fields/Indexes/Foreign Keys/Uniques/Checks/Rules/Triggers 为视觉占位）、紧凑行高 20px、类型化图标、浅蓝选中行。
- 右键菜单：连接节点（刷新、新建查询、搜索对象、测试连接、删除）、表节点（查询前 100 条、编辑表数据、查看字段、导入/导出 CSV/JSON/Excel、传输到其他连接、刷新）；连接卡片右键（测试连接 / 编辑连接… / 删除连接…）。
- 对象搜索弹窗；表节点「查询前 100 条」按方言生成 `TOP(100)` / `FETCH FIRST 100 ROWS ONLY` / `LIMIT 100` 并立即执行、写入历史。

### 3.3 SQL 编辑器与结果

- Monaco 编辑器，SQL 方言格式化（Alt+Shift+F）、SQL 补全（表/列/CTE，基于 Schema 元数据与作用域解析）、Ctrl+Enter 执行。
- 查询历史与收藏（本机加密）；收藏只替换编辑器内容不执行。
- 结果表格：大数据量虚拟滚动、分页、导出 CSV/JSON、行数与时间统计。
- 失败查询展示错误码/消息 + AI 修复入口。
- 可拖动 Splitter 调整连接栏宽度与编辑器/结果区高度，仅保存尺寸偏好。

### 3.4 表数据编辑与传输

- 按主键编辑、事务化批量保存；无主键表/视图/复杂字段只读。
- 跨库表传输：六引擎 15 组组合、32 方向真实集成（Unicode、NULL、精度数值、二进制、布尔、日期、时区时间戳、38 位整数）。
- JSON `null` 与 SQL `NULL` 区分（MariaDB 通过 `CHECK_CONSTRAINTS` 识别 JSON 别名）。
- 大对象流式传输：Oracle ↔ PostgreSQL 多 MiB CLOB/NCLOB/BLOB；SQL Server 源端按主键分块拉取 MAX/旧式 LOB（文本 64 KiB 单元、二进制 256 KiB，跨块代理项合并）；失败回滚。
- 空间行传输：PostGIS ↔ SQL Server（geometry/geography 分离）、PostGIS ↔ MySQL/MariaDB geometry（仅 XY）、PostGIS ↔ Oracle SDO_GEOMETRY（XY 与 XYZ/XYM/XYZM）、SQLite/GeoPackage/SpatiaLite 现有表几何 BLOB（原生 SpatiaLite BLOB 编解码）；geometry↔geography 转换需显式 opt-in。

### 3.5 GIS 数据交换（核心差异化能力）

- 五种格式：Shapefile、GeoJSON（RFC 7946）、KML、MapInfo TAB、GeoPackage；`inspect` / `preview` / `convert` / `validate` / `import` / `export`。
- 目标数据库：SQLite/SpatiaLite、GeoPackage、PostGIS、MySQL/MariaDB、SQL Server、Oracle SDO_GEOMETRY。
- 图层选择与 `/vsizip/` 归档内成员直接访问（含 ZIP 成员名编码 `zipFilenameEncoding`）。
- 编码处理：BOM 识别 UTF-8/UTF-16LE/BE；无 BOM 候选置信度 ≥90% 且领先 ≥15pp + 全文件严格解码才提示；SHP `.cpg` 优先于 LDID；CP936/CP950/GB18030 显式覆盖；UTF-8 尾部截断修复；不修改源文件。
- CRS：显式 PROJ pipeline（`-ct`，需同时指定目标 CRS）、目标 CRS 校验、未知源 CRS 拒绝默认 4326、可选 datum grid 未提供。
- 几何：MakeValid（GDAL/OGR）、逐图层 `validate` 报告 NULL/Empty/错误位置与有上限样本；Z/M 维度扫描与超集补位；内环/坍塌环与 QGIS 3.44.8 对照。
- 空间索引 opt-in：Oracle（create/append/overwrite，元数据 5% 外扩 + 0.05 容差）；MySQL/MariaDB（create/overwrite，NOT NULL + SRID CHECK）；SQL Server（create/overwrite，聚集主键 + geometry 边界框/geography 自动网格）；SpatiaLite RTree / GeoPackage RTree 扩展。
- 范围导入/导出：桌面 SVG 预览 + 框选（源 CRS 轴对齐矩形 → OGR `-spat`）；导出 bbox 五库支持（PostGIS 直接过滤，其余四库暂存后 GDAL 过滤，不减少数据库扫描）。
- 进度/取消/报告：分批导入、operation report（成功/失败要素数、警告、限制）、取消回滚。

### 3.6 MongoDB 工作流

- Collection 浏览、`find`/`aggregate`、JSON/EJSON 查看、索引管理。
- GeoJSON FeatureCollection 导入、2dsphere 索引、`geo-find` 空间关系查询、geo-export。
- Mongo 文档页（桌面）与 CLI 命令族。

### 3.7 AI SQL 助手

- Provider：DashScope Chat / Embedding / Rerank（DPAPI 加密配置，模型设置面板可录入/测试）；CLI `ai models list/test`。
- 能力：`generate`（SQL 草稿）、`repair`（执行后修复）、`explain` / `explain-plan`（解释手动粘贴的执行计划，**不执行 EXPLAIN/ANALYZE**）、`gis`（PostGIS 空间 SQL）。
- Schema RAG：完整列和外键元数据、v5 索引格式、宽表分块（1,500 列 → 9 分片）、1,024 维 Embedding、多 Schema 检索 + Rerank、结构指纹防 stale。
- 安全：只读 SQL 校验、标识符/Schema 校验、系统目录白名单（避免 `information_schema` 误报）、PostGIS 测量单位澄清（角度/未知单位的距离/面积/缓冲请求要求确认）、密钥不出现在响应与证据、请求取消 IPC。
- GUI：SQL 页与 GIS/Mongo 页均有 AI 入口；面板内可切换连接；选中表/候选表、检索引用展示；草稿仅预览，不自动插入或执行。

### 3.8 CLI 命令族

`doctor` / `connections` / `databases` / `schemas` / `tables`（list, columns, transfer）/ `query run` / `data import|export` / `mongo`（collections, find, aggregate, indexes, create-2dsphere-index, geo-find, geo-import, geo-export, import, export）/ `gis`（inspect, preview, convert, validate, import, export）/ `ai`（models, sql generate|gis|repair|explain|explain-plan）。

---

## 4. 当前交付与验证状态

| 项目 | 状态 |
|---|---|
| 单元测试 | `pnpm test`：442 通过 / 6 项既有 CLI 条件跳过 |
| 类型检查 / 构建 | `pnpm typecheck`、`pnpm build` 通过 |
| 集成测试 | 77 套中 76 通过；唯一失败 `test:integration:mvt-postgis` 因本地 `.pbf` 夹具已从 `F:\GeoData`/`F:\temp` 删除（数据缺失，非功能缺陷） |
| 集成脚本数量 | 80 个 `.mjs` 脚本（`tests/integration`） |
| 安装包 | MSI 约 199 MB，未代码签名；ASAR 完整性校验 + 仅从 ASAR 加载 + Inspector fuse 关闭 |
| 最新桌面产物 | `release-static-gdal-geos-msi-connmenu-20261124`（图标对齐 + 连接右键菜单，已安装，快捷方式已更新） |
| 用户数据 | 7 个演示连接、查询历史/收藏、AI 配置在 `%APPDATA%\@db-studio\desktop`，未受影响 |

---

## 5. ⚠️ 重大风险与已知问题（架构师需优先决策）

### 5.1 源码缺失事故（P0，最高优先级）

- `apps/desktop/src` 与 `apps/desktop/electron` 两个源码目录在会话中丢失；工作区无 Git 仓库、无备份、无卷影副本。
- 其余源码（`packages/*/src`、`apps/cli/src`）与全部编译产物完好。
- **影响**：最近的 UI 改动（白色主题、紧凑布局、Navicat 风格对象树、图标对齐、连接右键菜单）全部直接改在 `apps/desktop/dist/renderer/assets` 编译产物上；任何 `pnpm build` 都会覆盖这些补丁。
- **决策点**：(a) 从备份恢复源码后把补丁回写到 TSX/CSS；(b) 若无备份，用 `dist/electron/main.js`（未压缩 tsc 输出）与会话记录近似还原。无论哪种，**必须立即建立 Git 版本控制与定期备份**。

### 5.2 编译产物补丁的脆弱性（P0）

- CSS 补丁：`index-DQQUtUzE.css` 末尾追加多段覆盖规则（白色主题、紧凑树、图标对齐、右键菜单样式）。
- JS 补丁：`DatabaseObjectTree-BUT6wZ0A.js` 注入 `navicatTransform`（Tables 分组 + 7 个只读子节点）；`App-D3avBeWb.js` 末尾追加 `connContextMenuSafe` IIFE（全局 contextmenu 监听 + 自建菜单 DOM，复用隐藏的 `.connection-tools button` 点击）。
- 曾因直接改写压缩 JSX 的 `Dropdown` 包裹导致 `SyntaxError: Unexpected token '}'`，页面白屏，后从 asar 恢复。
- **决策点**：源码恢复后必须全部改为源码实现；在此之前，任何 UI 改动都应先在 CDP 验证 + `node --check` + asar 内容断言，再重建 MSI。

### 5.3 验收覆盖缺口

| 缺口 | 说明 |
|---|---|
| 干净 Windows 验收 | 多次尝试受 UAC / `GetCursorPos failed (0x80070005)` / 沙箱权限阻断；主机安装版验收不等同干净系统 |
| 安装版 GUI 点击 | 大量 GIS/SQL/AI/索引流程仅源码侧或 CDP 验收，安装版点击未系统覆盖 |
| 自动化测试 | UI 交互主要靠手工 CDP 脚本，缺少可回归的 E2E 套件 |
| MVT 夹具 | 本地 `.pbf` 全部缺失，集成脚本失败；合成夹具只覆盖能力，不覆盖真实数据 |
| 未知编码源 | 33 个数据集编码 unknown、32 个图层要求显式编码、3 个 Neutral TAB 因 GDAL 块读取错误无法导入 |

### 5.4 发行与合规

- 未代码签名，Windows 可能提示发布者未知。
- GDAL/PROJ 传递依赖许可证审计未完成：28 个 SPDX 文档为 NOASSERTION、26 DLL 依赖未捆绑 MSVC CRT、Poppler GPLv2 / MySQL Connector/C GPLv2+FOSS exception、完整对应源码 offer 与 CRT/Build Tools 条款待审；外部分发前必须关闭。
- NSIS 安装包偶发 Windows "无效的系统 DLL 重定位"；MSI 方案目前可用。

### 5.5 功能边界与性能

- MySQL/MariaDB 空间行传输仅 XY；空间主键不支持；geometry↔geography 转换限定 PostGIS↔SQL Server 且需 opt-in。
- 导出 bbox 对非 PostGIS 四库不减少数据库扫描/传输（先暂存全表再由 GDAL 过滤）。
- `scanFeatureDimensions` 仍读取完整 ogr2ogr stdout；大要素（25 万顶点/7.4 MB GeoJSON 单面）扫描约 1.5–3.2 秒；完整 GIS 导入峰值内存、并发、超大数据集性能未审计。
- SQLite LOB 目标仍物化（`node:sqlite` 无增量 BLOB 写接口）。
- 安装版无 Inspector fuse，GUI 验收依赖同源构建的 CDP 副本。

---

## 6. 优化建议清单（按优先级）

> 每条给出「问题 → 建议 → 验收标准」，便于架构师排期。

### P0 — 必须先做

| # | 问题 | 建议 | 验收标准 |
|---|---|---|---|
| 1 | 源码丢失、无版本控制 | 恢复/重建 `apps/desktop/src`、`electron`；初始化 Git（含 `.gitignore`、LFS 策略），每日构建产物与源码双备份 | 克隆即可 `pnpm install && pnpm build`；两个源码目录纳入版本控制 |
| 2 | UI 改动只在编译产物 | 把 4 项 UI 补丁（白色主题、紧凑树/Navicat 分组、图标对齐、连接右键菜单）回写源码，删除所有 dist 注入 | 全新 `pnpm build` 后 MSI 包含全部 UI 效果，dist 无手工补丁标记 |
| 3 | GUI 无自动化回归 | 基于现有 CDP 脚本建立 Playwright/Electron E2E 套件：右键菜单、连接增删改、SQL 预览、GIS 导入导出、AI 草稿 | CI 每次提交运行；覆盖 5 个核心用户旅程 |
| 4 | 补丁引入过一次白屏 | 建立"产物补丁 SOP"：修改前备份 asar、`node --check`、asar 内容断言、CDP 冒烟、再构建安装 | SOP 文档化；未来补丁零白屏 |

### P1 — 架构与质量

| # | 问题 | 建议 | 验收标准 |
|---|---|---|---|
| 5 | 适配器行为差异散落 | 提炼统一 `DatabaseAdapter` 契约测试矩阵（分页、LOB、空间类型、错误分类），新引擎接入必须过矩阵 | 七引擎共享一套契约测试，差异显式登记在能力矩阵 |
| 6 | Core/GIS 任务生命周期 | 统一进度/取消/回滚模型：把 GIS 子进程、表传输、AI 请求纳入同一 `OperationHandle`（ID、进度、取消、作用域校验） | 任意任务可取消且无残留；连接切换自动取消失效任务 |
| 7 | 大 GIS 数据性能 | 对 `scanFeatureDimensions` 改为流式提前终止；补充 100 万要素/1 GB 级基准与峰值内存监控；评估 worker 化 | 大文件扫描时间/内存有基线数据，超阈值告警 |
| 8 | 空间索引缺口 | 关闭 MySQL/MariaDB/SQL Server 的 append 索引、SQLite 现有表索引；统一"索引创建前校验 + 换表后验证 + 失败回滚"模板 | 三库 create/append/overwrite 全组合真实集成通过 |
| 9 | 编码未知源 | 在 UI 中把"候选编码"升级为一等流程：置信度、样本预览、用户确认、结果语义复核、决策留痕 | 32 个待决图层全部有用户确认记录或明确跳过原因 |
| 10 | AI Provider 单一 | 抽象 Provider 接口（Chat/Embedding/Rerank），支持至少一种备选；模型设置面板增加连通性诊断与费用提示 | 切换 Provider 不改业务代码；诊断可定位鉴权/端点/区域错误 |
| 11 | SQL 校验覆盖面 | 扩展只读校验到 CTE/系统目录/空间函数组合场景；把"澄清而非拒绝"的策略系统化 | 误报率基线化；已知误报全部单测覆盖 |
| 12 | 结果集体验 | 大结果虚拟滚动 + 流式加载 UI、列宽持久化、筛选/排序、多结果 Tab；复制为 INSERT/CSV | 10 万行结果打开 <2s，交互不卡 UI 线程 |

### P2 — 体验与发行

| # | 问题 | 建议 | 验收标准 |
|---|---|---|---|
| 13 | 桌面交互细节 | 全局键盘快捷键（连接切换、执行、格式化、面板开关）、树节点就地重命名/复制、右键菜单覆盖所有对象类型、可访问性（ARIA + 键盘导航） | 常用操作可全键盘完成；焦点环与 ARIA 符合 WCAG 2.1 AA 抽查 |
| 14 | 连接卡片与树视觉一致性 | 源码化 Design Token（品牌色、行高 20px、缩进 10px、图标 18×20、菜单 12px），统一 light 主题 | 设计 token 单测/截图回归；无硬编码色值 |
| 15 | 安装包瘦身与签名 | 清理未用 GDAL driver/依赖（PDF/Poppler 等）、PROJ grid 按需；申请代码签名证书 | 安装包体积下降且签名校验通过；SmartScreen 无未知发布者提示 |
| 16 | 许可证合规 | 逐依赖完成 license/notice/CRT/源码 offer 审查，产出可发布的 NOTICE 与源码提供方案 | 法务签署；28 个 NOASSERTION 全部有结论 |
| 17 | 文档与可观测性 | 统一结构化日志（脱敏）、操作报告 JSON 化、CLI `--verbose`；文档与能力矩阵由代码生成器产出 | 一次构建同步更新文档矩阵，杜绝文档漂移 |

---

## 7. 建议的评审议题（供架构师拍板）

1. **源码恢复路径**：是否有备份？若没有，是否接受从编译产物近似还原（成本/风险）？
2. **UI 技术栈**：继续 Ant Design + 编译产物补丁，还是源码化后替换为更可控的组件方案（如 Headless UI + Token）？
3. **是否引入正式 E2E/CI**：当前无 Git、无 CI，是否同意先建基础设施再谈功能优化？
4. **GIS 运行时策略**：继续随包静态 GDAL（许可重、体积大），还是改为外部可配置运行时（部署复杂）？
5. **AI 边界**：是否扩展多 Provider 与缓存/向量库外部化，还是维持单 Provider + 本地索引？
6. **P2 功能**：ER 模型、备份/调度、BI 是否维持"不做"？如需做，应作为独立产品阶段。

---

## 8. 附录：关键文件索引

| 主题 | 文件 |
|---|---|
| 架构 | `docs/architecture.md` |
| 范围决策 | `docs/feature-evaluation.md` |
| 进展索引 | `docs/progress.md` |
| 数据库能力 | `docs/database-capability-matrix.md`、`docs/database-adapters.md` |
| GIS 设计与差异 | `docs/gis-design.md`、`docs/gis-implementation-gaps.md`、`docs/gis-database-capability-matrix.md` |
| AI | `docs/ai-sql-architecture.md`、`docs/ai-sql-security.md`、`docs/ai-provider-design.md`、`docs/ai-embedding-rag.md` |
| 事故与 UI 补丁 | `docs/incident-source-loss-20261124.md`、`docs/ui-redesign-20261123.md`、`docs/navicat-tree-style-20261124.md`、`docs/object-tree-context-menu.md`、`docs/conn-menu-align-20261124.md` |
| 测试 | `docs/test-report.md`、`docs/full-test-rerun-20261123.md`、`docs/ai-sql-test-report.md` |
| 源码（存留） | `packages/{shared,database,gis,core,ai}/src`、`apps/cli/src` |
| 源码（缺失） | `apps/desktop/src`、`apps/desktop/electron` |
| 当前编译产物 | `apps/desktop/dist/renderer/assets/{App-D3avBeWb.js,index-DQQUtUzE.css,DatabaseObjectTree-BUT6wZ0A.js}` |
