# Embedding、Schema RAG 与 Rerank

更新日期：2026-11-21

## 2026-11-18 超长表结构分块索引

桌面索引格式已升到 v5。旧桌面端只采集前 160 列和 40 个外键。建索引现在会采集所选表的完整列和外键元数据。对于 Chat，需求和当前 SQL 中明确引用的字段优先进入有大小上限的 Schema 上下文。第 200 列的自动回归验证了请求内容和草稿校验。已安装的 v5 MSI 通过真实 SQLite 的 1,500 列空表和本机模拟模型，验证了窗口建索引、加密持久化、检索请求、Chat 上下文和 SQL 草稿预览。该次窗口验收使用固定模拟回复。详见 [运行证据](../.cache/installer-smoke/full-schema-gui-acceptance-20261118.json)。

- Schema 文档格式升为 v4。单表结构现在按完整字段/关系记录切成不超过 8,000 字符的 Embedding 文档，最多 32 片；单次建立索引最多 200 片。超过边界时会在发送请求前明确报错，不再静默丢弃 40,000 字符之后的字段或备注。
- 每片各自保存向量，但仍使用同一连接/数据库/Schema/表键；本地检索按表合并分数，更新或清理一张表会替换或移除它的全部分片。模型指纹变化会要求按新格式重建当前 Schema 范围。
- 分块只用于 Schema 元数据检索，不包含业务行；Rerank 与最终 SQL 上下文仍从当前数据库加载所需表结构，并受既有请求大小限制约束。
- 建立和清理索引的写入按顺序合并到当前磁盘快照，避免并发操作用旧快照覆盖彼此。
- DashScope 在线回归将一张 1,500 列合成表拆为 8 片，返回 1,024 维向量。旧文档边界之后的字段在分块后获得更高的检索分数，重建时替换了该表全部旧分片。同轮跨 Schema 合成查询也通过 Embedding、Rerank 和 Chat，再由本地验证器检查生成草稿。

## 2026-11-18 PostGIS 空间列指纹与索引反馈

- Schema 索引和 SQL 生成现在先调用共享的 `applyPostgisSpatialMetadata`，再计算结构指纹，统一 PostGIS 驱动返回的 `USER-DEFINED` 类型与规范化后的 `geometry/geography` 元数据。真实 PostGIS 集成选取 3 个合成 Schema，3/3 指纹配对一致，原始元数据未被改写；生产 stale 检查也判定规范化结构全部新鲜，并在改变三个表的 SRID 后将它们全部标为过期。Embedding、检索、Rerank 和 SQL 只读/Schema 校验通过。临时 Schema 已清理，SQL 未执行，外发内容仅含合成 Schema 与测试意图。详见 [脱敏结果](../.cache/ai-schema-fingerprint-postgis-20261118.json)。
- `findStaleSchemaIndexTableKeys` 被 Electron AI handler 复用；当前 PostGIS normalization regression、stale predicate 回归与 AI 包 87 项完整测试通过。
- AI 面板的索引按钮新增持续可见、带无障碍播报的成功/失败/取消状态，并在连接范围、Schema/表选择或面板状态改变后清除旧消息。桌面测试 72/72、AI 包测试 87/87、类型检查和生产构建通过；含状态反馈的 MSI（SHA-256 `7C027F6E83680A37CB38E9095B31858AA97C7CD358CA6689EB754217C3150235`）已安装，载荷哈希匹配且主窗口启动响应。[安装摘要](../.cache/installer-smoke/schema-index-feedback-msi-build-20261118.json)。
- 2026-11-18 当时安装的 MSI 没有点击索引按钮；此缺口已由 2026-11-20 当前源码 MSI 的安装版验收补上：GUI 为合成 PostGIS 表建立 3 维索引，添加列并刷新元数据后显示结构过期提示，重建后提示消失。仅使用 loopback Chat/Embedding mock，SQL 未执行且未读取业务行；详见[安装版报告](test-report.md#2026-11-20-installed-msi-schema-index-rebuild-and-stale-structure-gui-acceptance)。

## 2026-11-21 Schema 索引覆盖差异提示

- 生成 SQL 前会比较当前 Schema 表清单与所选连接、数据库、Schema 和 Embedding 模型范围内已有索引条目；提示未索引表与已删除表残留的数量，并继续用可用语义索引和关键词检索，不自动重建或删除索引。
- AI 单元测试14/14、AI 包 host-loopback 套件89/89、桌面类型检查和生产构建通过。本次没有联系外部模型。系统无法判定缺失表是用户有意只索引部分表，还是索引后 Schema 有变化，因此只报告差异，不擅自扩大索引范围。详见[AI 测试报告](ai-sql-test-report.md#2026-11-21-ai-schema-index-coverage-differences)。

## 建立索引

2026-11-16：索引文档曾将字段和外键排在备注之前，避免长备注先耗尽 40,000 字符上限；结构本身超过上限时仍可能截断。2026-11-18 的分块格式已消除此静默截断边界。文档格式版本纳入模型指纹，旧格式索引不会参与新版语义召回，应用提示重建并回退关键词。格式或模型变更后重建时，当前 Schema 的旧索引整体被替换，请选择所有需要语义检索的表；其他连接和 Schema 的索引不受影响。AI 包 79/79 测试、桌面 typecheck 通过；C4F MSI 包含当时索引格式修改，交互工作流尚未验收。

后续源码将元数据变化指纹改为覆盖完整表结构，而不是截断后的文档；超过文档上限的变化也能在该表被检查时触发过期提示。AI 包 80/80 测试、typecheck 和 build 通过。已安装 A3FD MSI 尚未包含此项修改。

同日使用新版构建的 AI 包重新运行 `test:integration:ai-schema-rag`：合成三表全部召回，Embedding 为 1,024 维，Rerank 将道路表排第一；另一连接无匹配，清理一个范围保留另一范围。请求使用模型密钥认证，正文只含合成表结构和查询意图，未连接数据库或发送数据库凭据、业务行。该有限样例不证明复杂查询准确率。

Embedding 是可选增强。用户在当前连接中明确选择 Schema 和表，再点击建立索引。一次最多选择 100 张表，Embedding 批次最多 10 个文档。每张表生成一片或多片文本，内容限于表和列元数据、备注、键关系和已知空间类型。

向量及文档存于应用用户数据目录的 DPAPI / Electron `safeStorage` 加密文件 `ai-schema-index.enc`。索引范围由连接 ID、数据库、Schema 唯一确定；增量建立仅替换选中表。模型 URL、Provider、模型名或配置维数变化时旧模型向量不混用，须重新建立索引。保存或删除连接会清理该连接的索引。

## 查询

只在本次 Schema 同意已开启、Embedding 已启用且密钥存在时发送 Query 向量。当前所选的每个连接/数据库/Schema 范围分别检查索引；兼容索引参与本机余弦/关键词混合检索。缺少或不兼容的范围会显示警告，并回退到关键词或仅使用其他兼容范围。AI SQL 生成不依赖 Embedding。

若用户启用了 Rerank，最多对 12 个召回候选发送截断的 Schema 文档，随后保留最多 8 张表用于 Chat 上下文。Query 和 Schema 摘要只在本次请求内发送，不写到索引之外的日志。Rerank 失败时保留本地混合排序。

## 验证边界

15 项 AI 单元测试覆盖范围隔离、增量替换、维数与模型切换、Rerank 排序以及执行计划输入边界。2026-11-02 Provider 冒烟只向 Embedding 发送一条合成文本并返回 1,024 维。当天另有单独的桌面 GUI 验收，为选定测试 Schema 建立本机索引并完成检索、Rerank 与 Chat 流程；该结果证明这组受控测试数据的链路可用，不代表一般业务 Schema 的检索质量或 SQL 准确率。

## 2026-11-02 桌面 Schema RAG 验收

- 在隔离的 Windows unpacked 构建中连接项目测试库 `dbstudio_test`，只选择 `ai_rag_acceptance_20261102` 下的 `land_use_lookup`、`parcel_inventory`、`parcel_sales` 三张测试表。
- 经用户授权，将所选表的结构元数据和合成查询意图发送至 DashScope。Embedding 为三张表建立了 1,024 维本机语义索引，查询流程完成语义检索、Rerank 与 Chat，界面未显示 Rerank 回退。
- 生成的 PostgreSQL 只读聚合草稿引用上述三张表，未插入编辑器或执行。没有发送业务行、数据库密码或连接 URI。
- 该验收覆盖主机 unpacked 版本；不代表安装版或干净机器验收，也未覆盖跨 Schema 和一般业务查询质量。对应详情见 `docs/ai-sql-implementation-plan.md` 与 `docs/progress.md` 的 2026-11-02 记录。

2026-11-09 更新：使用桌面加密设置中的 DashScope 配置分别运行 Chat、Embedding 和 Rerank 最小探测，三项通过；Embedding 返回 1,024 维。本轮请求仅含 Provider 测试代码中的合成短文本，没有新增 Schema 索引或上传 Schema。此前受控测试 Schema 的桌面 RAG 验收仍以上述 2026-11-02 记录为准。

## 2026-11-11 实时 Schema 检索回归

- 新增 `pnpm run test:integration:ai-schema-rag`，从当前用户加密桌面设置读取 Embedding 与 Rerank 配置；集成使用三份合成表结构，不连接数据库，也不读取业务行。
- 在线 Embedding 将三份合成 Schema 文档索引为 1,024 维，合成自然语言查询召回三项候选；DashScope Rerank 将道路几何表排在第一。额外断言验证了不同连接无匹配结果、清空一个连接/Schema 范围不会删除另一连接的索引。
- 命令通过。此证据覆盖 Provider、Schema 文档格式、Embedding、范围隔离、局部清理和 Rerank 的端到端组合；不替代桌面 IPC、加密文件持久化或任意业务 Schema 的检索质量验收。

## 2026-11-16 数据库范围隔离复核

- 回归测试补充验证：同一连接和同一 Schema 下，换到另一个数据库不能命中原索引；连接隔离、Schema 隔离和局部清理断言保留。
- AI 包测试 77/77 通过。在线 RAG 脚本再次返回 1,024 维 Embedding；三份合成 Schema 均被召回，Rerank 将 `public.road_segments` 排第一，另一连接结果为 0，并保留了另一个隔离范围的索引。
- 请求正文只包含脚本内三份合成表结构和合成查询意图；服务认证使用模型 API 密钥。未连接数据库，也未发送业务行、数据库凭据或连接 URI。该结果验证范围隔离和合成检索排序，不证明复杂业务或跨 Schema 查询准确率。机器记录：[scope regression](../.cache/ai-schema-rag-scope-20261116.json)。

## 2026-11-17 多 Schema RAG 与无歧义表键

- SQL 助手允许用户显式选择最多 16 个 Schema；表清单、关键词候选和 Embedding 检索只覆盖所选范围。索引仍按连接、数据库和单个 Schema 隔离；跨 Schema 请求合并已选范围内兼容的本机索引。缺索引或旧格式索引会显示警告。
- 内部表键改为 JSON 二元组 `[schema, table]`，避免 Schema/表名含点号时发生碰撞。索引文档指纹版本升至 3；旧版本不能混用，重建单个 Schema 时该 Schema 的旧向量会被替换。GIS SQL 保持单 Schema 约束。
- 多 Schema 实现初次验证时，AI 全量测试 82/82 通过；全工作区测试 330 通过、6 个 CLI 测试跳过；`pnpm typecheck` 和 `pnpm build` 通过。新增跨 Schema 验证器回归后，AI 包测试先更新为 83/83；2026-11-17 的 CTE 输出列校验修复后为 84/84。
- 在线 RAG 使用 `public`、`parks`、`crm` 三个合成 Schema 的三张表：Embedding 1,024 维，三张候选全部召回，Rerank 将 `public.road_segments` 排第一；其他连接匹配数为 0，清除所选范围后保留另一个连接范围。新增跨 Schema 查询回归后，限定 `public` 与 `parks` 范围召回两表，Rerank 后交给 Chat；Chat 生成引用 `public.road_segments` 和 `parks.park_areas` 的单条只读草稿，并通过 Schema/只读静态校验。请求只含脚本内合成 Schema 和意图，没有连接数据库或执行 SQL。详见[机器记录](../.cache/ai-schema-rag-multi-schema-20261117.json)。
- 新增验证器回归覆盖跨 Schema 的表和列解析、带尾分号 CTE 输出、CTE 内缺列拒绝，以及 CTE 输出别名排序；`pnpm --filter @db-studio/ai test` 当前通过 84/84，AI 与 CLI 包构建通过。
- 实时测试已覆盖一个合成的三 Schema 空间聚合查询；这不证明其他复杂业务查询的一般准确率。2026-11-17 使用安装 MSI 的原始 `app.asar` 做了受控 UI 回放，验证 PostGIS Schema/表清单 IPC、AI 抽屉和本机设置读取；所选 Schema 的列/外键加载、Embedding/Rerank/Chat 请求 IPC 与模型生成界面仍未验收。按请求打开 Schema 同意控件时自动审批失败，未执行点击且没有发送 Schema。详见[MSI PostGIS UI 冒烟证据](../.cache/installer-smoke/msi-8235-postgis-ui-smoke-20261117.json)。

## 2026-11-17 Live PostGIS multi-Schema metadata and RAG

- The loopback-only integration creates four randomized synthetic schemas in `dbstudio_test`, selects three, and loads their columns, comments, and PostGIS spatial metadata through `CoreService` and the production metadata loader.
- DashScope Embedding, local multi-Schema retrieval, Rerank, and Chat all pass for the three selected tables. The generated draft passed deterministic checks for separate road and stop aggregation CTEs, two `ST_Intersects` relations, distinct road/stop counts, stored length aggregation, retaining parks without road matches, the minimum-stop threshold, and ordering. It also passed local read-only/schema validation. The SQL was not executed and no business rows were read.
- All four temporary schemas were dropped and verified. The external payload contained only generated schema metadata and synthetic intent; no credential, connection URI, model response, or SQL text was logged. This covers one complex synthetic spatial query, not general SQL accuracy. A later controlled replay of the installed MSI's original `app.asar` verified PostGIS schema/table-list IPC plus the visible AI drawer/model-settings UI and `ai:settings:get`; it did not exercise selected-table columns/foreign-key loading, Embedding/Rerank/Chat request IPC, or model generation. The per-request Schema consent click was not executed after automatic approval review failed. See [sanitized evidence](../.cache/ai-schema-rag-postgis-live-20261117.json), [installed-payload UI replay](../.cache/installer-smoke/msi-8235-rea-ui-replay-20261117.json), and [PostGIS UI smoke evidence](../.cache/installer-smoke/msi-8235-postgis-ui-smoke-20261117.json).
