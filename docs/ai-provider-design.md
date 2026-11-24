# AI Provider 设计

更新日期：2026-11-12

## HTTP 适配

- Chat: `POST {baseURL}/chat/completions`，支持普通 JSON 响应、SSE 增量和用户取消。
- Embedding: `POST {baseURL}/embeddings`，按索引配置批次，校验向量数量、数值与维数。
- DashScope Rerank: `POST https://{baseURL-host}/api/v1/services/rerank/text-rerank/text-rerank`，校验候选索引、有限分数和重复项。

所有调用使用 Node 原生 `fetch`，有请求超时、父级 AbortSignal 传递和统一错误类型。成功 JSON 响应最多读取 8 MiB，错误正文最多读取 16 KiB，流式 Chat 响应最多读取 8 MiB；超限即取消读取并返回 `response` 错误（错误正文则保留有限诊断并标注截断）。HTTP 重定向被拒绝。错误消息会遮蔽 Bearer 值和常见 API Key 字符串；密钥不会写日志。

## URL 与兼容性

远程 URL 必须使用 HTTPS；HTTP 只允许回环地址。URL 中不得带用户名、密码、查询串或片段；远程 DNS 解析不能指向本机或私网。OpenAI-compatible 服务实际支持的响应格式可能不同，结构化响应失败时最多触发一次无密钥修复请求。

Chat 与 Embedding 可分别设置 URL、模型、超时和密钥；Rerank 使用单独的 DashScope Provider 配置。配置中省略 Rerank 时不发请求。Rerank 只接收同意共享的 Schema 摘要，不接收业务行。

## Rerank 预算与回退

在关键词/向量召回后，Desktop 最多取 12 个候选表；每个 Schema 文档最多 1,200 字符，Query 最多 1,000 字符。最终上下文仍最多 8 张表，显式选中的表维持优先级。Provider 超时、网络错误、响应格式错误或用户取消时：请求取消则终止；其他 Rerank 失败记录警告并回退到本地混合排序。

2026-11-02 的本地 mock Provider 测试校验端点、请求体、Bearer 使用和响应索引；同日实际 DashScope 冒烟用两个合成文档完成排序。详见[测试报告](ai-sql-test-report.md)。

## Structured SQL assistant responses

SQL assistant requests use OpenAI-compatible JSON Object mode when the provider accepts `response_format`. Providers that return HTTP 400 identifying this parameter as unsupported receive one compatibility retry without it; SQL assistant JSON parsing and static validation still run. For DashScope Qwen models, a retry after invalid structured output disables thinking mode for that retry only, then restores the configured default on later requests. The assistant prompt states the JSON field types, and diagnostics report parse reasons without logging model response content. This improves structural reliability but does not make model-generated SQL trustworthy; read-only validation and user review remain required.
