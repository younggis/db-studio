# 本机 QGIS 安装与组件分析

研究日期：2026-11-01。仅检查已安装文件、运行版本查询和读取公开源码；没有修改 QGIS 安装目录。

## 安装与版本证据

| 项目 | 实测结果 |
|---|---|
| 安装目录 | `C:\Program Files\QGIS 3.44.8` |
| QGIS | 3.44.8-Solothurn，构建标识 `d25052deb8b` |
| GDAL/OGR | 3.12.2，构建日期标识 2026-02-03 |
| PROJ | 9.8.0，版本命令输出的发布日期为 2026-03-02 |
| GEOS | 3.14.1（由随附工具版本输出确认） |
| 操作系统 | Windows 11 Home，build 26200 |

QGIS 进程必须在 OSGeo4W 环境中启动。直接启动 `qgis_process.exe` 会因 DLL 搜索路径不完整而失败；通过 `bin\o4w_env.bat` 初始化环境后，`qgis_process.exe --version` 正常返回上述版本。该脚本设置 GDAL、PROJ、Python、Qt 插件路径和经整理的 PATH。随附 `ogrinfo.exe`、`ogr2ogr.exe`、`gdalinfo.exe` 位于 `bin`，GDAL 数据位于 `apps\gdal\share\gdal`，PROJ 数据库位于 `share\proj`。

## 组件关系

桌面程序和处理工具通过 QGIS Core、GDAL/OGR、PROJ、GEOS 与 Qt 组合工作。REA PE 导入表检查发现 `qgis_core.dll` 静态导入表包含 `gdal312.dll`、`proj_9.dll`、`geos_c.dll`、SQLite 与 Qt 等依赖；`qgis_process.exe` 也导入 QGIS Core、GDAL、PROJ、GEOS、Qt 和分析模块。导入表只证明二进制依赖，不证明特定用户操作期间执行了某个调用。

REA 对安装目录做过一次通用应用扫描，但返回的是部分覆盖而且没有应用候选，不能据此判断组件不存在。更具针对性的 PE 检查覆盖了 `qgis_core.dll` 和 `qgis_process.exe` 的完整导入表。REA 会话没有目标二进制打开，Ghidra Provider 未配置；本研究因此采用本机版本输出、公开源码与 GDAL 命令行实测，未声称完成 Ghidra 函数级追踪。

REA 证据：`qgis_core.dll` 导入分析 `ev_92be74a286f044a57ef238f2adecd68006934c1e5dbd22f4bbeec21dad458d5c`；`qgis_process.exe` 导入分析 `ev_fcde44fd02404ab33ccff701ec12add1fb2c826d833493ca68c68f3faa63bb81`；安装目录概览 `ev_0fea3a1bd2d7d5b4332379bbbcd7aa9b84c76a22ffb9236763d7f32e7571cbaa`（摘要哈希 `14a575e9dc19391c2aac429c0897f2df5d24df7cb73a9cc9f7757d3c9322e0e2`）。

## 对 DB Studio 的影响

QGIS 是研究和对照环境，不是 DB Studio 的运行依赖。DB Studio 通过独立 GDAL/OGR CLI 子进程处理矢量数据，并由 PROJ 数据目录完成 CRS 转换。最终安装包仍需自己的 GDAL/PROJ runtime、数据文件和驱动；本机能运行 QGIS 不能证明用户机器安装了 QGIS，也不能替代独立 runtime 许可审查。

Windows 克隆机/干净安装验收尚未完成。用户已要求停止反复尝试虚拟机；没有在克隆机运行安装器，也没有使用或记录 PIN。该项应由后续手动验收关闭。

## 参考资料

- [QGIS 3.44 PyQGIS 矢量图层文档](https://docs.qgis.org/3.44/en/docs/pyqgis_developer_cookbook/vector.html)
- [QGIS 3.44 源码：OGR 矢量 Provider](https://github.com/qgis/QGIS/blob/final-3_44_8/src/core/providers/ogr/qgsogrprovider.cpp)
- [QGIS 3.44 安装文档](https://docs.qgis.org/3.44/en/docs/user_manual/introduction/getting_started.html)
- [GDAL 3.12.2 Windows 构建说明](https://gdal.org/en/stable/development/building_from_source.html)

## 2026-11-17 安装与 Processing Runtime 复核

- REA `inspect_desktop_application` 对 `C:\Program Files\QGIS 3.44.8` 在 1,200 项预算处停止，已探测 572 个文件、读取 151,013 字节；结果是 partial，不据此推断未访问目录内容不存在。证据 `ev_9a2f0938912ee6f15f192a059d4c3cd0caa1913c487f668023c08e8596c5bbbe`。
- 通过 `bin\qgis_process-qgis-ltr.bat`、隔离 `QGIS_CUSTOM_CONFIG_PATH` 和 `QT_QPA_PLATFORM=offscreen` 查询当前环境：QGIS 3.44.8-Solothurn、GDAL/OGR 3.12.2、PROJ 9.8.0、GEOS 3.14.1-CAPI-1.20.5、Qt 5.15.13、Python 3.12.13。`--json list` 的 providers 字段是按 provider ID 分组的 object；重新按 object property 计数后为 438 个算法，而旧解析记录 426 是低估。
- 机器摘要：[`qgis-process-runtime-20261117.json`](../.cache/qgis-process-runtime-20261117.json)。这次仅枚举处理提供者，没有使用 QGIS 桌面配置、连接、生产数据或修改安装目录。

## 2026-11-17 MapInfo TAB 空值探针

- 用隔离合成 GeoJSON 在 QGIS 自带 GDAL 3.12.2 中执行 GeoJSON→TAB→GeoJSON。Integer、Real 和 String 的 NULL 分别读回为 0、0.0 和空字符串；与输入为 0、0.0、空字符串的第二个要素无法区分。
- 该结果支持 DB Studio 在 TAB 导出时保留“NULL 可能变成空值/默认值”的警告。它只描述本机 GDAL 版本和该合成 fixture，不表示所有 MapInfo 客户端行为相同；没有使用用户数据或数据库。详见[机器证据](../.cache/qgis-tab-null-probe-20261117.json)。

## 2026-11-07 PE identity refresh

在同一安装目录下重新核对了两个 PE 文件的当前字节身份。REA 静态导入分析覆盖完整导入表：

| 文件 | SHA-256 | 导入模块 / 函数数 | REA Evidence |
|---|---|---:|---|
| `apps/qgis-ltr/bin/qgis_core.dll` | `49c6d022f1445cd6f8881e0e8ac4c8d222b72036e707e83317701d16d9f662de` | 49 / 4,550 | `ev_92be74a286f044a57ef238f2adecd68006934c1e5dbd22f4bbeec21dad458d5c` |
| `apps/qgis-ltr/bin/qgis_process.exe` | `554a4be89913535c2fa512851d483338cdde454bc7ad2526dade95aa00763920` | 19 / 378 | `ev_fcde44fd02404ab33ccff701ec12add1fb2c826d833493ca68c68f3faa63bb81` |

导入表再次显示 QGIS Core 静态依赖 `gdal312.dll`、`proj_9.dll`、`geos_c.dll` 与 Qt 等模块；`qgis_process.exe` 静态导入 QGIS Analysis/Core、GDAL、PROJ 和 GEOS。PE 导入是依赖关系证据，不证明某项 GUI 操作实际调用了这些入口。当前 REA binary session 没有打开目标，Ghidra provider 未配置，因此没有函数级运行路径结论。
