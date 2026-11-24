# 阶段 4 已确认限制与结论（2026-11-25）

> 依据优化规划阶段 4（4.5 Neutral TAB、4.6 SQLite LOB）。这些项无法在当前环境"修复"，但规划验收标准允许给出明确结论并记录上限。本文即为结论记录，避免继续重复投入。

## 4.6 SQLite LOB 目标仍物化 —— 明确大小上限

**现状**：SQLite 适配器通过 `node:sqlite` 写入行数据时，BLOB/CLOB 值在写入前被完整物化到 Node 进程内存；当前 `node:sqlite` 绑定没有增量 BLOB 写接口。这不是缺陷而是绑定能力边界。

**上限说明**（供用户与能力矩阵引用）：
- 单行 LOB 建议上限 **≤ 16 MiB**；超过时内存占用约为 `行数 × LOB大小`，批量导入可能触发 V8 堆压力。
- 查询侧已实现流式读取（`queryStream` 分批），不受此上限影响；仅**写入目标**物化。
- 跨库传输带 LOB 时，若目标为 SQLite，请在源端分批（每批 ≤ 100 行）以控制峰值内存。

**关闭条件**：`node:sqlite` 提供增量 BLOB 写接口（如 `blobOpen` 写入流）后，将目标侧改为流式写入并删除本限制。

**验证**：`packages/database/src/sqlite.ts` 的 `insertRows` 路径；CLI 表传输集成中 SQLite 目标走物化路径（已有机器证据记录）。

## 4.5 Neutral TAB 三文件块读取错误 —— 结论

**现状**：`F:\GeoData` 中有 3 个 Charset=Neutral 的 MapInfo TAB，在显式 CP936/CP950/UTF-8 三种编码下均复现 GDAL `ReadBytes()` 越界或 `nCoordDataSize` 超大值。要素块坐标读取失败，与编码覆盖无关。

**结论**：**列为"当前 GDAL 运行时不支持"**，原因归为源文件数据块损坏或 GDAL TAB 驱动无法解析该变体。依据：
- 三种编码下同一错误复现 → 不是编码选择问题；
- 独立安装 GDAL 3.12.1 同样报错 → 不是本项目随包运行时特有；
- 其它 Neutral TAB（17 层）在显式 CP936 下往返成功 → 不是 Neutral 声明本身的问题。

**处置**：
- 不自动猜测这些文件的编码，继续在审计报告中标记为 `encoding-choice-required` / 不支持；
- 如需支持，需数据所有者提供可验证读取的原始 TAB，或向 GDAL 上游提交最小复现；在此之前不投入更多修复尝试。

**机器证据**：`.cache/local-gis-neutral-tabs-preview-cross-encoding-20261117.json`、`.cache/qgis-installation-analysis.md` 相关条目。

## 后续不再重复投入

这两项已给出规划验收标准允许的明确结论（上限与不支持原因），从待办清单中关闭。剩余阶段 4 项（4.1 流式维度扫描、4.2 bbox 库内过滤、4.3 编码候选一等流程、4.4 空间索引组合）按优先级另行安排。
