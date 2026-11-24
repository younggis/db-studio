# QGIS/GDAL 字符集编码研究

编码处理是“读到正确文字”问题，不能只依据出现中文就猜编码。DB Studio 保存源文件不变；当元数据不充分或与数据冲突时，用户可以预览并覆盖源编码，写出时显式选择目标编码。

## 元数据和优先级

| 来源 | 格式 | 含义与边界 |
|---|---|---|
| `.cpg` 文件 | Shapefile | 字符集声明，GDAL 文档描述其优先于 DBF LDID；声明可能与真实字节不符，仍须校验样例字段 |
| DBF LDID | Shapefile | DBF 语言驱动标识；不是完整、跨厂商可靠的编码名称。GDAL 文档指出 LDID 87 会映射 ISO-8859-1，而部分数据实际使用其他编码 |
| GDAL `ENCODING` open option / `SHAPE_ENCODING` | Shapefile | `-oo ENCODING=...` 将覆盖限定到输入数据集；`SHAPE_ENCODING` 是进程级配置，可能同时影响同一 OGR 进程中的读写。输出应单独使用 driver creation option `ENCODING=...` |
| TAB `Charset` | MapInfo TAB | 文件元数据声明字符集；GDAL 将常用名称映射到 iconv 名称，例如 MapInfo 的 Windows 简体中文映射到 CP936 |
| 用户指定值 | 各格式 | 当声明缺失、可解码但结果可疑、声明冲突或预览明显错误时，允许用户人工选择。指定来源必须能追溯 |
| UTF-8 JSON | GeoJSON | JSON 文本读写使用 UTF-8；导出不提供任意 legacy 编码写出 |
| XML 文本 | KML | GDAL KML 输出使用 UTF-8；输入由 XML/驱动解析，不能用 DBF 的编码规则处理 |
| SQLite Unicode | GeoPackage | 属性文本是 SQLite 文本值，不读取 `.cpg` 或 DBF LDID |

GDAL 对 Shapefile 的说明是驱动行为依据，不应把它推广到 TAB、KML 或 GPKG。QGIS 3.44 的 OGR provider 源码还表明：打开 OGR 数据源前会清空进程级 `SHAPE_ENCODING`，避免全局覆盖误伤数据；当驱动没有声明 UTF-8 字符串而用户选择编码时，再把用户覆盖交给 provider。DB Studio 对 Shapefile 输入使用 `ogrinfo`/`ogr2ogr -oo ENCODING=...`，不再设置全局 `SHAPE_ENCODING`；输出编码由独立的创建选项设置。TAB 覆盖仍使用临时副本，避免改写源文件。

## DB Studio 的检测和覆盖策略

`packages/gis/src/encoding.ts` 的行为是：

1. 对 Shapefile 读取 `.cpg` 与 LDID，按 GDAL 行为优先采用 `.cpg`，同时提示冲突；
2. 将声明编码正规化，并对 DBF 字符字段样本做严格解码检查；检查发现无效字节序列时自动结果为 unknown，要求用户选择；
3. 对无 BOM CSV 使用最多 256 KiB 的候选样本；只有检测分数至少 90%、领先不同编码至少 15 个百分点，并且候选编码通过整个文件的严格流式解码，才标为启发式结果；
4. ASCII-only、低分、候选接近或全文件校验失败时仍标为未知。若存在可解码候选，向用户显示编码和分数，但导入前仍须手动选择；
5. 对启发式结果提示用户先检查属性预览。全文件严格解码证明字节可解码，不证明语义一定正确；不能只凭“出现中文”选编码；
6. 对 TAB 解析 `Charset`，并在用户覆盖时复制所有 sidecar 到 staging 目录，只改临时 `.tab` 中的 Charset；
7. 导出时明确传目标编码；Shapefile 和 TAB 使用格式驱动支持的 UTF-8/指定编码选项；
8. 将不可表示、字段截断等情况转成提示或错误，避免声称无损。

用户输入编码名会先经统一正规化和白名单/图标映射验证，无法识别的名称拒绝调用。显示“自动检测”时不能把启发式结果伪装为元数据事实。

## 实测

- 本机 GDAL 3.12.2 的 `test:integration:gis-encoding` 用五种目标格式做编码 smoke；UTF-8、CP936 Shapefile/TAB fixtures、中文属性读写/预览均通过。2026-11-02 的回归还验证 GBK Shapefile 重投影为 UTF-8 Shapefile 后 DBF 字节可按 `.cpg` 声明解码，中文属性完整。
- PostGIS 五格式往返检验了中文字段和属性值 甲、乙、两条记录，并在目标格式重新检查字段与值。
- 在实际往返中发现 MapInfo charset 名称映射键应使用 `UTF-8`，而不是 `UTF8`。修正后添加临时 TAB UTF-8 override 单元测试；仅在 staging 副本写覆写，不变更源 TAB。
- 2026-11-02 `@db-studio/gis` 的 22 个单测覆盖 `.cpg`/LDID 优先级与冲突警告、无效 UTF-8 声明及手动覆盖、DBF 非字符列后的字符列偏移、无声明歧义、CP936/GB18030、MapInfo charset 名称和写出映射。
- 2026-11-12 `@db-studio/gis` 的 46 项单测和 GDAL 3.12.2 编码 smoke 通过。授权 PostGIS 环回集成用无 BOM CP936 合成 CSV 生成 120 行；检测器判为 GB18030 高置信候选，CLI 未传 `--source-encoding` 即导入并投影至 EPSG:3857，数据库回读 120/120 个中文属性和 120/120 个目标 SRID。集成 `finally` 删除临时表和目录。

严格解码只能发现声明编码无法解释的字节序列；对所有字节都可解码的 legacy code page，字节合法不等于语义正确。因此仍保留中文属性预览和人工覆盖，不把元数据验证当作内容正确性的证明。

2026-11-12 对上一轮本地审计标为无 BOM 的 24 个 CSV 做了只读候选分析：10 个达到上述启发式门槛并通过全文件严格解码（9 个 GB18030、1 个 UTF-8）；10 个分数/差值不足，仍要求用户选择；另外 4 个审计记录路径当前不存在。启发式样例和自动化回归通过；这项统计不代表对 10 个文件逐字段做了人工语义确认。证据见 `.cache/local-gis-csv-encoding-candidates-20261112.json`。

本测试不是所有地区代码页和所有 GIS 厂商文件的兼容认证；尤其需要外部 MapInfo 版本确认 UTF-8 TAB 互操作。全文件严格解码仍不能区分所有兼容的 legacy code page，用户必须复核属性预览。

## 参考

- [GDAL Shapefile：编码来源、`.cpg`、LDID 与覆盖](https://gdal.org/en/stable/drivers/vector/shapefile.html)
- [GDAL MapInfo：Charset、`ENCODING` 和支持的字段类型](https://gdal.org/en/stable/drivers/vector/mitab.html)
- [QGIS 3.44 OGR provider 源码](https://github.com/qgis/QGIS/blob/final-3_44_8/src/core/providers/ogr/qgsogrprovider.cpp)
