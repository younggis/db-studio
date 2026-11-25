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

## 4. 状态

基础层已完成并通过 typecheck/build。**尚未重构任何具体页面**；等待逐个提供页面代码后按上述规则迁移。
