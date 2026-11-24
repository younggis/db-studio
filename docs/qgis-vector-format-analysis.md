# QGIS/GDAL 矢量格式能力分析

本矩阵以本机 QGIS 3.44.8 所带 GDAL 3.12.2、GDAL 驱动文档和 DB Studio 的真实 PostGIS 往返为依据。驱动能读写某格式不等于格式能无损表达所有 OGR 字段、几何和 CRS。

| 格式 | 读写与层模型 | 编码 | CRS / 几何 | 属性与兼容限制 | DB Studio 实测 |
|---|---|---|---|---|---|
| Shapefile | OGR Shapefile 驱动；一个图层由 `.shp/.shx/.dbf` 及可选投影、编码侧车组成 | `.cpg` 和 DBF LDID 是元数据线索；GDAL 提供 `SHAPE_ENCODING` 覆盖。写出时传 `ENCODING=UTF-8` | CRS 通常来自 `.prj`；一个图层对应一种几何族，Polygon 可由驱动按多部件规则解释 | DBF 字段名受 10 字符限制；字段类型、宽度和精度有限；字段名可能被裁切或改写 | PostGIS 往返通过；中文、空几何、字段约束报告通过 |
| GeoJSON | 单文件 JSON；通常一个 FeatureCollection 图层 | JSON 文本按 UTF-8；DB Studio 对非 UTF-8 写出请求拒绝 | RFC 7946 输出统一为 WGS 84 经度/纬度；坐标变换由 OGR/PROJ 执行；现代输出不写历史 `crs` 扩展 | 常见 JSON 值映射到 OGR 字段；GDAL 对 RFC7946 默认 7 位坐标小数；DB Studio 显式设置 17 位并通过 XYZ 浮点值往返测试；类型混杂时需检查驱动推断 | PostGIS 往返通过；检查 `RFC7946`、坐标和精度告警 |
| KML | OGR KML/LIBKML 驱动；XML 文档可含 Folder/多个图层 | KML 读写路径依赖 Expat；输出要求 UTF-8；XML 声明和来源文档编码需要验证 | KML 输出使用 EPSG:4326；`MultiGeometry` 和文件夹层次由驱动映射 | KML 样式、Folder、驱动生成的描述字段可能改变属性表现；往返后几何常以通用 `Geometry` 报告 | 使用本机 GDAL 完成 PostGIS 往返；报告输出 CRS 与字段/驱动差异 |
| MapInfo TAB | OGR MITAB 驱动；TAB 是含多个关联文件的图层集合，可通过图层列表选择 | TAB 的 `Charset` 元数据映射为编码；GDAL 提供 `ENCODING`；支持近期 MapInfo 15.2+ 的 UTF-8 写出 | CRS 可以保存在 TAB 元数据中；驱动可能报告 WKT，而非简短 EPSG 标识；支持多种 OGR 几何 | 驱动写出字段类型主要是 Integer、Real、String；字符串宽度可能截断；严格字段名净化可被关闭但接收端兼容性需验证 | PostGIS 往返通过；CP936 与 UTF-8 的 fixture/覆盖实测；TAB CRS WKT 规范化已修复 |
| GeoPackage | OGR GPKG 驱动；SQLite 容器，可包含多个矢量图层 | SQLite 文本按 Unicode 存储 | `gpkg_contents`、`gpkg_geometry_columns`、`gpkg_spatial_ref_sys` 描述图层、几何列和 CRS；使用 GeoPackage geometry 编码；每表一个 geometry column | 比 Shapefile/TAB 可表达更丰富的字段；SQLite/GeoPackage 类型和目标驱动仍有映射差异；同一文件可有多个图层 | PostGIS 往返、两层选择、字段映射和多种几何覆盖通过 |

## OGR 能力复用和输出规则

DB Studio 将读取、格式写入、驱动选项与 CRS 转换委派给 GDAL/OGR/PROJ；TypeScript 层统一做图层选择、字段映射、编码覆盖、警告、取消和结果校验。Shapefile 及 TAB 以临时副本和驱动选项处理编码，不改源文件。GeoJSON 与 KML 采用固定地理坐标输出策略，不能把项目 CRS 标签冒充真正的坐标转换。

DB Studio 的 CLI 和 GUI 都调用共享 GIS Service。多图层源必须明确选择图层；本轮 CLI 与桌面向导均已暴露图层、编码、CRS、字段映射、目标表和进度参数。数据库空间能力单独由 PostGIS adapter 实现。

## 需要用户理解的兼容边界

- 文件格式和数据库的类型系统不相同；报告里的警告说明可能的损失点，应用不会宣称所有转换都无损。
- Shapefile/TAB 对字段名、字符串长度和类型集合有限制；写出后应检查字段清单和实际值。
- GeoJSON RFC 7946 的 CRS 是 WGS 84；指定 projected target CRS 会被拒绝，而不是写入不符合 RFC 的坐标。
- KML 结果可能包含驱动生成字段，KML 中的多几何与目录层次也不等同于单一数据库行模型。
- GeoPackage 多图层导入必须选层；不能把 `.gpkg` 假设为只有一个 layer。
- 最小 GDAL runtime 候选曾因未启用 Expat 而无法读回 KML。该失败发现了发行运行时构建配置缺口；不能用“写文件成功”代替读写验证。

## 来源

- [GDAL Shapefile 驱动](https://gdal.org/en/stable/drivers/vector/shapefile.html)
- [GDAL GeoJSON 驱动](https://gdal.org/en/stable/drivers/vector/geojson.html)
- [GDAL KML 驱动](https://gdal.org/en/stable/drivers/vector/kml.html)
- [GDAL MapInfo File 驱动](https://gdal.org/en/stable/drivers/vector/mitab.html)
- [GDAL GeoPackage 驱动](https://gdal.org/en/stable/drivers/vector/gpkg.html)
- [OGR 矢量数据模型](https://gdal.org/en/stable/user/vector_data_model.html)
