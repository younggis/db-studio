# 图标对齐 + 连接右键菜单（2026-11-24）

## 背景

`apps/desktop/src` 与 `apps/desktop/electron` 源码仍缺失（见 `docs/incident-source-loss-20261124.md`），本轮继续直接修改编译产物并重建 MSI。

## 需求

1. 对象树图标与文字没有对齐 → 修正 CSS。
2. 连接管理中将功能按钮（测试连接 / 编辑 / 删除）放入右键菜单 → 隐藏内联按钮，新增 Navicat 风格右键菜单。

## 实施

### 1. 图标文字对齐（CSS `index-DQQUtUzE.css`）

`/* icon alignment fix */`：

- `.ant-tree-iconEle` 固定 18×20px、`margin-right:2px`、`inline-flex` 居中
- `.ant-tree-node-content-wrapper` 使用 `inline-flex; align-items:center`
- `.tree-node-title` / `.ant-tree-title` 统一 `line-height:20px; vertical-align:middle`
- 缩进 10px、switcher 14px

实测（打包版）：图标 `x30 y436 w18 h20`，标题 `x50 y435 w117 h22`，垂直差 1px 内，已对齐。

### 2. 连接卡片右键菜单（`App-D3avBeWb.js`）

之前直接改写压缩 JSX 的 `Dropdown` 包裹方案引入了 `SyntaxError: Unexpected token '}'`，已从已知良好的
`release-static-gdal-geos-msi-navicat-tree-20261124` asar 恢复 App chunk（`node --check` 通过，498075 字节）。

改用**无 JSX 改写的安全方案**：在 App chunk 末尾追加一段独立 IIFE（`/* connContextMenuSafe */`）：

- 全局 `contextmenu` 监听（捕获阶段），`closest('.connection-card')` 命中则 `preventDefault`
- 自建轻量弹出菜单 DOM：测试连接 / 编辑连接… / 分隔线 / 删除连接…（危险项红色）
- 点击菜单项时对同一卡片内原有的内联工具按钮按索引 `click()`（0=测试，1=编辑，2=删除）
  —— 复用原有闭包回调，无需触碰压缩 JSX
- 点击外部 / Esc / 滚动 / resize 自动关闭；位置自动避开视口边缘

CSS：`.connection-card .connection-tools{display:none!important}` + 菜单样式（白底、细边框、12px、hover 浅蓝）。

## 验证（打包版，非 dev runtime）

- `node --check App-D3avBeWb.js` 通过；asar 内 4 处补丁齐全
- CDP 实测打包版：7 张卡片、工具栏隐藏、右键菜单出现且项正确、编辑项点击可打开“编辑数据库连接”弹窗
- 图标文字对齐：见上

## 产物

- 重建 MSI：`apps/desktop/release-static-gdal-geos-msi-connmenu-20261124/DB Studio 0.1.0.msi`（199,050,037 字节）
- 已安装；桌面「DB Studio 最新版」快捷方式指向该目录的 `win-unpacked/DB Studio.exe`
- 旧版 `release-static-gdal-geos-msi-navicat-tree-20261124` 保留作为回退

## 注意

- 右键菜单依赖 DOM 中隐藏的 `.connection-tools button`；若源码恢复后重写组件结构，需在源码中重新实现菜单并移除此注入。
- 任何 `pnpm build` 都会覆盖这些编译产物补丁，必须在源码中落地。
