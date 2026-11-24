# QGIS、GDAL/OGR、PROJ 与 DB Studio 架构

## QGIS 参考实现

QGIS 矢量 Provider 负责把数据源暴露为图层、字段、要素和几何。QGIS OGR provider 调用 OGR 驱动，使用 provider 配置控制编码和打开选项；QGIS Core 还提供 CRS 和 Geometry API。GDAL/OGR 提供格式驱动、向量数据模型与 `ogrinfo`/`ogr2ogr` 工具；涉及坐标变换时使用 PROJ；数据库端的空间类型和操作由对应数据库/provider 处理。

本机二进制导入表显示 QGIS Core 静态依赖 GDAL/PROJ/GEOS/SQLite/Qt 等库。公开源码确认了 OGR provider、`QgsCoordinateTransform`、`QgsGeometry` 和矢量 writer 的调用职责。公开源码说明预期结构；导入表说明二进制依赖；本机 GDAL 命令与 fixture 说明实测行为。这三种证据不能互相替代。

## DB Studio 实现

```text
React GIS workspace ── Electron IPC ──┐
                                      ├── shared Core/GIS Service
Commander CLI ───────────────────────┘          │
                                                ├── ogrinfo / ogr2ogr (argv, subprocess)
                                                ├── GDAL drivers + GDAL_DATA
                                                ├── PROJ transformations + PROJ_DATA
                                                └── Postgres adapter ↔ PostGIS
```

子进程使用可执行文件路径和 argv 数组，不经过 shell 拼接；service 负责验证路径/层/CRS/编码参数、解析 JSON/OGR 结果、报告 progress/cancel、管理临时文件及核实输出。GUI 和 CLI 调同一 GIS service。PostGIS adapter 不与格式 driver 耦合。GDAL/PROJ runtime adapter 探测版本、路径和驱动并处理打包运行环境。

最终桌面软件通过独立 GDAL runtime 执行 GIS；本机 QGIS 仅供研究和对照。当前已有的 OSGeo4W 运行包在本机安装测试通过，但其依赖许可/完整源码审计未完成，不得把“技术可运行”描述成“可合法分发”。新的最小构建候选排除了 PDF/Poppler 与 MySQL driver，仍需 Expat、完整 DLL/import 检查、许可和源码义务审核。

## 证据级别

- REA 扫描：QGIS 目录的通用应用发现为部分覆盖，未返回目标候选；结论只说明 scanner 结果有限。
- REA PE 检查：`qgis_core.dll` 49 个导入模块/4,550 imports；`qgis_process.exe` 19 个导入模块/378 imports。用于静态依赖关联，不作运行时调用推断。
- 官方源码：QGIS 3.44.8 `qgsogrprovider.cpp`、`qgscoordinatetransform.cpp`、`qgsgeometry.cpp` 和 `qgsvectorfilewriter.cpp`。
- 本机可重复操作：通过 `o4w_env.bat` 启动 QGIS 工具，GDAL 3.12.2 报告五种目标驱动并成功读写；DB Studio 与隔离 PostGIS 真实往返通过。
- 未取得的证据：REA Ghidra Provider 未配置，所以没有函数级反编译调用图；无源代码时序/性能对照也未进行。

## 参考

- [GDAL/OGR 矢量模型](https://gdal.org/en/stable/user/vector_data_model.html)
- [GDAL 构建与驱动选择](https://gdal.org/en/stable/development/building_from_source.html)
- [PROJ transformations](https://proj.org/en/stable/usage/transformation.html)
- [QGIS 3.44 矢量数据 Cookbook](https://docs.qgis.org/3.44/en/docs/pyqgis_developer_cookbook/vector.html)
