# DB Studio Workbench Design System (v1)

全局高密度桌面生产力工具风格规范。后续所有页面重构必须复用本文件描述的
CSS 变量与基础组件，禁止在页面内重复硬编码颜色、间距、字号或控件尺寸。

## 1. 主题变量

源码：`apps/desktop/src/workbench-theme.css`（前缀 `wb-`，避免影响尚未迁移的页面）

| 类别 | 变量 | 值 |
|---|---|---|
| 背景 | `--wb-bg-toolbar` | `#F3F4F6` |
| | `--wb-bg-surface` | `#FFFFFF` |
| | `--wb-bg-hover` | `#EAECEF` |
| | `--wb-bg-selected` | `#E6F0FA` |
| | `--wb-bg-subtle` | `#F7F8FA` |
| 边框 | `--wb-border` | `#E2E4E8` |
| | `--wb-border-strong` | `#C9CDD4` |
| 主色 | `--wb-brand` | `#1677FF` |
| | `--wb-brand-hover` | `#0958D9` |
| 状态 | `--wb-success / warning / danger / info` | `#00B42A / #FF7D00 / #F53F3F / #1677FF` |
| 文字 | `--wb-text` | `#1F2329` |
| | `--wb-text-secondary / muted / inverse` | `#646A73 / #8F959E / #FFFFFF` |
| 字体 | `--wb-font-sans` | 系统无衬线（含中文） |
| | `--wb-font-mono` | JetBrains Mono / Cascadia / Consolas |
| | `--wb-font-size / -sm` | `12px / 11px` |
| | `--wb-line-height` | `1.4` |
| 尺寸 | `--wb-control-h / --wb-row-h` | `26px / 26px` |
| | `--wb-toolbar-h / --wb-statusbar-h` | `32px / 24px` |
| | `--wb-sidebar-w` | `260px` |
| | `--wb-radius / --wb-radius-sm` | `3px / 2px` |
| 间距 | `--wb-space-1..4` | `4 / 8 / 12 / 16px` |

深色主题通过 `[data-theme="dark"]` 覆盖同名变量，页面代码无需分支。

`.wb-app` 为 opt-in 作用域：只有加上该 class 的页面才会套用紧凑控件重置、
去阴影和 3px 圆角，因此旧页面不会被一次性改变。

## 2. 通用基础组件

源码：`apps/desktop/src/workbench/Workbench.tsx` + `workbench/workbench.css`

| 组件 | 用途 | 关键约束 |
|---|---|---|
| `WbWorkbench` | 页面骨架 | toolbar / sidebar / workspace / inspector / statusbar 五槽 |
| `WbToolbar` + `WbToolbarGroup` | 顶部紧凑工具栏 | 高 32px，灰底，1px 下边框 |
| `WbToolButton` | 工具按钮 | 26px 高，支持图标 + 文字 / 纯图标 Tooltip、active、danger |
| `WbDataTable<T>` | 数据表格 | 包装 antd Table；强制 26px 行高、斑马纹、1px 网格线、数字列等宽右对齐 |
| `WbTreeSidebar` | 左侧树导航 | 260px 宽，内建搜索槽、虚拟滚动树 |
| `WbTabContainer<T>` | 右侧多标签工作区 | card 型 Tab，0 间距，共享 1px 边框 |
| `WbInspector` | 右侧属性抽屉 | 用于详情/配置，避免整页跳转 |
| `WbStatusBar` | 底部状态栏 | 24px 高，左右信息槽 |

## 3. 页面重构规则

1. 页面根元素使用 `<WbWorkbench>`，禁止再居中或设 max-width。
2. 所有按钮用 `WbToolButton`（或 antd 按钮但受 `.wb-app` 约束），高度由变量决定。
3. 表格一律 `<WbDataTable>`；字段含 code/id/number 时添加 `className="mono"` 或 `"numeric"`。
4. 树/标签/属性面板分别用 `WbTreeSidebar` / `WbTabContainer` / `WbInspector`。
5. 任何新颜色、间距、圆角都必须先加入 `workbench-theme.css` 再使用。

## 4. 迁移状态

基础层已完成并通过 `pnpm test` / `typecheck` / `build` / `test:e2e`（6/6）。

已迁移页面（接入 WbWorkbench 骨架 + WbToolbar + WbStatusBar）：
- `MongoDocumentsPage.tsx`（MongoDB 文档）：工具栏与状态栏、索引表改用 `WbDataTable`
- `GisExchangePage.tsx`（GIS 数据交换）：标题与模式切换收拢进工具栏、状态栏

已纳入全局 token 作用域的面板/弹窗（`wb-surface` / `wb-app`）：
- 工具抽屉：备份恢复、结构同步、数据同步、表设计器、自动化调度、BI 图表
- 业务面板：Mongo AI、空间索引诊断、图层体检、查询历史、SQL AI 助手
- 弹窗：连接表单、对象搜索、表结构、表传输

编译版 SQL 主工作区（`workbench/compiled-shell.css` + `CompiledWorkbenchBridge.tsx`）：
编译 shell 位于 vendor chunk，且其早期源码 `recovered-source/src/App.tsx` 缺少
`workspace-store` / `ai-sql-insertion` 等依赖模块，无法整体重建为真实 TSX。
因此采用两层方案：
1. `compiled-shell.css` 按编译类名把 `shell/topbar/sidebar/workspace-head/statusbar/`
   `panel-toolbar/connection-card/query-table` 对齐到 `wb-*` token；
2. `CompiledWorkbenchBridge` 向编译 DOM **新增**共享组件 class
   （`wb-toolbar` / `wb-statusbar` / `wb-app` / `wb-table` / `wb-tab-container`），
   使其直接消费 `workbench.css` 的组件样式；同时渲染一个真实的 `WbStatusBar`
   React 组件替代编译版状态栏（旧节点隐藏但保留，E2E 选择器不变）。

CDP 实测：12px 字号、`#F3F4F6` 工具栏/侧栏、选中态 `#1677FF` 边框、24px 状态栏、
26px 按钮；编译节点已带共享 class。E2E 关键几何（对象树 28px/16px/6px、字形中心）保持不变。

## 5. 编译版 SQL 工作区整体迁移准备

为最终把编译 shell 换成真实 WbWorkbench 组件树，已重建 App.tsx 缺失的三个依赖模块
（经隔离 typecheck 验证 API 契约与 App.tsx 用法一致，并加入主工程且编译通过）：

- `apps/desktop/src/workspace-store.ts`：page / sql / sqlPath / result 状态与 setter
- `apps/desktop/src/ai-sql-insertion.ts`：appendAssistantSql（AI SQL 插入）
- `apps/desktop/src/gis-export-bridge.ts`：invokeGisExport / parseGisExportSpatialFilter

剩余障碍：两份恢复的 App.tsx 副本花括号不平衡（-3），存在历史结构性损坏；
且其中 symbols 与当前编译 chunk 不一致。直接替换会破坏现有 SQL/连接业务逻辑。
在此之前，编译 shell 继续通过 token 映射 + 共享 class 桥接 + 真实 WbStatusBar 接入设计系统。

## 5.1 编译 App chunk 替换试验（已回滚）

已做受控试验：保留编译 chunk（供其他 vendor chunk 引用其具名导出），仅把入口的
`import("./App-D3avBeWb.js").then(a=>a.bJ)` 指向真实 AppSource.tsx shim。
结果：build 通过，但运行时报 **React error #130（组件类型 undefined）**，
root  children=0。根因是编译 vendor chunk 自带 React，而真实 TSX 经 alias bridge
解析到不同的 lazy 组件实例，两套 React/组件注册表不兼容。已回滚，E2E 恢复 7/7。

因此当前 SQL shell 维持"token 映射 + 共享 class 桥接 + 真实 WbStatusBar"方案；
AppSource.tsx（语法已修复、typecheck 通过）保留为未来整体迁移的准备资产。

共享组件的真实消费（源码扫描确认八个组件全部被使用）：
- `WbWorkbench` / `WbToolbar` / `WbStatusBar`：MongoDB 文档页、GIS 数据交换页
- `WbToolButton`：工具启动器 9 个动作、BI 面板操作、MongoDB 页、对象树搜索/刷新
- `WbDataTable`：MongoDB 索引检查器
- `WbTreeSidebar`：对象浏览器（传入原 class 名与搜索槽，E2E 几何/选择器不变）
- `WbTabContainer`：BI 面板（图表设计 / 仪表盘）
- `WbInspector`：MongoDB 索引检查器（替代原 Modal Drawer）

内部渲染原语（JsonMiniEditor / LazyDataTable / MiniChart / GisControls / GisPreviewMap）
通过 `.wb-app` 祖先作用域自动继承 token，无需逐文件改动。

迁移原则与页面重构规则保持不变：所有新样式必须来自 `wb-*` 变量，禁止硬编码颜色/间距/字号。
