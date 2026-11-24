# AI SQL Assistant 技术调研

更新日期：2026-11-02

## 项目现状

项目已经具备 Electron Main/Renderer IPC、SQL 编辑器、六种关系数据库适配器、CLI、连接配置加密和 Monaco Editor。MongoDB 有独立文档查询服务。本功能复用这些边界，不建立第二套数据库连接层，也不让 AI 调用查询执行接口。

仓库没有现成 AI SDK、向量数据库或 Schema RAG 依赖。Node.js 原生 `fetch` 可完成 HTTPS、AbortSignal、JSON 和 SSE，因此 `@db-studio/ai` 使用轻量 HTTP Provider，没有新增模型 SDK。

## Provider 选型

| 能力 | 接入方式 | 选择理由 |
|---|---|---|
| Chat Completions | OpenAI-compatible HTTP | 可复用兼容服务的 `chat/completions`；模型响应解析、超时、取消和脱敏统一由本地 Provider 管理 |
| Embeddings | OpenAI-compatible `embeddings` HTTP | 可使用独立模型与维数配置；不需要第三方运行时 SDK |
| Rerank | DashScope Text Rerank HTTP API | DashScope 的排序端点不是 OpenAI Embeddings 接口；单独适配、检查索引和分数 |

实现及端点细节见 [Provider 设计](ai-provider-design.md)。模型配置和密钥边界见[模型配置](ai-model-config.md)与[安全说明](ai-sql-security.md)。

## 服务端文档核对

- 阿里云百炼公开文档列出 `qwen3.6-flash` 并说明其结构化输出能力：[模型信息](https://help.aliyun.com/zh/model-studio/qwen3-6-flash)。
- `text-embedding-v4` 同步 API 支持配置多个输出维度，默认 1,024 维，每次最多 10 条输入：[Embedding API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)。
- DashScope 文本排序 API 支持 `gte-rerank-v2`，按 Query 和 Document token 数限制请求：[Text Rerank API](https://help.aliyun.com/zh/model-studio/text-rerank-api)。实现将候选限制为 12 个，文档和查询均截断，以控制请求规模。

## 实际验证

2026-11-02 使用本机进程环境中的 DashScope 凭据执行了 Chat、Embedding、Rerank 冒烟，没有将密钥输出或保存到仓库。Chat 只收到合成的两列 Schema 和短问题；Embedding 收到一条合成文本；Rerank 收到两个合成候选。结果分别为只读 SQL 静态校验通过、向量 1,024 维、合成 Schema 排序高于无关文本。未向服务发送本机数据库结构、SQL 历史或业务行。

这验证了当前账号、网络和所配置模型在本次调用时可用；不等于使用真实数据库 Schema 建立语义索引，也不证明模型对任意用户 SQL 的正确率。项目代码知识图谱 MCP 连接返回 `Transport closed`，源码核查因此使用定向搜索和已构建测试。
