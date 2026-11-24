# AI SQL Assistant 调研与改造方案

## 当前代码基础

- Renderer 已使用 `@monaco-editor/react`，SQL 文本和查询结果由现有工作区状态管理。
- Electron Main 通过窄化 IPC 调用 `CoreService`；连接文件已用 Windows DPAPI / Electron `safeStorage` 加密。
- `CoreService` 可复用 PostgreSQL、MySQL、MariaDB、SQLite、SQL Server、Oracle 适配器的版本、Schema、表和列元数据；列元数据包含主键标记，六种 SQL 适配器均提供外键关系读取。
- MongoDB 使用独立文档服务与页面，不应套用 SQL 方言流程。
- 仓库没有现成 AI SDK、Schema RAG 或向量数据库依赖；Node 运行时已满足原生 `fetch` 要求。
- 代码知识图谱在本次调研中不可用（`Transport closed`），源码检查按 `AGENTS.md` 指引退回到定向搜索和阅读。

## 选型结论

1. 首期增加 `@db-studio/ai`，集中放置 OpenAI-compatible Chat Completions、结构化 SQL 助手流程、Schema 检索和安全校验。先用 Node 原生 `fetch`，避免把应用绑定到某家 SDK，也不增加运行时依赖。
2. Electron Main 持有模型密钥和数据库适配器。模型配置以加密文件保存；Renderer 只能读取不含密钥的模型摘要，通过受限 IPC 发起请求、取消请求和接收流式片段。
3. P0 Schema Context 使用当前连接的真实表/列/备注/主键/外键关系，按显式选择、关键词和可选的本地语义索引选取少量候选对象；不读取业务行。Schema 内容发送给 Chat 模型前须由用户明确开启，可手动刷新字段和关系缓存。
4. P0 提供生成、修复、解释、连接测试、取消、Monaco 预览和 Diff。所有结果先进入预览；只有用户点选“插入”或“应用修复”才修改编辑器，助手不调用数据库执行接口。
5. 默认只给出查询草稿，对多语句、明显写入语句和未在 Schema Context 中的对象添加阻断或警告。静态检查仅作为风险筛查，不声称等价于数据库权限或完整语法证明。
6. Embedding 与 Rerank 配置独立于 Chat 配置；它们不是 SQL 生成的前置条件。桌面端仅在用户选择表并主动建立索引后，才将这些表的结构元数据发送到 Embedding 服务；向量保存在 DPAPI / Electron safeStorage 加密的本机索引中，检索按连接、数据库和 Schema 隔离。请求仅在语义检索已启用且 Schema 同意开关开启时计算查询向量，并与关键词分数混合排序。索引不包含业务行。
7. CLI 复用 `@db-studio/ai` 的服务，模型参数从进程环境读取，避免依赖 Electron 启动或把 GUI 凭据导出给 CLI。

## 实施顺序

- P0-A：AI 类型、兼容 Provider、加密模型配置、连接测试、超时/取消/流式解析和单元测试。
- P0-B：从当前连接读取并限量缓存元数据，检索 Schema Context，提供对象校验与提示注入边界。
- P0-C：SQL 编辑器侧边助手、生成/修复/解释、错误入口、Diff 和用户确认式插入。
- P0-D：CLI 子命令与多数据库集成验证，更新安全、架构、模型配置和测试记录。
- P1-A：Embedding 配置、维度校验、选中表的本地 Schema 语义索引、范围隔离、增量替换、模型变更重建提示及连接清理；AI 请求提示当前表清单与语义索引覆盖差异（未索引表与已删除表残留），同时继续使用可用索引和关键词检索。
- P1-B：保守 SQL 静态优化建议、PostGIS SQL 模式、支持简单 CTE 链与单表派生子查询的 Schema-aware Monaco 表/列补全，以及用户手动提供计划文本的解释已接入；应用不自动执行 `EXPLAIN` 或 `ANALYZE`。

## 首期验收边界

- 未配置模型时，现有 SQL 编辑、执行和数据库浏览完全可用。
- 模型请求只通过当前连接 ID 读取必要的结构元数据，不传递密码、连接 URI 或业务行。
- 连接或标签页切换、面板关闭及用户取消都不会把旧响应应用到新的编辑器上下文。
- 模型异常或非法输出以可理解的错误呈现，不记录密钥、原始认证头或不必要的用户 SQL。
- Embedding/RAG 不作为 SQL 生成前置条件；模型服务实际输出未验证前，不将其描述为已验收。

## 当前实现与验证（2026-11-02）

- `@db-studio/ai`、Electron 模型设置与助手 IPC、React 面板、CLI 的 `ai models` / `ai sql` 命令均已接入。
- SQL 元数据包括外键列对应关系；缓存按连接、Schema、表隔离，保存或删除连接时清除，默认 5 分钟有效。每次请求最多纳入 8 张表、每表 160 列和 40 个外键。
- Chat、Embedding、Rerank 的模型设置及连通性检查已实现；Rerank 已参与同意 Schema 请求的候选重排，限制 12 个候选/1,200 字符文档/1,000 字符 Query，并保留混合检索回退。
- 验证结果：AI 包类型检查、构建通过，20 项单测通过；桌面端类型检查通过，13 项单测通过；`pnpm typecheck` 与 `pnpm build` 通过；最新工作区 `pnpm test` 为 106 项通过、3 项跳过。Renderer bundle 约 2.16 MB，构建提示 chunk warning。
- Oracle 的 SQL 静态语法验证目前降级为保守风险检查；其他已配置的方言解析也只作为预检，不能替代数据库验证。
- Schema 关键词和语义检索已组合；没有索引时自动退回关键词，并在模型结果中提示。索引只从用户显式选择的表构建，模型或维度切换会使该连接/数据库/Schema 的旧索引失效并要求重建。
- P1-B 的静态优化建议和 PostgreSQL/PostGIS 专用模式已接入。PostGIS 上下文读取实际版本、所选表 geometry/geography 字段、几何类型、SRID 和可用函数；助手不执行 SQL 或 EXPLAIN。Monaco 已提供当前 Schema 表、视图、简单别名、CTE 链、多表 CTE 显式投影和单表派生查询的输出列补全。执行计划解释已接入 GUI 与 CLI：用户从数据库客户端粘贴/读取计划文本，应用不执行数据库分析命令，计划限制 12,000 字符。
- 真实 DashScope 冒烟验证了合成 Schema SQL 生成、`text-embedding-v4` 返回 1,024 维及 `gte-rerank-v2` 排序；未发送真实数据库 Schema，也未验证用户表的真实索引生成与检索质量。该验证不替代多连接、多方言和复杂需求的质量评估。

## 桌面端真实 Schema RAG 验收补充（2026-11-02）

- 使用主机上静态 GDAL 的 unpacked Windows 构建、隔离 Electron 用户数据，以及 `127.0.0.1:25432` 上项目专属 PostgreSQL/PostGIS 服务。目标为 `dbstudio_test.ai_rag_acceptance_20261102`。
- 用户授权后，仅向 DashScope 发送 `land_use_lookup`、`parcel_inventory`、`parcel_sales` 的 Schema 元数据与合成查询意图。桌面 IPC 成功为三张所选表建立 1,024 维本机语义索引；Embedding 查询、Rerank 与 Chat 生成流程完成，UI 未报告 Rerank 回退。
- Chat 预览生成了只读 PostgreSQL 草稿，包含 2025 年日期范围、`parcel_id`/`zone_code` 两个连接、distinct parcel 计数、按地类汇总和 top-five 排序。结果明确列出三张引用表；草稿未插入编辑器或执行。
- RAG/SQL IPC 运行验收证明主机 unpacked 构建上的 GUI 链路可用。同一静态 GDAL 发行目录的 NSIS 包随后安装并启动成功，安装版 `app.asar` 哈希与 unpacked 构建一致。用户另行授权后，安装版已通过本机系统安全存储保存隔离 PostGIS 连接，成功连接 `dbstudio_test` 并浏览对象树；GIS inspect/import IPC 读取 `points.geojson` 后将 2/2 要素写入 `public.gui_ipc_geojson_20261102`。只读回读验证了 2 行、EPSG:4326、一个 Point 与一个 NULL 几何。安装版 AI/RAG IPC 和本轮 GIS 导出仍未完成；保存导出时主机桌面控制重试后返回 `GetCursorPos failed: 拒绝访问 (0x80070005)`，未产生导出文件。该结果不代表干净 Windows 验收，也不证明一般业务场景的 SQL 准确率。在线故障模式仍待补测。
- CLI AI 配置现在可在 Windows 下读取 GUI 共用的 DPAPI 加密模型配置，环境变量优先；`ai models list` 不显示凭据。CLI 执行计划命令通过 SQLite 哨兵表和 loopback 模拟模型服务完成端到端数据流验收，证明传入 SQL 不会被执行。AI Provider 的 401 脱敏、404、超时、断连和空流式响应通过 loopback 单元测试。该运行未访问外部模型，真实服务的计划解释质量仍待验证；Electron `safeStorage` 配置暂不能由 CLI 独立读取。
