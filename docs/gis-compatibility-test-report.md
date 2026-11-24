# GIS 兼容性与对照测试报告

运行日期：2026-11-03。对照 runtime 为本机 QGIS 3.44.8 附带 GDAL/OGR 3.12.2、PROJ 9.8.0。隔离 PostGIS 为 PostgreSQL 16 / PostGIS 3.6。测试写入项目专属 loopback 容器和 fixture；没有连接生产库。

## QGIS/GDAL/PROJ 基线

通过 `o4w_env.bat` 启动 QGIS 处理工具时，`qgis_process --version` 返回 QGIS 3.44.8-Solothurn，`ogrinfo --version` 返回 GDAL 3.12.2。驱动清单包含 Shapefile、GeoJSON、KML/LIBKML、MapInfo File、GPKG 和 PostgreSQL。直接启动 `qgis_process.exe` 不继承 OSGeo4W 的 DLL/GDAL/PROJ 路径会失败；这是部署环境要求，不是无安装错误。

## 自动化和实测

| 验证 | 命令/fixture | 结果 |
|---|---|---|
| GIS 单元测试 | `pnpm --filter @db-studio/gis test` | 25 个通过；编码、CRS 提取/拒绝、GeoJSON 精度、驱动选项、runtime 探测与报告覆盖 |
| 编码 QGIS/GDAL smoke | `pnpm run test:integration:gis-encoding` | QGIS 自带 GDAL 与安装包 static GDAL 均通过五种格式读写/检查；含 CP936 Shapefile/TAB、中文属性、CRS 检查和 RFC7946 坐标转换。2026-11-02 又验证 GBK Shapefile 重投影写为 UTF-8 Shapefile 后中文属性仍正确，`.cpg` 声明与 DBF 字节一致 |
| RFC 7946 GeoJSON 精度回归 | 文件转换 smoke 与 `pnpm run test:integration:postgis` | OGR 写出显式设置 `COORDINATE_PRECISION=17`，覆盖 GDAL 的 7 位默认值；文件转换和 PostGIS 导出均逐值保留 XYZ `[121.12345678901234, 31.12345678901234, 12.345678901234567]` |
| 五格式 PostGIS roundtrip | `pnpm run test:integration:postgis` | Shapefile、GeoJSON、KML、TAB、GPKG 各导入和导出 2 个 features；每种保留 1 个 null geometry、中文字段/值，数据库 CRS/SRID 3857，变换点在容差内匹配；PostGIS GeoJSON XYZ 精度回归通过 |
| CRS 已知点 | `pnpm run test:integration:postgis` | EPSG:4326 `(1.25,2.5)` → EPSG:3857 `(139149.36,278387.08)`，公差 0.05；反向输出回到 `(1.25,2.5)`，公差 0.00001 |
| CRS runtime 对照与投影间变换 | `pnpm run test:integration:gis-encoding`，分别指定 QGIS 和安装包 static GDAL | 两套 GDAL 3.12.2 运行时结果一致：EPSG:4490 往返保留 `(116.397,39.908)`；自定义 WKT1 UTM 51N `(500000,0)` → EPSG:4326 `(123,0)`；EPSG:32651 → EPSG:3857 extent X `13692297.3675727`、Y `0`。容差分别为 1e-5 度、轴顺序断言 1e-8 度及投影值 0.05 米 |
| 格式约束 | 五格式 roundtrip assertions | SHP 报 DBF 限制；RFC7946 报 WGS84/精度；KML 报 EPSG:4326；TAB 报 MapInfo 字段约束；GPKG 不报不支持输出限制 |
| 多层、字段映射和 CRS 缺失处理 | `pnpm run test:integration:postgis-multilayer` | 双层 GPKG 选层必填/不存在层拒绝；字段重命名、Integer64 映射；Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection、null 和 invalid polygon 的导入/导出检查通过。新增 VRT 回归把图层声明为 LineString、其中一条实际要素为 MultiLineString；PostGIS 通用 geometry 列保存两种原始要素类型，导入报告说明该列类型；追加到该通用列后两种类型仍各有 2 条。追加到既有受限几何列时，报告会提示目标列类型仍然生效。无字符串字段时不再要求无意义的编码选择。缺少 `.prj` 时报告无 CRS；没有 `--source-crs` 的导入被拒绝；显式指定 EPSG:32651→EPSG:4326 后，坐标确实完成变换而非仅重标记 |
| 进度和取消 | `pnpm run test:integration:postgis-cancel` | 200,000 features 导入和导出于 10% 取消；取消后无残余 PostGIS 表、最终输出或 staging 目录 |

## 运行时候选验证

vcpkg 的 GDAL 3.12.2 构建排除了 PDF/Poppler 与 MySQL GIS driver。首个无 Expat 候选不能读回 KML；加入 Expat 后，KML XML 虽含 `note` 的 ExtendedData，原生 KML reader 却只返回 Name/Description。GDAL 官方说明，构建 LIBKML 后它会成为默认 KML reader；本项目输出仍明确选择 KML writer，因此需要同时构建 LIBKML 才能完整读回扩展字段（[GDAL LIBKML driver](https://gdal.org/en/stable/drivers/vector/libkml.html)）。

最终候选位于 `.cache/gdal-reduced-candidate-libkml-20261101`，共 260 个文件、50,524,131 字节（含 26 个 DLL、ogrinfo/ogr2ogr/gdalinfo 和 38 份 vcpkg 版权/许可文本）；`bundle-manifest.json` 记录构建选项及其余文件的 SHA-256。该候选使用 GDAL 3.12.2 / PROJ 9.7.1，含核心 `proj.db` 而不含可选 datum-shift grid。GDAL 驱动清单包含 Shapefile、GeoJSON、KML/LIBKML、MapInfo TAB、GeoPackage 和 PostgreSQL/PostGIS，不含 PDF/MySQL。暂存 EXE/DLL 的 dumpbin 导入扫描没有发现 Poppler 或 MySQL client。每个运行二进制、静态/头文件依赖与 notice 映射见 [vcpkg 依赖清单](gdal-vcpkg-dependency-inventory.csv)。

候选验证结果：

- `test:integration:gis-encoding` 通过：五种格式各读回 1 条记录；中文字段与 KML 自定义属性正确，RFC 7946 坐标为 `[121.5, 31.2]`。
- `test:integration:gis-dimensions` 通过：构造 `PointZM` 要素并转换到五种格式；Shapefile/GeoPackage 保留 ZM，GeoJSON/KML 保留 Z 但报告 M 丢失，MapInfo TAB 报告 Z/M 降为 2D。通用 `Geometry` 图层也会在无法判明维度时给出保守提示。
- `test:integration:postgis` 通过：CSV/JSON/XLSX 表格往返及五种 GIS 格式的 PostGIS 导入/导出均通过；每种输出 2 条要素，空几何、中文值、SRID 3857 及 EPSG:4326 输出检查通过。第一次运行在 JSON 表导出时出现一次连接超时；服务健康检查正常，随后的完整重跑通过。
- `test:integration:postgis-multilayer` 通过：图层选择、字段映射、9 种几何覆盖、空/无效几何与导出映射通过。
- `test:integration:postgis-cancel` 通过：200,000 要素导入和导出均在 10% 取消，未留下部分表或导出文件。

候选已在当前 Windows 主机通过 GIS/PostGIS 集成验证，但没有替换 `apps/desktop/resources/gdal` 中的现有包。vcpkg 依赖清单将 DLL 和 EXE 映射至包版本及许可证声明；GDAL、libiconv、liblzma、pkgconf 等包的 SPDX 元数据不完整。候选 imports 还依赖未随包提供的 VCRUNTIME140、VCRUNTIME140_1 和 MSVCP140；本机 14.50.35719 运行库使主机测试通过，但干净 Windows 必须验证安装前置条件。38 份 notice 仍不等于逐依赖许可、Microsoft CRT、完整对应源码及再分发审查，发行许可和干净 Windows 安装验收继续 Pending。

## Static-CRT 安装包精度回归（2026-11-01）

精度修复后重新构建了独立 static-GDAL NSIS 安装包（203,365,680 bytes；SHA-256 `CAAB00B14827BACAE6087265EA5899D10760628E7FCD70E40F373ADF8ABEDA0E`），安装到 `.cache/installer-smoke/精度验证 静态 GDAL-20261101`。安装目录内 288 条 GDAL runtime 清单哈希全部匹配，installed `app.asar` 与此次构建一致。仅设置 `DBSTUDIO_GDAL_BIN` 后，GIS 编码 smoke 和五格式 PostGIS roundtrip 均通过；PostGIS 输出精确保留 XYZ binary64 坐标，9 张本轮临时表及输出目录均已清除。

## Static-GDAL 安装版 GUI GIS IPC（2026-11-02）

从上述安装目录启动 `DB Studio.exe`，使用独立 `.cache/installer-smoke/gui-static-gdal-userdata-20261102` 用户数据目录。安装版 GIS 页面打开 `tests/fixtures/points.geojson`，显示 Point、2 features、EPSG:4326 及中文字段/值。通过安装版 Electron IPC 连接项目隔离 PostGIS，导入至 EPSG:3857 后报告 2/2 成功；数据库检查确认中文值、转换后的坐标/SRID 及 null geometry。再导出 GeoPackage 并用安装目录中的 `ogrinfo` 复核：2 features、EPSG:4326、中文属性和坐标均正确，null geometry 保留。临时 PostGIS 表和 GUI 连接已删除；导出复核文件 `.cache/gui-gis-ipc-20261102/roundtrip.gpkg` 保留供复查。主机 GUI 验收不代表干净 Windows 安装；许可和完整对应源码审查仍待完成。

## 显式 PROJ 坐标操作（2026-11-11）

- GIS 文件转换、PostGIS 导入/导出及 CLI 命令支持可选 `--coordinate-operation`，将用户提供的 PROJ pipeline 传给 GDAL `ogr2ogr -ct`。必须同时指定目标 CRS；桌面操作分开保存导入/导出的目标 CRS 和 pipeline。
- static GDAL 3.12.2 集成 fixture 对 EPSG:4326 点应用完整 pipeline（轴序交换、角度转弧度、Web Mercator 投影、X 偏移 10 米），并与自动 EPSG:3857 输出比较，确认显式 operation 生效。首轮遗漏 axis swap 时发现 X/Y 对调，修订后的 pipeline 和断言通过。
- 验证：GIS 包 36/36；`DBSTUDIO_GDAL_BIN` 指向 static GDAL 后，CLI GIS 集成 4/4；Core build/typecheck、CLI typecheck 与桌面 typecheck 通过。支持显式选择不等于自动选择最佳 datum operation；所需 PROJ grid 仍需发行环境单独提供。

随后在同一安装版上用独立 `.cache/installer-smoke/gui-gis-ipc-crs-20261102` 用户数据再次验收 CRS 往返。GUI 通过 Electron IPC 将 fixture 导入 PostGIS 的 EPSG:3857 表，报告 2/2 成功；只读检查得到 2 行、1 个 Point、1 个 null geometry、SRID 3857，点坐标为 `(139149.36349159197,278387.0759542351)`，中文值为 `甲/乙`。GUI 导出到 `.cache/gui-gis-ipc-20261102/installed-gui-crs-export.gpkg`，再次报告 2/2 成功。静态 GDAL `ogrinfo` 复核文件有 2 features、EPSG:4326、`POINT (1.25 2.5)`、中文字段和值及 1 个 null geometry。该轮临时表和 GUI 连接配置均已删除；新 GeoPackage 保留供复查。此结果验证了已安装 GUI、Electron IPC、PostGIS 和 CRS 转换的主机集成，不替代干净 Windows 安装及发行许可/源码审核。

## Shapefile 编码校验和输入/输出隔离（2026-11-02）

- DBF 编码样本现在按字段描述符计算字符列的真实偏移；前置数值列不再导致采到错误字节。
- `.cpg` 与 LDID 冲突时保留 `.cpg` 优先级并显示警告。若声明编码不能严格解码抽样的 DBF 字符字段，自动结果改为 unknown，用户可明确覆盖；覆盖结果保留原声明错误警告。
- GDAL 官方 Shapefile driver 文档支持用 `ENCODING` open option 指定输入解释。服务现对输入使用 `-oo ENCODING=...`，避免全局 `SHAPE_ENCODING` 泄漏到输出；输出仍通过 driver creation option `ENCODING=...` 单独设置（[GDAL Shapefile encoding and open options](https://gdal.org/en/stable/drivers/vector/shapefile.html#encoding)）。
- `packages/gis` 单测 22 项通过；GIS 包和全工作区 typecheck、build 通过。静态安装目录上的 `test:integration:gis-encoding` 与项目隔离 PostGIS `test:integration:postgis` 均通过。后者核验五种格式各导入/导出 2 个要素、中文属性、空几何和 CRS；PostGIS roundtrip 临时目录已清理。

## 源 CRS 单独指定的 PostGIS 集成与桌面 IPC（2026-11-02）

- `tests/integration/postgis-gis-roundtrip.mjs` 新增只传 `--source-crs EPSG:4326`、不传目标 CRS 的回归；`pnpm test:integration:postgis` 通过。两条要素导入后 SRID 为 4326，已知点仍为 `(1.25,2.5)`，五种 GIS 格式原有往返断言也全部通过；脚本在 `finally` 中清理本轮唯一测试表和输出目录。
- 重新构建 `pnpm --filter @db-studio/desktop dist:win:static-gdal` 后，在主机运行 `apps/desktop/release-static-gdal/win-unpacked/DB Studio.exe`，使用隔离 Electron 用户数据目录 `.cache/gui-gis-ipc-20261102/isolated-userdata-rerun`。通过桌面 Electron IPC 导入 GeoPackage 到项目隔离 PostGIS，GUI 报告 2/2 成功；只读数据库检查确认 `public.codex_gui_crs_only_20261102_1740` 有 2 行、SRID 4326，`id` 和中文字段 `名称` 存在，几何坐标未变。
- 同一 GUI 将表导出到 `.cache/gui-gis-ipc-20261102/gui-gis-ipc-crs-only-20261102.gpkg`，并用本构建的静态 GDAL `ogrinfo` 复核 2 features、EPSG:4326、中文字段/值和点坐标。该验收运行的是 builder 解包目录中的主机应用，不是 NSIS 安装后验收，也不代表干净 Windows 验收。人工 GUI 测试表仍留在项目隔离 PostGIS 数据库中；自动集成脚本的临时对象已清理。

## 2026-11-01 工作区检查状态

- 本轮根目录 `pnpm run build`、`pnpm run typecheck`：通过；全量 `pnpm run test`：66 passed、3 skipped。GIS package 测试 19 passed。
- Windows 本机安装包在 host smoke 成功；虚拟机/干净 Windows 安装验收仍待用户自行安装和反馈。不会继续操作虚拟机。

## 解释和局限

测试覆盖规定的格式、项目 fixture、隔离 PostGIS 与本机 QGIS/GDAL 版本，不代表所有编码声明冲突、所有第三方 MapInfo 版本、所有 PROJ transformation grids 或所有文件厂商扩展。REA 导入表是静态证据；没有 Ghidra 函数级调用跟踪。运行包许可/完整源代码义务尚未完成，技术测试通过不等于法律清关。

## 主要参考

- [GDAL 3.12 Shapefile](https://gdal.org/en/stable/drivers/vector/shapefile.html)、[GeoJSON](https://gdal.org/en/stable/drivers/vector/geojson.html)、[KML](https://gdal.org/en/stable/drivers/vector/kml.html)、[MapInfo](https://gdal.org/en/stable/drivers/vector/mitab.html)、[GPKG](https://gdal.org/en/stable/drivers/vector/gpkg.html)
- [PROJ transformation operations](https://proj.org/en/stable/usage/transformation.html)
- [QGIS 3.44 OGR Provider](https://github.com/qgis/QGIS/blob/final-3_44_8/src/core/providers/ogr/qgsogrprovider.cpp)

## Shapefile encoding override regression (2026-11-04)

- `test:integration:postgis-multilayer` now creates a CP1252 Shapefile, deliberately changes its `.cpg` declaration to UTF-8, imports with an explicit CP1252 override, exports using CP1252, then reimports from the generated sidecar. The synthetic `café` value and one feature are preserved.
- A local corpus source with the same UTF-8-sidecar mismatch imported all 6,108 records into isolated PostGIS after the user-facing CP1252 choice was translated to GDAL's `WINDOWS-1252` label. Source files were not modified.
- GDAL notes that Shapefile's `ENCODING` open option overrides `.cpg` interpretation and uses CPLRecode-supported labels: [official GDAL Shapefile documentation](https://gdal.org/en/stable/drivers/vector/shapefile.html#open-options).

## Expanded local GIS/PostGIS corpus (2026-11-04)

- The repeatable batch runner now accepts explicit feature, data-bundle and CLI-time limits, source-ID/layer-prefix filters, per-source field-type overrides, and emits path-redacted failure details with source hashes.
- At 100,000 features / 100 MiB, 431 decoded layers with sufficient encoding evidence were eligible. The full batch passed 430/431; its one failure was matched by `sourceId` to a targeted CP1252 re-run, which passed 1/1. The aggregate report therefore records 431/431 with no failures: GeoJSON 92, GeoPackage 96, JSON 2, KML 11, Shapefile 97, and MapInfo TAB 133.
- Besides the existing CP1252 mismatch, this expanded run found one UTF-8 sidecar over CP936 bytes, a DBF numeric width/precision declaration that could not represent an observed value, and five GeoJSON string fields marked with JSON subtype. An explicit CP936 override, `WIDTH=real`, and five field-to-string mappings let the data import and round trip; these choices are recorded in the aggregate report, and no source file was changed.
- It skipped 76 layers requiring an encoding choice, 30 above the 100,000-feature limit, and 12 above 100 MiB. The full and targeted reports confirm PostGIS temporary tables and export directories were cleaned; no data was sent to an external service. This local corpus run verifies feature counts and reinspection, while field, encoding and geometry semantics remain covered by dedicated regressions.

## QGIS geometry validity and MakeValid comparison (2026-11-11)

- QGIS Process 3.44.8-Solothurn (GDAL/OGR 3.12.2, GEOS 3.14.1) ran `native:checkvalidity` with the GEOS method against a synthetic GeoJSON containing one XYZ self-intersecting bowtie polygon and one valid XYZ polygon. QGIS returned 1 valid feature, 1 invalid feature, and one error-location diagnostic: `Self-intersection` at `(1,1)`.
- QGIS `native:fixgeometries` default Structure and explicit Linework, plus the project's GEOS-enabled GDAL `ogr2ogr -makevalid`, each produced two `MultiPolygonZ` features. In this fixture they split the bowtie into two parts, retained the original XYZ vertices, and interpolated Z=25 at the crossing. Ring winding/start order differed. QGIS GEOS recheck returned valid 2 / invalid 0 / diagnostic 0 for both Structure and GDAL outputs.
- QGIS algorithm help states that output is always multi-geometry and M values are dropped. A second XYZM bowtie fixture showed that QGIS 3.44.8 writes a measured layer with M ordinates zero on repaired and valid features; direct GDAL GPKG output drops the M dimension on the repaired feature but keeps it on the valid feature. Through the DB Studio `--make-valid` PostGIS import, the repaired feature is promoted back to the layer's XYZM dimension with M=0, while the valid feature retains 500/600/700/800. The GIS operation report now warns about this zero-fill behavior whenever a source layer declares or contains M.
- QGIS GEOS recheck returned valid 2 / invalid 0 / diagnostics 0 for both XYZM fixed outputs. The test uses synthetic polygons only and does not establish behavior for holes, collapsed rings, collections or other GEOS edge cases. Complete hashes and observations are recorded in `.cache/qgis-fixgeometry-20261111/summary.json`; no local corpus files were modified.
