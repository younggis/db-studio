# AI SQL Assistant 架构

更新日期：2026-11-02

## 请求路径

```text
React / Monaco
  → preload 暴露的受限 IPC
  → Electron Main 读取加密模型设置、连接和 Schema 元数据
  → @db-studio/ai（Provider、检索、SQL 校验）
  → 返回预览草稿与警告
  → 用户检查后插入或接受 Diff
```

CLI 直接调用 `@db-studio/ai` 和 Core Service，不启动 Electron。数据库连接、SQL 执行和 GIS 服务继续由既有 Core/Adapter 持有；AI 服务没有 SQL 执行方法。

## 模块责任

- `packages/ai`: Chat/Embedding/Rerank Provider、任务提示、结构化响应校验、Schema 文档与本机向量索引、SQL 静态校验。
- `apps/desktop/electron/main.ts`: 加密配置、连接选择、受限 IPC、Schema 查询、请求取消和流式转发；密钥不返回 Renderer。
- `apps/desktop/src/AiSettingsModal.tsx`: Chat/Embedding/Rerank 配置、连通性测试和密钥状态。
- `apps/desktop/src/AiAssistantPanel.tsx`: 需求输入、Schema 同意、表选择、结果预览、Diff 和用户确认式应用。
- `apps/desktop/src/App.tsx`: Monaco SQL 工作区及本地表/列补全；列补全只请求所需表的元数据。
- `apps/cli/src/index.ts`: `ai models` 与 `ai sql` 命令，进程环境配置。

## 关键边界

Schema 只在当前请求显式同意后读取并发送；Embedding 建索引要求另外明确选择表并点击建立。向量索引按连接 ID、数据库和 Schema 隔离并在本机加密。模型只返回建议草稿；静态 SQL 校验通过仍需要用户审查并由用户自行执行。

实现边界和已知限制见[安全说明](ai-sql-security.md)及[实施计划](ai-sql-implementation-plan.md)。
