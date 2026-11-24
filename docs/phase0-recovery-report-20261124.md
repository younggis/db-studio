# 阶段 0 执行与验收报告（2026-11-24）

> 依据：`DB Studio 优化规划设计文档.md` 阶段 0「源码抢救与工程地基」。
> 结论：**阶段 0 未通过闸门**。源码部分恢复、版本控制已建立，但「全新克隆可 `pnpm build`」不成立，四项 UI 补丁仍只存在于编译产物。

---

## 0.1 源码恢复路径（逐条尝试）

| 顺序 | 路径 | 结果 | 说明 |
|---|---|---|---|
| 1 | Source map | ❌ | `dist/renderer/assets` 无 `.map`；`dist/electron/main.js.map` 有 `sources: ["../../electron/main.ts"]` 但 `sourcesContent` 为 undefined |
| 2 | AI 会话记录 | ⚠️ 部分成功 | OpenCode 会话 DB（`~/.local/share/opencode/opencode.db` + WAL，约 156 MB）中找到 55 次桌面源码 write/edit，以及 111 条 read 结果；已重放并产出 34 个文件，见 `recovered-source/` |
| 3 | 历史 release / asar | ⚠️ 仅编译层 | 多个 `release-*` 目录与 `app.asar` 可提取完整 dist，但不含 TSX |
| 4 | VS Code Local History / Claude file-history | ❌ | `entries.json` 与历史目录均指向其它项目（SnapCap、portal 等），无 db-connect 记录 |
| 5 | 手工回写兜底 | 未执行 | 规划中第 2 周末触发；目前已有部分基线，是否重写渲染进程待拍板 |

**恢复成果**：`recovered-source/` 下 34 个文件（13 个 src、3 个 electron、18 个构建配置）。
- `main.tsx`、`preload.cjs`、`contracts.d.ts`、`DatabaseObjectTree.tsx`、`styles.css`、`table-data-edit.ts`、`workspace-layout.ts` 等已完整恢复且语法通过。
- `App.tsx` 约 95%，79 行由编译产物 `App-D3avBeWb.js` 回填；仍有 1 处括号失衡。
- `main.ts` 约 64%、`AiAssistantPanel.tsx` 约 42%，存在未覆盖区域。
- 未恢复的渲染组件包括 ConnectionFormModal（完整）、GisControls（仅前 10 行）、TableStructureModal、TableDataEditorModal、TableTransferModal、LazyDataTable、MongoDocumentsPage、AiSettingsModal、DatabaseObjectSearchModal 等，以及多个本地模块。

## 0.2 版本控制

- ✅ `git init -b main`，配置 `younggis <younggis@163.com>`。
- ✅ 远端 `https://github.com/younggis/db-studio.git` 已建立推送；本地 `HEAD` 与远端 `main` 一致。
- ✅ 远端原有 LICENSE 通过 merge 保留，未强推覆盖。
- ✅ `.gitignore` 更新：排除 `node_modules`、`.cache`、`.learnings`、日志、`*.obj`、`release-*`、`build`、真实 `.env`；**保留** `apps/desktop/dist`（当前唯一可工作的 UI 代码）与各包 dist。
- ✅ 本地代理已配置（127.0.0.1:7890），后续 `git push` 可直接执行。
- ⚠️ 规划要求的「另一块磁盘 + 云端」双备份：云端已由 GitHub 满足；本地全量压缩备份见下一节。

## 0.3 UI 补丁回写源码

❌ **未执行**。原因：桌面源码不完整，回写后无法编译，反而会破坏当前可用的 dist。四项补丁仍以编译产物形式存在：

| 补丁 | 位置 |
|---|---|
| 白色主题 + 紧凑布局 | `dist/renderer/assets/index-DQQUtUzE.css` |
| Navicat 树 / Tables 分组 | `dist/renderer/assets/DatabaseObjectTree-BUT6wZ0A.js` |
| 图标文字对齐 | 同上 CSS（`icon alignment fix`） |
| 连接右键菜单 | `dist/renderer/assets/App-D3avBeWb.js`（`connContextMenuSafe` IIFE） |

## 0.4 产物补丁 SOP

已写入 `docs/artifact-patch-sop.md`，供源码恢复前的过渡期使用。

## 验收标准对照

| 规划验收标准 | 状态 | 证据 |
|---|---|---|
| 全新克隆后 `pnpm install && pnpm build` 成功 | ❌ | `pnpm --filter @db-studio/desktop run build` 退出码 1：`Could not resolve "electron/preload.cjs"`（`electron/`、`src/` 均缺失） |
| MSI 内含全部四项 UI 效果，`dist` 无补丁标记 | ⚠️ | 当前 MSI（`release-static-gdal-geos-msi-connmenu-20261124`）四项效果齐全且已 CDP 验收；但 dist 中仍有手工注入标记 |
| 远端仓库与离线备份各有一份可还原的完整副本 | ✅ | 远端 `main` = `4fa7979`；本地 `D:\db-connect-backups\db-connect-git-20261124.zip`（46.3 MB，`git archive` 精确镜像已提交内容） |

### 本次实测命令结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter @db-studio/desktop run build` | 1 | `Could not resolve "electron/preload.cjs"` |
| `pnpm typecheck` | 2 | `apps/desktop`: `error TS18003: No inputs were found ... include ["electron/**/*.ts"]`；其余包通过 |
| `pnpm test` | 1 | 各包全通过：gis 82、shared 22、database 77、ai 95、core 57（共 333）；`apps/desktop` 因 `build:preload` 找不到 `electron/preload.cjs` 失败 |
| 打包版 CDP 冒烟 | 通过 | 7 张连接卡片；右键菜单 3 项可见；图标 18×20 / 标题 y 差 ≈1px；编辑项可打开连接弹窗（见 `.cache/ui-packaged-final.png`） |

> 注：`pnpm test` 与 `pnpm typecheck` 的失败**仅来自桌面端源码缺失**，不是本轮改动引入的回归；packages/* 全部通过。

---

## 闸门结论与下一步

按规划「阶段 0 完成前其余阶段不启动功能开发」，**阶段 1–5 暂不启动**。需要架构师/用户拍板：

1. 若五条恢复路径均不完整，是否接受以 dist 为基线重写渲染进程？（规划中的后备方案）
2. 是否提供源码备份（网盘、其它机器、压缩包）？这是最快闭合闸门的路径。
3. 在源码恢复前，是否允许在 dist 层继续做小范围 UI 修补（按 SOP），还是完全冻结功能改动？

若决定「以 dist 为基线重写」，建议顺序：先恢复 `electron/`（可借用未压缩的 `dist/electron/main.js` + 已恢复的 `preload.cjs`），再按 `recovered-source/src/App.tsx` 与 dist chunk 的对应关系逐组件重建，最后用 E2E 锁定四项 UI 效果。
