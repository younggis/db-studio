# AI 模型配置

更新日期：2026-11-17

## 桌面端

在“模型设置”分别配置 Chat、Embedding、Rerank。Chat 配置可启用多个模型并选择默认模型；Embedding 和 Rerank 可单独关闭。密钥保存在 Electron 主进程管理的应用用户数据目录 `ai-models.enc`：Windows 使用当前用户 DPAPI，其他平台使用 Electron `safeStorage`。Renderer 只看到 `apiKeySet` 状态；密钥输入框不回填，留空保存会保留已加密的值。

## CLI 环境变量

```dotenv
MODEL_OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_OPENAI_MODEL=qwen3.6-flash
MODEL_OPENAI_API_KEY=<从本机安全环境变量提供>
MODEL_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_EMBEDDING_MODEL=text-embedding-v4
MODEL_RERANK_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_RERANK_MODEL=gte-rerank-v2
```

CLI 还支持 `MODEL_EMBEDDING_API_KEY`、`MODEL_RERANK_API_KEY`、`MODEL_EMBEDDING_DIMENSIONS` 和各模型独立超时变量；未设置单独密钥时可使用 `MODEL_OPENAI_API_KEY`。运行 `dbstudio ai models list` 查看非密钥配置，`dbstudio ai models test` 测试 Chat。

不要将真实 Key 粘贴进源码、任务文档、`.env` 示例、命令行参数或测试输出。桌面和 CLI 凭据存储彼此独立。更多实现和限制见[Provider 设计](ai-provider-design.md)。

## 2026-11-09 DashScope 本机配置核验

- 用户提供的 DashScope Chat、Embedding 与 Rerank 模型已保存到 `%APPDATA%\@db-studio\desktop\ai-models.enc`。该文件沿用 Electron 主进程的 Windows 当前用户 DPAPI 格式；只验证当前用户能解密且三类模型的密钥字段存在，没有输出或记录密钥值。
- CLI `ai models list` 能从加密桌面配置读取模型信息并只报告 `apiKeyConfigured` 状态。配置的模型为 `qwen3.6-flash`、`text-embedding-v4` 与 `gte-rerank-v2`。
- 三个 `ai models test` 最小探测均通过：Chat 返回有效文本、Embedding 返回 1,024 维向量、Rerank 响应结构有效。探测只包含内置合成文本，不包含数据库 Schema 或业务行。

## 2026-11-12 DPAPI 配置复核与模型连通性

- 发现桌面加密配置中的 Chat 指向本机回环地址且没有 API Key，Embedding 与 Rerank 未启用；这不符合当前 DashScope 验收配置。用户已明确授权使用其提供的模型设置，因此将 Chat、Embedding、Rerank 更新为 DashScope endpoint 与指定模型，写入默认桌面用户目录的 `ai-models.enc`，由当前 Windows 用户 DPAPI 加密；旧配置保留为加密备份。密钥值未写入项目文件、命令输出或本报告。
- CLI `ai models list` 确认三类模型都已配置，并且只显示 `apiKeyConfigured` 状态。真实最小连通性探测通过：Chat 返回有效文本，Embedding 返回 1,024 维向量，Rerank 对合成查询将相关候选排在首位。
- 探测仅发送 provider 内置或同等的合成短文本，没有发送数据库 Schema、连接凭据或本地数据。桌面应用读取同一默认 `userData` 配置；安装版 GUI 验收仍需单独确认安装/启动结果。

## 2026-11-16 DashScope 配置与在线回归

- 当前 `%APPDATA%\@db-studio\desktop\ai-models.enc` 仍为 DPAPI 加密配置。CLI 非密钥清单确认 Chat `qwen3.6-flash`、Embedding `text-embedding-v4` 和 Rerank `gte-rerank-v2` 均启用，三者的 Key 状态均已设置；未读取、输出或改写密钥。
- `dbstudio ai models test` 三类最小请求全部通过：Chat 有效文本响应、Embedding 1,024 维、Rerank 响应结构有效。项目在线 Provider 集成 `pnpm run test:integration:ai-provider` 通过生成、修复、静态优化契约、Embedding 和 Rerank；`pnpm run test:integration:ai-schema-rag` 通过 3 个合成表的索引、检索和排序，scope 隔离及清理断言均通过。
- 所有云端载荷均为合成 Schema、查询意图或排序短文本；没有发送业务行、数据库凭据或本地文件。默认网络沙箱 DNS 解析失败，按用户授权在受限沙箱外完成这些已声明的 DashScope 测试。复杂业务准确率和安装版 GUI 的可见交互仍需分别验证。

## 2026-11-17 现有 DPAPI 配置核验

- 读取默认桌面用户目录的 `ai-models.enc` 时仅在进程内 DPAPI 解密，并只输出脱敏状态。Chat `qwen3.6-flash`、Embedding `text-embedding-v4` 和 Rerank `gte-rerank-v2` 均启用，密钥字段均已设置，三个 Base URL 均匹配 HTTPS DashScope compatible endpoint。
- 配置已满足当前测试所需设置，因此本次未覆盖或重写密钥，也没有把 API Key 写入明文文件、命令输出或进度文档。隔离安装启动目录未复制默认用户配置，以避免加载已保存连接。
