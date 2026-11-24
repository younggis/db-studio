# 渲染进程重建：以 dist 为基线（阶段 0 后备方案）

> 日期：2026-11-24 · 依据用户对规划阶段 0 第 2 问的确认「需要」（接受以 dist 为基线重写渲染进程）。
> 原则：先让仓库可构建、可复现，再逐块用真实 TSX 替换编译产物。

## 已落地

### 1. Electron 主进程（完整还原）

`apps/desktop/electron/` 已从 `dist/electron/*.js`（未压缩的 tsc 输出）重建：

| 文件 | 来源 | 状态 |
|---|---|---|
| `main.ts`（107 KB） | `dist/electron/main.js` | 完整；文件头含 `// @ts-nocheck`（原类型注解未随编译产物保留） |
| `ai-operation-registry.ts` / `async-serial-queue.ts` / `connection-store-*.ts` | 对应 `.js` | 完整，同上 |
| `preload.cjs` | OpenCode 会话记录 | 完整源码 |
| `gis-export-bridge.cjs` / `ai-cancellation-bridge.cjs` | `dist/electron/preload.cjs` 内联代码 | 完整 |

验证：
- `pnpm --filter @db-studio/desktop run build:preload` 通过；生成的 bundle 与原始 `app.asar` 内 `preload.cjs` **SHA-256 完全一致**。
- `tsc -p tsconfig.electron.json --noEmit` 通过。

### 2. 渲染进程入口（薄壳）

`apps/desktop/src/main.tsx` 仅做一件事：side-effect import 原始 Vite 入口 chunk `vendor/index-CLh2VPBN.js`。该 chunk 自带 React 与挂载逻辑，因此**不能再从 npm `react` 重复 import**（会导致双 React 实例、hooks 报 `Cannot read properties of null (reading 'useContext')`）。

`apps/desktop/src/vendor/` 保存 37 个原始编译 chunk（1.59 MB，字节级来自最后一次已知良好构建，含四项 UI 补丁）。
`apps/desktop/public/assets/index-DQQUtUzE.css` 保存原始 CSS，解决 chunk 内 Vite preload 对未带 hash 文件名的引用。

### 3. 恢复基线保留

此前从会话记录恢复的 34 个文件仍在 `recovered-source/`。其中语法不完整的文件（App.tsx、main.ts、AiAssistantPanel.tsx、QueryHistoryDrawer.tsx）**不放入** `apps/desktop/src`，以免破坏 typecheck；它们作为后续逐块替换的参考基线。

## 当前验收

| 命令 | 结果 |
|---|---|
| `pnpm --filter @db-studio/desktop run build` | ✅ 通过（65 modules，含 vite build） |
| `pnpm typecheck` | ✅ 通过 |
| CDP 冒烟（新构建） | ✅ 7 张连接卡片、右键菜单 3 项、图标 18×20 与文字对齐、工具按钮隐藏、`Tables` 分组存在 |
| `pnpm test` | ✅ 378 通过 / 6 跳过（含桌面 18 项新测试） |

## 增量替换已解锁（React 实例桥）

直接把真实 TSX 组件混入 vendor chunk 会因**双 React 实例**导致 hooks 报 `Cannot read properties of null (reading 'useContext')`。已解决：

- 在 `src/vendor/index-CLh2VPBN.js` 末尾导出内部 React / ReactDOM 实例（`__dbStudioReactHooks` / `__dbStudioReactDom`），并补 `.d.ts`。
- 新增 `src/react-compat.ts`、`src/jsx-runtime-compat.ts`、`src/react-dom-compat.ts`，把 npm 的 `react` / `react/jsx-runtime` / `react-dom` 入口全部别名到 vendor 实例（`vite.config.ts` 的 `resolve.alias`）。
- 因此真实 TSX 与剩余 vendor chunk 共用同一个 hooks dispatcher，可**逐个**替换。

**首个替换已完成**：`DatabaseObjectTree-BUT6wZ0A.js` → 真实 `src/DatabaseObjectTree.tsx`，并把 Navicat `Tables` 分组逻辑用源码实现（`navicatTransform`），不再依赖 JS 注入。CDP 验证 `Tables` 分组仍在、图标文字对齐、右键菜单正常。

## 替换进度（2026-11-24）

已替换为真实 TSX 的业务组件（13 个）：

| 组件 | 源文件 |
|---|---|
| DatabaseObjectTree | `src/DatabaseObjectTree.tsx`（含源码版 Navicat Tables 分组） |
| GisControls | `src/GisControls.tsx` |
| LazyDataTable | `src/LazyDataTable.tsx` |
| QueryHistoryDrawer | `src/QueryHistoryDrawer.tsx` |
| TableStructureModal | `src/TableStructureModal.tsx` |
| DatabaseObjectSearchModal | `src/DatabaseObjectSearchModal.tsx`（本地 fetch + 取消，替代跨实例 react-query） |
| GisPreviewMap | `src/GisPreviewMap.tsx`（SVG 几何预览 + 拖拽框选） |
| TableTransferModal | `src/TableTransferModal.tsx`（本地资源状态） |
| TableDataEditorModal | `src/TableDataEditorModal.tsx`（复用 `table-data-edit` 差异/行变更逻辑） |
| AiSettingsModal | `src/AiSettingsModal.tsx`（Chat/Embedding/Rerank 设置） |
| ConnectionFormModal | `src/ConnectionFormModal.tsx`（含 SSH 隧道，复用 `connection-form-values`） |
| MongoDocumentsPage | `src/MongoDocumentsPage.tsx` + `src/MongoAiPanel.tsx`（内嵌 AI 面板） |

vendor 目录仍有 27 个编译 chunk（约 1.5 MB），但其中绝大多数是**第三方库**（React、antd、Monaco、sql-formatter、antd Table/Pagination/Dropdown 等），无需还原。真正待还原的业务组件只剩 2 个：

- `App-D3avBeWb.js`（488 KB，主组件；恢复源约 95%，仍有 JSX 结构缺口）
- `ConnectionFormModal-CvGV5FvW.js`（29.5 KB）
- `AiAssistantPanel-DZzJ5MwT.js`（22.6 KB；恢复源约 42%）

## 后续替换顺序（建议）

1. 继续翻译小 chunk：`GisControls`（Checkbox/Progress 包装）、`LazyDataTable`、`TableStructureModal`、`QueryHistoryDrawer` 等，按编译产物逐块还原为 TSX。
2. 恢复 `recovered-source/src/App.tsx`（约 95%，仍有少量 JSX 结构缺口）作为最终入口，届时删除 `src/main.tsx` 薄壳。
3. 每替换一个组件：把对应 vendor chunk 改为 re-export shim → `pnpm build` → `pnpm typecheck` → CDP 冒烟 → 提交。
4. 全部替换后删除 `src/vendor/`、`src/*-compat.ts` 与 `vite.config.ts` 别名，回到纯 npm React。

## 已知限制

- `electron/*.ts` 使用 `@ts-nocheck`，类型安全尚未恢复；应在后续提交中逐步补回类型注解并移除该指令。
- `pnpm test` 中桌面测试为 0，CI 若要求全绿需先补写测试；不建议用 `--passWithNoTests` 掩盖。
- Monaco 在 CDP dev runtime 下报初始化错误（缺少 `resources/monaco/vs`），此为既有环境现象，非本轮回归；打包版包含该 extraResource。
