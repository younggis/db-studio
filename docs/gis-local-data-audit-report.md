# 本地 GIS 数据审计与往返验证

更新日期：2026-11-15

## 范围与隐私

2026-11-04 的只读普通文件扫描覆盖了用户授权的两个本地目录，共发现 1,261 个矢量或空间数据候选项；同一轮还检查了 100 个 ZIP、17 个 7z/RAR 压缩包的目录成员。ZIP 成员内容扫描于 2026-11-05 重跑并启用受限解包回退。扫描只保存格式、状态、图层数量、字段数量和少量解码状态等审计元数据，不保存属性样本值。扫描未修改源文件。

普通文件和 7z/RAR 汇总保存在工作区 `.cache/local-gis-data-audit-20261104-mvt-format-utf8.json` 和 `.cache/local-gis-7z-rar-audit-20261103-static584.json`。ZIP 成员审计于 2026-11-05 增加解包回退，最新原始报告为 `.cache/local-gis-archive-audit-20261105-fallback-v2.json`。原始审计 JSON 含相对路径和驱动错误，适合本机排查；本报告只保留汇总，不复述具体源文件名称。

### 2026-11-14 当前文件复扫

- 重新扫描 `F:\GeoData`（152 项）和 `F:\temp`（357 项），共 509 个候选。格式状态为：CSV 21、DXF 1、GeoJSON 98、GeoPackage 28、JSON 1、KML 4、Shapefile 108、TAB 156；另有 12 个 JSON 未识别为矢量数据，80 个 ZIP 留待成员检查。
- 检查结果包含 420 个图层预览：388 个完成解码，32 个需要用户确认编码；33 个文件级编码状态仍为 unknown。审计不会把编码歧义自动选成导入编码。
- 本次只读扫描没有改写或导入源数据。GDAL 打开失败和非空间 JSON 分类都不表示源文件损坏。最新机器可读报告为 `.cache/local-gis-data-audit-current.json`。

### 2026-11-14 ZIP 成员复扫（后续由 2026-11-15 分批报告复核）

- 复查两个根目录的 80 个 ZIP：70 个含成员、10 个没有矢量成员。枚举 193 个矢量格式候选，其中 24 个 JSON 经内容分类为非空间数据；其余 169 个空间候选全部由当前静态 GDAL 解码成功。
- 后续按偏移分批复扫确认了相同的 80 个 ZIP 和 169 个空间成员。完整机器报告以 `.cache/local-gis-archive-audit-aggregate-latest.json` 为准；这是成员枚举和预览结果，不等于所有 ZIP 数据都已完成 PostGIS 往返。

### 2026-11-14 7z/RAR 成员复扫

- 检查当前两个根目录的 13 个 7z/RAR：8 个 7z、4 个含数据的 RAR 全部完成成员检查，另 1 个 RAR 没有矢量成员。共找到 106 个数据候选，其中 105 个矢量成员全部解码成功，另 1 个 JSON 为非空间内容。
- 未报告成员检查失败或跳过。机器可读报告为 `.cache/local-gis-7z-rar-audit-latest.json`。该审计验证成员可读和有限图层预览；完整数据转换需另做导入导出往返。

## 普通文件扫描

### 2026-11-12 高置信 CSV PostGIS 往返补充

- 从当前 `F:\GeoData` 与 `F:\temp` 扫描中筛选 10 个已确认高置信编码的无 BOM CSV，使用项目隔离 PostGIS 服务做文件→临时表→GeoPackage 往返。10/10 通过，合计 707,453 个要素，数据库与导出计数均匹配。
- 每层最多抽样 20 行，因若干图层不足 20 行，实际比较 163 个要素；CSV 输入和数据库导出均为空几何，样本一致。1,957 个文本字段值样本顺序无关比较全部一致。此结果不代表全量属性或几何无损证明。
- 临时表和导出目录均已清理，未更改源文件，`externalDataSent=false`。机器可读摘要见 `.cache/local-gis-csv-postgis-roundtrip-20261112.json`；报告不记录源属性值。

| 扩展名 | 成功检查 | 检查失败或待处理 | 说明 |
|---|---:|---:|---|
| Shapefile | 136 | 0 | 含多图层预览结果 |
| GeoJSON | 102 | 1 | 一项解析失败，错误位置在输入内容后段 |
| GeoPackage | 97 | 0 | |
| MapInfo TAB | 157 | 2 | 两项未能打开 |
| KML | 5 | 0 | |
| CSV | 28 | 0 | 已检查为可解析候选；CSV 是否包含空间字段需按文件确认 |
| JSON | 2 | 40 | 两项可读；其余未识别为可检查的矢量数据，不能据此断言文件损坏 |
| PBF | 1 | 589 | 对代表性失败项尝试自动、OSM 和 MVT 驱动仍未打开；不能据此断言全部 PBF 均非空间数据 |
| DXF | 1 | 0 | |
| ZIP | 0 | 100 | 常规数据扫描只登记压缩包，成员另行检查 |

常规扫描记录 1,261 个候选数据项：529 项检查成功，632 项检查失败，100 个 ZIP 待成员扫描。已检查数据得到 549 个图层预览，其中 475 个解码成功，另有 74 个图层需要人工确认字符编码，分布在 60 个文件中。编码审计缺少足够可靠的声明或元数据时不会猜测字符集；需要在导入时由操作者选择。没有字符串属性字段的图层不需要进行字符集选择。

## ZIP 成员扫描

- 独立递归压缩包枚举器发现 100 个 ZIP；常规候选扫描列出 99 个，两种扫描器的纳入规则略有差异。100 个 ZIP 中，87 个包含向量格式成员，13 个没有向量成员。
- 共枚举 211 个矢量候选成员；扫描器跳过了 AppleDouble ._* 元数据文件。对 /vsizip/ 访问失败的成员，会先校验相对路径，再将单文件或 TAB/SHP/MIF 配套文件临时提取到 .cache 并重试；每个候选默认最多提取 1 GiB，临时目录在检查结束时清理。
- 181 个图层成功检查。另有 27 个 .json 成员经内容抽样确认不是 GeoJSON/ESRI JSON，记为 non-vector-json；剔除后 184 个空间数据候选中有 181 个成功读取。
- 剩余 3 个 MapInfo TAB 文件均由 GDAL 报告第 15 行字段定义解析失败。将三个 TAB 连同配套文件复制到 ASCII 临时文件名后，用 QGIS 3.44.8 自带的 GDAL 3.12.2 再读，三项仍报同一错误；当前静态 GDAL 候选也是同版本并得到相同结果。这说明问题不只出现在静态候选，但仍不足以单独证明源文件损坏。对照证据见 `.cache/local-gis-archive-tab-qgis-compare-20261105.json`。
- 2026-11-11 对失败样本进一步检查确认，字段名中的 ASCII 括号触发该解析错误。GIS 输入准备现在只在临时副本中规范化不会破坏常见 DBCS 字节的 ASCII 字符，保留 GBK/Big5/Shift-JIS 多字节字段名原字节；调用方收到 warning，源归档和 sidecar 不变。通过应用层 `GdalService.inspect` 以 CP936 检查真实 TAB，MapInfo 图层读取到 1,240 个要素及全部 10 个字段；`隧道覆盖CGI(4G)`、`隧道覆盖CGI(5G)`、`细分段长度(km)` 对应字段以 `_` 代替括号。由于 TAB 声明 `Neutral`，导入中文属性仍要求用户明确选择字符集。

## 7z/RAR 成员扫描

- 枚举了 17 个压缩包，共识别 113 个数据集候选、112 个矢量候选；111 个图层由 OGR 解码，1 个成员需密码，另有 1 个 JSON 清单确认不是空间数据。
- 每个数据集的临时解包限制为 1 GiB / 20,000 个成员；扫描过程没有绕过 7-Zip 的链接目标检查。解包目录按候选清理，最终临时根目录无残留，源压缩包未修改。
- 后续真实往返从 SHP、TAB、KML、GPKG 各选 1 个、共 200 个要素：PostGIS 导入计数及同格式导出均通过；几何样本 26/26 匹配，文本抽样 181 项一致，坐标容差 `1e-8`。报告为 `.cache/local-gis-7z-rar-roundtrip-20261105.json`。
- PolygonZ Shapefile 与通用 KML 图层的 Z 坐标均通过抽样比较；通用 KML 导入显式采用 XYZ，2D 要素可能补零。TAB 导出使用 PostGIS extent 生成 MapInfo `BOUNDS`，本地样本由此通过 `1e-8` 坐标比较。PostGIS 临时表、导出文件与解包副本均已清理，报告记录 `externalDataSent=false`。
- 两个超过 20 MiB 样本上限的候选未纳入往返；1 个密码保护 SHP 尚未验证。该结果是有界样本证据，不代表全部归档成员已往返。

## 使用本机数据的 PostGIS 往返

新增 `pnpm test:integration:local-gis-roundtrip`，从已解码、编码有来源声明且规模受限的本机数据中，各选取一个样本，通过 CLI 导入隔离 PostGIS 测试库、核对表内要素数，再导出相同格式并重新检查要素数。2026-11-03 在通用 geometry 列导入修复后再次运行，五种格式的本机样本要素数均与下表一致。

| 格式 | 源文件解码要素数 | PostGIS 导入要素数 | 导出后要素数 | 编码元数据 |
|---|---:|---:|---:|---|
| Shapefile | 7 | 7 | 7 | CP936 |
| GeoJSON | 7 | 7 | 7 | UTF-8 |
| KML | 6 | 6 | 6 | UTF-8 |
| MapInfo TAB | 9 | 9 | 9 | CP936 |
| GeoPackage | 296 | 296 | 296 | UTF-8 |

五种格式的要素数均保持一致。测试使用唯一临时表，并在结束时核对表已删除；导出文件写入系统临时目录并清理。此项证明了这些样本可完成真实导入、导出和要素计数验证，不代表其余全部本机文件都已导入，也不单独证明属性、几何坐标或编码逐字段完全等价。跨格式的几何、CRS、字段和编码边界由现有专用 GIS 集成用例另行验证。

## 混合单几何/多几何导入回归

批量探测发现有些数据源把图层声明为单几何类型，但实际要素包含 MultiLineString 或 MultiPolygon；直接按声明类型建 PostGIS 几何列会拒绝整次导入。PostGIS 新建/覆盖导入现在使用通用 `geometry` 列，不改写各要素自身的几何类型，并在导入报告中说明列类型选择。追加导入会保留目标表既有的几何列类型，并在报告中提示受限类型可能拒绝不匹配要素。真实集成回归覆盖声明为 LineString、含 LineString 与 MultiLineString 要素的图层，并验证创建及追加后两种类型都保留。更新后的本机五格式样本和标准 PostGIS 五格式往返均通过。

在最初的 10,000 要素 / 20 MiB 边界下，2026-11-04 静态 GDAL 与隔离 PostGIS 批次有 401/401 通过。随后将可配置边界扩大到 100,000 要素 / 100 MiB，并增加来源哈希诊断及按来源覆盖字段类型/字符集的能力。扩展批次共 431 个合格图层：全量运行 430/431 通过；余下的 CP1252 来源通过带精确编码覆盖的定向复验。聚合证据严格匹配两份报告中的 sourceId，最终覆盖 431/431：GeoJSON 92/92、GeoPackage 96/96、JSON 2/2、KML 11/11、Shapefile 97/97、MapInfo TAB 133/133。

扩展边界下跳过 76 个编码信息不足的图层、30 个超过 100,000 要素上限的图层和 12 个超过 100 MiB 数据包上限的图层。两项人工编码覆盖分别为 CP1252 和 CP936；两个字段类型异常使用明确映射（DBF `WIDTH` 到 `real`；GeoJSON 的 5 个混合 JSON 子类型字段到字符串）。没有自动猜测这些覆盖。聚合报告 `.cache/local-gis-roundtrip-batch-20261104-expanded-aggregate.json` 引用全量与定向报告，并确认临时 PostGIS 表、导出目录均清理，未向外部服务发送数据。

其中一个 Shapefile 的 `.cpg` 声明为 UTF-8，但 PostGIS 拒绝其首要素的文本字节。GDAL 实测以 `WINDOWS-1252` 解释后能生成合法 UTF-8；程序原先把用户选择的 CP1252 规范化为 `CP1252`，而当前 GDAL 运行时需要 `WINDOWS-1252`。现在只在 GDAL 调用边界转换名称，用户界面与审计仍使用 CP1252。批次显式为该来源覆盖 CP1252，其他文件不自动猜测。项目的 PostGIS 多图层集成新增误标记 sidecar 的合成回归：导入一条 `café`、以 CP1252 导出并从导出文件自动识别后重导入，属性和要素数保持一致。对该本机来源的定向导入也成功写入 6,108 条；源文件未修改。

## 可复现命令

```powershell
$env:DBSTUDIO_GDAL_BIN = (Resolve-Path '.cache\gdal-static-candidate-20261103-liblzma-5.8.4\bin').Path
$env:DBSTUDIO_LOCAL_GIS_AUDIT_REPORT = '.cache/local-gis-data-audit-20261103-static584.json'
pnpm test:integration:local-gis-data
$env:DBSTUDIO_LOCAL_GIS_ARCHIVE_REPORT = '.cache/local-gis-archive-audit-20261103-static584.json'
pnpm test:integration:local-gis-archives
$env:DBSTUDIO_LOCAL_GIS_7Z_RAR_REPORT = '.cache/local-gis-7z-rar-audit-20261103-static584.json'
pnpm test:integration:local-gis-7z-rar
$env:DBSTUDIO_LOCAL_GIS_AUDIT_REPORT = '.cache/local-gis-data-audit-20261103-static584.json'
pnpm test:integration:local-gis-roundtrip
```

## 2026-11-04 定向复核与坏 UTF-8 源文件

- 对 `F:\GeoData\building.shp`（1,700,704 要素）和 `F:\GeoData\t_gis_microgrid_new.shp`（14,410 要素）使用显式 CP936 完成 PostGIS 往返；各抽查前 20 行的文本字段，分别比较 100 和 140 个值，源值与导出值一致。证据见 `.cache/local-gis-roundtrip-cp936-text-verified-20261104.json`。
- `F:\temp\t_gis_grid_old.shp` 的第二个来源根副本（136 要素）通过往返，临时表及导出目录已清理；见 `.cache/local-gis-roundtrip-t_gis_grid_old-second-root-20261104.json`。
- 两份 `city_road.shp` 副本均无法按其 `.cpg` 的 UTF-8 声明完成 PostGIS 导入。DBF 扫描在两份文件中都定位到第 32073 条记录的 `CITY` 字段；其中一份的真实隔离库失败报告在 `Error.message` 和结构化 `report.warnings` 中都包含该定位提示，事务回滚、临时表清理确认。未用整文件 CP936 覆盖，也未改动源文件。见 [坏 UTF-8 定位证据](../.cache/local-gis-invalid-utf8-diagnostic-20261104.json)。
- 本次 GIS 包测试 27/27、类型检查和构建通过。坏字节源在 OGR 元数据检查阶段仍可读，因此定位提示由实际导入失败路径提供。

## 来源目录感知的较大要素往返（2026-11-04）

- 重新扫描 1,261 个候选项，生成 `.cache/local-gis-data-audit-20261104-root-aware.json`。每个数据集均保留 `sourceRoot`；这修复了旧静态审计清单缺少来源根、批次脚本用首个可匹配根目录解析同名相对路径的歧义。
- 使用新清单在隔离 PostGIS 对 5 个 100,000 至 500,000 要素、数据包不超过 100 MiB 的图层逐一导入、计数、导出并复核：GeoJSON 149,356；两份不同来源根下的同名铁路 Shapefile 分别为 172,778 和 293,486；Shapefile 道路图层 412,235；显式 CP936 的 Shapefile 159,926。5/5 的源端、PostGIS 和导出要素数一致。
- 对前四个含文本字段的图层分别抽查前 20 行，比较 40、20、20 和 140 个文本值，均一致；第五个图层没有文本字段。CP936 覆盖仅针对报告中对应的一个 source ID，未写回源文件。
- 临时 PostGIS 表和导出目录均已清理；报告 `.cache/local-gis-roundtrip-root-aware-20261104.json` 确认 `postgisTemporaryTablesCleaned=true`、`exportDirectoryCleaned=true`、`externalDataSent=false`。这组较大样本补充既有 431/431 小规模合格图层聚合结果，不代表对未入选的大文件全部完成往返。
- 继续从来源目录感知清单选择两个 500,000 至 1,500,000 要素、数据包不超过 250 MiB 的道路 Shapefile：526,353 和 1,235,628 要素均通过导入、PostGIS 计数、导出及重新解码；各抽查前 20 行文本字段的 20 个值均一致。两份文件名相同但来源根不同，批次以 source ID 区分。报告 `.cache/local-gis-roundtrip-root-aware-500kplus-20261104.json` 确认 2/2 通过、临时表及导出目录清理、未发送外部数据。
- 在确认 C、F 盘剩余空间后，另对两个近 1 GiB 数据包做串行往返：Shapefile 832,746 要素、GeoJSON 832,747 要素均通过数据库计数和导出重新解码；前 20 行分别比较 100 和 80 个文本值，结果一致。约 1.04 GiB GeoJSON 导出曾产生 1.35 GB 临时文件，批次结束已删除。报告 `.cache/local-gis-roundtrip-root-aware-1gb-shapefile-20261104.json` 和 `.cache/local-gis-roundtrip-root-aware-1gb-geojson-20261104.json` 均确认临时表/输出目录清理，未发送外部数据。

## 2026-11-04 additional 100k–500k feature round trips

- Four previously untested, metadata-encoded Shapefiles from the audited source roots passed decode, PostGIS import/count, same-format export, and output re-decode/count: 188,488, 133,265, 367,122, and 113,483 features. Bundles ranged from 118.6 to 247.7 MB.
- The first 20 rows of each source and export were compared: 280, 280, 140, and 220 text values respectively, all equal. No encoding or field-type overrides were needed.
- The serial batch report `.cache/local-gis-roundtrip-root-aware-100kplus-followup-20261104.json` records 4/4 passed, zero failures/skips, temporary PostGIS tables cleaned, export directory cleaned, and `externalDataSent=false`.
- Two additional road Shapefiles were not treated as successful round-trip candidates because their actual UTF-8 imports fail at DBF record 32073, field `CITY`; that malformed-byte failure, rollback, and cleanup are recorded separately.

## 2026-11-04 million-feature Shapefile round trips

- Four additional metadata-encoded Shapefiles passed serial PostGIS import/count, same-format export, and output re-decode/count: 1,067,375 features (1.40 GB bundle), 1,511,504 features (1.99 GB), and two separate 3,747,507-feature layers (3.14 GB each).
- First-20-row text comparisons matched 280, 280, 40, and 40 values respectively. No encoding, field-type, or field-name overrides were applied.
- `.cache/local-gis-roundtrip-root-aware-millionplus-followup-20261104.json` records 4/4 passed, zero failures/skips, PostGIS temporary tables cleaned, export directory cleaned, and no external data sent. Two other >1m feature layers had already passed in earlier reports (1,235,628 and 1,700,704 features).

## 2026-11-04 larger-layer coverage and explicit-encoding regression

- A further eight audited layers with 125,277–858,186 features and 344 MB–1.13 GB bundles passed serial PostGIS import/count, same-format export, and re-decode/count. Three layers contained 125,277 features each; the other five contained 262,179, 281,478, 320,297, 450,873, and 858,186 features. First-20-row comparisons matched all 1,840 sampled text values. The report `.cache/local-gis-roundtrip-root-aware-250m-1g-followup-20261104.json` records 8/8 passed, zero failures/skips, cleanup confirmed, and `externalDataSent=false`.
- The baseline root-aware audit contains 1,261 candidates; among 529 inspected datasets it recorded 549 layer previews, with 478 decoded and 71 requiring an explicit encoding choice. After the driver-aware MVT verification below, the derived current snapshot records 491 decoded and 58 still requiring an explicit choice. Those remaining choices are not guessed.
- Across the earlier nine larger samples and the later batches of four 100k–500k, eight 125k–858k, and four million-feature layers, 25 larger known-encoding layers now have round-trip evidence. This does not include the two malformed `city_road.shp` copies, which remain separately documented failures.
- Fixed the local round-trip batch preflight so a layer marked `encoding-choice-required` is eligible when that exact source file has an explicit encoding override. A synthetic two-feature GeoJSON was intentionally marked as unknown encoding and supplied an explicit UTF-8 override; PostGIS import/count/export/re-decode passed, all four sampled Chinese text values matched, and the temporary table and export directory were removed. Evidence: `.cache/encoding-override-roundtrip-20261104.json`; no source data was changed and `externalDataSent=false`.

## MVT PBF input and format-defined UTF-8 (2026-11-04)

- GDAL identified the inspected `.pbf` source as the `MVT` driver. The Mapbox Vector Tile specification states that MVT and OSM PBF are different formats; its schema declares string-valued properties, and Protocol Buffers requires strings to be valid UTF-8. See the [MVT specification](https://mapbox.github.io/vector-tile-spec/), [`vector_tile.proto`](https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto), and [Protocol Buffers encoding guide](https://protobuf.dev/programming-guides/encoding/).
- GIS inspection now marks UTF-8 as format-defined only after GDAL reports driver `MVT`; a generic `.pbf` extension alone does not trigger this rule. The desktop GIS file picker now includes `.pbf` as an input choice. MVT remains read-only in this GDAL runtime, so the verified export target was GeoPackage.
- All 15 MVT layers (2,754 features total) passed attribute preview, isolated PostGIS import/count, GeoPackage export, and re-decode/count. Across the first 20 rows per layer, 166 rows and 592 text values matched. Three layer-specific field mappings translate `name_zh-Hans` to the PostgreSQL-safe `name_zh_hans`; the values matched. The report `.cache/mvt-postgis-roundtrip-20261104.json` records zero failures, cleaned temporary tables/export directory, and `externalDataSent=false`.
- `.cache/local-gis-data-audit-20261104-mvt-format-utf8.json` preserves the 1,261-candidate root-aware audit and updates only this verified MVT dataset; the resulting layer totals are 491 decoded and 58 requiring an explicit encoding choice.

## ZIP archive members through PostGIS (2026-11-05)

- Added `pnpm test:integration:local-gis-archive-roundtrip` to exercise small, non-empty SHP, GeoJSON, and TAB members directly from the archive audit. Selection requires a known source encoding, a positive decoded feature count, at most 10,000 features, and at most 20 MiB for the member family; the default run selects up to 18 layers, balanced across the three formats.
- Ran the package command `pnpm test:integration:local-gis-archive-roundtrip`, including a fresh workspace build. The default 18-layer acceptance run passed all 6 Shapefile, 6 GeoJSON, and 6 TAB layers. Source, PostGIS, and exported feature counts matched for 1,683 features. Geometry comparison covered up to 20 features per layer (121 total) with `1e-8` coordinate tolerance; the first 20 attribute rows per layer covered 121 rows and 363 string values, all equal.
- Polygon comparison treats ring start vertex and winding direction as equivalent, while still comparing every coordinate within tolerance; interior rings and MultiPolygon members are matched independent of ordering. This corrected a false mismatch in one boundary polygon whose ring ordering changed during export.
- The report `.cache/local-gis-archive-roundtrip-batch-20261105-v6.json` confirms zero failures, PostGIS tables, export files, and archive extraction directories cleaned, and `externalDataSent=false`. Six empty/unknown-count candidates, 32 candidates above the feature cap, and one candidate that still required an encoding choice were skipped; the run does not claim exhaustive coverage of all archived data.

## 2026-11-05 bounded 7z/RAR archive audit

- Reworked `tests/integration/local-gis-7z-rar-audit.mjs` to extract only each selected dataset and required Shapefile/TAB/MIF sidecars. FileGDB members are selected as one family. Each dataset is limited to 1 GiB and 20,000 archive entries; it is removed immediately after inspection. The report records extraction limits and per-member outcomes.
- Corrected 7-Zip link-property parsing: `Alternate Stream = -` means no stream and no longer rejects ordinary RAR archives. Actual non-empty link/alternate-stream metadata still causes the archive to be skipped. Small `.json` files are classified by top-level GeoJSON shape so ordinary manifests do not count as vector data.
- Full scan of `F:\GeoData` and `F:\temp` processed all 17 7z/RAR archives: 113 dataset candidates, 112 vector candidates, and 111 successfully decoded layers. One SHP archive requires a password; one ordinary JSON manifest was excluded; two RAR files contained no vector members. No extraction-limit skips occurred, and the final run left no temporary extraction directories.
- Evidence: `.cache/local-gis-7z-rar-audit-20261105-final.json`. Inspection did not modify source archives, import data into PostGIS, or send data externally; this archive audit is decode/preview coverage, not a full round-trip test for every member.

## 2026-11-06 local vector candidate rescan

- Re-scanned the authorized `F:\GeoData` and `F:\temp` roots with the staged GDAL runtime. The report accounts for all 1,261 candidates: 529 inspected datasets, 632 inspection failures, and 100 ZIP archives deferred to the separate archive-member workflow.
- Extension status totals: GeoJSON 102 inspected / 1 failed; GeoPackage 97 inspected; JSON 2 inspected / 40 failed; KML 5 inspected; PBF 1 MVT inspected / 589 GDAL inspect-failed; Shapefile 136 inspected; TAB 157 inspected / 2 failed; CSV 28 inspected; DXF 1 inspected; ZIP 100 deferred. These are GDAL inspection outcomes; a failed open is not by itself proof that a source file is corrupt or that its encoding is invalid.
- Machine-readable evidence: `.cache/local-gis-data-audit-20261106.json` (1,261 status records; status totals sum to 1,261). The scan was local and read-only; source data was not imported, rewritten, or sent to a model.

## PBF glyph resource classification follow-up (2026-11-07)

- The 589 `.pbf` records previously marked `inspect-failed` all reside beneath `datasilkbagtest/mapboxgl/font` or `datasilkbagtest/mapboxgl/glyphs`. Their six directory groups total 589 files; representative headers show protobuf font-stack names and Unicode ranges. They are Mapbox glyph SDF resources, not vector layers. Mapbox documents the `{fontstack}/{range}.pbf` template and describes the payloads as glyph data in PBF format: [glyphs style property](https://docs.mapbox.com/style-spec/reference/glyphs/) and [Fonts API](https://docs.mapbox.com/api/maps/fonts/).
- The separate `.pbf` file at `datasilkbagtest/mapboxgl/pbfs/193.vector.pbf` is the one record GDAL recognized as MVT. The original audit JSON is preserved; the classification and six raw header samples are in `.cache/local-gis-pbf-classification-20261107.json`.
- This resolves the 589 GDAL failures as non-vector inputs, not as corrupted vector files. The check read source files only and sent no data externally.

## Classification of all 632 inspection failures (2026-11-07)

- Reconciled all failed opens in `.cache/local-gis-data-audit-20261106.json`: 589 Mapbox glyph PBF files are font resources; 40 `.json` files are valid JSON but not GeoJSON FeatureCollections (two are OSM Overpass responses); two `._*.TAB` entries are AppleDouble resource-fork metadata; one `.geojson` file is malformed on disk.
- `F:\GeoData\t_gis_city.geojson` is 207,730,519 bytes and has 194,629,632 NUL bytes. GDAL stops at line 487,988, character 17; the final large NUL region is 194,627,753 bytes. The original source was left unchanged rather than guessed into a repaired dataset.
- The 632-item classification and evidence are in `.cache/local-gis-failed-input-classification-20261107.json`. It records `sourceFilesModified=false` and `externalDataSent=false`. The 100 ZIP archives remain handled by the separate archive-member workflow.

## 2026-11-09 CSV encoding refresh

- Re-scanned the authorized `F:\GeoData` and `F:\temp` roots after adding conservative CSV BOM detection. The current snapshot contains 1,216 candidates: 27 CSV, 110 Shapefile, 158 TAB (156 inspected, 2 open-failed), 96 GeoJSON, 96 GeoPackage, 4 KML, 1 DXF, 42 JSON (2 inspected and 40 not opened as vector datasets), 590 PBF (1 MVT and 589 glyph resources), and 92 ZIP archives deferred to the archive workflow. The file inventory differs from the 2026-11-06 snapshot, so candidate totals are not a direct before/after comparison.

- Three CSV files have valid UTF-8 BOM metadata and were inspected without an encoding choice. Twenty-four CSV layers still require an explicit encoding. Alongside 1 DXF, 6 Shapefile and 22 TAB layers, the current snapshot has 53 layers requiring manual encoding selection. No encoding was guessed from byte validity alone.
- CSV support now validates BOM-declared UTF-8/UTF-16LE/UTF-16BE over the full stream and transcodes manually selected legacy encodings through a temporary UTF-8 copy. A synthetic CP936 WKT CSV passed GDAL preview/conversion and PostGIS import: one feature, the Chinese attribute matched, and the geometry was stored at SRID 3857. Source bytes were unchanged; the PostGIS integration removed temporary tables and output files.
- A first local CSV import/export sample exposed GDAL PostgreSQL driver's default field-name laundering (`LAUNDER=YES`). PostGIS imports now pass `-lco LAUNDER=NO`; this preserves punctuation and case such as `SSB-RSRP(dBm)`. Re-running the three BOM-declared CSV samples through PostGIS to GeoPackage passed 3/3: 139,208 features, 1,842 text values and 41 geometry samples matched. The tables and exports were cleaned, and no external data was sent. Machine-readable result: `.cache/local-gis-roundtrip-csv-bom-to-gpkg-20261109-launchnone.json`.
- Machine-readable evidence: `.cache/local-gis-data-audit-20261109-csv-encoding.json`. The scan was local and read-only; it stores inspection metadata, not source attribute values, and sent no data to external services.

## 2026-11-10 candidate path stability check

- Compared the 2026-11-09 candidate path manifest (`.cache/local-gis-data-audit-20261109-csv-encoding.json`, 1,216 records) with the current files under the two authorized roots. The same 1,216 supported-extension paths are present: zero new paths, zero missing paths, and zero candidates with a last-write time after the manifest timestamp.
- This was a metadata-only comparison, not a re-read or roundtrip. The 2026-11-09 parse/encoding statuses and the separate archive-member results remain the applicable content evidence; no source file was opened, rewritten, or transmitted during this stability check.

## 2026-11-10 DXF encoding declaration handling

- The sole DXF candidate in the 2026-11-09 snapshot declares `$DWGCODEPAGE=ANSI_936`. GIS encoding detection now reads the ASCII DXF header and maps recognized `ANSI_<codepage>` labels to supported `CP<codepage>` names; this declaration resolves to CP936. Tests cover both the recognized declaration and an unsupported code page.
- The actual audited DXF was read-only rechecked and returned `source=metadata`, `declaredEncoding=CP936`, confidence 1. The code change also passed GIS unit tests and build; it is not a new corpus scan or DXF import roundtrip. The remaining 52 encoding-choice layers in that snapshot are 24 no-BOM CSV, 22 TAB without a recognized Charset declaration, and 6 Shapefiles, including two CPG/LDID conflicts that remain warnings for preview verification.

## 2026-11-11 DXF preview and full-scan follow-up

- The full read-only scan of the same two authorized roots completed over 1,216 candidates. The DXF is now inspected successfully with one layer; aggregate status totals are 493 inspected datasets, 631 GDAL inspection failures, and 92 ZIP archives deferred for member inspection. The failure groups remain 589 glyph PBF resources, 40 JSON documents that are not GeoJSON FeatureCollections, and two AppleDouble TAB sidecars.
- The DXF's declared CP936 is metadata for its driver, not an override GDAL accepts. Preparation now leaves `$DWGCODEPAGE` for GDAL to apply. The audited file returned a three-row preview with `requiresUserChoice=false`; size and modification time were unchanged. This verifies inspect and preview only, not a DXF import/export round trip.
- Remaining encoding choices are 52 layers: 24 CSV, 22 TAB and 6 Shapefile. Evidence: `.cache/local-gis-data-audit-20261111-dxf-fix.json`; the source files were read only and no data was sent externally.

## 2026-11-11 ZIP member scan initial failure

- Re-scanned all 92 ZIP archives under the two authorized roots. The inventory found 204 vector-member candidates; 43 decoded successfully and 161 remain uninspected because the PowerShell fallback process failed to start with `spawn UNKNOWN` (`errno=-4094`). These 161 records are scanner failures, not findings that the source members are invalid.
- A focused retry decoded the MapInfo TAB layer in `9&13号线图层.zip` (64 features), while `京昆收费站线路图.zip` reproduced the process-start failure twice. The results indicate that the fallback path is not yet reliable; the prior 2026-11-05 archive round-trip evidence remains separate and unchanged.
- Machine-readable evidence: `.cache/local-gis-archive-audit-20261111-final.json`, with focused diagnostics in `.cache/local-gis-archive-audit-20261111-diagnostic2.json` and `.cache/local-gis-archive-audit-20261111-single-retry.json`. Sources were read only; the scan did not import data or send it externally.

## 2026-11-11 ZIP fallback manifest and full rescan

- Changed the fallback extractor to write its selected-member manifest as a temporary UTF-8 JSON file instead of a Base64 environment variable. The manifest is removed in a `finally` block, and the enclosing extracted directory remains subject to the existing cache-root-checked cleanup.
- Re-scanned all 92 ZIP archives: 204 vector-member candidates, 27 JSON members excluded as non-GeoJSON, 174 layers decoded, and 3 `fallback-inspect-failed`. All 161 process-start failures from the prior run were cleared. The 3 remaining members are TAB files from the same `13408684395_20260609...高速.zip` family; extraction succeeded, but GDAL reports `Failed to parse field definition at line 15`.
- Re-ran those five matching archives with QGIS 3.44.8's bundled GDAL 3.12.2. Two additional layers decoded; the same three TAB members failed at line 15. Their field declaration includes a name such as `隧道覆盖CGI(5G)`; the [Precisely MapBasic Create Table reference](https://help.precisely.com/r/t/1031443568/2023-12-31/MapBasic/pub/Latest/en-US/MapInfo-MapBasic-Reference/Create-Table-statement?contentId=zgGcg2eDmt4QbE_aB~zF3Q) documents column names as letters, digits, and underscores. This correlates with the parser failure but does not prove the source tables are invalid in MapInfo itself.
- Evidence: `.cache/local-gis-archive-audit-20261111-manifest-final.json` and `.cache/local-gis-archive-qgis-runtime-20261111.json`. No source archive was modified; the full scan left no fallback extraction directories or manifest files, and no data was sent externally.

## 2026-11-12 no-BOM CSV candidate review

- Added bounded candidate detection to the GIS encoding service. For an unmarked CSV, the detector ranks encodings from at most 256 KiB of bytes, then validates the selected candidate by strict streaming decode of the entire source. It returns an import-capable heuristic only when the detector score is at least 90%, the lead over another encoding is at least 15 percentage points, and the full-file decode succeeds. Ambiguous candidates remain `unknown`; import stays blocked until an explicit encoding is supplied.
- Re-evaluated all 24 CSV records marked as requiring a choice in `.cache/local-gis-data-audit-20261111-dxf-fix.json`: 10 high-confidence candidates passed whole-file decoding (9 GB18030, 1 UTF-8), 10 remain manual, and 4 referenced paths were no longer present under `F:\GeoData` or `F:\temp`. The 256 KiB sample is only a ranking input; attribute preview remains necessary because strict byte validity does not prove semantic correctness.
- GIS encoding tests passed 46/46, GIS build passed, and `pnpm run test:integration:gis-encoding` passed with GDAL 3.12.2. A synthetic CP936 CSV was inferred and transcoded for preview/conversion without changing the original bytes; another synthetic file with an invalid byte after the sample remained `unknown` after full-file validation. The user-authorized PostGIS regression also passed: a no-BOM 120-row synthetic CP936 CSV was imported without a manual encoding override, and all 120 Chinese attributes and EPSG:3857 geometries were verified in the isolated database before cleanup.
- Machine-readable candidate metadata: `.cache/local-gis-csv-encoding-candidates-20261112.json`. It contains paths, byte lengths, detector results and warnings only; it does not contain source attribute values. The review was read-only and sent no corpus data externally.

## 2026-11-12 current corpus rescan

- Rebuilt the current workspace, then reran `tests/integration/local-gis-data-audit.mjs` against `F:\GeoData` and `F:\temp` using the GEOS-enabled static GDAL 3.12.2 candidate. The scan discovered 503 current candidates and completed; the previous 2026-11-11 snapshot contained 1,216 candidates, so its totals are historical and not directly comparable without considering the files' current presence and scanner candidate set.
- Current dataset statuses: 21 CSV, 1 DXF, 96 GeoJSON, 28 GeoPackage, 1 JSON, 4 KML, 108 Shapefile and 153 TAB datasets inspected; 12 JSON paths returned GDAL unsupported-format diagnostics, 2 AppleDouble `._*.TAB` paths returned unsupported-format diagnostics, and 77 ZIP archives were deferred for archive-member inspection. The layer previews yielded 379 decoded and 36 encoding-choice-required layers. Of the latter, 10 CSV, 6 Shapefile and 20 TAB source files need explicit encoding choice; there are also 10 unknown CSV detections and 21 unknown TAB detections overall (including files that did not require preview rows).
- Report `.cache/local-gis-data-audit-20261112.json` stores paths, dataset/layer metadata counts and bounded diagnostics; preview values are not written. The scan did not modify source data, import to a database or transmit corpus content. ZIP member inspection and round-trip remain separate tasks.

## 2026-11-12 high-confidence CSV to GeoPackage round-trip

- Converted all 10 CSVs classified as high-confidence heuristics by the current scan to temporary GeoPackages using the detected UTF-8/GB18030 encoding, including the 706,137-feature / 139.9 MB UTF-8 source. All 10 conversions completed and reported matching source/output feature counts across 707,453 total features.
- Compared up to 20 rows per source/output pair for all 109 text fields (1,957 text values total); no mismatched text fields or values were found. This is a bounded preview comparison, not proof that every attribute row or geometry is lossless. The 20 CSVs that still require a manual decision were not converted.
- GeoPackage files were created only in a unique OS temporary directory and removed in `finally`; cleanup was confirmed. Machine-readable summary `.cache/local-gis-csv-gpkg-roundtrip-20261112.json` stores file paths, encoding, counts and comparison totals only, not attribute values. PostGIS was unavailable in this run, so this round-trip does not satisfy the separate database integration check.

## 2026-11-12 declared-encoding Shapefile/TAB to GeoPackage sample

- From 195 currently present SHP/TAB candidates with declared/format encoding, at most 20 MiB data bundle and at most 10,000 features, selected the first 12 in stable audit order for a file-format round-trip. All 12 conversions passed, covering 4,768 features total (including an empty layer); source and GPKG output counts matched.
- Compared up to 20 preview rows per layer: all 36 matched text fields showed 0 value mismatches across 147 sampled rows, and all sampled geometry types matched. This does not verify every attribute or full geometry coordinates; the run is a bounded compatibility check, not a lossless proof.
- Outputs were placed under a unique system temporary directory and removed in `finally`. `.cache/local-gis-shp-tab-gpkg-roundtrip-20261112.json` records paths, declared encodings, counts and comparison outcomes without attribute values. No database was used because PostGIS/Docker was unavailable.

## 2026-11-12 high-confidence CSV PostGIS round-trip

- Re-ran the same 10 high-confidence CSV candidates through the isolated project PostGIS service and exported each temporary table to GeoPackage. All 10 passed, with 707,453 total features and matching database/export counts.
- Compared up to 20 rows per layer; the actual sample contained 163 features because several layers had fewer than 20. All 163 source/export geometries matched (all were null), and all 1,957 sampled text values matched without depending on feature order.
- Temporary PostGIS tables and export directories were cleaned. Source files were unchanged and `externalDataSent=false`. `.cache/local-gis-csv-postgis-roundtrip-20261112.json` contains paths, counts and sample totals, not source attribute values.

## 2026-11-12 current ZIP member scan and PostGIS round-trip

- Re-scanned the 77 ZIP archives in the current authorized corpus. The archive inventory found 190 vector-member candidates and 24 JSON members excluded as non-spatial; all 166 spatial candidates decoded. Ten archives had no vector members.
- Expanded the bounded archive-member PostGIS round-trip to 116 eligible layers: 30 GeoJSON, 9 Shapefile and 77 MapInfo TAB. All passed import, feature-count check, same-format export, geometry comparison and text preview comparison. The successful layers contained 58,749 features; 1,585 sampled geometries and 10,564 sampled text values matched.
- The batch skipped 9 members above the 20 MiB bundle limit, 11 above 250,000 features, 15 that require an explicit encoding choice, and 6 with empty or unknown feature counts. These are deliberate sample limits or unresolved encoding decisions, not source corruption findings. No layer-level import/export failures remained.
- The first expanded run exposed precision overflow for a declared fixed-width numeric field. GIS normalization now retains field width/precision and supplies GDAL `COLUMN_TYPES=<destination-field>=NUMERIC` for Real fields with decimal precision when the user has not selected an explicit target type. The single failed member passed a focused PostGIS retest, then the complete expanded batch passed 116/116. GIS tests passed 49/49; typecheck and full workspace build passed.
- Evidence is in `.cache/local-gis-archive-audit-20261112.json`, `.cache/local-gis-archive-roundtrip-20261112-expanded.json` (initial run) and `.cache/local-gis-archive-roundtrip-20261112-fixed.json` (final run). Temporary extraction, PostGIS tables and export directories were cleaned; source archives were unchanged and `externalDataSent=false`.

### Larger SHP/GeoJSON sample and source encoding failures

- Raised the per-layer limit to 2,000,000 features and the Shapefile sidecar-bundle limit to 250 MiB. The larger selection contained 125 layers: 32 GeoJSON, 16 Shapefile and 77 TAB. 121 passed; the successful layers contained 441,164 features, with 1,685 geometry samples and 11,624 text values matching. Four SHP imports failed before feature-count validation.
- Focused safe diagnostics found invalid UTF-8 bytes in three distinct DBF contents: record 418/`COUNTY`, record 792/`name`, and record 32,073/`CITY`; the last content appears in two ZIP copies with the same SHA-256. Each associated `.cpg` declares UTF-8. The audit stores record number and field name only, never raw attribute values. The application advises repairing/re-exporting these sources because overriding the encoding for an entire file could corrupt otherwise valid attributes.
- The bounded run skipped 9 members above 250 MiB, 17 members requiring a user-selected encoding and 6 members with an empty or unknown feature count. The two-million-feature limit did not skip candidates. Extraction, temporary PostGIS tables and export directories were cleaned; source archives were unchanged and `externalDataSent=false`.

## 2026-11-12 Additional declared-encoding SHP/TAB PostGIS batches

- Continued from the 503-item audit of `F:\GeoData` and `F:\temp`. Nineteen serial batches attempted 222 distinct SHP/TAB source paths with declared or high-confidence encoding, a 250 MiB sidecar-bundle cap, and a 2,000,000-feature cap; this includes the earlier 12-layer file-only sample.
- 216/222 layers passed; successful layers contained 3,809,014 features. All 2,513 sampled geometries and 10,806 sampled text values matched. Six SHP imports failed and are not counted as passes. Four failures resolve to three unique DBF invalid-UTF-8 contents despite the `.cpg` declaration (record 792/`name`, 418/`COUNTY`, and 32,073/`CITY`; the CITY content has a duplicate source copy). Two additional text-attribute write failures remain unexplained by the sanitized report; no alternate encoding was guessed.
- All nineteen reports confirm PostGIS temporary-table and export-directory cleanup. Source files were not modified and `externalDataSent=false`. Reports: `.cache/local-gis-shp-tab-gpkg-roundtrip-20261112-next.json` and `-next-02.json` through `-next-19.json`. No candidates remain under these current gates. This bounded sample is not a full-file losslessness proof; unknown-encoding files, oversized bundles, and the six failures remain open.
- Evidence: `.cache/local-gis-archive-roundtrip-20261112-large-fixed.json`; focused reports `.cache/local-gis-archive-utf8-failure-diagnostic-20261112.json`, `.cache/local-gis-archive-utf8-fujian-diagnostic-20261112.json`, and `.cache/local-gis-archive-utf8-cityroad-diagnostic-20261112.json`.

### 2026-11-12 SHP remediation retests

- The original nineteen-batch baseline remains 216/222; its failure counts were not rewritten. A focused retry of `F:\GeoData\t_gis_microgrid_new.shp` with an explicit CP936 override passed 14,410 features; 20 geometry samples and 140 text values matched. The `.cpg` still declares UTF-8, so this is an explicit user-choice result, not a correction to the source declaration. Report: `.cache/local-gis-shp-tab-gpkg-roundtrip-20261112-tgis-cp936-retest.json`.
- `F:\temp\mingshan.shp` has UTF-8-valid attribute cells but DBF field-name descriptors that end in incomplete UTF-8 sequences. The GIS service now rewrites those names to stable ASCII aliases only in a temporary sidecar copy and reports the affected 1-based columns. CLI inspection reports `7→DBF7`, `8→DBF8`, `9→DBF9`, and `13–16→DBF13–DBF16`; all 16 fields remain available. A real PostGIS round-trip passed all 6,108 features; 20/20 geometry samples and 260 text values matched. PostGIS table and export directory were cleaned, source bytes were unchanged, and `externalDataSent=false`. Report: `.cache/local-gis-mingshan-fieldname-normalized-20261112.json`.
- These two focused remediations raise the separate remediated tally to 218/222; the four remaining paths correspond to three distinct DBF attribute-value corruption contents. The baseline remains useful for reproducing original behavior and is not presented as a post-fix full batch.

### 2026-11-12 1–2 GiB ZIP member PostGIS round-trips

- The three remaining selected members with extracted sidecar bundles above 1 GiB and below 2 GiB were run serially through PostGIS import, count validation, same-format export, and re-decode. All 3 SHP layers passed, with 3,437,065 total features.
- Each layer compared 20 geometry samples and 280 text values; all 60 geometries and 840 text values matched. PostGIS temporary tables, export directories, and archive extraction directories were cleaned. All reports record `externalDataSent=false` and source archives were not modified.
- Per-layer reports: `.cache/local-gis-archive-roundtrip-over1g-01-20261112.json`, `-02-20261112.json`, and `-03-20261112.json`. These results cover the three selected members under the 2 GiB cap; they do not resolve the separate invalid-UTF-8 members or members requiring a user encoding choice.

## 2026-11-12 full-file ASCII-compatible CSV handling

- The previous 503-candidate scan reported four no-BOM CSV files as unknown because its bounded text samples contained only ASCII. A new detector path streams the complete file and only selects UTF-8 when every byte is below `0x80` and there are no NUL bytes. It labels the result `ascii-compatible`, keeps the original encoding unknown, and explains that supported ASCII-compatible code pages yield the same decoded content. A non-ASCII or NUL byte anywhere in the file keeps the manual-choice requirement.
- Re-scanned all 503 current candidates. The scan found 383 decoded layers and 32 layers requiring an encoding choice. Four ASCII-compatible CSV files are `F:\GeoData\内江-51.csv` (4,230 records), `F:\GeoData\路测.csv` (1,000), `F:\GeoData\采样点.csv` (140), and `F:\temp\test1.csv` (278); GDAL identifies all four as attribute-only tables with no geometry fields. Unknown CSV detections are now 6; the 6 SHP and 21 TAB unknown cases remain unresolved.
- All four CSV tables passed an isolated PostGIS import, row-count check, and GeoPackage export. The database/export counts matched 5,648 total records. Up to 20 rows per source were compared: 80/80 geometries matched as NULL and 180 text values matched independent of feature order. The first attempt used CSV as the export extension, which the GIS exporter rejects; the test harness cleaned its temporary tables and output directory, then the same batch passed after selecting GeoPackage.
- The final report `.cache/local-gis-ascii-postgis-roundtrip-20261112-gpkg.json` records `postgisTemporaryTablesCleaned=true`, `exportDirectoryCleaned=true`, and `externalDataSent=false`. The fresh scan is `.cache/local-gis-data-audit-20261112-ascii-invariant.json`; it contains metadata and counts only, not source attribute values. Source CSV files were not modified.

## 2026-11-12 MapInfo Neutral Charset comparison on local data

- `F:\GeoData\city.tab` declares `Charset Neutral`, so its original source charset remains unknown. A read-only CLI preview with an explicit CP936 selection decoded its Chinese name field as readable text; the source encoding classification was not changed.
- Imported the 42-feature TAB into isolated PostGIS with CP936 and separately exported TAB as CP936 and UTF-8. Both runs passed the row-count check and same-format readback. For each run, 20/20 geometry samples and 40 text preview values matched independent of feature order.
- PostGIS temporary tables and export directories were cleaned; the source file was not modified and `externalDataSent=false`. Reports `.cache/local-gis-city-tab-cp936-postgis-20261112.json` and `.cache/local-gis-city-tab-cp936-to-utf8-postgis-20261112.json` contain counts and comparison outcomes only. The result demonstrates both charset paths on one real sample, not the correct encoding for the other 20 `Neutral` TAB files.

## 2026-11-12 MapInfo Neutral TAB 明确覆盖批次

- 对未知编码清单中的 20 个 Neutral Charset TAB 使用逐源显式 CP936 覆盖，在隔离 PostGIS 做导入、计数、同格式 TAB 导出及解码核对。17/20 通过，成功层累计 13,981 个要素；244/244 个几何样本和 1,267 个文本值抽样匹配。临时 PostGIS 表和导出目录均已清理，`externalDataSent=false`。本批次不改变剩余文件的编码状态，也不证明 Neutral 声明本身指向 CP936。
- 三项在 GDAL 导入阶段失败：`F:\temp\grid.tab` 与 `F:\temp\海螺沟_物业点.tab` 报 `ReadBytes(): Attempt to read past end of data block`；`F:\temp\t_gis_high_speed_segment.tab` 报 `Too big nCoordDataSize = 30598648`。这些是当前导入错误，不能仅据此归因于字符集。另有 1 项超过本批次大小上限而跳过。
- 随后对这三个文件分别以 CP936、UTF-8、CP950 执行只读属性与几何预览。两个小图层在每种编码下均能读出前 5 条，但读取完整要素集时三种编码都复现 `ReadBytes()`；大图层在每种编码下都于前 5 条预览时复现相同 `nCoordDataSize`。该对照支持将本次失败归为 GDAL 要素读取/几何数据块错误，而非这三种字符集选择的差异；不据此推断源文件损坏，也未更改源文件。
- 批次报告：`.cache/local-gis-neutral-tabs-cp936-postgis-20261112.json`；编码对照摘要（仅计数、几何类型和错误摘要，不含原始属性值）：`.cache/local-gis-neutral-tabs-preview-cross-encoding-20261112.json`。未知编码清单仍保留人工选择要求。

## 2026-11-12 Neutral TAB 跨编码只读诊断补充

- 机器可读摘要：`.cache/local-gis-neutral-tabs-preview-cross-encoding-20261112.json`。测试将三个失败文件按 CP936、UTF-8、CP950 分别作 5 条和全量预览；两个小图层各编码的前 5 条读取成功，全量读取均报数据块末尾越界；`t_gis_high_speed_segment.tab` 在全部三种编码下均报同一坐标缓冲大小错误。JSON 只存状态、要素/预览计数、几何类型、错误摘要与安全标记，不存属性原文。

## 2026-11-12 未知编码 CSV PostGIS 显式覆盖复测

- 对当前审计清单中的 6 个未知编码 CSV 逐源选择编码，并在隔离 PostGIS 完成导入、要素计数、GeoPackage 导出及文本预览回读。6/6 通过，合计 1,775 个要素；113 个样本行、878 个文本值全部匹配，未启用字段类型或字段映射覆盖。
- 该结果证明这些明确覆盖下的样本可完成数据库往返，不证明选中的字符集就是源文件的真实编码；自动检测结果仍为 unknown，导入仍需用户选择。最大 10,000 要素/20 MiB 边界内没有跳过项。
- PostGIS 临时表与导出目录均已清理，未更改源文件，`externalDataSent=false`。`.cache/local-gis-unknown-csv-postgis-20261112.json` 只记录相对路径、逐源编码决策、计数和对比统计，不保存属性值。

## 2026-11-12 未知编码 Shapefile 跨编码只读预览

- 对 6 个仍需编码选择的 SHP，分别用 CP936、UTF-8、CP950、GB18030 获取最多 10 行属性预览；24/24 次均成功读取，共覆盖 125,277、32,895、15,824、4,838、5,300 和 5,431 个要素图层。
- 其中 4 个 `.cpg` 声明 UTF-8 的 DBF 样本仍无法通过严格 UTF-8 检查；另外 2 个没有 `.cpg` 的样本，其前 10 行字符字段仅显示 ASCII，无法据此识别源编码。不同解码结果的汉字/替换字符计数只能作为预览差异，不能证明语义正确，因此 6 个来源仍保留人工编码选择。
- `.cache/local-gis-unknown-shp-cross-encoding-20261112.json` 仅存编码、成功状态及计数，不含属性原文；源文件只读，未发送外部服务。本轮没有执行这 6 个来源的 PostGIS 导入。

### 无 `.cpg` SHP 的全 DBF 字符字段扫描

- 对上述两个无 `.cpg` 的 DBF 按头部字段描述符逐记录扫描全部字符字段；读取并核对了声明的 5,300 与 5,431 条记录，没有保存字段值。
- 第一份 DBF 的 174,900 个字符字段字节中含 171 个高位字节和 159,376 个 NUL；第二份 59,741 个字符字段字节没有高位字节，但含 30,116 个 NUL。第二份虽未发现高位字节，NUL 密度使其不满足当前保守的 ASCII 文本判定条件，因此没有把来源状态改为 `ascii-compatible`。
- 两份来源继续保留人工选择/检查状态。报告 `.cache/local-gis-unknown-shp-dbf-full-scan-20261112.json` 只含相对路径和字节计数；扫描只读、未发送外部服务。NUL 计数本身不等同于源文件损坏判断。

### 2026-11-12 UTF-8 声明 SHP 的完整编码候选往返

- 对四个 `.cpg` 声明 UTF-8、但 DBF 样本未通过严格 UTF-8 校验的图层，分别以 CP936、CP950、UTF-8 和 GB18030 显式覆盖，在隔离 PostGIS 中检查 178,834 个要素，并导出 GeoPackage。
- CP936 与 CP950 均为 4/4 图层通过：数据库与导出要素数一致，80/80 个几何样本以及每批 420 个文本样本匹配。UTF-8 为 0/4（DBF 属性记录含非法 UTF-8 字节）；GB18030 为 0/4（GDAL 拒绝源文本属性写入）。失败报告不保存属性原文。
- 这组往返只证明 CP936 与 CP950 在所测样本上的结构可读和 round-trip 一致；两种编码都能成功不代表语义上可互换，也不证明全量无损。源 `.cpg` 与自动检测结果保持原样，界面仍应要求用户选择编码。
- 批处理预检曾把同目录同名 `baidu_aoi.geojson` 错算为 SHP 配套体积并跳过 `baidu_aoi.shp`。现已将 SHP 文件束统计限制为已知 Shapefile sidecar 扩展；修正后 125,277 要素图层纳入两种成功候选的 4/4 往返。该修改仅影响集成验收脚本的体积预检。
- 报告：`.cache/local-gis-utf8-cpg-override-cp936-fixed-20261112.json`、`-cp950-fixed-20261112.json`、`-utf-8-fixed-20261112.json`、`-gb18030-fixed-20261112.json`。临时 PostGIS 表及导出目录均已清理；源文件未修改，报告记载 `externalDataSent=false`。

### 2026-11-12 DBF 尾随 NUL 填充的完整 ASCII 验证

- 无 `.cpg` 的 DBF 过去仅根据最多 500 条样本判断；ASCII 与尾随 NUL 混合样本会一律要求手动选择。现对 DBF 字段描述符及每条有效记录流式完整扫描：只有所有字符字段的非 NUL 字节均为 ASCII、NUL 只出现在字段尾部、记录区长度符合声明时，才标记 `ascii-compatible` 并用 UTF-8 安全解码。原始代码页仍标记未知；高位字节、嵌入 NUL、无效结构或不完整记录仍要求人工选编码。
- 重扫 `F:\GeoData` 与 `F:\temp` 全部 503 项：CSV unknown 仍为 6，SHP encoding-choice-required 从 6 降至 5，TAB 仍为 21；新增 1 个 SHP `ascii-compatible`。`F:\temp\广绵扩容施工图路线(全线棒棒线)\广绵扩容施工图路线(全线棒棒线)2.shp` 的 5,431 条 DBF 记录都只有 ASCII 字节和尾随 NUL，且无高位/嵌入 NUL；其无覆盖 PostGIS→GeoPackage 往返通过，5,431/5,431 要素、20 个几何样本、40 个文本值匹配。
- 同目录的 `...1.shp` 有 171 个高位字节，仍标记 unknown；CP936、CP950 显式选择的 PostGIS 往返均通过（5,300 要素、20 个几何与 40 个文本样本匹配），但两种成功不证明语义相同，因此保留用户选择。
- GIS 套件 55/55 通过；`pnpm --filter @db-studio/cli... build` 编译 GIS、Core、CLI 及其依赖成功。机器报告 `.cache/local-gis-data-audit-20261112-ascii-dbf-nul-padding.json` 与 `.cache/local-gis-ascii-dbf-nul-postgis-roundtrip-20261112.json`；显式候选报告 `.cache/local-gis-ascii-dbf-nul-unknown-{cp936,cp950}-20261112.json`。临时表/导出目录已清理，源文件未改动，`externalDataSent=false`。

### 2026-11-12 QGIS Processing 独立转换对照

- QGIS 3.44.8 / GDAL 3.12.2 在隔离 profile 和 offscreen 模式下运行 `gdal:convertformat`，分别转换上述两份无 `.cpg` SHP 到 GPKG。两次退出码为 0；独立 `ogrinfo` 的输出要素数分别为 5,431 和 5,300，与源清单一致。
- QGIS 隔离输出 `.cache/qgis-dbf-nul-output-20261112/{ascii-compatible,unknown-high-byte}.gpkg` 未保存到源目录；机器摘要 `.cache/qgis-dbf-nul-gdal-runtime-20261112.json` 不含属性原文。该运行只验证开文件、转换及计数，不证明属性值语义无损，也不改变第一份文件的 unknown 状态。用户 QGIS 配置未使用，源文件未修改，`externalDataSent=false`。

### 2026-11-12 Neutral TAB 大文件补充往返

- 对此前因批次大小门槛跳过的 `F:\GeoData\ganzi.tab`（同名 TAB 文件束 36,931,916 字节，7,074 个要素）单独提高测试上限至 50 MiB，并分别显式选择 CP936、CP950，完成 PostGIS 导入、计数、TAB 导出及回读。
- 两种编码均为 1/1 通过：导出计数与源审计一致；每次比较 20 个几何（20/20 匹配）及 20 行中的 260 个文本值（全部匹配）。机器报告 `.cache/local-gis-neutral-ganzi-cp936-postgis-20261112.json`、`.cache/local-gis-neutral-ganzi-cp950-postgis-20261112.json` 均确认临时表、导出目录已清理且 `externalDataSent=false`。
- TAB 只声明 `Charset Neutral`。两种候选都能往返不构成真实源代码页的证据，来源仍要求用户选择编码；本次不证明未抽样的属性值全量一致，也未修改源文件。

### 2026-11-12 当前 GeoPackage 全集 PostGIS 往返

- 针对本次 503 项扫描中的 28 个 GeoPackage（合计 41,094 个要素、约 298 MB），在隔离 PostGIS 串行完成导入、计数核对、GPKG 导出与回读。28/28 图层通过，数据库和导出要素数与审计值一致，无失败或跳过。
- 每层最多按 20 个要素抽样：541/541 个几何匹配，541 行的 4,308 个文本字段值匹配，比较不依赖要素顺序。源文件的检测编码均来自元数据；抽样结果不代表未抽样属性全量一致。
- PostGIS 临时表及导出目录均确认清理，源文件未修改，`externalDataSent=false`。机器报告 `.cache/local-gis-gpkg-roundtrip-20261112.json` 记录逐层结果、样本计数和清理标志。

### 2026-11-13 当前 GeoJSON/KML PostGIS 往返与 KML id 字段复验

- 基于 2026-11-12 对 503 项本机候选的审计，对 84 个受批次上限约束的 GeoJSON 图层及 4 个 KML 文件中的 7 个图层执行 PostGIS 导入、计数核对、同格式导出和回读。GeoJSON 84/84 通过；KML 5/7 通过。另有 6 个 GeoJSON 超过 10,000 要素、6 个超过 20 MiB，按明确上限跳过；全部 4 个 KML 文件都进入测试。
- 全部 91 个候选层共比较 1,338 个几何样本，均与源坐标匹配。KML 的 26 个样本从二维变为 XYZ 且新增 Z 为 0；这符合导入阶段对泛型 KML 图层保留海拔的现有警告，不表示原源文件含海拔。成功图层的 11,540 个文本样本值精确匹配。
- 失败列实际是默认 LIBKML 读取时排在首位的字符串字段 `id`，不是 `Name`；此前报告只记录了列序号，故曾误判为名称字段。GDAL 只读结构探针确认 `city.kml` 和 `test.kml` 均含 `id`、`Name`、`description` 等字段；PostGIS 样本仍保留源 `id`，而默认 KML 输出回读把该属性交给 Placemark 标识，原 6–7 字符值变成 26–27 字符。另行核验确认 `Name` 值没有变化。
- 将两个来源在导入时显式映射 `id=source_id` 后，真实隔离 PostGIS 往返 2/2 通过：42 与 6 个要素计数一致，20/20 与 6/6 几何样本一致，148 个文本值样本全匹配；临时表与导出目录清理，`externalDataSent=false`。报告 `.cache/local-gis-kml-id-aliased-roundtrip-20261113.json` 不含原始属性值。
- 为避免默认导出静默改写该属性，PostGIS→KML 现在会在检测到未显式映射的字符串 `id` 字段时，自动改名为无冲突的 `source_id`（若冲突则递增后缀），并把原因写入操作警告。GIS 单测 60/60 通过，其中服务级测试确认导出 OGRSQL 使用 `id AS source_id` 并包含改名警告；GIS/Core/CLI 依赖构建通过。用本机 GDAL 对原始两个 KML 做 OGRSQL 别名转换与回读，两个文件的 `id` 多重集合均逐值精确匹配；脱敏摘要为 `.cache/local-gis-kml-id-alias-offline-20261113.json`。
- 首次新自动别名复验受主机 loopback 沙箱限制，后续在已授权的宿主测试环境完成，结果见下方“自动别名 PostGIS 复验”。GDAL 将 LIBKML 的字符串 `id` 字段映射到 KML Placemark `<id>` 的规则见 [LIBKML 驱动文档](https://gdal.org/en/stable/drivers/vector/libkml.html)。

### 2026-11-13 RFC 7946 GeoJSON 大样本复验

- 按 GDAL GeoJSON 驱动的 RFC 7946 行为，将样本在 WGS 84 经度/纬度中比较；对 GeoJSON/JSON 输出使用 XY `1e-7` 度（纬度约 1.1 cm）容差，Z/M 保持 `1e-8`。顶点数量、环结构、几何类型及顺序无关的样本匹配仍须满足比较器约束；该规则只适用于 GeoJSON/JSON，不放宽其他格式。
- 以真实隔离 PostGIS 复测 `F:\GeoData\baidu_aoi_test.geojson`（125,277 要素）：计数一致，20/20 几何样本、80 个文本值通过。复测 `F:\temp\t_gis_road.geojson`（9,999 要素）：计数一致，20/20 几何样本、160 个文本值通过。两轮均清理临时表和导出目录，`externalDataSent=false`；报告分别为 `.cache/local-gis-geojson-large-aoi-rfc7946-20261113.json`、`.cache/local-gis-geojson-road-rfc7946-tolerance-20261113.json`。
- 按 160,000 要素与 500 MiB 文件束上限复跑扩大 GeoJSON 样本组：10 个候选中 9 个完整通过，包含 125,277 要素图层；1 个在 PostGIS JSON 字段导入阶段失败，另有 2 个因超过文件束上限跳过。失败错误是 `invalid input syntax for type json`，涉及 OGR 识别为 `String(JSON)` 的混合字符串/数字字段；记录中不保留原始属性值。未能把该项修复为成功，临时表及导出目录均清理。报告 `.cache/local-gis-geojson-expanded-rfc7946-tolerance-20261113.json`。
- 后续对失败源 `F:\temp\dim_gis_org_boundary.geojson` 使用字段映射显式将全部五个 `String(JSON)` 列转换为字符串。只映射其中一个字段不足以完成导入；为五列同时应用 GeoJSON `OGR_SCHEMA` 子类型覆盖，并将 PostgreSQL 目标列设为 `VARCHAR` 后，14,524 个要素完整往返，20/20 几何样本和 240 个文本值样本匹配。此成功依赖用户明确选择这五列的目标类型，不代表自动推断或未映射 JSON 子类型均可直接导入。报告 `.cache/local-gis-org-boundary-json-string-source-schema-verified-20261113.json`。
- 该轮为最多 20 个要素的几何样本验证，不等价于对每个图层全部几何作逐顶点比对。早先 84 个常规大小 GeoJSON 图层仍为 84/84 通过；大样本结果单独报告，不与基线合并为全集保证。

### 2026-11-13 KML 自动别名 PostGIS 复验

- 使用默认字段映射，在隔离 PostGIS 对 `F:\GeoData\city.kml` 与 `F:\GeoData\test.kml` 分别执行导入、计数核对、KML 导出和回读。自动别名路径 2/2 通过，分别为 42 和 6 个要素；几何样本为 20/20 与 6/6，文本样本值 100/100 与 48/48 匹配。
- 测试报告 `.cache/local-gis-kml-id-auto-alias-roundtrip-20261113.json` 确认 `fieldMapOverridesUsed=[]`、临时 PostGIS 表清理、导出目录清理，且 `externalDataSent=false`。这补足了先前仅有显式字段映射和离线 OGRSQL 探针、缺少默认服务路径数据库往返的证据。

## 2026-11-13 ZIP 归档 250 MiB–1 GiB PostGIS 回环补测

- 扩展 `tests/integration/local-gis-archive-roundtrip.mjs`，新增 `DBSTUDIO_LOCAL_GIS_ARCHIVE_ROUNDTRIP_MIN_BUNDLE_BYTES`，可与最大 bundle 限额组合筛选续测区间；旧运行默认行为不变。
- 使用 2026-11-12 的 77 个 ZIP 归档审计清单，将最大 bundle 设为 1 GiB、最小值设为 250 MiB、最大要素数 2,000,000、单并发。筛选出 4 个 SHP 与 2 个 GeoJSON 图层，6/6 完成隔离 PostGIS 导入、计数核对、同格式导出和回读，合计 1,999,745 个要素，无失败。另排除 142 个小于最小值成员、3 个大于 1 GiB 成员、6 个计数未知成员。
- 几何样本 120/120 匹配；120 行、1,240 个文本值样本匹配。归档解压目录、临时数据库表和导出目录均清理；`externalDataSent=false`。报告 `.cache/local-gis-archive-roundtrip-20261113-250mib-1gib.json`。
- 与此前 1–2 GiB 批次 3/3 成功结果合并，本轮覆盖当前审计发现的全部 9 个 >250 MiB 且 ≤2 GiB ZIP 矢量 bundle。更大文件、未知编码成员和已定位为无效 UTF-8 的源数据仍需分别处置。

## 2026-11-13 `F:\GeoData` / `F:\temp` 矢量候选复扫

- 使用当前 CoreService 和静态 GDAL 3.12.2 只读重扫两个目录，共枚举 503 个扩展名候选并读取图层元数据及最多 3 条属性预览；没有连接数据库或修改源文件。机器报告：`.cache/local-gis-data-audit-20261113-refresh.json`。
- GDAL 识别 412 个候选文件，展开为 415 个图层；384 层预览可解码，31 层按设计保留显式编码选择（6 CSV、5 SHP、20 TAB），没有属性预览失败。5 个 SHP 的 `.cpg` 声明 UTF-8 与 DBF 采样字节不匹配；20 个 TAB 声明 `Charset Neutral`；6 个 CSV 的候选编码置信度或竞争间距不足，工具没有自动定稿。
- 另有 12 个 `.json` 文件未被 GDAL 识别为空间数据（其中 1 个 `.json` 文件确认为可读矢量），2 个 `._*.TAB` AppleDouble 元数据文件没有有效 MapInfo 头，均保留为候选识别失败而非成功图层。77 个 ZIP 候选进入单独归档审计；此前归档审计覆盖其中 166 个矢量成员，成功解码，并按大小/要素门槛完成多批 PostGIS 回环，超限和未知编码项目仍按各批报告保留。
- 本次审计验证的是检查和预览，不是 415 层的逐层数据库导入/导出或全量属性无损证明。部分已知编码、格式和大样本的回环证据分别见下文各轮报告；需显式选择的源继续等待数据所有者确定编码后再做语义验收。

## 2026-11-14 真实数据追加往返批次（补入汇总）

- 对 `.cache/local-gis-realdata-roundtrip-batch-20261114-02.json` 至 `-05.json` 做只读汇总：4 份报告各选 10 层，40/40 状态为 `completed`，源、PostGIS 中间表与导出要素数一致，合计 70,144 个要素。按格式统计：GeoJSON 10 层/23,378 要素，GeoPackage 14 层/9,971 要素，Shapefile 11 层/32,800 要素，MapInfo TAB 5 层/3,995 要素。
- 报告记录的几何匹配与属性匹配计数均为 70,144；40 层有 1 次字段重命名，未映射源字段合计为 0。四份报告均为 `externalDataSent=false`，且没有记录失败图层。
- 这是从当前候选池选择的 40 层补充证据，不代表其余可解析图层、未知编码数据或压缩包成员已经全部完成往返。汇总保留字段匹配计数的原始报告语义，不将样本匹配扩大为未经逐字段核对的全量无损声明。

## 2026-11-15 本地 ZIP 归档完整解码复扫

- 对 `F:\GeoData` 与 `F:\temp` 当前可见的 80 个 ZIP 归档按偏移分 12 批检查，批次覆盖 80 个不同路径，没有重复或遗漏。审计识别 193 个矢量格式候选和 24 个非空间 JSON；169 个空间候选全部由 GDAL 解码成功。70 个归档至少含一个可检查成员，10 个没有矢量成员。
- 初始并发全量扫描的 `.cache/local-gis-archive-audit-latest.json` 留下 4 个回退解压 `ENOENT` 记录（同一 ZIP 中 4 个成员）。后续按偏移分批复扫完整覆盖 80 个归档，169/169 空间候选解码成功；38 个重叠索引的批次结果一致。单档复核也通过 36/36。暂未定位首次 `ENOENT` 的外部原因，因此不把那份原始报告当作完整结果。
- `tests/integration/local-gis-archive-audit.mjs` 支持 `DBSTUDIO_LOCAL_GIS_ARCHIVE_OFFSET`、`DBSTUDIO_LOCAL_GIS_ARCHIVE_LIMIT`、工具/ZIP 列表/回退解压超时及自定义报告路径。新增 `node tests/integration/aggregate-local-gis-archive-audit.mjs` 合并分批报告、检查覆盖并按时间选择每个索引的最新结果；聚合结果为 `.cache/local-gis-archive-audit-aggregate-latest.json`。归档只读，未修改源文件。
- 本次结果是归档成员识别和解码验证，不是 169 层全部 PostGIS 往返。格式回环的已测范围、跳过原因及损坏/未知编码限制仍以本报告前述逐批结果为准；初始全量报告、分批原始 JSON 和聚合 JSON 均保留逐层记录。

## 2026-11-15 7z/RAR 编码候选与 PostGIS 往返

- 使用当前 13 个 7z/RAR 归档审计快照，在 20 MiB bundle、10,000 要素上限下复跑隔离 PostGIS 往返：TAB 30 层、GeoPackage 66 层，共 96/96 通过，32,038 个要素；几何样本 1,655/1,655、文本值样本 12,014 项匹配。2 个超出字节上限的候选和 6 个需要编码选择的候选未计入成功数；临时表、导出目录、解包目录均清理。详见 `.cache/local-gis-7z-rar-roundtrip-comprehensive-20261115.json`。
- 将 2 个大于 20 MiB 的 GeoPackage 成员单独提高至 250 MiB / 20,000 要素上限后，2/2 通过，含 20,575 个要素，几何 40/40、文本值样本 320 项匹配。与前一批合并后为 98/98 层（30 TAB、68 GeoPackage）、52,613 个要素、几何 1,695/1,695、文本值 12,334 项匹配；报告 `.cache/local-gis-7z-rar-roundtrip-geopackage-20mib-250mib-20261115.json`。
- 为测 4 个编码未知 CSV 的显式选择路径，新增归档 CSV 编码覆盖测试开关和格式筛选。四个文件合计 217 个要素；分别明确指定 CP936 与 GB18030 后，CSV→PostGIS→GeoPackage 两组均 4/4 通过，计数、几何和抽样文本检查完成。UTF-8 候选 4/4 在导入文本属性时失败，诊断不含原始值；所有批次资源均清理。
- CP936 与 GB18030 都能通过，UTF-8 失败也不足以单独证明源文件实际编码。产品仍应要求用户选择；本次测试不改变归档和原始 CSV。报告见 `.cache/local-gis-7z-rar-roundtrip-csv-gpkg-cp936-20261115.json`、`-gb18030-20261115.json` 和 `-utf8-20261115.json`。

## 2026-11-16 Current audit coverage cross-check

- Compared the current 504-candidate root audit with historical `successfulLayers` records using normalized source root, relative path, and layer index. The 378 currently decoded layers with metadata/format/ASCII-compatible encoding or a strict heuristic score of at least 0.9 all have prior successful PostGIS roundtrip evidence; none were left uncovered. Encoding-choice-required, unreadable, and failed-preview layers are excluded and remain unresolved.
- This is a coverage cross-check, not a new import/export run and not independent proof that a heuristic encoding is the source encoding. The six user-confirmed CSV encodings have their own explicit-override evidence. See [coverage evidence](../.cache/local-gis-trusted-layer-coverage-20261116.json).

## 2026-11-19 Root data audit refresh

- Re-ran the read-only CoreService/GDAL audit on `F:\GeoData` and `F:\temp` using the packaged GDAL 3.12.2 runtime. It enumerated 504 candidate paths, matching the 2026-11-18 path set exactly.
- The root scan returned 415 vector layers: 379 previews decoded and 36 retained `encoding-choice-required`; no layer preview failed. The 36 count is detector output and includes explicitly resolved sources whose original bytes still have incomplete or ambiguous encoding metadata. In particular, the user-authorized UTF-8 staging repairs for `city_road.shp` and `bonc_small_grid_outline.shp` are separately validated by full PostGIS/GeoPackage roundtrips; the six confirmed CSV choices also have explicit-override roundtrip evidence.
- The inventory also contains 80 ZIP archive candidates, which remain under the separate archive-member audit; 12 JSON files were not recognized as vector data. The scan reads metadata and up to three preview rows, does not write to the input trees, and stores no attribute values. Machine report: [2026-11-19 audit snapshot](../.cache/local-gis-data-audit-20261119-refresh.json).
- The duplicate `F:\temp\分地市道路(1)\city_road.shp` has byte-identical present Shapefile sidecars to `F:\GeoData\city_road.shp` (five hashes match), so the corrected UTF-8 roundtrip result can be inherited without a duplicate import. See [hash comparison](../.cache/gis-roundtrip/duplicate-city-road-sidecar-hash-check-20261119.json).

## 2026-11-19 Encoding-candidate reconciliation

- After excluding six user-confirmed CSV sources, the two byte-identical `city_road` copies, and the UTF-8 repaired `bonc_small_grid_outline`, 27 layers still had raw `encoding-choice-required` status. Existing reports contain completed explicit CP936/CP950 candidate roundtrips for 24 unique layers (one is an empty TAB layer); repeated imports were avoided.
- A current CoreService/GDAL CP936 candidate rerun of `F:\GeoData\fujian_road.shp` imported and exported 159,926 features; 20/20 geometries and 140/140 text sample cells matched. The original file stayed read-only.
- Current CP936 PostGIS retries for `grid.tab`, `海螺沟_物业点.tab`, and `t_gis_high_speed_segment.tab` all failed at GDAL's TAB data-block read. Two produced `ReadBytes()` past-end errors; the third rejected a 30,598,648-byte coordinate block. The earlier CP936/CP950/UTF-8 read-only preview reproduced these error types. Temporary database objects and exports were cleaned, with no external data transfer.
- A candidate roundtrip shows that the chosen candidate can be consumed and re-emitted in the sampled scope; it does not confirm that the candidate equals the original source encoding. See [reconciliation evidence](../.cache/gis-roundtrip/encoding-candidate-reconciliation-20261119.json) and the linked run reports in `docs/test-report.md`.

## 2026-11-19 Opt-in UTF-8 DBF tail repair

- The application now offers a strict-by-default repair path for standalone UTF-8 Shapefiles. It streams character DBF fields, accepts only an incomplete terminal code point, stages all same-stem sidecars in a temporary directory, replaces that one suffix with `?`, and leaves original files untouched. Interior invalid UTF-8 is rejected; ambiguous source encoding is not guessed.
- The CoreService/PostGIS smoke imported both previously authorized sources and verified exact row and replacement-marker counts. `city_road`: 366,620 features, 19,440 `CITY` cells. `bonc_small_grid_outline`: 91,204 features, 1,560 `COUNTY` and 26 `SMALLAREA` cells. Random tables were dropped and source DBF hashes matched before/after.
- This import option does not resolve the 27 remaining ambiguous-encoding candidates. Their CP936/CP950 roundtrips remain candidate checks and are not proof of source encoding; three TAB layers still fail current GDAL block reads. See [repair evidence](../.cache/gis-roundtrip/utf8-tail-repair-postgis-smoke-20261119.json) and [test report](test-report.md#2026-11-19-opt-in-utf-8-shapefile-tail-repair).
- A follow-up with the GDAL 3.12.2 executable bundled with QGIS 3.44.8 tried CP936, CP950, and UTF-8 against those three TABs (nine temporary GeoPackage imports); all reproduced the same per-file data-block failures. Because both installations use the same GDAL version, this is a build/runtime cross-check only. It neither selects a true source encoding nor proves source corruption. See [candidate evidence](../.cache/gis-roundtrip/qgis-gdal-neutral-tab-candidate-gpkg-smoke-20261119.json).

## 2026-11-20 CLI entrypoint follow-up

- The UTF-8 terminal-byte repair acceptance now invokes the built CLI for the two previously authorized Shapefiles, then checks PostGIS counts and replacement markers with read-only SQL. It passed at 366,620 and 91,204 rows respectively; repaired cell counts matched, temporary tables were removed, and source DBF hashes were unchanged.
- This is additional CLI-path evidence and does not alter encoding classifications. The 27-layer candidate set remains unproven as to original encodings; the three TAB read failures remain open. See [CLI run evidence](../.cache/gis-roundtrip/utf8-tail-repair-postgis-smoke-20261119.json).

## 2026-11-20 Three-TAB PostGIS candidate matrix

- Ran CP936, CP950, and UTF-8 imports through the CLI into random tables on the isolated PostGIS service for `grid.tab`, `海螺沟_物业点.tab`, and `t_gis_high_speed_segment.tab`. All nine attempts reproduced the same per-source read error seen in the prior GDAL checks. Because no attempt completed import, there is no PostGIS export/readback roundtrip for these three layers.
- Each random table was cleaned, source component hashes were unchanged, temporary outputs were removed, and `externalDataSent=false`. The outcomes are candidate-path diagnostics only; they do not prove any original encoding or source corruption. [Machine evidence](../.cache/gis-roundtrip/neutral-tab-postgis-encoding-matrix-20261120.json).

## 2026-11-22 未决字符编码候选复验

- 使用当前 DB Studio CLI 和随包 GDAL 3.12.2，对 27 个未决图层按清单运行 35 次 CP936、CP950、UTF-8 只读属性预览；26 次成功、9 次失败。成功预览样本没有 U+FFFD 或控制字符，且不再要求用户选择编码。预览报告只留计数、编码候选与错误类别，不保存属性值。
- `grid.tab`、`海螺沟_物业点.tab` 的三种候选都出现 `ReadBytes()` 超出数据块；`t_gis_high_speed_segment.tab` 三种候选都出现坐标块大小错误。这些结果不能证明源编码，也不能据此判断源文件损坏。
- 对 26 个可读候选在授权隔离 PostGIS 中逐项执行当前 CLI 导入、数据库计数、GeoPackage 导出及文本/几何样本比较，26/26 通过。重复候选运行合计 374,906 个要素；424 行文本样本、2,567 个文本值及 424 个几何样本匹配。26 组源 sidecar 哈希未变；隔离 Schema、临时导出清理完成，复查没有遗留 Schema；`externalDataSent=false`。
- 所有结果只标记为 **候选验证、未证明真实源编码**。失败的 9 次候选未导入。逐层机器结果与可复现命令见[测试报告](test-report.md#2026-11-22-current-source-local-encoding-candidate-preview-refresh)、[预览记录](../.cache/gis-roundtrip/encoding-candidate-preview-20261122.json)、[汇总](../.cache/gis-roundtrip/encoding-candidate-validation-summary-20261122.json)和[PostGIS 往返矩阵](../.cache/gis-roundtrip/current-postgis-candidate-matrix-20261122-1e52549616bc/acceptance.json)。
