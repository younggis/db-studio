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
| `pnpm test` | ⚠️ packages 333 项全通过；`apps/desktop` 因源码测试文件缺失报 `No test files found`（非回归） |
| CDP 冒烟（新构建） | ✅ 7 张连接卡片、右键菜单 3 项、图标 18×20 与文字对齐、工具按钮隐藏 |

## 后续替换顺序（建议）

1. `src/main.tsx` 改为恢复出的真实入口（含 ConfigProvider、Monaco loader），此时需用 vendor chunk 提供的 React 实例，或整体切换到 npm React 并同步替换所有 chunk。
2. 按 `recovered-source/src/App.tsx` + 编译 chunk 的对应关系逐组件重建：先 `DatabaseObjectTree`（已有完整源码）、`table-data-edit`、`workspace-layout` 等小模块，再 `App.tsx`。
3. 每替换一个组件：删除对应 vendor chunk 的引用 → 构建 → CDP 冒烟 → 提交。
4. 全部替换后删除 `src/vendor/`，恢复桌面单元测试（现缺失，需重写）。

## 已知限制

- `electron/*.ts` 使用 `@ts-nocheck`，类型安全尚未恢复；应在后续提交中逐步补回类型注解并移除该指令。
- `pnpm test` 中桌面测试为 0，CI 若要求全绿需先补写测试；不建议用 `--passWithNoTests` 掩盖。
- Monaco 在 CDP dev runtime 下报初始化错误（缺少 `resources/monaco/vs`），此为既有环境现象，非本轮回归；打包版包含该 extraResource。
