# 阶段 1–2 执行进展（2026-11-24）

> 依据：`DB Studio 优化规划设计文档.md`。阶段 0 的后备方案（以 dist 为基线源码化渲染进程）已完成 14/15 个业务组件；本文件记录转入质量基础设施后的交付。

## 已完成

| 规划项 | 内容 | 验证 | 提交 |
|---|---|---|---|
| 1.1 适配器契约测试矩阵 | `tests/integration/adapter-contract.mjs`：对 6 个关系引擎跑统一用例（testConnection、query、绑定参数、schema/table 发现、create/columns/read、错误分类），输出机器报告 | 6/6 引擎通过 | `04b17e3` |
| 1.3 合成夹具替代本地文件 | `test:integration:mvt-postgis` 改为测试时由 PostGIS `ST_AsMVT` 生成 `.pbf` 落盘，自建 audit，跑完整批量回环，自动清理 | 通过，`dependsOnLocalFiles:false` | `bc81e6b` |
| 1.4 Electron E2E | Playwright + CDP 接管现有 dev runtime，3 条核心旅程（连接卡片/右键菜单、对象树 Tables 分组/图标对齐、SQL 页 AI/历史抽屉） | 3 passed / 10.3s | `132ea09` |
| 1.5 CI 流水线 | GitHub Actions：verify（typecheck/build/unit）+ integration（compose 起库、契约矩阵、MVT） | 文件在 `docs/ci/ci.yml` | `407bbb7` |
| 2.4 SQL 只读校验基线 | `packages/ai/src/sql-validator.test.ts`：9 项覆盖 CTE、系统目录、空间函数、写操作、多语句、越界表、字符串内分号 | AI 包 104 项全通过 | `3c7f5b8` |
| 2.2 IPC 运行时校验 | `packages/shared/src/ipc-contracts.ts`：16 个通道的 zod schema + 结构化错误；preload 边界 `invoke()` 统一校验 | shared 28 项测试通过；E2E 3/3；全量 test/typecheck/build 通过 | `b3dc68a` |
| 2.3 AI Provider 抽象 | Rerank 扩展为 `openai-compatible` / 本地 `/v1/rerank`，保留 DashScope 路径；设置面板增加 Provider 选择 | AI 包 107 项通过（含 3 项新契约） | `bc381c6` |
| 1.5 CI 激活 | workflow 已推送到 `.github/workflows/ci.yml`，API 验证 200 | GitHub Actions 将在 push/PR 运行 | `a0658de` |
| 构建卫生 | 所有包 tsconfig 排除 `*.test.ts`，清理 132 个误入 dist 的编译测试产物 | build/test 全绿 | `5a37cd4` |
| 2.1 OperationHandle | `packages/core/src/operation-handle.ts` 统一任务注册表（sender 限定取消、按连接/发送者批量取消、陈旧句柄 finish 守卫），主进程 GIS/AI 全部接入 | core 63 项通过（含 6 项新单测）；E2E 3/3 | `9710c21` |

## 关键约束与待办

- **CI 已激活**：`.github/workflows/ci.yml` 已推送（用户为 PAT 增加 Workflows 权限后）。verify + integration 两个 job 会在 push/PR 自动运行。
- **1.2 集成脚本迁移**（80 个 `.mjs` 迁入 Vitest projects）：未做，工作量大且与现有脚本运行方式重叠；建议保持现有脚本 + npm script 组织。
- **1.6 结构化日志/报告**：未做。
- **2.1 OperationHandle 统一任务模型**：✅ 已完成，见上表。
- **2.2 IPC zod 运行时校验**：✅ 已完成，见上表。
- **2.3 AI Provider 抽象与本地模型**：部分完成（本地 Rerank 已支持；本地 Chat/Embedding 原已支持）。
- **阶段 3–5**：未启动（产品差异化、性能、发行合规）。

## 当前全量状态
`pnpm test` ✅（含新增 6 引擎契约、自包含 MVT、校验基线）· `pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test:e2e` ✅ 3/3 · Git 本地/远端一致 `3c7f5b8`。

## 建议优先级
1. 阶段 1.6 结构化日志 + 1.2 集成脚本迁移——工程效率。
2. 阶段 3 产品差异化（图层体检面板、查询结果地图视图）——依赖桌面源码化收尾（仅 App.tsx 编译 chunk）。
3. 阶段 4–5 性能与发行合规——需外部条件（法务、代码签名证书）。
