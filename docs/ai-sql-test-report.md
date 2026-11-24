# AI SQL Assistant 测试报告

更新日期：2026-11-22

## 2026-11-21 独立 CLI 生成、修复与解释实时验收

- `pnpm run test:integration:ai-cli-sql-assistant` 完成共享、数据库、GIS、Core、AI 与 CLI 依赖构建，并使用应用 DPAPI 加密的 Chat 配置，对独立 CLI 的 `ai sql generate`、`repair`、`explain` 各执行一次真实 DashScope 调用；三条命令均退出码 0。生成和修复 SQL 通过 CLI 校验，解释命令返回说明文本。
- 数据库是临时 SQLite 文件，只包含合成 `main.customers(customer_id, city, created_at)` Schema、0 行数据。修复夹具同时包含有效 `city` 和合成错误列 `unknown_column`；返回 SQL 保留 `city` 并移除错误列。没有读取业务行或执行模型生成 SQL。
- 云端仅收到合成 Schema 元数据与测试意图；凭据、连接 URI、SQL 内容及完整模型响应均未写入机器证据。临时数据库与夹具已清理。脱敏机器证据：[CLI SQL 助手](../.cache/ai-cli-sql-assistant-2026-11-21-82ca578cf07c.json)。
- 这是三条 CLI 路径的单次真实链路验收，不代表不同数据库方言或任意用户查询的普遍正确性；模型输出仍需由用户审阅。

## 2026-11-21 多表关系不明时返回澄清

- 真实 DashScope CLI 验收发现，任务书要求在关系未知时停止猜测，但实现契约不允许 generate 响应返回空 SQL：解析器会把澄清视为无效结构；回归脚本也会把澄清当作 explain 结果检查。现已允许带有说明的空 SQL 澄清响应、明确提示模型缺少外键/明确连接条件时不要生成 JOIN，并修正 CLI 集成脚本检查顺序。
- AI 包新增回归覆盖空 SQL 澄清且跳过本地 SQL 校验器。AI 包完整测试在允许本机 loopback mock 的环境下通过 93/93；AI 类型检查、共享依赖构建和 CLI 构建通过。
- `pnpm run test:integration:ai-cli-sql-assistant` 通过四条真实 DashScope 场景：generate、repair、explain、ambiguous-relationship。最后一项返回关于 `purchaser_customer_id` / `recipient_customer_id` 的澄清，没有 SQL 草稿且没有进入 SQL 校验。临时 SQLite 仅含合成 `customers` 与 `orders` Schema、0 行；本地执行一条预期失败的只读 SQL 以捕获 SQLite 列错误，并执行两个只读零行计数。模型生成 SQL 未执行，数据库凭据/连接 URI 未发送；DashScope API key 仅用于授权头且没有写入证据。完整模型响应未记录，临时文件已清理。机器证据：[CLI 澄清集成摘要](../.cache/ai-cli-sql-assistant-2026-11-21-96303df91fb8.json)。
- 这验证了该明确的模糊关系案例和本次模型响应；不能保证任意模型/提示都始终遵循约束。关系提示提供确定性指引，但 SQL 校验器不负责证明 JOIN 语义正确，输出仍需审阅。

## 2026-11-15 六引擎 SQL 修复过滤条件保留复验

- 前一批真实执行矩阵发现，部分模型响应会在修复缺列时遗漏 `id = 1` 过滤；另一次 Oracle 请求遇到 Provider 故障。修复提示现要求只修改报错所需 SQL，并原样保留 WHERE/HAVING 条件、比较符、字面值或参数占位符、布尔分组及作用域。
- 更新后的 `pnpm test:integration:ai-sql-repair-execution-matrix` 完成工作区依赖构建，PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 六个真实隔离数据库场景全部通过（6/6）。每条候选 SQL 先通过只读/Schema、随机来源表及 `id = 1` 保留检查，再在隔离库执行并返回预期的一行合成结果；全部临时表已删除。
- DashScope 只接收随机合成表 Schema、合成缺列错误和测试意图。输出不记录 SQL、模型响应或凭据，并确认 `businessRowsSent=false`、`credentialsSent=false`、`responseContentLogged=false`。该结果覆盖此六种方言的单列修复样例；模型输出仍可能波动，不代表任意业务查询的正确率。

## 2026-11-11 只读副作用与列级 Schema 校验

- 静态验证新增对 `SELECT … INTO` 写入目标、行锁读取（如 `FOR UPDATE` / `LOCK IN SHARE MODE`）、常见序列/会话状态函数及 PostgreSQL advisory locks / MySQL `RELEASE_ALL_LOCKS()` 的确定性拒绝，覆盖 PostgreSQL、MySQL 和 Oracle 写法。注释、字符串和带引号标识符中的相同文本不会触发规则；Oracle `SELECT … INTO` 也不依赖 AST 解析器。
- 新增 6 个副作用拒绝场景和引用标识符不误报断言。解析器支持的方言会将 AST 列引用与实时表结构对照；校验覆盖限定表名/别名、`ORDER BY` 输出别名、CTE 输出名和 `COUNT(*)`，并验证 CTE 显式列名不会掩盖其查询体中的缺失源列。新增回归防止输出别名全局豁免同名物理列（包括 CTE 查询体）。Oracle 没有 AST 方言解析器，因此不能自动进行列存在性检查。
- AI 包 3 个测试文件 / 38 项通过，工作区全量 `pnpm test` 为 217 项通过、4 项 CLI GIS 条件测试跳过；`pnpm typecheck` 和 `pnpm build` 均通过。PostgreSQL `pg_try_advisory_lock`、`pg_advisory_unlock_all` 与 MySQL `RELEASE_ALL_LOCKS()` 也由副作用回归确认拒绝。构建仍提示 renderer 主 chunk 为 2,226.20 kB（683.72 kB gzip）。
- 规则是已知副作用形式的静态拦截，不是数据库权限边界或完整 SQL 安全证明；解析器和函数清单未覆盖的厂商语法仍需人工复核。

## 2026-11-11 优化建议证据来源标记

- SQL 优化任务现在明确为静态 SQL 审查：提示词要求建议关联实际 SQL/Schema、指出证据缺口和权衡；有执行计划时拒绝走静态优化入口，并引导使用执行计划解读。
- 服务端确定性添加 `evidenceBasis=static-review` 与“未读取执行计划、未运行查询或 EXPLAIN”的警示。执行计划解读确定性添加 `evidenceBasis=user-supplied-plan` 与“计划由用户提供，本应用未执行 SQL/EXPLAIN”的警示。桌面结果卡显示相应标签，不依赖模型自行声明证据来源。
- `pnpm --filter @db-studio/ai test`：3 个文件、36 项通过；AI 包类型检查、构建及桌面端类型检查通过。受限运行首次因 loopback 沙箱策略未能启动本地 HTTP mock；在授权的宿主测试环境重跑通过。
- 这只能区分静态审查和用户粘贴计划两种证据来源，不证明优化建议确实提升性能；仍需在目标数据库评估查询和执行计划。

## 2026-11-11 桌面连接密文恢复保护

- 当连接配置密文无法由当前系统解密时，桌面端新增用户确认的“备份并重建”入口。主进程复核配置不可读后，以不覆盖的名称保留原始密文字节，再创建空的安全存储；可读文件、缺失文件或安全存储服务暂不可用时不执行重置。
- 5 项连接存储恢复回归通过，包括解密后非对象数组的损坏载荷判定；桌面端完整测试 8 个文件 / 50 项通过，typecheck 和构建通过。Vite 有约 2.22 MB renderer chunk 提示。覆盖测试未操作用户 AppData；实际安装版 GUI 尚未验收。

## 2026-11-11 渲染端到主进程 AI 取消契约

- 新增桌面跨层契约测试，把 React 请求生命周期 helper 与 Electron 主进程 operation registry 接在一起，验证连接切换及面板关闭会触发主进程 AbortSignal、旧请求结果失效、非所属 renderer 无法取消请求，以及 requestId 冲突不会覆盖活动请求。
- `pnpm --filter @db-studio/desktop test`：9 个文件、54 项通过；桌面端 typecheck 通过。该测试确认取消 IPC 两端的本地契约，不等于在可见安装版 GUI 中触发取消。安装版 GUI 验收仍受 Windows Computer Use `GetCursorPos failed: 拒绝访问 (0x80070005)` 阻断。

## 2026-11-11 DashScope 在线回归

- `pnpm run test:integration:ai-provider` 通过：Chat 生成与修复的只读/Schema 校验有效；静态优化结果不含 SQL 字段或 SQL 验证对象；Embedding 返回 1,024 维；Rerank 将相关的合成 Schema 文档排在无关文档之前。
- `pnpm run test:integration:ai-provider-dialects` 通过 7/7：PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 和 PostGIS 合成场景均通过只读检查及所需方言断言。
- `pnpm run test:integration:ai-provider-repair-quality` 通过 6/6：覆盖 PostgreSQL 缺列、MySQL/SQL Server/Oracle/SQLite 分页语法修复及 PostgreSQL 标识符引用。
- 所有请求只发送合成 `ai_smoke_places(id, label)` Schema 和合成意图。脚本不记录模型响应或 SQL，不执行生成 SQL，也不发送业务行、数据库凭据或连接 URI。此证据不等同于复杂生产 Schema 的正确率评估或可见桌面 IPC 验收。

## 自动化验证

| 验证 | 结果 | 范围 |
|---|---|---|
| `pnpm --filter @db-studio/ai test` | 56 项通过（2026-11-12） | Provider 错误分类、超时/取消、8 MiB JSON/SSE 响应上限、16 KiB 错误正文截断、本地 Embedding、维度/索引校验、密钥脱敏、PostGIS 上下文、SQL 副作用与列级 Schema 静态校验、Schema 索引/Rerank、安全上下文裁剪与注入输出拒绝 |
| `pnpm run test:integration:ai-provider-cancel` | 通过 | 配置的 DashScope Chat 流式响应收到首个 delta 后取消；Provider 返回 `code=cancelled`；仅发送合成提示，不发送 Schema，未记录响应正文 |
| `pnpm run test:integration:ai-provider-auth-failure` | 通过 | DashScope Embedding 与 Rerank 使用临时无效测试密钥分别返回 HTTP 401；Provider 分类为 `provider` 并脱敏。仅发送合成文本，不修改加密配置，不输出响应正文 |
| `pnpm test:integration:ai-sql-repair-execution-matrix` | 6/6 通过（2026-11-15） | 六引擎真实缺列修复；保留 `id = 1` 过滤并在项目隔离数据库执行，临时表清理通过；只发送合成 Schema / 错误 / 意图，不记录响应正文或 SQL |
| `pnpm run test:integration:ai-provider-repair-quality` | 通过 | DashScope 修复 PostgreSQL 缺失列和 MySQL `TOP` 方言错误；输出仅经静态检查，不执行 SQL，不记录 SQL 正文 |
| `pnpm run test:integration:ai-provider-dialects` | 最新整轮 7/7 通过 | DashScope Chat 对 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 和 PostGIS 生成合成查询；静态只读校验通过，不执行或记录 SQL 正文。Oracle 曾在一次整轮运行中返回无效结构化输出，后续单项和整轮重跑通过 |
| `pnpm --filter @db-studio/desktop test` | 58 项通过（9 个文件，2026-11-11） | 布局、SQL Schema 补全上下文、表/列别名、CTE 投影、AI 请求替换/上下文隔离/作用域切换取消及主进程取消注册竞态 |
| `pnpm test` | 253 项通过，4 项 CLI 条件测试跳过（2026-11-12） | 全工作区 7 个测试项目；CLI GIS 用例因本次测试进程未配置 GDAL runtime 跳过。受限沙箱中的 loopback mock/SSH fixture 先报 `EACCES`，在用户已授权的宿主 loopback 环境重跑通过 |
| `pnpm typecheck` | 通过（2026-11-11） | 工作区全部可类型检查包 |
| `pnpm build` | 通过（2026-11-11） | 工作区构建；Vite 仍提示主 renderer chunk 为 2,226.20 kB（683.72 kB gzip） |
| `pnpm test` | 217 项通过，4 项跳过（2026-11-11） | 工作区 7 个测试项目；CLI 4 项因本次进程未配置 GDAL Runtime 跳过。默认沙箱禁止 loopback，授权宿主环境重跑后全套通过 |
| `pnpm test` | 124 项通过，3 项跳过 | 2026-11-04 完整工作区回归；跳过项是当前进程未显式配置 GDAL Runtime 时的 CLI GIS 测试 |
| `pnpm typecheck` / `pnpm build` | 通过 | 2026-11-04 工作区类型检查与生产构建；Vite 仍报告约 2.17 MB renderer chunk 提示 |
| `pnpm test` | 137 项通过，3 项跳过 | 2026-11-05 新增 Provider 认证故障与向量维度回归后的工作区测试；跳过项仍为缺少显式 GDAL Runtime 的 CLI GIS 用例 |
| `pnpm typecheck` / `pnpm build` | 通过 | 2026-11-05 全工作区类型检查和生产构建；renderer chunk 为 2,167.36 kB，保留 Vite 提示 |
| CLI 执行计划命令帮助 | 通过 | `node apps/cli/dist/index.js ai sql explain-plan --help` 显示 SQL 文件和计划文件参数；没有连接数据库或执行计划 |
| PostGIS AI 元数据集成 | 通过 | 隔离 PostGIS 3.6.4 服务；geometry/geography、SRID、函数签名及备注，临时表清理通过 |
| `pnpm run test:integration:ai-sql-dialects` | 通过 | PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 基于实时 Schema 生成 SQL 并在隔离数据库执行，均返回预期 2 条合成记录；PostGIS 从真实空间元数据生成 `ST_DWithin`，返回 2 条；临时对象和 SQLite 文件清理通过 |

## 2026-11-12 Provider 响应体资源上限

- Provider 先前对成功 JSON 和 HTTP 错误响应直接调用 `response.json()` / `response.text()`，流式 Chat 也会持续累积 SSE 内容。现在成功 JSON 上限为 8 MiB、错误正文上限为 16 KiB、流式响应上限为 8 MiB；读取成功响应时采用有界 reader，超限后取消流并返回 `response` 错误，超大的错误正文只保留有界脱敏诊断并标记截断。
- 新增 loopback 回归覆盖超大普通 Chat JSON、128 KiB Provider 错误正文和超大 SSE 帧；确认不会把超大 Chat delta 发给调用方。AI 包测试为 56/56 通过；全仓 `pnpm test` 为 252 项通过、4 项 CLI GIS 环境条件跳过；`pnpm typecheck`、`pnpm build` 均通过。构建仍有既有 Node stream/zlib externalization 和 renderer chunk advisory。
- 这些限制约束客户端读取和累积的响应体积，不限制 Provider 在网络对端已生成的内容，也不替代超时、取消或模型 `max_tokens` 设置。
| `pnpm run test:integration:ai-sql-repair` | 通过 | 10 类修复场景在 PostgreSQL/PostGIS 与 SQLite 上观察真实错误、调用共享修复服务、静态校验并执行修复结果；所有结果符合合成数据预期，临时对象和 SQLite 文件清理通过 |
| `pnpm run test:integration:mongodb-ai` | 通过 | 隔离 MongoDB 7.0.45；本地模拟模型生成 Find 与 Aggregate 草稿，两个只读查询均成功，随机测试 Collection 清理通过；未访问外部模型 |

### SQL 生成方言矩阵（2026-11-03）

集成脚本在六种关系型数据库中各创建唯一合成表，写入两条 `active` 和一条 `inactive` 记录，再通过真实 Core Service 读取服务器版本、Schema、列名、类型及键元数据。loopback 确定性模型按当前引擎生成 COUNT 查询；静态验证后实际在对应数据库执行，六种方言均返回 2。PostGIS 分支另建 `geometry(Point, 4326)` 表，从 `geometry_columns`、`pg_extension` 和 `to_regprocedure` 读取真实空间元数据，生成并执行 `ST_DWithin` 查询，返回 2 个距离范围内要素。MongoDB 使用独立 Find/Aggregate JSON 流程，见上方 Mongo 集成行。

Oracle 当前缺少 SQL AST 方言解析器，因此其对象引用检查是保守校验，不能依赖解析器返回的 `referencedTables`；本次仍验证生成语句引用所选合成表，并通过 Oracle 实际执行得到预期结果。矩阵没有调用外部模型服务。

### SQL 修复错误回路（2026-11-03）

`pnpm run test:integration:ai-sql-repair` 覆盖缺表、缺列、混合大小写标识符、PostgreSQL 方言语法错误、缺失 JOIN 条件、GROUP BY、SQLite 不支持的日期函数、缺失参数、PostGIS SRID 不一致和几何类型不匹配。每个初始查询先在真实隔离数据库执行并捕获错误，再将该错误、当前 SQL 和实时 Schema 交给共享修复服务；本地确定性模型生成预设的只读修复，静态验证通过后再次在对应数据库执行。10 项结果均符合合成数据预期，临时表和 SQLite 文件已清理。

该确定性回路验证输入上下文、结构校验和数据库执行路径；它不代表真实云端模型对这些错误的理解或修复质量。没有把这些新建测试 Schema、错误信息或 SQL 发送到外部模型。

### AI 请求生命周期竞态（2026-11-04）

- 连接切换现在在 React 提交阶段同步取消旧 AI 请求并更新连接身份；关闭面板或卸载面板时也在布局清理阶段取消请求。
- 成功和错误响应都必须同时匹配当前请求 ID 与当前连接 ID。新增桌面单元测试覆盖当前请求通过、请求被替换以及旧连接响应被拒绝。
- `pnpm --filter @db-studio/desktop test` 的 16 项、全工作区 `pnpm test` 的 117 项通过；`pnpm typecheck` 与 `pnpm build` 通过。
- 本测试覆盖请求有效性判定和代码构建，没有在可见 Electron 窗口中人工切换连接/关闭 SQL 页面触发 IPC 取消；该桌面交互验收仍待完成。

### 主进程取消注册竞态（2026-11-04）

- SQL 与 MongoDB AI IPC 在读取模型配置和连接信息前注册 requestId，`ai:cancel` 可在这些异步步骤进行时定位对应 AbortController；连接和设置查找结束后会检查 abort 状态，再继续数据库元数据或模型调用。
- 重复 requestId 现在被拒绝；取消限定于发起 IPC 的 sender；清理仅删除创建该 map 项的同一个 operation，避免迟到的 finally 清除复用 ID 的新请求。
- 新增 3 项桌面测试，覆盖 setup pending 时取消、重复 ID 及 sender 隔离/identity-safe cleanup。桌面测试 19/19、全工作区 124 passed/3 skipped、`pnpm typecheck` 和桌面生产构建通过。
- 这组单测和打包确认不等价于可见 Electron IPC 验收。用户已授权启动最新版，但 Computer Use 运行时在窗口枚举前初始化失败；连接切换和关闭助手的可见窗口验收仍待完成。

### MongoDB AI 作用域取消与隔离启动复验（2026-11-05）

- Mongo AI 抽屉原先只在关闭时取消 IPC；连接、数据库、Collection 或 Find/Aggregate 模式变化时，迟到响应可能覆盖当前目标的结果。新增请求生命周期管理器后，这四种作用域变化会在 React 布局阶段取消活动 requestId；成功/错误响应仅在 requestId 和作用域都仍匹配时处理，关闭/卸载也会取消。
- 桌面测试扩展到 26 项，新增 7 项请求生命周期断言，覆盖四种作用域变化、相同作用域不取消、替换请求、迟到完成以及关闭/卸载清理。`pnpm --filter @db-studio/desktop typecheck` 和生产构建通过；renderer 仍有约 2.17 MB chunk 提示。
- Electron 主进程新增 `DBSTUDIO_USER_DATA_DIR` 支持：按 [Electron `app.setPath` 要求](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path)，在 `ready` 前创建并设置独立 `userData` 和 `sessionData` 目录。用官方静态 GDAL 配置重建了独立 NSIS 包，安装器 SHA-256 为 `CA25034E097EB4F4FF2CEFA2406724FAAD0BF0F8691C1AD416B2972A0B1A45CE`，`app.asar` SHA-256 为 `4F6ACFB2E4D61EA99A1B1ADB8909DFEFEA8E0A145EBD86F3CB72ED314C929FCA`。归档检查确认 main bundle 含隔离目录覆盖，renderer bundle 含作用域更新逻辑。
- 本轮启动的是该 NSIS 包匹配的 `win-unpacked` 程序，并设置隔离目录 `.cache/installer-smoke/ai-cancel-lifecycle-20261105`；运行后观察到 `session` 缓存目录，且没有连接或模型设置文件。Computer Use 能枚举到新窗口，但截图两次均报 `GetCursorPos failed: 拒绝访问 (0x80070005)`；没有发送 UI 输入，也没有运行新 NSIS 安装器。安装版连接切换/关闭时的可见 IPC 取消验收仍待完成。
- 后续按即时授权复验安装版：窗口清单中已存在 `.cache/installer-smoke/ai-cancel-nsis-installed-20261105-r1/DB Studio.exe` 进程。绑定并重新枚举后重试窗口捕获，均返回 `GetCursorPos failed: 拒绝访问 (0x80070005)`；未发送 UI 输入。重新运行 `pnpm --filter @db-studio/desktop test` 为 4 个文件、26 项通过，覆盖作用域切换、关闭/卸载取消和主进程注册表，但可见安装版 IPC 行为仍无法验收。

### DashScope 流式 Chat 取消（2026-11-05）

- 新增 `pnpm run test:integration:ai-provider-cancel`。脚本从当前用户 DPAPI 加密设置读取已启用 Chat 模型，强制使用流式响应，以合成提示请求一段长文本，并在首个 delta 到达时立即触发 AbortController。
- 新增的 loopback 回归在同一 HTTP 响应块中放入多个 SSE frame，并在首个 delta 回调中 abort，复现 Provider 仍继续送出第二个 delta。根因是取消异常被 malformed-frame catch 当作解析错误吞掉。修复后，Provider 在每个 delta 回调后检查取消状态，并将 JSON 帧解析错误与取消错误分开处理。
- Loopback 回归覆盖首帧回调取消且同一 HTTP 缓冲块含后续 delta；`pnpm --filter @db-studio/ai test` 31/31、类型检查和构建通过。在线脚本收到一个 delta 后以 `code=cancelled` 结束；只发送了合成文本，未发送 Schema，脚本不输出或保存响应正文。
- 在线脚本首次运行的断言误用了 `kind` 字段；按 Provider 的实际 `code` 错误契约修正后，真实 DashScope 冒烟通过。
- 这验证本机客户端在流式传输中的取消和响应拒绝；无法证明服务端在收到断连后停止计算或计费。可见 Electron IPC 取消验收仍待完成。

### Embedding / Rerank 在线认证故障注入（2026-11-05）

- 新增 `pnpm run test:integration:ai-provider-auth-failure`，从 Windows 当前用户 DPAPI 配置读取启用的 Embedding 和 Rerank 模型，但仅把内存中的 API Key 替换为无效测试值后发起请求；原加密配置不变。
- DashScope 对两类请求分别返回 HTTP 401。Provider 将两者分类为 `code=provider`，异常消息不包含无效测试 Key 或已保存 Key。脚本只输出错误类别、状态码和脱敏布尔值，不输出响应正文。
- 请求正文只有合成文本，不发送 Schema、数据库数据或连接信息。AI 包测试 34 项通过，AI 包类型检查、AI 与 CLI 构建通过，在线故障注入通过；工作区 `pnpm test` 为 137 项通过、3 项跳过。
- 当前只验证真实服务的认证失败路径。实时 404、超时、断连和 Rerank 非法响应仍未在远程服务上注入；本地回归覆盖 Embedding 维度不匹配和 Rerank 重复索引拒绝。服务端错误行为或格式变更仍需后续检查。

### DashScope SQL 修复质量冒烟（2026-11-05）

- 扩展 `pnpm run test:integration:ai-provider-repair-quality`，使用当前用户 DPAPI Chat 配置覆盖 PostgreSQL 缺失列、MySQL `TOP`→`LIMIT`、SQL Server `LIMIT`→`FETCH`、Oracle `TOP`→`FETCH`、SQLite `TOP`→`LIMIT` 和 PostgreSQL 反引号标识符六个合成修复场景。
- 2026-11-06 重跑结果为 6/6 通过共享 `runSqlAssistant` 的只读及 supplied-Schema 静态校验。集成脚本只记录场景名、成功状态和校验状态；不输出模型响应或修复 SQL，也不执行 SQL。
- 请求只发送合成 `ai_smoke_places(id, label)` Schema 与合成 SQL/错误/意图。此结果只覆盖六个窄场景，不代表所有修复类型、在线故障恢复或复杂业务 SQL 均已通过。

### DashScope SQL 方言生成质量冒烟（2026-11-05）

- 新增 `pnpm run test:integration:ai-provider-dialects`，对 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 和 PostgreSQL/PostGIS 逐项调用 DPAPI 配置的 Chat 模型。
- 六种关系型方言均生成“按 id 排序返回第一条”的查询草稿，并匹配各自分页语法与只读/Schema 静态校验；PostGIS 场景使用合成 geography(Point, 4326) 元数据，生成含 `ST_DWithin`、SRID 4326 和 2500 米参数的草稿并通过校验。
- 发送内容仅为合成 `ai_smoke_places` 表结构和测试意图；SQL 没有执行或记录。最新整轮 7/7 通过。Oracle 曾在一次整轮运行中返回无效结构化输出；单项和后续完整重跑均通过。测试器逐项打印脱敏状态，便于保留部分通过证据。
- 这是七种引擎的窄场景在线质量证据，不替代隔离数据库真实执行矩阵，也不代表更复杂查询的模型准确率。

## 实际云端冒烟（2026-11-02）

使用本机已保存的 DPAPI 加密模型配置，实际调用 Chat、Embedding、Rerank。Chat 对合成 Schema 生成 SQL，并修复一条 PostgreSQL `TOP` 方言错误；生成和修复结果均通过只读/表字段静态验证。Embedding 返回一条 1,024 维向量；Rerank 在两条合成文本中将 Schema 文档排在无关天气文档之前。脚本仅输出成功状态、向量维数和排序索引，不输出 Key 或生成 SQL。

该测试证明本次调用的凭据、网络和服务端接口可用；它没有使用真实数据库 Schema 建立 Embedding 索引，也没有评价复杂业务 SQL 的准确性。真实模型生成/修复 SQL 未执行；隔离数据库执行覆盖由本地确定性模型的独立集成测试完成。

## 桌面端真实 Schema RAG + Rerank 验收（2026-11-02）

- 在主机启动静态 GDAL 的 unpacked Windows Electron 构建，并使用隔离的 Electron 用户数据。通过项目专属 PostgreSQL/PostGIS loopback 服务 `127.0.0.1:25432`，对 `dbstudio_test` 中的 `ai_rag_acceptance_20261102` Schema 做 GUI 验收。
- 按用户明确授权，仅选取 `land_use_lookup`、`parcel_inventory`、`parcel_sales` 三张表的 Schema 元数据，未读取或发送业务行、数据库密码或连接 URI。模型设置沿用已启用的 DashScope `text-embedding-v4`、`gte-rerank-v2` 和 `qwen3.6-flash`。
- GUI 确认建立了 3 张表的 1,024 维本机语义索引。随后真实 GUI IPC 请求完成了 Embedding 检索、Rerank 候选排序和 Chat SQL 生成；结果未出现“Schema Rerank 暂不可用”的本地回退警告。
- Chat 返回 PostgreSQL 只读草稿，引用三张获准的表，按 `sold_at` 的 2025 年半开区间过滤，连接 `parcel_id` 和 `zone_code`，按 `land_use_name` 汇总 distinct parcel 数和 `sale_amount`，降序取前五。结果在预览中显示，检查提示说明静态检查不能替代数据库权限或人工审查。未插入编辑器，也未执行生成 SQL。
- RAG/SQL IPC 流程本身在主机上的 unpacked 构建验收。之后构建并安装了同一静态 GDAL 发行目录生成的 NSIS 包，且安装版 `app.asar` 与 unpacked 构建哈希一致。用户另行授权后，安装版通过应用本机安全存储保存隔离 PostGIS 连接并成功连接 `dbstudio_test`；GIS 页通过安装版 IPC 读取 `points.geojson` 元数据并导入 `public.gui_ipc_geojson_20261102`，UI 报告 2/2 成功。PostGIS 只读回读确认 2 行、1 个 EPSG:4326 Point 和 1 个 NULL 几何，属性值为合成中文测试值。安装版 AI/RAG IPC 与本轮 GIS 导出尚未验收；导出保存步骤遇到 `GetCursorPos failed: 拒绝访问 (0x80070005)`，未生成输出文件。此验收也不构成干净 Windows 环境或复杂业务需求准确率评估。

## 当前未关闭验收项（2026-11-17）

- 当前源码的 SQL 生成已在七个隔离数据库引擎真实执行；修复已覆盖六引擎缺列、缺表、日期函数、参数占位符和过滤条件保留，以及 PostgreSQL/PostGIS JOIN 聚合、混合 SRID 和几何函数类型场景。具体场景与安全 guard 见下方 2026-11-13 至 2026-11-15 记录。模型输出仍可能波动，这些合成场景不等同于任意生产 SQL 的正确性证明。
- 当前 DashScope Chat、Embedding、Rerank 配置和最小在线请求已复验，合成 Schema 的 Embedding/Rerank 隔离测试通过。2026-11-16 以故意无效的测试密钥对三类 Provider 做真实远端鉴权失败验收，均返回401且错误消息不泄露密钥；Chat 另通过了不可解析 `.invalid` Base URL 的 `network` 分类与1 ms客户端超时分类。2026-11-17 的真实流式取消冒烟已收到 DashScope 首个内容片段（560 ms）后调用 AbortController，客户端返回 `cancelled`。这验证请求已送达且客户端中止处理正常，但不能证明 DashScope 服务端停止计算或计费。新增实时无效路径检查收到 DashScope HTTP 404，Provider 正确归类为 `provider` 且未输出密钥或响应正文；这关闭了一个实际 HTTP 端点错误分类缺口。2026-11-17 又完成北京 Key 到新加坡官方域名的地域不匹配验收，HTTP 401 被分类为 provider（详见下节）；DashScope 实际 Rerank 非法响应仍未验收；本地 `assistant.test.ts` 63/63 通过，覆盖畸形/重复 Rerank 项及响应体、超时、取消和密钥脱敏。
- 执行计划解释的七方言合成矩阵现已 7/7 通过；针对此前 Oracle 调用超过 60 秒的情况，验收脚本新增 1,000–300,000 毫秒可配置超时，本次使用 180,000 毫秒。最新记录见[结果](../.cache/ai-cli-explain-plan-online-last.json)。隔离 PostGIS 事务中的 JOIN/聚合与 `ST_DWithin` EXPLAIN JSON 计划为 2/2 通过；MySQL/MariaDB JSON EXPLAIN、SQL Server `STATISTICS PROFILE` 实际计划、Oracle DBMS_XPLAN 估算计划又通过 4/4 真实计划解释。SQL Server 的验收脚本执行固定的只读合成 SELECT 以取得实际算子行数，未执行任何用户 SQL；四库合成对象和 Oracle 计划记录均清理。详细结果见 [PostGIS 证据](../.cache/ai-cli-explain-plan-real-postgis-last.json) 和 [多引擎报告](../.cache/ai-cli-explain-plan-real-multidb-last.json)。每引擎仅覆盖一个合成形状，任意生产计划的解释质量仍未证明；产品本身不自动执行用户 SQL，也不执行 `EXPLAIN ANALYZE`。
- Schema RAG 已实现显式多 Schema 选择，索引仍按连接/数据库/单个 Schema 隔离；2026-11-17 合成测试覆盖检索/Rerank、范围清理、无歧义键和跨 Schema Chat。新增实时 PostGIS 集成通过 `CoreService` 加载三个随机合成 Schema 的列、备注和空间类型，再经 DashScope Embedding/Rerank/Chat 生成复杂空间聚合草稿；两个独立聚合 CTE、空间关系、distinct 计数、零道路 LEFT JOIN 路径、阈值和排序断言，以及只读/Schema 静态校验均通过。未读业务行或执行 SQL，四个临时 Schema 均已清理。该测试不经过 Electron IPC；真实桌面 IPC、可见交互和一般生产 SQL 准确率仍未证明。详见 [RAG 范围记录](../.cache/ai-schema-rag-multi-schema-20261117.json)及[PostGIS 实时证据](../.cache/ai-schema-rag-postgis-live-20261117.json)。
- CLI 的表名无命中回退现已覆盖实时 PostGIS 元数据：先按表名/表备注选择；无命中时以并发 8 加载字段名和字段注释，再选最多 8 张表。2026-11-17 隔离测试分别通过字段名与字段注释检索，AI SQL 只发送至 loopback mock，GIS 元数据及只读草稿校验也通过。此项关闭 CLI 对字段名/注释的检索缺口；多 Schema Chat/IPC、桌面交互和复杂业务准确率仍开放。详见 [PostGIS CLI 回归证据](../.cache/ai-cli-column-search-postgis-20261117.json)。
- 当前 E76 MSI 已在 2026-11-17 重新安装，Windows Installer 返回 0，安装版 `app.asar` 与已知构建负载一致，见 `.cache/installer-smoke/install-E76FB992-20261117.log`。受限进程上下文中的启动尝试未存活（其中一次退出 `0x80000003`），但这不是主机桌面启动失败的证据；此前同一 E76 构建负载在主机上下文启动成功，见 [E76 启动复验](../.cache/installer-smoke/current-msi-e76-host-startup-20261116-rerun.json)。本轮尚无可见桌面工作流验收。Mongo AI 抽屉逐项交互和 Monaco 补全键盘验收仍开放。
- 多 Schema MSI `3D1C151C17ED44E34CF229F959BF0D536DB664FB81CC780CF498624C27911D4D` 已安装，安装 `app.asar` 与构建负载匹配；主机隔离配置启动后 renderer 响应，详见[安装启动记录](../.cache/installer-smoke/multischema-msi-install-startup-20261117.json)。当前可见安装版交互仍未验收：Computer Use helper 初始化报 kernel assets 路径不存在，且安装 EXE 的 `EnableNodeCliInspectArguments` Fuse 已禁用，REA 主动场景不能启动此目标（只读证据见[Fuse 记录](../.cache/installer-smoke/multischema-msi-electron-fuses-20261117.json)）。真实数据库元数据加载后的多 Schema Chat/IPC、复杂业务检索正确率、干净 Windows 安装和发行许可审查仍未关闭。
- 随后用户针对 E76 MSI 确认 UAC；该包安装退出码 0，安装版 `app.asar` 与 E76 负载哈希一致，以隔离用户数据启动 15 秒后 4 个进程响应。E76 取代 3D1 多 Schema MSI 成为当前安装版，因此本机当前安装内容不包含 3D1 后续修改。未做 GUI 点击或数据库/模型操作；安装和进程证据见[记录](../.cache/installer-smoke/e76-uac-confirmed-install-startup-20261117.json)。
- 当前源码 MSI 已构建并安装（SHA-256 `ADCCA3BBD20A5E53C3A3E2DCA97008F10993E5AC46DD4839FA225BDF8AE2234F`），包含本轮列注释检索评分修改；安装版 `app.asar` 与发行负载一致。隔离数据目录启动 15 秒后 4 个进程响应。未做 GUI 点击、数据库或模型操作；Computer Use helper 仍无法初始化。详见[构建/安装证据](../.cache/installer-smoke/current-source-msi-cli-column-search-20261117.json)。
- 后续当前源码 MVT MSI `55EDB89A895AB1798988027852FAB47202584694176AB8E4FB9219B3AE274347` 已安装并启动，安装版 `app.asar` 哈希匹配；REA 被动确认 renderer 有 390 个 DOM 节点、1 个 frame、14 个资源和 12 个脚本。该安装没有 GUI 点击、数据库或模型操作；computer-use helper 因 kernel assets 缺失不可用，renderer screenshot 尚未取得。详见[安装启动证据](../.cache/installer-smoke/postgis-mvt-install-startup-20261117.json)及[renderer 观察](../.cache/installer-smoke/postgis-mvt-renderer-inspection-20261117.json)。
- 2026-11-18 当前安装已更新到 transfer-float MSI（SHA-256 `A4CBA1EF491FCCC52371E16B503BF85C8220C13C473C5DBE46AB77D7845241C4`）；Windows Installer 返回 0，隔离启动显示可响应的 DB Studio 主窗口并正常关闭，安装载荷与构建 app.asar 哈希一致。REA 被动读取 renderer 得到 454 个 DOM 节点、14 个脚本和 16 个资源，但未执行脚本或 IPC；未打开数据库或 AI 工作流，也未做点击验收，故这不关闭可见 AI/RAG/IPC 验收项。详见[安装启动证据](../.cache/installer-smoke/transfer-float-install-startup-20261118.json)和[REA 证据](../.cache/installer-smoke/transfer-float-rea-renderer-20261118.json)。
- 随后 renderer 按需拆包 MSI `CA931FA17D37DE1F6D309DC0E2FF8138EF3CE93FBD86C48BF30EE66638A2C7A1` 已安装并隔离启动；Windows Installer 返回 0，安装 `app.asar` 与候选一致，窗口响应正常。REA 后续被动检查捕获 491 个 DOM 节点、14 个脚本和 16 个资源，入口/App chunk 大小与构建证据一致。Computer Use 初始化失败，未做截图或点击，因此功能导航、数据库 IPC 或 AI 工作流仍未验收。详见[安装启动证据](../.cache/installer-smoke/renderer-split-msi-install-startup-20261117.json)和[REA 页面证据](../.cache/installer-smoke/renderer-split-msi-rea-inspection-20261117.json)。

## 2026-11-17 Synthetic cross-schema Chat generation

- Extended `tests/integration/ai-schema-rag-smoke.mjs` to continue from selected-scope Embedding retrieval and Rerank into `runSqlAssistant` using only the two reranked synthetic tables in `public` and `parks`.
- `pnpm test:integration:ai-schema-rag` passed with DashScope: selected-scope retrieval returned 2 tables, Rerank preserved both selected schemas, and Chat produced a PostgreSQL read-only draft referencing `parks.park_areas` and `public.road_segments`. The draft passed the schema/read-only validator. It was not executed.
- Added deterministic validator coverage for a schema-qualified join plus rejection of an unselected schema and an unknown column. `pnpm --filter @db-studio/ai test` passed 83/83; `@db-studio/ai` and `@db-studio/cli` builds passed.
- The request used only hard-coded synthetic table/column metadata and a synthetic spatial join intent; there was no database connection or business data. The initial sandboxed attempt could not resolve the model host; the authorized network-enabled rerun passed. No key or model response body was written to the report.
- This exercises package-level retrieval, Rerank and Chat composition. Loading several schemas from a live database through Electron IPC and visible desktop interaction remain unverified, as do complex business relevance and production SQL correctness. See [sanitized evidence](../.cache/ai-schema-rag-multi-schema-20261117.json).

## 2026-11-17 CLI column-name and comment search

- `cliSqlContext` now preserves table comments and column comments for relevance scoring. If table names and table comments do not match the request and no `--table` was supplied, it loads candidate columns with concurrency 8, then selects at most eight relevant tables. Metadata load failures are surfaced as warnings; foreign keys are fetched only for selected tables.
- Extended `tests/integration/postgis-ai-cli-smoke.mjs` to exercise a live isolated PostGIS schema with a temporary table. Requests matched once by a unique column name and once by a unique column comment, without `--table`; both selected the expected table and supplied the field metadata to the model prompt. The existing GIS request also preserved geometry/geography SRID and `ST_DWithin` metadata and passed read-only validation.
- AI tests passed 84/84; CLI tests passed 23/23 with 6 environment-specific skips. The PostGIS CLI integration passed; both temporary tables were removed and cleanup verified. `pnpm typecheck` and full `pnpm build` passed, including the Desktop renderer. Its model endpoint was a loopback stub only; no business rows, database credentials, or remote model service were used.

## CLI AI 设置共享验收（2026-11-03）

- Windows CLI 现在可读取 DB Studio 的 `ai-models.enc` DPAPI 用户级加密配置；环境变量优先，隔离安装目录可通过 `DBSTUDIO_USER_DATA_DIR` 指向。API Key 仅在进程内存中使用，`ai models list` 只显示配置状态，不输出密钥。
- 2026-11-06 修复默认用户数据目录与 Electron 包名路径不一致的问题：CLI 现在默认从 `%APPDATA%\@db-studio\desktop` 读取，仍支持 `DBSTUDIO_USER_DATA_DIR` 覆盖；新增 Windows DPAPI 回归验证该默认路径。
- 用合成 DPAPI 配置验证了 CLI 配置读取与 `ai models list` 输出脱敏。CLI 计划命令用 loopback 模拟 Chat endpoint 完成真实命令流测试，没有访问外部模型服务。Electron `safeStorage` 格式目前仍需通过环境变量为 CLI 配置模型。
- 验证：`pnpm --filter @db-studio/cli test` 为 16 项通过、3 项跳过；AI Provider 单测为 20 项通过；CLI 类型检查和构建通过。最终工作区 `pnpm test` 为 106 项通过、3 项跳过，`pnpm typecheck` 通过。
- 路径修正后再次验证：CLI 测试 17 项通过、3 项环境相关测试跳过；CLI 类型检查通过；同一 DPAPI 配置驱动的 DashScope SQL 修复冒烟 6/6 通过。
- 外部模型对人工计划的解释质量，以及错误 Key、错误区域 URL、超时、断网和取消的在线服务验收仍待验证。

### DPAPI 模型配置在线连通（2026-11-03）

- `ai models list` 从 Windows 当前用户的 `ai-models.enc` 读取 DPAPI 加密配置，显示 Chat、Embedding、Rerank 均已配置且不输出密钥。
- `ai models test --kind chat` 使用 `qwen3.6-flash` 成功返回最小文本响应；`--kind embedding` 使用 `text-embedding-v4` 返回 1,024 维；`--kind rerank` 使用 `gte-rerank-v2` 通过响应结构检查。
- 三项都是最小连通检查，没有发送项目 Schema、本地 GIS 文件或业务数据库行。CLI 进程环境中没有模型密钥明文变量。
- `pnpm run test:integration:ai-provider` 现可从同一加密配置读取模型，通过 Chat 生成、PostgreSQL `TOP` 方言修复和静态优化字段契约检查；Chat 请求仅使用 `ai_smoke_places(id, label)` 合成 Schema，SQL 经静态检查但没有在数据库执行。Embedding/Rerank 也使用分开的已保存配置。

## MongoDB AI 查询结构（2026-11-03）

- 补充了独立 `runMongoAssistant` 服务和 `ai:mongo-assistant:run` IPC，不再让 MongoDB 文档页只依赖手写 Filter / Aggregate。
- 查询页新增 AI 抽屉，提供 Find/ Aggregate 生成、解释与基于最近错误的修复。每次调用都需勾选上下文发送同意；请求不包含文档样本、连接 URI 或凭据。结果可复制或应用到查询输入框，但不会自动执行。
- 输出校验使用 JSON 解析、深度/节点/长度上限与只读 Pipeline 阶段白名单，禁止 JavaScript 相关运算符、写入阶段和诊断阶段；格式或安全校验失败后只重试一次。
- 自动化验证：Mongo AI loopback 单元测试 6 项通过，覆盖生成、错误修复、解释、未完成输入和 JavaScript/写入阶段拒绝；集成测试在项目专属 MongoDB 7.0.45 容器用合成文档执行模型返回的 Find Filter/Projection/Sort 与 Aggregate Pipeline，结果分别为降序 rank `[3, 2]` 和分组计数 `[2, 1]`，并确认临时 Collection 清理。模型端点为 loopback 确定性响应，没有发送测试结构到 DashScope。
- 随后用当前源码重建静态 GDAL NSIS 安装包。安装器为 unsigned；ASAR 索引已确认包含生产构建的当前 renderer asset。
- 完整工作区验证：`pnpm test` 112 项通过、3 项跳过；`pnpm typecheck` 和 `pnpm build` 通过。Vite 保留既有约 2.17 MB renderer chunk 提示。

## 生成 SQL 的实体计数约束与在线 Schema 复核（2026-11-04）

- SQL 提示现在区分实体数和事件/交易数：一对多连接后统计实体须按实体主键 `COUNT(DISTINCT ...)`，统计事件则按事件行计数；优先利用已知主外键关系，并在关系不足时说明不确定性。回归测试验证提示约束存在。
- 用获准的 `ai_rag_acceptance_20261102` 测试 Schema 和同一查询意图，通过已配置的 DashScope Chat 生成只读 SQL。模型按 `parcel_id` 使用 distinct 实体计数；SQL 静态校验通过，没有执行生成语句。
- 本次 AI 包测试 28/28 通过。发送内容限于此前授权的三张测试表结构和查询意图；未发送业务行、连接 URI 或密码。
- 本节记录时，NSIS 安装版的 GUI IPC 取消验收仍待执行；该项后来于 2026-11-16 使用延迟 loopback 响应完成连接切换和关闭抽屉取消验收，详见 [安装版 AI/RAG 与 IPC 取消验收](#2026-11-16-installed-msi-ai-rag-and-ipc-cancellation)。2026-11-17 定向复跑 `ai-request-guard.test.ts`，12/12 通过；它覆盖渲染层请求生命周期，不代替可见桌面点击或远端服务端取消验收。

## 优化任务结构化输出约束（2026-11-04）

- 使用此前获准的测试 Schema 和合成优化意图调用 DashScope Chat 时，模型在 `optimize` 响应中返回了非空 `sql` 字段，含索引 DDL。该 SQL 没有执行；此调用仅用于检查结构化返回行为。
- 解析器现在仅允许 `generate`、`repair`、`gis` 返回 SQL 字段。`explain`、`explain-plan`、`optimize` 若返回非空 SQL 草稿，服务拒绝该次结构并重试一次；静态建议仍必须区分推测与执行计划证据，应用不会自动执行 `EXPLAIN`。
- 修复后再通过实际 `runSqlAssistant` 调用已配置 DashScope Chat，输入限于合成 `ai_smoke_places(id, label)` Schema 和一个只读过滤查询意图。服务返回静态建议，无 `sql` 字段、无 SQL 校验对象；没有执行 SQL，未发送业务行或凭据。
- 持久化更新 `tests/integration/ai-provider-smoke.mjs`，使该真实 Provider 集成每次执行时也检查 `optimize` 结果字段契约。本次 `pnpm run test:integration:ai-provider` 中生成、修复、优化约束、Embedding 1,024 维及 Rerank 全部通过，仅发送合成 Schema。
- 新增 loopback 回归：首个 `optimize` 响应违反字段契约，第二次正确返回解释文本；服务最终不返回 SQL 草稿或 SQL 验证结果。AI 包测试 30/30、全工作区测试 121 项通过 / 3 项跳过；类型检查和生产构建通过。
- 当前源码已打包到隔离输出目录的 NSIS 安装包。静态 GDAL 清单的 289 个文件均与候选运行时的大小和 SHA-256 匹配；从 `app.asar` 提取打包后的 AI 助手模块，确认包含非 SQL 任务字段拒绝和无 SQL 字段提示。安装版 GUI IPC 行为尚未复验，因为 Windows 桌面控制运行时初始化失败。

## DashScope CLI 实时验收（2026-11-05）

- 清除 CLI 子进程模型环境变量覆盖后，`pnpm test:integration:ai-provider` 从当前用户加密设置读取模型并通过：Chat 生成和修复均通过只读/schema 校验；静态优化结果不含 SQL 字段或 SQL 校验对象；Embedding 返回 1,024 维；Rerank 将合成 Schema 文档排在无关文档之前。
- 输入只包含合成表 `public.ai_smoke_places(id, label)` 及合成查询/错误意图；没有真实 Schema、业务行、连接 URI 或凭据发送到模型，没有执行生成的 SQL。
- 新增 `pnpm test:integration:ai-cli-explain-plan-online` 真实 Chat 验收：使用合成 SQLite 查询/执行计划与 `:memory:` 数据库，解释长度 686 字符，不含 `sql` 字段；脚本断言查询未执行并清理临时文件。摘要见 `.cache/ai-cli-explain-plan-online-last.json`。
- 本次后续全工作区回归 `pnpm test` 为 126 项通过、3 项环境相关跳过；`pnpm typecheck` 通过。
- 实时模型测试不等于可见桌面交互验收；连接切换和关闭助手时的 Electron IPC 取消仍待 GUI 控制恢复后复核。

## 2026-11-09 DashScope provider 集成复验

- 先将用户授权的 Chat、Embedding、Rerank 配置写入默认桌面配置并按当前用户 DPAPI 加密。CLI `ai models list` 仅显示密钥状态，未输出凭据。
- `pnpm run test:integration:ai-provider` 通过：Chat 生成与修复草稿均通过只读/Schema 静态校验；优化任务没有 SQL 字段或 SQL 校验结果；Embedding 返回 1,024 维；Rerank 将合成 Schema 文档排在无关文档前。

## 2026-11-12 回归复验

- `pnpm --filter @db-studio/ai test` 在允许本机 loopback 测试服务的执行环境中通过：3 个测试文件、38/38 项。普通沙箱运行无法访问测试进程自建的 `127.0.0.1` 服务。
- `pnpm test:integration:ai-cli-explain-plan-online` 通过：仅发送合成 SQL 与计划文本，使用 SQLite `:memory:`，未执行 SQL；`qwen3.6-flash` 返回 586 字符解释，没有 SQL 字段，临时文件已清理。首次受限执行因模型主机名解析失败，切换到已授权的联网执行后通过。
- `pnpm run test:integration:ai-provider-auth-failure` 通过：对 DashScope Embedding 与 Rerank 发送合成文本和故意无效的密钥，两端均返回 HTTP 401，错误分类正确且没有泄露或记录密钥/响应正文。
- `pnpm run test:integration:ai-provider-cancel` 通过：真实流式 Chat 收到首个 delta 后立即取消；请求以取消状态结束，只记录了计数，不记录响应文本，也未发送 Schema。
- 测试只发送合成 `public.ai_smoke_places(id, label)` Schema 和内置意图，没有业务行、密码或连接 URI；生成 SQL 未在数据库执行。此 Provider/CLI 结果不替代安装版 GUI IPC 取消验收或真实复杂业务质量评估。

## 2026-11-10 安装版 GUI 取消验收续测

- 当前源码 unsigned NSIS 安装版已运行，并显示项目隔离 PostGIS 连接。此前“解释 SQL”测试在关闭 AI 助手面板后，loopback 延迟服务记录了客户端取消；请求未发送给 DashScope，Schema 同意保持关闭。
- 连接范围切换的第二次请求于 `2026-11-10T01:05:35.647Z` 到达 `127.0.0.1:27491`，日志没有对应 `client-cancelled`。交互过程未能证明连接确实在请求期间改变，因此该次结果为不确定，不能作为通过。loopback 服务随后已停止，当前健康检查失败且此前 PID 已退出。
- 续测时 `@oai/sky` 的窗口清单与 DB Studio accessibility tree 指向 DB Studio，但截图返回 Codex 会话窗口。发现不一致后未继续发送界面输入。安装版连接切换 IPC 的可见验收仍待完成。
- 同日 `pnpm --filter @db-studio/desktop test` 通过：7 个文件、45 项测试；其中 lifecycle/operation registry 覆盖连接作用域变化、请求取消和发送方隔离。单测不替代上述可见安装版验收。
- CLI 对 DPAPI 模型配置的脱敏读取显示 Chat、Embedding、Rerank 均已配置且 key-present；输出不包含 API Key，也不报告 enabled 状态。此前关于 Embedding/Rerank 未配置的文字已在进度与差异文档中更正。

## 2026-11-10 连接配置错误反馈补充

- 在此前安装版中尝试配置仅用于本机 SQLite 取消验收的临时连接时，保存和取消按钮操作后对话框均未关闭，界面未显示错误；连接列表保持为空。只读文件元数据检查显示默认 `connections.enc` 仍为 278 字节，时间戳为 2026-10-31。本次没有通过新版本重试，保存 IPC 失败原因尚未确定。
- 为让下次复验能区分列表读取与连接保存故障，桌面页新增连接列表错误态和重试入口，连接保存异常会显示主进程错误文本。`pnpm --filter @db-studio/desktop typecheck` 通过；`pnpm --filter @db-studio/desktop test` 通过 7 个文件、45 项测试。
- 更新后的 unsigned NSIS 安装包为 201,749,098 字节，SHA-256 `94929D0890590F01BB468AC3A8CC5E28AF576FC463E4F0FCA2FB5DCA8B9FFDCD`。用户对该重建版本的即时启动确认待回复；本轮未发起 AI 请求、未发送 Schema，也未访问 DashScope。安装版连接切换取消验收仍未完成。

### 2026-11-10 新重建 NSIS GUI 续验（不确定）

- 用户即时授权后已安装并启动上述构建。安装版读取并显示已有 PostGIS 与 SQLite 测试连接；PostGIS 状态为 `dbstudio_test` / `127.0.0.1:25432`。模型设置只读显示 Chat 指向本机 `127.0.0.1:2491/v1`，密钥未配置，Embedding/Rerank 关闭；本轮未改动加密模型配置，也没有 DashScope 调用路径。
- 在 AI 面板选中用户此前授权的单张合成测试表 `ai_rag_acceptance_20261102.land_use_lookup`，勾选 Schema 许可并提交合成取消意图。界面显示“正在请求模型”，但未取得可关联该次请求的本机服务到达/断开记录。之后尝试切换连接时窗口截图再次报 `GetCursorPos failed: 拒绝访问 (0x80070005)`；停止继续输入。连接切换是否发生在请求期间、关闭面板是否向主进程发送 `ai:cancel` 均无法确认，因此不记为通过；生成 SQL 未应用或执行。
- 本次没有触发连接保存失败，因而连接保存异常提示也未能在 GUI 中复现验证。桌面端先前 7 文件 / 45 项自动化测试和 IPC 生命周期测试仍是自动化证据，不能替代上述可见 IPC 验收。

## 2026-11-10 DashScope Provider 配置与集成复验

- CLI 只读脱敏列举确认加密桌面设置中的 Chat、Embedding、Rerank 均已配置，端点为 DashScope OpenAI-compatible URL，模型分别为 `qwen3.6-flash`、`text-embedding-v4`、`gte-rerank-v2`；输出只显示密钥存在状态，不显示密钥值。
- `pnpm run test:integration:ai-provider` 在线复验通过：Chat 生成与修复均通过只读/Schema 校验；优化响应没有 SQL 字段或校验结果；Embedding 返回 1,024 维；Rerank 处理两个合成文档且相关文档排名第一。脚本摘要标记 `schemaSent: synthetic only`。
- 本次只发送合成 Schema 与查询意图；未发送业务行、数据库凭据或连接 URI，生成 SQL 未执行。该 Provider 冒烟不覆盖真实复杂业务准确率，也不替代安装版 GUI 连接切换/关闭页面的 IPC 取消验收。

## 2026-11-10 Schema RAG 空范围清理修复

- 代码审查发现，当一次索引更新得到空表列表时，索引函数原先直接返回旧快照，导致已删除 Schema 表的 embedding 仍留在本地索引中。
- 现在空列表更新会删除目标连接/数据库/Schema scope 的全部条目，并保留其他 scope。新增测试验证目标 scope 被清空、另一个连接的向量不受影响。
- 定向 `schema-index.test.ts` 通过 6/6；默认受限沙箱中全量测试因禁止本机 loopback 而有 22 项 provider 测试报 `fetch failed`。在授权 loopback 测试环境重跑后，AI 包全套 3 个文件、35/35 通过，`pnpm --filter @db-studio/ai typecheck` 通过。此变更只涉及本地索引元数据，没有数据库或模型网络请求。

## 2026-11-11 Schema Embedding IPC 取消

- Schema 索引构建现在分配独立 request id，复用 Electron 的 AI 操作注册表和 `ai:cancel` IPC；关闭助手抽屉、切换连接、Schema 或表选择、组件卸载，以及用户点“取消索引”都会取消该操作。Renderer 忽略失效请求的成功/错误响应。
- 主进程把 AbortSignal 传给每批 Embedding 请求，并在数据库元数据阶段、每个 Embedding 批次和加密索引提交前检查取消。加密写入使用独立临时文件，未提交的取消操作会清理临时文件。
- 桌面端 9 个测试文件 / 58 项通过，双 tsconfig 类型检查与生产构建退出码 0。IPC 生命周期测试验证连接、Schema、表选择变化和抽屉关闭时操作注册表会收到取消。
- 这些自动化测试不等于安装版 GUI 实测，也不证明远端 Embedding 服务收到连接断开后停止计算或计费；当前尚未通过安装包现场验收此新路径。

## 2026-11-12 JSON 输出契约与 DashScope 方言矩阵

- SQL 助手调用 Chat Provider 时请求 OpenAI-compatible `response_format: { type: "json_object" }`。System 指令明确要求 `referencedObjects`、`assumptions`、`warnings` 是字符串数组，空值使用 `[]`。若服务明确以 HTTP 400 拒绝 `response_format`，Provider 回退到文本模式，保留原 JSON 提示和解析校验。
- 若首轮输出解析失败，重试继续要求 JSON；对 DashScope Qwen 系列模型仅在该重试中设置 `enable_thinking=false`，不向其他 OpenAI-compatible 服务发送该厂商参数。重试两次仍无效时，错误只显示字段/格式原因，不保存或记录模型响应正文。
- 首轮真实模型矩阵曾定位 `referencedObjects` 数组类型不符合约定。补充字段类型契约和 Qwen 结构化重试后，已配置的 DashScope `qwen3.6-flash` 完整矩阵 7/7 通过：PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite、PostGIS；SQL 均通过静态只读校验及各自方言断言。未连接真实数据库、未执行 SQL、未保存响应内容。AI 包 59/59、全仓 `pnpm typecheck` 和 `pnpm build` 通过。
- 此矩阵仅发送合成 `ai_smoke_places` Schema 与合成意图；不能代表任意业务查询的正确率。DashScope 参数依据 [官方 Chat Completions 参数文档](https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope)；不同模型或兼容服务可能不支持 JSON 模式，代码会在明确拒绝时回退。

## 2026-11-12 MongoDB AI Provider 质量补充

- 新增 `pnpm run test:integration:ai-provider-mongo-quality`，从当前用户加密桌面配置读取已启用 Chat 模型。合成字段结构覆盖 Find 的 status 过滤、字段投影、降序排序，以及 Aggregate 的 match/group/count/sort。
- 首轮真实模型验证发现 Aggregate 有时把查询草稿放在顶层 `filter` 而未返回 `pipeline`。Mongo 助手现在请求 JSON Object 输出，并给出明确的 Aggregate JSON 形状示例；两次结构校验仍失败时仅返回安全的阶段/字段级诊断，不回显模型响应。明确拒绝 JSON Object 参数时沿用 Provider 兼容回退。
- DashScope `qwen3.6-flash` 最终 Find 与 Aggregate 场景 2/2 通过，均通过只读结构校验。只发送合成 Schema/意图；查询未执行，响应正文未记录。AI 包单测 60/60；全工作区 `pnpm test` 通过（259 项通过、4 项 CLI 条件跳过），`pnpm typecheck` 与 `pnpm build` 通过。构建保留既有 Node stream/zlib externalization 提示及 renderer chunk 大小警告。
- 新增 `pnpm run test:integration:ai-provider-mongo-live`，将同一真实模型流程接到项目隔离 MongoDB。MongoDB 7.0.45 上临时插入 4 条合成记录；模型生成的 Find 返回 3 条记录，分数降序为 9、7、5；Aggregate 返回 West=2、East=1。生成结构先通过只读阶段白名单，再由 `MongoDocumentAdapter` 执行。临时集合删除后通过 `listCollections` 验证不存在。仅把合成 Schema/意图发送给模型，业务行未发送、响应正文未记录。

## 2026-11-12 中文 Schema 关键词与字段回退

- `selectRelevantTables` 为连续 Han 字符生成去重双字词，保留英文 token 权重与显式选表优先规则。Electron 无候选时通过 8 路并发加载当前 Schema 的完整表元数据，再运行本地字段级词法检索；复用 5 分钟的 `getAiSchemaTable` 缓存并把 metadata failures 计入 warnings。
- 新增“统计城市道路长度”排序测试、并发上限/部分失败测试。AI 包 3 个测试文件 / 62 项、桌面端 9 个测试文件 / 58 项通过；完整工作区 typecheck 与 `pnpm build` 通过。构建保留 `node:stream`/`node:zlib` externalization 和 2,228.10 kB renderer chunk 提示。隔离 PostGIS 实测空合成表的中文列名能通过 Core 元数据与词法匹配被选中，清理后确认表不存在；未调用 DashScope 或使用业务行。
- 此全 Schema 字段扫描只在表名/注释、语义检索和显式选表均没有候选时触发；首次扫描可能增加查询延迟，受 8 路并发和 IPC 取消控制。它提供词法字段召回，不推断跨词同义关系；Embedding/Rerank 仍为可选语义路径。

## 2026-11-13 DashScope MariaDB SQL 修复补测

- 将真实 Provider 修复质量矩阵扩展到 MariaDB：用合成 `ai_smoke_places(id, label)` Schema 检查 `TOP 1` 分页语法修复为 MariaDB `LIMIT 1`，并保留 `ORDER BY id`。
- `pnpm run test:integration:ai-provider-repair-quality` 通过：7/7 个 DashScope SQL 修复场景均满足任务类型、只读静态校验和方言/意图断言；MariaDB 新场景通过。
- 仅发送合成 Schema 和错误/修复意图；脚本未记录模型响应正文，生成 SQL 未执行。本结果不代表真实业务查询的普遍准确率。

## 2026-11-13 七引擎 AI SQL 生成真实执行

- 新增 `pnpm test:integration:ai-generated-sql-execution`。脚本从当前用户加密桌面 AI 配置读取启用的 Chat 模型，并从项目 `docker/.env` 读取隔离数据库连接。真实模型只收到随机合成表结构和固定测试意图；不发送连接 URI、密码或业务行。
- 正式命令的共享、数据库、Core、AI、CLI 构建均通过，七个隔离引擎共 14/14 场景通过：PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite 各覆盖单表查询和 CTE + 外键 JOIN + 分组/HAVING；PostGIS 覆盖距离筛选和同一复杂聚合查询。各查询先通过静态只读校验与测试表来源/函数约束，再由真实目标数据库执行；每个场景返回预期的一行合成结果。复杂夹具先用已知 SQL 验证关系与聚合结果；临时表和 SQLite 文件在 `finally` 中清理。
- AI 系统提示现在要求 JOIN 使用 Schema 提供的外键列对，不得凭相似 `id` 列推断关系，并保留请求明确要求的 CTE、JOIN、分组、HAVING、投影和排序。真实模型曾出现错误分组、零行结果、未满足来源形态和超时；这些输出被测试拒绝或未执行。明确 JOIN 列、分组列与包含边界的阈值后，最终完整批次通过 14/14。模型生成仍有随机波动；该结果只覆盖每种引擎一个合成复杂用例及一个单表/空间用例，不代表生产查询准确率、性能或复杂 SQL 的普遍正确性。
- Oracle/PostGIS 的当前静态解析器不能为这些场景提供完整 `referencedTables` 集合。集成脚本使用随机表名、可选单一 CTE、严格 FROM/JOIN 来源白名单、拒绝逗号隐式连接及字段/函数/查询形态断言保护后才执行；这不是通用 Oracle/PostGIS AST 验证。运行摘要只记录引擎、场景、校验/执行状态和行数，不记录 SQL、模型响应或结果字段值。应用仍只生成和校验 SQL，不会自动执行模型生成的查询。
- 同轮 AI 包单测 62/62、AI 包 typecheck/build 通过。DashScope 只接收合成 Schema 和测试意图；结果摘要显示 `businessRowsSent=false`、`credentialsSent=false`、`responseContentLogged=false`。

## 2026-11-13 六引擎 AI SQL 修复真实执行

- 新增 `pnpm test:integration:ai-sql-repair-execution-matrix`，覆盖 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite。每个引擎在项目隔离测试服务中创建随机合成表和一行哨兵值，先由目标数据库真实触发缺列错误，再把该表 Schema、错误和修复意图发送到已配置 Chat Provider。
- 只有助手结果通过只读/Schema 校验、唯一来源匹配本次随机表、没有函数/集合运算，并保留 `id = 1` 与 `label` 投影，脚本才执行。六引擎最终完整批次 6/6 通过，均返回预期的一行合成结果，并报告随机夹具已删除；SQL、数据库错误正文、模型响应正文、业务行和凭据均未写入输出。
- 真实缺列错误代码包括 PostgreSQL `42703`、MySQL/MariaDB `ER_BAD_FIELD_ERROR`/1054、SQL Server 207、Oracle `ORA-00904`、SQLite `ERR_SQLITE_ERROR`。首轮发现 SQLite 驱动代码前缀与预期不同，修正后 SQLite 单独复验及完整矩阵通过；另一批次遇到模型请求超时，单引擎复验与最终完整批次均通过，说明在线模型质量/可用性仍有波动。
- 范围限制：目前只覆盖六引擎的单列名修复；缺表、大小写/引用、JOIN/GROUP BY、日期函数、参数以及 PostGIS SRID/几何类型等仍需真实执行验证。该闭环不替代数据库只读权限；模型输出仍需人工确认，应用不会自动执行生成 SQL。

## 2026-11-13 六引擎缺表 SQL 修复真实执行

- 新增 `pnpm test:integration:ai-sql-missing-table-repair`，覆盖 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite。每个隔离服务创建唯一随机表并插入一行哨兵，再实际查询随机近似错误表名以触发对应数据库缺表错误。
- 助手仅得到真实隔离 Schema、合成错误与修复意图；结果通过只读/Schema 校验、单一来源、正确表名、字段投影和 `id = 1` 条件 guard 后才执行。六引擎 6/6 通过，均返回一行合成结果并清理随机表/SQLite 文件；输出未记录 SQL、响应正文、业务行或凭据。
- 此矩阵覆盖任务三列出的缺表场景，仍不覆盖大小写/引用、方言、日期函数、参数和非 PostgreSQL JOIN 聚合修复，也不证明通用 SQL 安全性。

## 2026-11-13 PostgreSQL 外键 JOIN 与聚合修复真实执行

- 新增 `pnpm test:integration:ai-postgres-join-repair-execution`。脚本在项目隔离 `dbstudio_test` 中随机建区域/地点两表并创建真实外键 `region_id → id`，先用错误的 `region_code` 关联触发 PostgreSQL `42703`。
- 向模型发送两表 Schema、外键列对、真实合成数据库错误及明确任务意图。SQL 只有通过只读/Schema 校验、表来源恰为这两张夹具表，并保留 CTE、活跃过滤、FK JOIN、`GROUP BY region_name`、包含边界的 `HAVING COUNT(*) >= 2` 和降序后才执行。
- 最终真实验收通过：模型修复 JOIN 列，实际查询返回唯一预期聚合行；夹具清理确认成功。中间一次执行前诊断发现函数白名单把 `AS (` 误认为调用，未执行该候选 SQL；排除 SQL 关键字后重跑通过。日志只保留布尔 guard 和行数，不记录 SQL、响应正文或业务值。
- 此项只覆盖 PostgreSQL 的一种外键关联错误；其他方言和 JOIN/GROUP BY 错误仍需独立实测。
## 2026-11-13 PostGIS 混合 SRID 修复真实执行

- 新增 `pnpm test:integration:ai-postgis-srid-repair`：在授权的本机隔离 PostGIS 数据库创建随机 `geometry(Point,4326)` 合成表和单个测试点，并先执行真实的 4326/3857 混合 SRID 查询以确认目标数据库报错。
- 助手只收到随机表 Schema、从 `geometry_columns` 读取的几何类型/SRID、由本机 `to_regprocedure` 确认可用的函数名和合成意图。输出须通过只读/Schema 校验、唯一随机表来源、保留 `ST_Intersects`、原经纬度坐标及 4326 SRID 等 guard 后才会执行；正确结果必须返回测试 id 1。夹具在 `finally` 清理。
- 真实闭环通过：PostGIS 对错误 SQL 返回 `XX000`；模型响应通过只读/Schema 校验、单一随机表来源、`ST_Intersects`、原坐标 `-122.4, 37.8`、纠正为 4326 且仅使用服务器确认函数等守卫。执行后实际返回唯一的合成 id 1，随机表清理成功。
- 执行摘要未记录 SQL、错误正文、模型响应正文、测试行或凭据；只向模型发送随机 Schema/空间元数据和测试意图。该结果仅覆盖混合 SRID 修复这一形态，不代表任意坐标转换或几何类型修复。

## 2026-11-14 PostGIS 几何函数参数类型修复

- 新增 `pnpm test:integration:ai-postgis-geometry-type-repair`：以随机合成 `geometry(Polygon,4326)` 表触发 `ST_AsGeoJSON(jsonb)` 的真实函数参数类型错误，并读取实际空间列元数据与服务端函数能力。
- 模型修复只有通过只读/Schema、随机表来源、读取 `geom` 而非 `label`、保留 id/GeoJSON 投影及服务器确认函数守卫后才执行；执行结果需要验证为一条 Polygon GeoJSON 记录并清理夹具。
- 真实闭环通过：PostGIS `42883` 确认 `ST_AsGeoJSON(jsonb)` 没有匹配重载；模型选择 geometry 列后通过只读/Schema、随机表、函数白名单及投影守卫，执行结果为一条 Polygon GeoJSON，临时夹具清理成功。真实模型只收到合成 Schema/意图，无业务行、凭据或响应正文进入日志。
- 验收发现 Electron 元数据能力检查对带默认参数的 PostGIS 函数使用精确 `to_regprocedure` 签名，遗漏可通过默认参数调用的 `ST_AsGeoJSON(geometry)`（也影响四参数 `ST_AsMVT` 调用）。修复为同时检查可调用的完整签名。`pnpm --filter @db-studio/desktop typecheck` 通过；PostGIS AI metadata smoke 在 PostGIS 3.6.4 上通过，报告 2 个空间列、13 个服务器确认函数。
- 本场景仅验证 JSONB 与几何参数类型不匹配这一具体修复，不表示任意 PostGIS 参数错误均已覆盖。

## 2026-11-14 六引擎日期函数方言修复

- 新增 `pnpm test:integration:ai-sql-date-function-repair`，覆盖 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite。每个引擎在隔离测试库的随机时间表中插入当前与 30 天前两条合成记录，由真实不兼容日期函数触发数据库错误。
- 模型结果需通过只读/Schema、随机表来源、最近 7 天过滤、引擎原生日期语法和结果行数 guard 后执行；夹具清理并分别记录。
- 最终批次通过 6/6：PostgreSQL `42703`、MySQL/MariaDB `ER_SP_DOES_NOT_EXIST`、SQL Server 驱动 `EREQUEST`/102、Oracle `ORA-00907`、SQLite `ERR_SQLITE_ERROR`。六个模型候选均通过只读/Schema、来源、七天边界与本地方言语法 guard；真实数据库只返回当前合成 id 1，旧记录被排除，随机表或 SQLite 文件均已清理。
- 测试发现 SQL Server `DATEADD(day,...)` 的解析器把 `day` 误识别成未声明字段，导致合法候选校验失败。SQL 校验器现在只在 `DATEADD` 第一参数位置将日期部分识别为关键字；其他位置的缺失 `day` 列仍会被拒绝，新增回归覆盖两种行为。AI 包 63/63 单测通过。
- SQLite 候选使用保留时间精度的 `datetime('now', '-7 days')`，不是按日截断的 `date()`。仅向模型发送随机时间列 Schema、合成错误和测试意图；未发送业务行或凭据，也未记录 SQL/响应正文。结果只证明各引擎这一种日期窗口修复形态。


## 2026-11-14 六引擎 SQL 参数占位符修复

- 新增 `pnpm test:integration:ai-sql-parameter-repair`，覆盖 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite。用每个引擎不兼容的占位符语法实际触发数据库错误，并通过 Adapter 对随机哨兵查询绑定唯一参数。
- SQL 助手系统提示明确各驱动占位符格式，要求保留绑定数量/顺序且不得内联值。输出须通过只读/Schema、随机表、精确占位符/参数过滤和投影守卫后，使用同一参数数组执行。
- 最终批次通过 6/6：PostgreSQL `42601`、MySQL/MariaDB `ER_PARSE_ERROR`、SQL Server `EREQUEST`/102、Oracle 驱动 `NJS-098`、SQLite `ERR_SQLITE_ERROR`。每个查询保留单个绑定参数，实际返回合成哨兵行；所有随机表和 SQLite 文件均清理成功。
- 验收发现静态解析器把 T-SQL `@p1` 绑定变量误判为列。SQL 校验器现跳过 T-SQL 变量引用，但仍对普通字段执行完整 Schema 检查；回归测试覆盖已知变量通过和缺失字段拒绝。AI 包单测 63/63 通过。
- 参数值 `1` 只用于本机驱动绑定，没有发送给模型；仅发送占位符 SQL、真实错误和随机 Schema。结果未记录 SQL/响应正文，也没有自动执行未通过守卫的模型 SQL。

## 2026-11-14 PostgreSQL/Oracle 混合大小写标识符修复

- 新增 `pnpm test:integration:ai-sql-quoted-identifier-repair`：在隔离 PostgreSQL 和 Oracle 中分别创建含 `"RecordID"`、`"DisplayName"` 的随机表，以未引用的小写字段触发真实错误。
- 助手结果精确保留双引号大小写、投影和 `RecordID = 1` 条件，通过只读/Schema/来源守卫后执行。最终批次 PostgreSQL/Oracle 2/2 通过，数据库错误分别为 `42703` 和 `ORA-00904`；修复查询均返回一条哨兵结果，夹具已清理。
- 首次候选引入原 SQL 中不存在的绑定参数，守卫拒绝执行；修复意图明确禁止新增参数后通过。该项只验证两个引擎的混合大小写列引用错误。

## 2026-11-14 Task 12.4 安全回归

- SQL 助手单测用恶意表注释作为不可信 Schema 输入，检查发送上下文不包含数据库密码、连接串或业务行哨兵；确定性 loopback 模型返回 `DELETE` 后，SQL 只读校验拒绝该结果。`pnpm --filter @db-studio/ai test` 通过：3 个文件、63 项。
- 桌面单测通过：9 个文件、64 项；请求生命周期测试确认连接切换/替换请求后旧 AI 响应不会应用。代码路径中模型结果仅保存为预览，只有用户点击“插入编辑器”或“接受并应用修复”才调用编辑器插入回调；修复结果未通过校验时按钮禁用。
- UI 明示 AI 不执行 SQL；未启用模型时请求按钮不可运行，Schema 默认不发送，生成/修复/GIS 任务需勾选 Schema 同意。以上桌面行为本次由源码与单测核对，未在可见安装版窗口中逐项点击验收。
- 此回归验证应用请求/结果边界，不替代目标数据库账号权限配置审计；独立安装版 GUI 交互验收单独跟踪。

## 2026-11-14 PostgreSQL 最小权限边界

- 首次只读审计发现现有 `dbstudio_test` 自动化账号是超级用户，不能作为数据库权限边界证据。新增 `pnpm test:integration:postgres-ai-permissions`，仅面向 `127.0.0.1:25432/dbstudio_test`。
- 测试创建随机临时角色和 Schema；角色无超级用户、建库、建角色或复制权限，仅获得单张合成表的 `SELECT` 与 Schema `USAGE`。验证该读取成功，读取其他表、`INSERT`、`UPDATE`、`DELETE`、`CREATE TABLE` 均被 PostgreSQL `42501` 拒绝。
- 完成后验证哨兵表未变化，并删除临时 Schema 和角色。最终命令通过；临时密码不打印、不持久化。
- 新增 `pnpm test:integration:mysql-family-ai-permissions`，在同一隔离 MySQL 8.4 与 MariaDB 11.4 测试库中分别创建随机临时账号，仅授予一张合成表的 `SELECT`。两引擎均确认授权读取成功，未授权表读取、`INSERT`、`UPDATE`、`DELETE` 和 `CREATE TABLE` 被拒绝；夹具未变且临时账号/表均删除。

## 2026-11-14 SQL Server、Oracle 与 MongoDB 最小权限边界

- 新增 `pnpm test:integration:sqlserver-oracle-ai-permissions`，在项目隔离 SQL Server `127.0.0.1:21433/dbstudio_test` 和 Oracle Free `127.0.0.1:21521/FREEPDB1` 上分别创建随机账号与合成表。SQL Server 登录仅获得一张表的 `SELECT`；Oracle 用户仅获 `CREATE SESSION` 和一张表的 `SELECT`。
- 两个引擎均由应用的 CoreService/真实驱动确认授权读取成功；未授权表读取、`INSERT`、`UPDATE`、`DELETE` 和 `CREATE TABLE` 均返回真实数据库权限错误。两表哨兵状态未变化，临时账号/登录与表清理验证通过。
- 新增 `pnpm test:integration:mongo-ai-permissions`，对项目隔离 MongoDB `127.0.0.1:27018/dbstudio_test` 创建随机 collection 级角色，只对一张合成 collection 授予 `find`。MongoDocumentService 读取获准集合成功；未授权集合读取、文档导入、UPDATE、DELETE 和 CREATE COLLECTION 均以 MongoDB Unauthorized (13) 拒绝。
- MongoDB 临时角色、用户及 collection 已清理；测试只使用合成标记，密钥与临时密码未打印。
- SQLite 没有数据库账号/角色，新增 `SqliteConnectionConfig.readOnly` 文件只读打开选项与 `pnpm test:integration:sqlite-ai-permissions`。真实 Node SQLite 连接可以读取临时测试文件；`INSERT`、`UPDATE`、`DELETE` 与 `CREATE TABLE` 均被文件只读模式拒绝，哨兵保持不变，临时文件清理成功。SQLite 的只读边界作用于整个文件，不能隔离单表读取。
- 目前七种数据库/存储类型都有相应的最小权限验证：六种服务器数据库按账号/角色验证，SQLite 按文件只读模式验证。该覆盖不代表用户当前保存的业务连接账号自动变为只读。
- SQLite 变更后，`pnpm --filter @db-studio/database test` 在允许本机 loopback 的环境通过：10 个文件、55 项；`pnpm --filter @db-studio/core test` 通过：3 个文件、11 项。

## 2026-11-14 PostGIS GIS SQL 单位与 SRID 提示回归

- GIS SQL system prompt 明确区分 geography 的米制距离与 geometry 的 CRS 单位（可能为度），要求只使用上下文提供的空间列/SRID/能力；若相关空间列类型或 SRID 不足以确定单位，则返回空 SQL 并要求用户确认，禁止猜测 SRID、做任意转换或 cast 来伪造米制语义。
- `assistant.test.ts` 检查传给模型的 system prompt 包含这些约束，并确认空间元数据不足时助手可返回空 SQL 与待确认事项；结果解析仅对 GIS 任务允许空 SQL，避免把澄清结果当作可执行草稿。共享元数据加载器由桌面 IPC 和 CLI 共用，CLI 在调用 GIS 助手前实际读取 PostGIS 版本、所选表的空间列/SRID/坐标维度及受支持函数。
- AI 助手现会在应用侧拒绝缺少 PostGIS 版本、空间列、有效 SRID 或函数能力的上下文，不会把此类 GIS 请求发送给模型。`pnpm --filter @db-studio/ai test` 通过 4 个文件、68 项；CLI 单测通过 5 个文件 19 项，1 个文件 4 项跳过；AI 构建、CLI 与桌面类型检查通过。测试包含模拟 provider/数据库上下文，不证明云模型在所有实际输出上都会遵循提示。
- `pnpm test:integration:postgis-ai-context` 在授权的隔离 PostGIS 3.6.4 上通过真实 CoreService 连接和共享 loader，读取随机合成表中的 geometry/geography 两列、POINT 类型、SRID 4326 及 10 项服务器支持的空间函数；临时表清理通过。该结果验证元数据采集链路，不代表模型生成的任意空间 SQL 均正确。
- CLI 新增 `ai sql gis` 入口，`--include-schema` 明确授权将所选 Schema 发送给配置的模型。`pnpm test:integration:postgis-ai-cli` 使用真实 PostGIS 元数据和 loopback-only 模型 mock，确认模型上下文含 geometry/geography 两列及 SRID 4326、ST_DWITHIN 能力和空间单位提示；响应草稿经过只读/Schema 校验，临时表清理通过。该验收不访问外部模型服务。

## 2026-11-14 PostGIS GIS CLI 真实 DashScope 生成验收

- 在授权的隔离 PostGIS 3.6.4 测试库中创建随机合成表，调用当前配置的 DashScope Chat 模型执行 CLI `ai sql gis`，任务指定 `geography` 列和坐标点 500 米范围。
- 真实生成草稿通过只读 SQL 校验，使用 `ST_DWithin` 与 geography 列、保留 500 米距离，并引用随机测试表；CLI 未执行生成的 SQL。随机表清理与 `to_regclass` 检查通过。
- 随后在另一随机表中插入一条目标范围内和一条范围外的合成点。确认生成响应是单语句 SELECT、引用对象恰为测试表且通过只读校验后，实际在隔离 PostGIS 执行；数据库只返回近点 id 1，远点被排除，夹具清理通过。
- 本次仅向模型发送合成 Schema 和固定测试意图，不发送业务行、连接 URI 或凭据。该单场景结果验证真实模型调用与 GIS 上下文链路，不代表模型对任意空间查询的准确率。

## 2026-11-14 安装版 AI 请求取消状态复核

- 已安装 r4 主窗口仍运行并显示前一轮 GIS 页面；重新枚举窗口后，打开 SQL 工作区的坐标输入和 Accessibility 点击均返回 `GetCursorPos failed: 拒绝访问 (0x80070005)`。按桌面控制恢复规则停止本轮 UI 输入，没有向模型发送 Schema/意图，也未执行 SQL。
- 源码侧重新运行桌面 AI 取消链路回归（`ai-ipc-cancellation.test.ts`、`ai-request-guard.test.ts`、`ai-operation-registry.test.ts`）通过 21/21。全工作区宿主回环测试 309 项通过、4 项条件跳过；`pnpm typecheck` 和 `pnpm build` 通过。
- 因无法打开 AI 面板并观察进行中的请求、连接切换或面板关闭事件，安装版 GUI 取消/旧结果隔离仍为未验收；源码回归不替代该交互证据。没有把既有 RAG/Provider CLI 测试当作 GUI 取消通过。

## 2026-11-14 Schema Embedding 与 Rerank 在线 RAG 复验

- 审阅 `tests/integration/ai-schema-rag-smoke.mjs` 确认在线载荷为脚本硬编码的三个合成表定义和一个合成检索意图。运行 `pnpm test:integration:ai-schema-rag` 通过：Embedding 1,024 维，检索出 3 个候选，Rerank 将 `public.road_segments` 排第一；无关连接匹配数为 0，scope 清理保留另一 scope。
- 本次调用配置的 Embedding 与 Rerank Provider；未读取/发送真实数据库 Schema、业务行、连接 URI 或 API 凭据。此结果验证合成场景的索引隔离和排序，不评估真实复杂业务需求的检索准确率，也不替代安装版 GUI 取消验收。

## 2026-11-14 Schema 同意状态与请求范围

发现 SQL Assistant 在 Chat/Embedding 请求进行时仍允许切换 Schema 同意复选框。桌面 UI 现于 `busy || indexBusy` 时锁定该选项，防止本地同意状态与已提交请求范围不一致。桌面 typecheck/build 通过，AI 生命周期相关 3 个文件 21/21 通过；本次未调用模型。安装版可见交互因 Computer Use `GetCursorPos failed: 拒绝访问 (0x80070005)` 尚待验收。

## 2026-11-15 Provider advisory-field compatibility

- A live DashScope smoke initially rejected two model replies because `warnings` was returned as a scalar string instead of an array. This is an advisory display field and did not affect SQL validation, but it prevented an otherwise valid read-only result from being shown.
- The parser now treats missing/null advisory fields as empty arrays and normalizes one bounded nonempty string into a single item. It continues rejecting objects, non-string array elements, oversized values, invalid task/dialect/SQL, and unsafe SQL. New unit coverage exercises scalar `referencedObjects`/`warnings` and null `assumptions`.
- `@db-studio/ai` passed 74/74 tests. The rerun of `pnpm test:integration:ai-provider` succeeded with synthetic Schema only: read-only Chat generation and repair, optimization without SQL, 1,024-dimension embedding, and rerank of two synthetic documents. No database rows, URI, password, or local files were sent to DashScope.

## 2026-11-16 DashScope live configuration and RAG recheck

- `dbstudio ai models list` read the current-user DPAPI encrypted settings without exposing credentials and reported the configured Chat, Embedding, and Rerank models. `dbstudio ai models test --kind chat|embedding|rerank` passed all three live minimum requests; Embedding returned 1,024 dimensions.
- `pnpm run test:integration:ai-provider` passed: Chat generation and repair both passed read-only/schema validation, static optimization returned no SQL or validation object, Embedding returned 1,024 dimensions, and Rerank put the synthetic Schema document first.
- `pnpm run test:integration:ai-schema-rag` passed: three synthetic table documents were indexed and retrieved; `public.road_segments` ranked first, unrelated connection scope returned no matches, and scoped clear preserved the other scope.
- DashScope received only synthetic Schema/query/ranking text. No real database rows, credentials, connection URI, or local files were sent. These tests do not establish installation GUI interaction or complex business-query accuracy.

## 2026-11-16 Installed MSI AI/RAG and IPC cancellation

- In the installed 0.1.0 GUI, a project-isolated profile connected to the approved PostGIS test database. With explicit Schema consent, Chat generated read-only `COUNT(*)` drafts for the selected synthetic `ai_rag_acceptance_20261102.land_use_lookup` table. The user-triggered Schema indexing action created the local encrypted index; a subsequent draft no longer showed the “no semantic index” notice. No generated SQL was inserted into the editor or executed.
- Installed-GUI connection-switch and drawer-close IPC cancellation both passed against delayed loopback Chat responses. The mock used a dummy key, received only the approved synthetic Schema, and retained no request body or credential. Switching from `AI Acceptance B` to `AI Acceptance A` cleared busy state, closed the request, and kept the drawer open; closing the drawer during a second pending request closed the request and drawer. The encrypted AI settings were restored byte-for-byte and the original UI settings were confirmed. The focused `ai-request-guard` and `ai-ipc-cancellation` tests passed 20/20; see [acceptance evidence](../.cache/installed-gui-ai-switch-close-20261116.json).
- Desktop-control activation remained unavailable for the four same-title windows, so the final interaction used the already-running project-isolated installed instance over loopback CDP with an explicit same-origin header. The mock saw two `/v1/chat/completions` requests and two client disconnects; the only Chat receiver was the local mock.

# 2026-11-16 桌面编辑器 SQL 插入回退

- Monaco 编辑器模型尚未就绪时，AI SQL 插入回调会将生成内容追加至现有 SQL，而不是将已有内容替换；已有文本为空时仍只插入生成内容。
- 抽取为 `apps/desktop/src/ai-sql-insertion.ts`，新增三项桌面回归（已有查询追加、空编辑器插入、保留末尾空白）。桌面单测69/69、类型检查、生产构建通过。
- 当前源码 MSI SHA-256 为 `ADB008FE068709D8133E9CDB31CC6BD7C46E6977AD9A903977E6E60BA1A1C668`；用户手动确认 UAC 后安装成功，安装 `app.asar` 与发行负载哈希一致。隔离用户数据启动后窗口响应正常，REA 被动观察到 464 个 DOM 节点；未做 GUI 工作流交互，所以编辑器回退的安装版可见行为仍待交互验收。

## 2026-11-16 真实 Provider 鉴权失败覆盖

- 扩展在线鉴权脚本，将 Chat 与 Embedding、Rerank 一并纳入。使用合成短文本和故意无效的测试密钥，不向服务发送当前配置的真实 API Key，也不记录响应正文。
- `pnpm run test:integration:ai-provider-auth-failure` 通过；三类 DashScope 服务均返回 HTTP 401，Provider 错误分类正确，输出已脱敏。
- 另验证不可解析的保留 `.invalid` Base URL 返回 `network`，以及真实 Provider 地址上的1 ms客户端超时返回 `timeout`；该超时只证明客户端中止处理。
- 当前仍缺错误区域/端点的真实服务响应、请求已发送后的远端断连、Rerank 非法响应以及服务端取消行为验收。

## 2026-11-17 多引擎执行计划在线质量矩阵

- 扩展 `pnpm run test:integration:ai-cli-explain-plan-online`，使用隔离测试连接和合成 SQL/计划覆盖 SQLite、PostgreSQL、MySQL、MariaDB、SQL Server、Oracle 与 PostGIS 共7种场景，包括嵌套循环索引扫描、全表扫描、范围索引/排序、哈希连接、Oracle 访问路径及 PostGIS GiST + `ST_DWithin`。
- 7/7 通过。每项响应均包含指定的关键算子/访问路径、讨论估算值与缺少实测运行数据，且没有可执行 `sql` 字段。测试只读取测试连接版本/Schema 名称；没有读取表结构或业务行，没有执行输入 SQL、`EXPLAIN` 或 `ANALYZE`。模型只收到合成 SQL/计划和连接方言上下文，结果不记录完整模型回复。
- 这是结构化合成计划的在线质量回归，不代表厂商实际 `EXPLAIN` 文本的完整兼容性或任意用户计划解释准确率。详细脱敏摘要见 `../.cache/ai-cli-explain-plan-online-last.json`。

## 2026-11-17 AI request lifecycle regression rerun

- `pnpm --dir apps/desktop exec vitest run src/ai-request-guard.test.ts` passed 12/12. Coverage includes scope changes for connection, database, schema, engine, collection and Mongo query mode; request replacement; active-request finish; and close/unmount cleanup.
- This verifies renderer request lifecycle behavior only. The installed-build delayed-loopback IPC cancellation flow is recorded above; it does not prove DashScope stopped server-side work or billing after a client disconnect. Computer Use initialization still fails because the kernel assets path is missing, so no visible desktop workflow was exercised in this rerun.

## 2026-11-17 PostGIS vector tile helper capabilities

- Expanded the PostGIS capability probe to check `ST_AsMVTGeom`, `ST_TileEnvelope`, and `ST_MakeEnvelope` against server function signatures. `ST_TileEnvelope` checks the current five-argument form and the older four-argument form with custom bounds; metadata includes a helper only when the server reports one of those signatures.
- The GIS prompt now tells the model to use `ST_TileEnvelope`, `ST_AsMVTGeom`, and `ST_AsMVT` only when the server metadata confirms them, and to retain user-supplied tile coordinates. A synthetic MVT CTE using `ST_AsMVT(tile.*)` passed read-only and Schema validation. Generated SQL was not executed.
- `pnpm run test:integration:postgis-ai-context` passed against PostGIS 3.6.4. The live loader returned both spatial columns and 18 confirmed function names, including the MVT helpers; its temporary table was removed. AI tests passed 85/85, workspace tests passed 339/339 with no skips, and `pnpm typecheck` / `pnpm build` passed. See [`postgis-mvt-capability-20261117.json`](../.cache/postgis-mvt-capability-20261117.json) and [full workspace verification](../.cache/workspace-verification-post-mvt-20261117.json).
- The function signatures follow the PostGIS references for [ST_AsMVT](https://postgis.net/docs/ST_AsMVT.html), [ST_TileEnvelope](https://postgis.net/docs/ST_TileEnvelope.html), [ST_AsMVTGeom](https://postgis.net/docs/ST_AsMVTGeom.html), and [ST_MakeEnvelope](https://postgis.net/docs/ST_MakeEnvelope.html).

## 2026-11-17 Live DashScope PostGIS MVT generation

- Added `pnpm run test:integration:ai-postgis-mvt`. The integration creates one empty synthetic road table in the authorized loopback `dbstudio_test` database, loads its live columns and PostGIS spatial metadata through CoreService, and checks the server-reported MVT function set before calling DashScope Chat.
- The online GIS draft preserved tile `8/66/98`, used the confirmed MVT helpers, and passed local read-only and Schema validation. The SQL was not executed and no business rows were read; the temporary Schema was dropped and its absence verified.
- The default sandbox blocked the loopback connection with `EACCES`; the same command passed in host context. Only synthetic Schema metadata and the synthetic MVT intent were sent to the previously authorized HTTPS DashScope endpoint. Sanitized result: [`ai-postgis-mvt-generation-20261117.json`](../.cache/ai-postgis-mvt-generation-20261117.json).

## 2026-11-17 PostGIS MVT PBF reference query

- `pnpm run test:integration:postgis-mvt` executed a fixed reference query against PostGIS 3.6.4 using two synthetic line features in a temporary Schema. Tile `8/66/98` encoded exactly the one in-tile feature and returned a 57-byte non-empty PBF payload; the out-of-tile feature was excluded.
- This validates server-side MVT encoding independently of the model-generated draft. No model SQL was executed, no business rows were read, and cleanup verified the temporary Schema was removed. See [`postgis-mvt-pbf-smoke-20261117.json`](../.cache/postgis-mvt-pbf-smoke-20261117.json).

## 2026-11-17 Seven-dialect explain-plan matrix retry

- The online matrix now accepts `DBSTUDIO_AI_PLAN_TEST_TIMEOUT_MS` from 1,000 to 300,000 ms and passes the selected value to each CLI request, with a matching process timeout. This lets slow provider responses be retried without changing the encrypted model configuration.
- Re-ran all seven synthetic cases with a 180,000 ms model timeout after the earlier matrix stopped at Oracle with the 60,000 ms default. SQLite, PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, and PostGIS each returned the expected dialect, required plan operators/access paths, estimate/runtime caveats, and no executable `sql` field. Result: 7/7; `qwen3.6-flash`.
- The external request contained only synthetic SQL, plan text, and engine context. The isolated database adapters read server/schema identity only; no user query or `EXPLAIN` was executed, no business rows or Schema were sent, and no persistent database changes were made. Temporary request files were removed.
- The machine report is [ai-cli-explain-plan-online-last.json](../.cache/ai-cli-explain-plan-online-last.json). This validates the seven crafted examples; live MySQL/MariaDB, SQL Server, and Oracle plan coverage is added below. Accuracy on arbitrary production plans remains open.

## 2026-11-17 Live multi-engine explain plans

- Added `pnpm run test:integration:ai-cli-explain-plan-real-multidb`. It captures MySQL and MariaDB `EXPLAIN FORMAT=JSON`, Oracle `EXPLAIN PLAN`/`DBMS_XPLAN`, and a SQL Server actual plan through `SET STATISTICS PROFILE ON` using only synthetic temporary-table data.
- All four live plans were interpreted by the configured `qwen3.6-flash` Chat model (4/4). Each response matched the live dialect and key plan concepts, discussed estimates and the availability of runtime measurements, and omitted an executable `sql` field. MySQL, MariaDB, and Oracle plans are optimizer estimates; SQL Server's profile is actual and its single read-only SELECT ran only against the synthetic temporary tables. Microsoft documents that `STATISTICS PROFILE` returns the query result followed by a profile containing actual operator row counts and execution counts ([SET STATISTICS PROFILE](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-profile-transact-sql)).
- The four databases used 50,000 generated rows in total. MySQL/MariaDB temporary tables and the SQL Server transaction were cleaned; Oracle's session was closed before a separate connection dropped both global temporary tables, and its `PLAN_TABLE` rows were deleted. Cleanup checks passed for all four engines; no user query or persistent database change occurred.
- Only synthetic SQL and plans were sent to Chat. No business rows, schema, credentials, or connection URI were included. Sanitized evidence: [live multi-engine plan report](../.cache/ai-cli-explain-plan-real-multidb-last.json). This covers one constructed plan per engine, not arbitrary production plans.

## 2026-11-17 Live SQLite EXPLAIN QUERY PLAN interpretation

- Extended `pnpm run test:integration:ai-cli-explain-plan-real-multidb` to create and remove an isolated SQLite file with 10,000 synthetic rows, then capture actual `EXPLAIN QUERY PLAN` output for an indexed `SEARCH` and an unindexed `SCAN`.
- DashScope interpreted both plans (2/2). The responses identified the observed operators and explicitly stated that this SQLite output provides no row-count estimates, cost estimates, or runtime measurements; neither response contained executable SQL. This matches SQLite's documented high-level plan output and its warning that the textual format can change across versions ([EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)).
- The extended command passed 6/6 interpretations across SQLite, MySQL, MariaDB, SQL Server, and Oracle. It used 60,000 synthetic rows total, cleaned all five databases' temporary objects and deleted the temporary files; no persistent database changes occurred. Only synthetic SQL and plan text were sent to Chat, without Schema, credentials, or business rows.
- Sanitized evidence: [live multi-engine plan report](../.cache/ai-cli-explain-plan-real-multidb-last.json). This remains one constructed plan shape per case and does not establish accuracy on arbitrary production plans.

## 2026-11-17 Live DashScope stream cancellation

- Updated `test:integration:ai-provider-cancel` to disable Qwen thinking for this transport check, request a short synthetic noun list, make the first-delta deadline configurable, and write a sanitized machine report.
- `pnpm run test:integration:ai-provider-cancel` passed against the configured DashScope Chat endpoint. The first content delta arrived in 560 ms; the test aborted immediately and Provider classified the request as `cancelled` (`deltaCount: 1`). No response text or Schema was recorded or sent.
- An earlier long-generation prompt with thinking enabled did not produce a content delta within 45 seconds and was aborted; this did not establish a transport failure. The revised check isolates stream transport from long reasoning latency.
- This proves the client received a real stream event and canceled its request. It does not prove the remote service stopped generation or billing after disconnect. The sanitized evidence is [ai-provider-cancel-last.json](../.cache/ai-provider-cancel-last.json).
- `pnpm --filter @db-studio/ai exec vitest run src/assistant.test.ts` passed 63/63, including local invalid Rerank root/items, duplicate indexes, cancellation, timeout and secret-redaction cases. This does not simulate malformed output from the actual DashScope service.

## 2026-11-17 Live DashScope invalid endpoint response

- Added `pnpm run test:integration:ai-provider-endpoint-error`. It builds AI and CLI packages, reads the enabled Chat model from encrypted desktop settings in-process, and changes only the request's in-memory URL to an intentionally nonexistent path on the exact official `dashscope.aliyuncs.com` HTTPS host.
- The live endpoint returned HTTP 404 and `AiProviderError` classified it as `provider`. The test sent one synthetic sentence, no Schema, logged neither the API key nor response body, and did not persist the altered URL or modify saved settings. The diagnostic evidence is [ai-provider-endpoint-error-20261117.json](../.cache/ai-provider-endpoint-error-20261117.json).
- The first run in the restricted network context returned `network` before receiving HTTP; the same package command then passed in the authorized host network context. This verifies invalid-path HTTP handling, not region-specific routing errors or actual malformed DashScope Rerank responses.

## 2026-11-18 Wide Schema embedding

- `pnpm run test:integration:ai-schema-rag` passed using the existing encrypted DashScope configuration. Embedding returned 1,024 dimensions for all eight fragments of a 1,500-column synthetic table. The final fragment contained a field beyond the old 40,000-character cutoff.
- Local scoring with the returned tail vector and the final field name improved when that fragment was present. Retrieval returned one table result and rebuilding replaced its previous fragments. The cross-Schema synthetic case also passed Rerank and Chat plus local read-only and object validation. The test uses the stored tail vector for a deterministic comparison. General semantic matching for wide production tables remains unmeasured.
- `pnpm test` passed with 351 tests and six existing CLI skips. Workspace typecheck and build passed.
- The live PostGIS harness passed against the recovered loopback PostGIS 3.6.4 service. It loaded three synthetic Schema tables and three spatial columns, retrieved and reranked all three, and validated the generated spatial aggregation draft locally. The draft was left unexecuted.

## 2026-11-17 Live DashScope regional key mismatch

- Added `pnpm run test:integration:ai-provider-region-mismatch`. It reads the enabled Chat model from encrypted desktop settings and temporarily sends one synthetic sentence to the official Singapore DashScope host while retaining the configured Beijing-region API key. The request override is in memory only; saved settings were not changed.
- The live request returned HTTP 401 and the provider classified it as `provider`, consistent with Alibaba Cloud's guidance that API keys and endpoints are region-specific ([error codes](https://help.aliyun.com/en/model-studio/error-code-start), [regional endpoints](https://help.aliyun.com/en/model-studio/regions/)). The sanitized report contains only host names, status, and classification; it does not contain the key or response body. No Schema was sent.
- This verifies generic authentication/provider error handling for a real cross-region mismatch; the app does not claim to distinguish region mismatch from other HTTP 401 causes. A malformed response from the actual DashScope Rerank service remains unverified; local malformed-response tests remain the available coverage.
- Reproducible evidence: [`ai-provider-region-mismatch-20261117.json`](../.cache/ai-provider-region-mismatch-20261117.json); command source: [`ai-provider-region-mismatch-smoke.mjs`](../tests/integration/ai-provider-region-mismatch-smoke.mjs).

## 2026-11-21 AI provider package regression refresh

- Ran `pnpm --filter @db-studio/ai test`. The restricted-sandbox attempt failed 54 tests because local mock-service fetches returned `fetch failed` (33 passed; six unhandled errors were also reported). Re-running the same command with host loopback access passed all 87 tests in four files.
- The suite covers local simulated provider HTTP errors, timeouts, disconnects, bounded error bodies, API-key redaction, malformed Chat/Embedding/Rerank payloads, cancellation, and response-index validation. It does not contact DashScope. No production source changed in this check; machine evidence: [`ai-provider-suite-loopback-20261121.json`](../.cache/ai-provider-suite-loopback-20261121.json).


## 2026-11-21 AI Schema index coverage differences

- Added `findSchemaIndexTableCoverageDifferences` to compare the current database table inventory with entries indexed for the active Embedding model and selected connection/database/Schema scopes. It reports current tables without matching vectors and indexed table keys no longer present in the current inventory. The Electron AI request adds a localized count warning and continues with available semantic results plus keyword ranking; it does not mutate the local index or database.
- The `schema-index.test.ts` suite passed 14/14, including new-table, removed-table, scope-isolation, and model-identity cases. The AI package build passed, desktop typecheck passed, and the production desktop build passed.
- The full AI package suite first hit blocked localhost mock fetches in the restricted sandbox; the host-loopback rerun passed 89/89 tests in four files. No external model request was made. This diagnostic cannot distinguish an intentionally partial index from a schema that changed after indexing; it reports the exact coverage difference so the user can decide whether to rebuild.

## 2026-11-21 AI Provider DNS rebinding protection

- Model base URL validation now resolves a host once, rejects the URL if any returned address is private for a remote host (or non-loopback for a local host), and pins the HTTP(S) connection to those validated addresses. Chat, Embedding, and Rerank share the pinned transport. Node's HTTP clients do not automatically follow redirects; a 3xx response is surfaced as a provider error.
- Added a mixed-answer regression that rejects a hostname resolving to both `8.8.8.8` and `10.20.30.40`. A separate local Chat regression validates `model.localhost` as `127.0.0.1`, leaves a later `203.0.113.77` DNS answer unused, and succeeds with global `fetch` stubbed to fail. This checks the HTTP connection uses the vetted resolver result rather than resolving the host a second time.
- A local 302 regression confirms the request returns a provider error and the redirect target receives no request. `pnpm --filter @db-studio/ai test` passed 92/92 across four files. AI package build and typecheck, desktop typecheck, and desktop production build passed. No external model endpoint was contacted. DNS and redirect behavior used mocked DNS/local HTTP servers; no packaged Electron runtime or external DNS/TLS/provider request was exercised. Machine evidence: [`ai-provider-dns-pinning-20261121.json`](../.cache/ai-provider-dns-pinning-20261121.json).

## 2026-11-21 Live AI services over the DNS-pinned transport

- After the provider's DNS-pinning change, the standalone AI SQL CLI smoke was rerun against the saved encrypted DashScope Chat profile. Generate, repair, and explain all passed (3/3). The temporary SQLite database contained synthetic Schema only and zero rows. The smoke executed one deliberately invalid read-only SELECT to capture SQLite's actual missing-column error and ran read-only count checks; the model-generated SQL was not executed. The configured DashScope API key was sent in the authorization header and was not recorded; no database credentials or connection URI were sent, and full model responses were not recorded: [`CLI evidence`](../.cache/ai-cli-sql-assistant-2026-11-21-a3515abb32e5.json).
- The live Schema/RAG smoke then exercised Embedding, Rerank, and Chat through the current transport. Embedding returned 1,024 dimensions; three synthetic table documents were embedded/retrieved, Rerank placed the road table first, and cross-Schema Chat returned a read-only-valid draft referencing only the two selected synthetic tables. A 1,500-column synthetic table produced eight chunks; the final-field scoring and full-chunk replacement checks passed.
- This RAG smoke uses in-memory synthetic metadata and does not connect to a database. No source rows or business Schema were used. The configured provider key was sent only as DashScope authorization and was not recorded; the synthetic prompt contained no database credentials or connection URI. SQL was validated but not run. See the [sanitized RAG summary](../.cache/ai-schema-rag-dns-pinning-20261121.json). These checks verify current provider connectivity and crafted scenarios; they do not prove arbitrary model output or production-schema accuracy.

## 2026-11-22 PostGIS geometry measurement-unit clarification

- Added a deterministic post-generation guard for measurement requests whose SQL uses `ST_DWithin`, `ST_Distance`, `ST_Buffer`, `ST_Area`, or `ST_Length` on a referenced `geometry` column. If PostGIS metadata does not establish a positive finite linear unit (including angular EPSG:4326 coordinates), the assistant clears the SQL draft and asks the user to confirm the CRS and desired units. A metric-distance request against a known non-metre geometry unit remains blocked with a targeted clarification; `geography` is not subject to this geometry-unit rule.
- Added a synthetic regression in which “统计建筑面积” returns `ST_Area(geom)` for an EPSG:4326 polygon. The result contains no SQL and no validation result. The AI package suite passed 94/94; the targeted assistant suite passed 68/68.
- Full workspace `pnpm typecheck`, `pnpm build`, and `pnpm test` passed: 419 passed, 6 existing CLI skips. Tests used local mocks; no external model request or installed-GUI click was part of this change.
