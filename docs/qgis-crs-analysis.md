# QGIS/GDAL/PROJ CRS 与坐标转换

坐标值、CRS 声明和坐标变换是三件不同的事：CRS 元数据只说明坐标含义；给坐标赋 EPSG 标签不会改变数值；只有 PROJ/GDAL 真正执行变换后才可标为目标 CRS。

## CRS 如何被发现

OGR 首先从格式容器和配套元数据读取 CRS：Shapefile 的 `.prj`、TAB 内部 CRS 描述、GeoPackage 的 SRS 表、GeoJSON/KML 中格式定义的 CRS 规则，以及数据库中的 geometry SRID。结果可以是 EPSG 标识、WKT，或未解析 CRS。DB Studio 规范化 OGR 检查结果中的 WKT/EPSG 信息，并保留无法归一为 EPSG 的 WKT；TAB 实测曾返回嵌套 WKT 而非 EPSG 字符串，服务因此补充读取嵌套 CRS。

来源缺失或无效时，界面允许用户明确填写源 CRS。系统不会把未知源数据默认标成 EPSG:4326，不会把坐标原值放进目标格式再伪称已变换。转换错误或目标 CRS 不合法时，操作失败并清理临时输出。

## 变换执行和轴顺序

DB Studio 将 `-s_srs`、`-t_srs` 与格式驱动选项以独立 argv 元素传给 GDAL/OGR，由 GDAL 调用 PROJ 选择 operation/pipeline。业务层不重写投影算法。GDAL 3 / PROJ 6 起，EPSG authority axis order 可能与传统 GIS 的 x=longitude、y=latitude 顺序不同；本应用使用 OGR/GIS 的传统 XY 数据序列，并通过具体坐标断言校验实际结果，不能仅比较 SRID。

RFC 7946 GeoJSON 固定 WGS 84 longitude/latitude，KML 输出也按 EPSG:4326 约束。DB Studio 在用户请求 projected target CRS 写入这两类输出时拒绝请求，避免把错误数值装入一个看似成功的文件。GeoPackage、Shapefile 和 TAB 则可用明确目标 CRS。

## 可重复的实测

- 源测试点为 EPSG:4326 `(1.25, 2.5)`；导入 PostGIS 时指定 EPSG:3857，五种文件格式的数据库坐标均在容差 0.05 内达到 `(139149.36, 278387.08)`，且 geometry SRID 为 3857。
- 从 PostGIS 导出并写成 RFC 7946 GeoJSON/其他格式后，检查点回到 `(1.25, 2.5)`，容差 0.00001；GeoJSON 不含旧式 `crs` 扩展。
- `test:integration:gis-encoding` 已分别在 QGIS 3.44.8 附带的 GDAL 3.12.2 和安装包内 static GDAL 3.12.2 上运行；两者均通过 CRS 检查及已知点断言。
- EPSG:4490 GeoPackage 往返保留 `(116.397, 39.908)`，容差 `1e-5` 度。
- 自定义 WKT1 UTM 51N `(500000, 0)` 转到 EPSG:4326 得到 `(123, 0)`，验证传统 XY 轴顺序。
- EPSG:32651 `(500000, 0)` 转到 EPSG:3857 后 extent 为 X `13692297.3675727`、Y `0`，容差 `0.05`，覆盖投影到投影路径。
- 单元测试覆盖缺 CRS、非法 CRS、目标格式 CRS 限制、CRS 从 OGR 嵌套对象/WKT 提取与转换失败报告。

这些基准点验证了指定路径，不表示每个地区格网/基准转换均有同样精度。发行 runtime 未包含可选 PROJ datum-shift grids；需要这些网格的转换必须由部署方配置对应数据目录并单独验证。

## 参考

- [GDAL GeoJSON RFC 7946 驱动选项](https://gdal.org/en/stable/drivers/vector/geojson.html)
- [GDAL KML 输出 CRS 行为](https://gdal.org/en/stable/drivers/vector/kml.html)
- [PROJ 坐标转换使用说明](https://proj.org/en/stable/usage/transformation.html)
- [PROJ FAQ：轴顺序、WKT 与 authority identifiers](https://proj.org/en/stable/faq.html)
- [QGIS 3.44 `QgsCoordinateTransform` API](https://api.qgis.org/api/3.44/classQgsCoordinateTransform.html)
- [QGIS 3.44 坐标变换源码](https://github.com/qgis/QGIS/blob/final-3_44_8/src/core/proj/qgscoordinatetransform.cpp)
