# 恢复的桌面端源码（阶段 0 部分成果）

> 生成日期：2026-11-24 · 来源：OpenCode 会话数据库 `~/.local/share/opencode/opencode.db`（含 WAL）中的 `session_message` 记录

## 恢复方法

`apps/desktop/src` 与 `apps/desktop/electron` 在会话中丢失。按优化规划阶段 0 的路径逐条尝试：

| 路径 | 结果 |
|---|---|
| 1. Source map | ❌ renderer 无 `.map`；electron 的 `main.js.map` 无 `sourcesContent` |
| 2. AI 会话记录 | ✅ **部分成功**：从 OpenCode DB 提取出 55 次针对桌面源码的 write/edit 调用，以及 111 条 `read` 工具结果 |
| 3. 历史 release/asar | ⚠️ 只能提供编译层，且当前 dist 已被 UI 补丁修改 |
| 4. VS Code Local History / Claude file-history | ❌ 无本项目记录 |
| 5. 手工回写 | 仅作兜底，尚未执行 |

恢复脚本保存在 `.cache/recover/`（不入库）。核心流程：
1. 解析 `session_message` → 提取 `tool` part 的 `state.input`（写/编辑参数）与 `state.content`（读结果）。
2. 选取每个文件**单一一致快照**（同一 session 的分块 read），按行号组装，避免混用不同版本导致行号错位。
3. 按时间顺序重放全部 edit（App.tsx 15/15、styles.css 14/14 命中）。
4. 用编译产物 `App-D3avBeWb.js` 回填 App.tsx 未读到的 79 行（SQL 补全 provider、editor status、splitter、results toolbar）。
5. esbuild 逐文件语法检查，并修复截断标记与若干 JSX 结构。

## 文件清单与状态

> 「语法」为 esbuild transform 结果；「完整」表示该工具结果覆盖了原文件的主要部分。语法通过 ≠ 完整。

| 文件 | 恢复字符数 | 语法 | 完整度 | 说明 |
|---|---:|---|---|---|
| `src/App.tsx` | ~106 KB | ⚠️ 尾声多一个 `}` | ~95% | 79 行由编译产物回填；仍有 1 处括号失衡待人工核对 |
| `src/styles.css` | ~51 KB | ✅ | ~98% | 13 行缺口；含全部 UI 补丁后的样式 |
| `src/main.tsx` | 2.8 KB | ✅ | 100% | 含白色主题 ConfigProvider |
| `src/DatabaseObjectTree.tsx` | 1.9 KB | ✅ | 100% | 来自完整 write 调用（Navicat 树版本） |
| `electron/preload.cjs` | 5.3 KB | ✅ | 100% | 完整 |
| `electron/contracts.d.ts` | 8.4 KB | ✅ | 100% | 完整 |
| `src/table-data-edit.ts` | 5.2 KB | ✅ | 100% | 完整 |
| `src/workspace-layout.ts` | 2.4 KB | ✅ | 100% | 完整 |
| `src/QueryHistoryDrawer.tsx` | 8.3 KB | ⚠️ | ~95% | 1 处 JSX 结构待修 |
| `electron/main.ts` | 49 KB | ⚠️ | ~64% | 约 514 行缺口（分段未覆盖区域） |
| `src/AiAssistantPanel.tsx` | 11.9 KB | ⚠️ | ~42% | 约 276 行缺口 |
| `src/ConnectionFormModal.tsx` | 1.7 KB | ✅ | 仅前 71 行 | 不完整但语法正确，不可直接使用 |
| `src/GisControls.tsx` | 0.3 KB | ✅ | 仅前 10 行 | 不完整但语法正确，不可直接使用 |
| `src/connection-store-*.ts` 等 | 4 个 | ✅ | 100% | 完整 |
| `builder-configs/*.cjs` | 18 个 | ✅ | 100% | 完整 |

## 已知缺口（必须由用户/后续会话补齐）

1. **未恢复的渲染进程组件**：`ConnectionFormModal`（完整）、`GisControls`、`TableStructureModal`、`TableDataEditorModal`、`TableTransferModal`、`LazyDataTable`、`MongoDocumentsPage`、`AiSettingsModal`、`DatabaseObjectSearchModal`、`LazyGis*` 等；以及 `workspace-store.ts`、`ai-sql-insertion.ts`、`gis-export-bridge.ts`、`sql-completion.ts` 等本地模块。
2. **4 个文件语法未通过**：`App.tsx`、`main.ts`、`AiAssistantPanel.tsx`、`QueryHistoryDrawer.tsx`，差异均为会话记录未覆盖的区域或 JSX 截断，需对照 `apps/desktop/dist` 手工核对。
3. **未验证**：这些文件从未参与 `tsc -p tsconfig.json` / `vite build`，类型与导入完整性未知。

## 使用方式

在确认补齐缺失文件之前，**不要**把这些文件直接复制进 `apps/desktop/src` 或 `apps/desktop/electron`——当前工作区仍能运行，是因为 `apps/desktop/dist` 完整。本目录仅作为恢复基线留在版本库中。
