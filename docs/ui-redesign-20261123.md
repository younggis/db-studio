# 界面美化与交互优化（2026-11-23）

## 设计方向

采用「精炼数据工作台」方向：保留原有深色导航 + 浅色工作区的专业骨架，用统一设计 token 收敛色彩、圆角、阴影与间距；滚动条、焦点环、消息提示与表格操作按 Navicat 的「高密度、短反馈、工具栏分级」习惯 refine，而不是引入花哨装饰。

## 已实施改动

### 1. 全局样式（`apps/desktop/src/styles.css`）

- 新增完整 CSS 设计 token：`--brand` / `--ink` / `--canvas` / `--surface` / `--line` / `--radius*` / `--shadow*` / `--ring` / `--font-ui` / `--font-mono`，替换散落的硬编码色值。
- **滚动条**：新增全局细滚动条（8px、圆角 thumb、透明 track），深色侧栏使用单独的深灰 thumb；覆盖连接列表、对象树、工作区、历史抽屉、字段映射等所有滚动容器。
- **焦点态**：`:where(button, a, input, textarea, select, [tabindex]):focus-visible` 统一 2px 品牌色描边 + offset；连接卡片与树操作按钮另有专属 focus 样式。
- 选中文本、卡片 hover 阴影、卡片圆角/标题层级等细节微调。

### 2. Ant Design 主题（`apps/desktop/src/main.tsx`）

扩展 `ConfigProvider` token：主色 hover/active、文本次级色、边框色、字号 12、行高 1.55、控制高度 SM、阴影；并对 Button / Card / Input / Select / Table / Tabs / Tooltip / Message 做组件级覆盖（表头底色、行 hover、紧凑单元格、柔和消息阴影等）。

### 3. GIS 数据交换布局（重点）

根因：`.form-row` 是 `75px + 1fr` 两列网格，部分行有第三个子元素（长提示文字），被挤进 75px 标签列，导致换成 6–8 行。

修复：
- 标签列改为 `auto`，标签 `white-space: nowrap`，字号 10→11px。
- 第三个子元素（提示文字）用 `grid-column: 2` 放到控件下方，整列宽度显示。
- 带字数统计的 TextArea 提示文字增加右内边距，避免与 `0 / 4096` 重叠。
- 卡片圆角/阴影与标题层级提升；窗口 ≤1500px 时上下两张操作卡自动改为单列，给标签留足宽度。

效果：截图对比 `F:/knowledgebase/db-connect/.cache/ui-before/03-gis-page.png` → `.cache/ui-after/03-gis-page.png`，「坐标操作（可选）」「范围过滤（源 CRS，可选）」不再换行。

### 4. 交互优化：表节点「查询前 100 条」

- `App.tsx` 对象树每个表节点新增绿色播放按钮（`aria-label="查询前 100 条"`）。
- 复用 `buildTablePreviewSql(engine, schema, table)`，按方言生成 `TOP (100)` / `FETCH FIRST 100 ROWS ONLY` / `LIMIT 100`。
- 点击后：切到 SQL 查询页、载入 SQL、**立即执行**并在结果面板显示，同时成功提示 `已读取 <表名> · N 行。` 并写入查询历史（与 Navicat 双击表直接看数据一致）。
- 验证：截图中 20 个快捷按钮可见，点击后结果面板返回 4 行数据。
- 补充：GIS / MongoDB 页面顶部导航栏也加入「AI 助手」入口（`page !== "query"` 时显示，避免与 SQL 页工具栏按钮重复），点击可直接打开 AI SQL Assistant 抽屉；CDP 验证 GIS 页按钮存在且面板可打开。
- AI 表匹配容错：原逻辑在需求既无表名/字段名、又未勾选候选表、且无语义索引命中时会直接抛「未能从所选 Schema 范围找到相关表」。改为回退发送所选 Schema 前 8 张表并在警告中说明如何提升准确度；UI 上把选表控件加上「相关表（推荐选择，可多选）」标签与明确 placeholder。CDP 用模糊需求「查询一些数据，看看前几条」验证：不再报错，生成 `SELECT * FROM public.dbstudio_demo LIMIT 5;`。
- AI 面板连接选择：原面板只显示当前连接（未选连接时按钮禁用且难以自行恢复）。面板顶部新增「连接」下拉，直接在抽屉内切换（回调 `setActiveId` 并清除旧错误/选中 SQL）；禁用按钮增加 title 说明原因。
- 全白主题（2026-11-24）：按用户要求移除全部深色模式，顶栏、侧栏、对象树、状态栏、运行时信息条统一改为白色/极浅灰底 + 细边框 + 青绿点缀。选中连接卡片为浅绿底并带左侧品牌色条，树节点 hover/选中为淡青底，树图标按类型着色（数据库绿、Schema 蓝、表灰蓝），侧栏滚动条改为浅灰。CDP 截图验证 `.sidebar` / `.topbar` 背景均为 `rgb(255,255,255)`（`F:/knowledgebase/db-connect/.cache/ui-white/02-white-tree.png`）。`pnpm test` 442 通过/6 跳过、typecheck/build 通过；重建 MSI（199,045,941 字节，`app.asar` 哈希 `2D0DC5093CE617E9B9B90BAF27DD73C124F50E925968D0CD0F2D84C3AB9EB43E`）并安装，桌面快捷方式已指向白色主题版。
- 系统目录校验误报修正：需求「有哪些表」生成的 `SELECT ... FROM information_schema.tables` 被静态校验器误判为「Schema Context 中不存在模型引用的表」。为各引擎（Postgres/MySQL/MariaDB/SQL Server/Oracle/SQLite）加入系统目录白名单，并给出「查询引用了数据库系统目录/信息视图」提示；业务表仍照常校验。新增单测覆盖，AI 包 95/95 通过。2026-11-24 重建 MSI（199,058,229 字节，`app.asar` 哈希 `A10363479EA8D80AE2251F73B66F43A6ABB3250D69B3C4702A89CFA680063814`）并安装，桌面「DB Studio 最新版」快捷方式已指向该 exe。

### 5. 参考 Navicat 的依据

REA 静态分析确认 Navicat Premium 16.3.9 的 859 个具名位图包含 100%/150%/200% DPI × 明/暗 多套设计资产（`BB2_*`、`GLYPH_*`、`NG_*`、`PDBN_*`），并从随附手册截图中观察到三区布局、密集类型化树、两级工具栏、状态栏信息中心、短句式句号结尾消息。本次借鉴了：密集树 + 类型化图标、工具栏/状态栏层级信息密度、短句式成功提示（`已读取 … · N 行。`）、以及主题 token 化的明/暗适配基础。报告：`.cache/navicat-ui-research-20261123.md`。

## 验证

- `pnpm test` 442 通过 / 6 项既有 CLI 跳过；`pnpm typecheck`、`pnpm build` 通过。
- CDP 回放（当前构建 + 演示连接）截图确认：滚动条细化、GIS 标签不换行、快捷预览返回数据、无消息错误。
- 前后截图：`.cache/ui-before/`、`.cache/ui-after/`。
