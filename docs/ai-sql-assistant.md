# AI SQL Assistant

## 数据流

Renderer 通过受限 Electron IPC 请求 Main 进程执行模型调用。Main 读取加密设置和当前连接的数据库元数据；数据库密码、连接 URI 和业务行不会加入模型上下文。模型响应作为 SQL 草稿显示在面板中，不会自动执行。生成 SQL 可在检查后插入编辑器；修复 SQL 先在只读 Diff 中逐项核对，再由用户接受。

只有开启“允许将本次匹配的表结构发送给模型”后，Main 才读取并发送 Schema。用户可选择候选表，也可按需求关键词匹配。每次最多发送 8 张表、每表 160 列和 40 个外键。PostgreSQL 另读取表/字段备注；外键读取失败时会显式警告助手不要假定关系。结构缓存按连接、Schema 和表名隔离，有效 5 分钟；保存或删除连接会清除缓存，面板提供下一次请求强制刷新字段和关系的选项。

支持 PostgreSQL、MySQL、MariaDB、SQLite、SQL Server 和 Oracle 的结构上下文。MongoDB 使用独立的 Filter / Aggregate AI 助手，不进入 SQL 生成或 SQL 校验流程。

## 模型设置

桌面端将 Chat、Embedding、Rerank 配置保存在应用用户数据目录的 `ai-models.enc` 中。Windows 使用 DPAPI，其他平台使用 Electron `safeStorage`。Renderer 只获得不含密钥的公开配置；密钥输入框不会回填密钥，留空保存时保留已保存密钥。

示例环境变量只用于 CLI；不要将真实密钥提交到仓库或写进文档：

```dotenv
MODEL_OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_OPENAI_MODEL=qwen3.6-flash
MODEL_OPENAI_API_KEY=<从本机环境或安全凭据存储提供>
MODEL_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_EMBEDDING_MODEL=text-embedding-v4
MODEL_RERANK_MODEL=gte-rerank-v2
```

CLI 命令包括 `dbstudio ai models list|test` 和 `dbstudio ai sql generate|repair|explain|explain-plan`。生成、修复必须带 `--include-schema`，明确表示允许发送所选表结构。执行计划解释通过 `--file` 与 `--plan-file` 显式提供 SQL 和计划文本；应用只把它们交给模型解释，不连接数据库执行 `EXPLAIN` 或 `ANALYZE`，计划上限为 12,000 字符。CLI 设置与桌面端凭据相互独立，密钥只从进程环境读取；`models list` 不显示密钥，URL 中的凭据和查询参数会被遮蔽。

Chat/Embedding 使用 OpenAI-compatible 接口；Rerank 使用 DashScope Text Rerank 接口。远程服务要求 HTTPS，HTTP 只允许回环地址；配置拒绝 URL 凭据、查询参数和片段，并检查远程主机的 DNS 解析结果。

## Schema 语义索引

- 在助手面板里明确选择表，再点“将所选表结构发送至 Embedding 服务并建立本机索引”。只处理选中的最多 100 张表，不读取任何业务记录；字段类型、表/字段备注、关系和 PostGIS 空间类型会组成索引文档。
- 索引文件保存在应用用户数据目录的 `ai-schema-index.enc`，Windows 使用当前用户 DPAPI，其他平台使用 Electron `safeStorage`。索引键隔离连接 ID、数据库和 Schema；连接配置保存或删除时清除该连接下的索引。
- 新建索引时只替换当前所选表的向量。切换 Embedding Provider、URL、模型或配置维度会清除该范围内旧模型向量并要求重建，避免混用维度和模型版本。
- 查询时仅在 Embedding 已启用、配置密钥存在且本次允许发送 Schema 时计算用户需求的向量，并将语义分数与关键词分数结合。没有索引、维度不兼容或 Embedding 服务不可用时退回关键词匹配，并将原因列为结果警告。
- 启用 Rerank 后，对本地召回的最多 12 个 Schema 候选二次排序；每份文档最多 1,200 字符，查询最多 1,000 字符，最终 Chat 上下文最多 8 张表。Rerank 仅在同一 Schema 同意分支内运行，失败时回退到关键词/向量排序；它不会扩大召回集合。
- “建立索引”按钮代表用户同意将明确选择的 Schema 元数据发送到 Embedding 服务；Embedding 设置和本次 Schema 同意开关缺一不可。查询向量也会发送到所配置的 Embedding 服务。

## PostGIS SQL

PostGIS 专用模式要求 PostgreSQL 连接、开启 Schema 同意并明确选中空间表。Main 查询 `pg_extension`、`geometry_columns` / `geography_columns` 和有限的 `to_regprocedure` 函数清单，为助手提供真实 PostGIS 版本、空间字段、几何类型、SRID、坐标维数和支持函数。助手按几何/地理类型提醒距离单位差异，只生成只读草稿；不运行 SQL、`EXPLAIN` 或 `ANALYZE`。当用户需求与草稿同时涉及 `ST_DWithin`、`ST_Distance`、`ST_Buffer`、`ST_Area` 或 `ST_Length` 等测量操作时，如果被引用的 `geometry` 坐标单位未知、角度制或无法确认是有效线性单位，策略检查会清空 SQL 草稿并要求确认 CRS/期望单位。明确要求米制距离、但 geometry 单位不是米时也会要求澄清；`geography` 路径不受这条 geometry 单位检查影响。

## MongoDB 查询助手

- Mongo 文档查询页的“AI 助手”通过独立的 `runMongoAssistant` 服务与 Electron IPC 提交请求；支持 Find 的 Filter / Projection / Sort、Aggregate Pipeline、当前查询解释和错误修复。
- 每次请求都需要显式勾选同意。模型只接收自然语言需求、数据库与 Collection 名称、用户填写的可选字段提示，以及解释/修复任务所需的当前查询和错误文本。不读取文档样本、连接 URI、密码或业务记录。
- 返回值必须是 JSON。Aggregate 只允许只读阶段；拒绝 `$where`、`$function`、`$accumulator`、`$out`、`$merge` 和服务器诊断阶段。结构错误或安全检查失败时最多重试一次。
- 结果只显示为待审核草稿。用户可复制或应用到 Find/Aggregate 查询框；应用不会运行查询，执行仍需用户单独点击原有查询按钮。
- 字段提示由用户提供；助手不扫描 Collection 样本来推断 Schema。未提供字段提示时，模型必须把无法确定的字段作为假设列出。

## Monaco Schema 补全

编辑器在 `FROM` / `JOIN` / `UPDATE` / `INTO` 后显示当前默认 Schema 的表和视图，也会建议当前 WITH 子句定义的 CTE 名称；在表、已识别别名、简单 CTE 链或单表派生子查询后建议列名。基表列元数据按连接/Schema/表缓存 60 秒，连接、Schema 或对象浏览结果刷新后清除。补全不访问业务行；复杂子查询、多来源 CTE 和方言特有的关联语法仍有限。

## SQL 风险控制

- 助手只输出一个建议性的只读 `SELECT` / `WITH` 草稿，不调用数据库执行接口。
- 多语句、写入操作、`SELECT … INTO`、行锁读取、已知会修改序列/会话状态的函数和 Schema 中不存在的表/列会被阻断或警告；解析器支持的方言会校验 AST 中识别出的物理表列引用，并处理别名与已知 CTE 输出列。复杂表达式仍可能保守处理，外部访问或副作用形式仍可能未被规则覆盖，需人工复核。
- SQL 静态解析覆盖 PostgreSQL、MySQL、MariaDB、SQLite 和 SQL Server。Oracle 暂无对应 AST 方言解析器，只进行保守语句与写入关键字检查，不能自动校验列是否存在。
- 静态检查不是数据库权限控制，也不保证语法正确；最终仍需按当前数据库和用户权限验证。
- 用户需求、SQL、错误信息和 Schema 名称都按不可信输入处理。模型输出必须符合结构化 JSON；格式错误时最多进行一次修复请求。
- 连接切换、面板关闭、取消和 Renderer 销毁都会中止或丢弃旧请求，不会将旧结果应用到新连接。
- Rerank 仅接收显式同意后的 Schema 元数据和有上限的自然语言查询；补全 IPC 仅读取当前候选表的列结构。

## 验证记录

2026-11-22 增加 PostGIS geometry 测量单位策略检查：EPSG:4326 的面积草稿会因角度单位被阻断并返回澄清；AI 包 94/94、全工作区 419 项通过和 6 项既有 CLI 跳过，`pnpm typecheck` 与 `pnpm build` 通过。详见 `docs/ai-sql-test-report.md`。

2026-11-11 增加只读 SQL 副作用拦截和列级 Schema 检查后，AI 包 38 项测试通过；当前工作区全量回归为 217 项通过、4 项 CLI GIS 条件测试跳过。Oracle 因缺少 AST 方言解析器不做自动列存在性校验。具体用例及边界见 `docs/ai-sql-test-report.md`。

截至 2026-11-03：

- `@db-studio/ai` 27 项单元测试通过；覆盖 Provider 错误与流式、Rerank/Embedding、SQL 静态校验、Mongo 查询安全、敏感上下文裁剪和恶意 Schema 注释回归。
- `@db-studio/database` 构建和类型检查通过，25 项单测通过。桌面端 13 项测试通过，覆盖表/列补全、Schema 限定名、别名、多表 CTE 投影、CTE 链和派生表列。
- `pnpm typecheck` 和 `pnpm build` 均通过。2026-11-03 `pnpm test` 为 113 项通过、3 项跳过。Vite renderer bundle 约 2.17 MB 并发出 chunk warning。
- PostGIS AI 元数据集成冒烟通过：PostGIS 3.6.4，geometry/geography 字段与 SRID 4326 检测、12 个空间函数/签名解析、表/字段备注读取均通过；临时表已由脚本 finally 清理。
- SQL 方言集成矩阵通过：基于实时 Schema 在 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 生成 COUNT 查询并分别实际执行，均返回 2 条合成记录；PostGIS 读取真实 geometry 元数据后生成并执行 `ST_DWithin`，返回 2 个范围内要素。Oracle 因无 AST 方言解析器，引用表的自动 AST 列表不可用，但生成 SQL 仍在 Oracle 上成功执行。
- SQL 修复错误回路覆盖 10 类真实错误：缺表、缺列、标识符大小写、方言语法、JOIN 条件、GROUP BY、日期函数、SQL 参数、PostGIS SRID 与几何类型。loopback 确定性模型生成修复草稿后，静态验证和实际数据库结果均符合预期；这验证服务链路，不评估外部模型的修复质量。
- MongoDB 独立 AI 助手集成通过：在授权的 MongoDB 7.0.45 项目容器上执行 Find 与 Aggregate 草稿，使用 loopback 确定性模型并清理唯一测试集合。
- CLI Node 26 实际启动检查通过，`ai models list` 不输出密钥，`ai sql --help` 可用。该检查同时覆盖 `node-sql-parser` CommonJS 导入。
- DashScope 实际冒烟通过：合成 Schema 上的 Qwen SQL 草稿通过只读和对象校验，`text-embedding-v4` 返回 1,024 维，Rerank 将相关合成文档排在无关文本之前。请求未包含真实数据库 Schema，也未建立真实 Schema 向量索引。
- P1-B 已增加执行计划解释任务：GUI 粘贴数据库客户端生成的计划，CLI 使用 `ai sql explain-plan --file <sql> --plan-file <plan>`。两种入口均不执行 SQL，并限制计划文本为 12,000 字符；系统提示区分规划估算与用户提供的实测值，不生成可插入 SQL 草稿。
- SQL 优化目前只给静态建议；应用不自动执行 `EXPLAIN` / `ANALYZE`。执行计划解释依赖用户从数据库客户端提供的计划文本。SQL 补全支持简单 CTE 链、多表 CTE 的显式投影和单表派生子查询；多来源 `SELECT *`、复杂投影、嵌套查询及方言差异仍有限。
