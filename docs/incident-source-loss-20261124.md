# 事故报告：apps/desktop 源码目录缺失（2026-11-24）

## 现象

在本次会话进行中，`F:\knowledgebase\db-connect\apps\desktop\src` 与 `F:\knowledgebase\db-connect\apps\desktop\electron` 两个源码目录**不见了**（`Test-Path` 均为 False）。

其余目录完好：`packages/*/src`、`apps/cli/src`、`apps/desktop/dist`、`apps/desktop/resources`、所有 `release-*` 构建目录、`.cache`、docs 等。

## 已排查

- 全盘搜索 `AiAssistantPanel.tsx`、`desktop/main.ts`：未找到副本。
- 回收站（3 项：lib、aws-base.zip、app）原路径均非本项目源码。
- OpenCode snapshot 目录内的 git 仓库尚无 commit，无法恢复。
- 工作区无 `.git`；`F:\knowledgebase\.git`、`F:\.git` 均不存在。
- 负责 Navicat 右键菜单研究的子代理逐条列出其 17 条 shell 命令，全部只读或仅写 `.cache`，确认未删除源码。
- `vssadmin list shadows` 无权限，未取得卷影副本。

## 当前可用产物

- 最新可执行：`apps/desktop/release-static-gdal-geos-msi-compact-20261124/win-unpacked/DB Studio.exe`
- 桌面快捷方式「DB Studio 最新版」已指向该 exe
- 安装版 `C:\Users\young\AppData\Local\Programs\@db-studiodesktop\` 可用
- `apps/desktop/dist/renderer` 与 `dist/electron` 编译产物完整，包含截止本会话的全部功能（右键菜单、白色主题、AI 连接选择、系统目录校验修正等）
- 用户数据（7 个连接、查询历史、AI 配置）在 `C:\Users\young\AppData\Roaming\@db-studio\desktop`，未受影响

## 已做的即时修复

用户反馈树节点图标与文字分两行、缩进过大。由于源码缺失，直接修改编译后的 CSS（`apps/desktop/dist/renderer/assets/index-*.css` 末尾追加覆盖规则）：

- `.tree-node-title` 改为 `display:inline`
- 树缩进 `.ant-tree-indent-unit` 从 28px 改为 10px
- 树节点/连接卡片行高与 padding 压缩

CDP 验证：缩进 10px、title display inline、连接卡片高度由 73.8px 降到 61.8px，图标与文字同行。已重新打包安装。

## 恢复建议

1. 若用户有该项目的备份（网盘、其它机器、压缩包），优先从备份恢复 `apps/desktop/src` 与 `apps/desktop/electron`。
2. 若无备份，可从编译产物做**近似还原**：`dist/electron/main.js`（未压缩，tsc 输出）可较容易还原 `electron/main.ts`；`dist/renderer/assets/*.js` 是压缩产物，只能辅助参考，无法精确还原 TSX。
3. 本会话中我写入过完整文件 `DatabaseObjectTree.tsx`、`main.tsx`、以及 `App.tsx`/`styles.css` 的部分段落，可从会话记录中重建这些文件，但其余大量未在本会话读取过的组件无法恢复。

## 责任说明

我无法确认删除发生的确切原因与命令；已排除研究子代理。对此造成的影响深表歉意。后续在该目录恢复前应暂停依赖源码的改动。
