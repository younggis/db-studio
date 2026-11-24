# QGIS/OGR Geometry 与属性处理

OGR 的矢量模型是 Dataset → Layer → Feature → Geometry/Fields。几何的坐标序列由 CRS 解释；字段类型属于驱动层映射，不是所有格式都能表达相同类型集合。QGIS 基于 OGR provider 读取矢量要素，再用 `QgsGeometry` 提供几何操作；DB Studio 把传输和格式细节留给 OGR，把数据库几何读写留给 PostGIS adapter。

## 几何类型与特殊值

服务区分 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection、空 geometry 和 SQL NULL geometry。空几何有类型但没有坐标；NULL geometry 表示该 feature 没有几何值，不能将它转换成 POINT EMPTY。GeometryCollection 是集合，而不是同质的 MultiGeometry。多部件几何是否保持取决于目标驱动的数据模型；写到 Shapefile 等限制较强格式时会检查实际层类型和驱动结果。

## 有效性、转换与异常

格式转换会保留 OGR 可表达的几何；不会默默执行 `MakeValid`、修复拓扑或以另一个 geometry type 替换坏数据。数据库写入由 PostGIS 校验；转换失败时错误会关联操作和层上下文。几何对象导出后需要重新读取检查类型、空值数、要素数与 extent，不能只看写命令退出码。

## 属性映射

字段映射包含目标名称和目标字段类型。导入/导出前显示并验证字段映射；SQL NULL 与空字符串保持区分；数值转换在映射定义处完成，不能把溢出或不受支持的类型静默变成字符串。Shapefile DBF、MapInfo TAB 和 GeoJSON 各有自身字段限制，见 [矢量格式矩阵](gis-format-matrix.md)。

## 实测覆盖

PostGIS multilayer/geometry integration 通过 OGR fixture 实际交换：Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection、一个 NULL geometry，以及一个自交 invalid polygon。测试检查 geometry type、NULL 数、有效性和导出至 GPKG/GeoJSON 后的 9 个 feature。另用双层 GPKG 实测未指定层/不存在层时报错、指定层只导入对应要素、中文字段重命名和 Integer64 映射。另有 200,000 feature 导入/导出取消测试，验证取消不会留下部分数据库表或最终文件/临时目录。

## Z/M 维度保留

`pnpm run test:integration:gis-dimensions` 使用真实 OGR `PointZM` fixture 验证五种输出：Shapefile 与 GeoPackage 保留 Z/M；RFC 7946 GeoJSON 与 KML 保留 Z 高程但不保留 M；MapInfo TAB 输出为 2D。GIS Service 会在操作报告中注明这些已知降维；当 OGR 仅报告通用 `Geometry`/`GeometryCollection` 时，也会提示目标格式可能丢失不支持的维度。该机制不等于阻止有损转换，调用方仍须查看 warnings。

其他覆盖仍有限：这项维度探针只用 PointZM，不代表所有线/面、多部件、曲线、厂商扩展和逐要素混合维度都已验证；目标驱动随 GDAL 版本变化时须重跑维度测试。已有有效性测试也不覆盖所有面修复规则、测地线或所有厂商自定义几何编码。

## 参考

- [OGR 矢量数据模型](https://gdal.org/en/stable/user/vector_data_model.html)
- [QGIS 3.44 矢量数据结构与要素访问](https://docs.qgis.org/3.44/en/docs/pyqgis_developer_cookbook/vector.html)
- [QGIS 3.44 `QgsGeometry` API](https://api.qgis.org/api/3.44/classQgsGeometry.html)
- [QGIS 3.44 Geometry 源码](https://github.com/qgis/QGIS/blob/final-3_44_8/src/core/geometry/qgsgeometry.cpp)
## QGIS 和 GDAL 的整环坍塌对照（2026-11-18）

同一份两要素合成夹具用于 QGIS 3.44.8 的 Linework 和 Structure，以及随 DB Studio 分发的 GDAL 3.12.2。修复带内环和尖刺的面时，三种输出空间等价，均去掉尖刺并保留内环。对于整环共线的面，QGIS 两种方法均保留属性行及空 MultiPolygon，GDAL 保留属性行及非空 MultiLineString。六条输出均由 PostGIS 校验为有效，并逐条与预期形状或空几何检查匹配。

直接 OGR 写 GeoPackage 时，原 Polygon 图层容纳 MultiLineString 会产生类型警告。工程内的 PostGIS 导入使用通用 geometry 列接收修复后的类型。真实 PostGIS 集成验证 DB Studio 保留两条记录，分别为带内环的面和与预期线段等价的线。这个用例说明修复可能改变空间维度或产生空几何。对照使用合成数据。详见 [对照证据](../.cache/qgis-collapsed-rings-20261118/summary.json)。

