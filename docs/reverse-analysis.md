# Navicat reference notes

Research was limited to local installation metadata, a bounded REA inventory and a read-only main-window observation. No saved database password was read, copied or used.

## Confirmed observations

- Windows uninstall metadata identifies **PremiumSoft Navicat Premium 16.3**, version **16.3.9**, installed under `C:\Program Files\PremiumSoft\Navicat Premium 16`.
- The executable reports file version **16.3.9.0** and product version **16.3**.
- REA `inspect_desktop_application` scanned 136 entries (119 files probed, 40,444 bytes read) with complete coverage within its configured scan limits. It identifies `navicat.exe` as a PE x64 image. A directory scan does not establish runtime behavior.
- REA's Ghidra provider is not configured, and native macOS UI inspection is unavailable on this Windows host.
- A read-only launch and screenshot of the main window showed a top menu and toolbar, a left connection list, a central object workspace, a right connection-summary pane, and a bottom status bar. The selected profile and its connection details are deliberately excluded from this report.

## Design inferences

- A persistent connection tree beside a tabbed central workspace is a useful, familiar organization for this tool. The project will use its own layout and visual design.
- The main-window observation is sufficient to guide the initial shell structure, but not to reproduce unseen workflows.

## Unknown and not yet studied

- SQL editor behavior, result paging, object-tree expansion, MongoDB browsing and import/export wizard behavior have not been inspected.
- No connection was opened and no database operation was initiated in Navicat.
- The bounded REA inventory does not establish which components execute for each feature. DLL names and bundled files are not treated as proof of feature behavior.

## 2026-11-21 function-level REA probe

- REA read-only opened the installed `navicat.exe` (x64 PE; SHA-256 `2A52A151…9734AAC4`), matching the binary recorded above. Requests to trace “Query Editor” and “Data Transfer” stopped at provider selection because Ghidra 12.1.x is not configured (`GHIDRA_INSTALL_DIR` unset); Hopper is unsupported on this Windows host, and IDA/Kuna are unavailable or unconfigured. The REA target was closed without running Navicat or accessing saved profiles.
- This attempt produced no function or workflow evidence. The exact sanitized provider diagnostics are in [the probe record](../.cache/rea-navicat-function-probe-20261121.json); function-level analysis remains pending.

Evidence: REA desktop inventory `ev_97f2c6dfb3b0ba6ac53b01d7f13957c907bf57d4b55e5ed77c1891515ae41f68`; file inventory view `ev_20128caa6933e6acafa1906270d5d4b7758f9fadc80f45c418600cc4c16abea`. Visual observations are from the local UI screenshot on 2026-10-30.

## 2026-11-07 artifact identity refresh

- Rechecked the installed `navicat.exe` file identity: version `16.3.9.0` / product `16.3`, 63,989,032 bytes, SHA-256 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`.
- The current REA desktop-application summary reports the same installation directory, 136 entries examined, 119 files probed and 40,444 bytes read; it found no framework candidates. Evidence `ev_521cbdbc1415f118e80d6c54fe948036845848cb132b7ed904c5eba49943e05f` links to the retained inventory `ev_3dc43fe3be0f95d523199da61c6f619df7e1e6edfaa4db617a09771a42cb0fbe`. This bounded directory scan does not establish runtime behavior.
- The active REA binary session currently has no target open, and Ghidra is not configured. The existing main-window screenshot remains the only direct UI observation; SQL editor, result paging and import/export wizard behavior are still unknown. No database connection was opened.

## 2026-11-09 focused PE evidence refresh

- Rechecked the installed `navicat.exe` PE import table. REA evidence `ev_a44247e31312680509ecaf2cb939730abe11f76c865b49f57b152ee81f3b39d0` reports complete parsing of 54 DLL descriptors, 1,569 imports, and 46 delay-load imports with no parser issues. The import set includes Win32 UI libraries (`user32.dll`, `gdi32.dll`, `gdiplus.dll`), `FreeImage.dll`, and `wsock32.dll`. This is static linkage evidence only; it does not show which imports execute during SQL editing, browsing, or transfer workflows.
- A refreshed bounded inventory of the Navicat installation covered 136 entries (119 files probed, 40,444 bytes read), with no generic framework candidate identified. This does not establish the absence of a custom or statically linked UI framework. Evidence: `ev_82ce2598ecfed88f375fb01e8c019c9c862689f97a4ca3277fd82ec7db139d09`.
- QGIS 3.44.8 directory inventory stopped at its 256-entry limit and probed 8 files (2,444 bytes). Treat it as partial coverage. Targeted PE imports are stronger dependency evidence: `qgis_core.dll` imports GDAL 3.12, PROJ, GEOS, Qt, SQLite, PDAL and SpatiaLite (`ev_92be74a286f044a57ef238f2adecd68006934c1e5dbd22f4bbeec21dad458d5c`); `qgis_process.exe` imports QGIS Analysis/Core, GDAL, PROJ and GEOS (`ev_fcde44fd02404ab33ccff701ec12add1fb2c826d833493ca68c68f3faa63bb81`). Neither import table proves runtime call paths.
- No new Navicat feature workflow was inspected. The 2026-10-30 read-only main-window capture remains the only direct Navicat UI observation; editor, paging, object-tree expansion, and import/export behavior remain unknown. No profile or database connection was opened.
- The current authorized NSIS acceptance attempt reached the installer page, but the screenshot capture showed a Codex-level “Allow ChatGPT to use DB Studio” prompt instead of the installer, while the accessibility tree described the installer. No installer control was clicked after this mismatch, and no installed-build behavior is claimed. Desktop app approval must be resolved by the user before UI acceptance can continue.

## 2026-11-10 REA bounded installation inventory refresh

- Re-ran `inspect_desktop_application` on Navicat Premium 16 with a 1,024-entry limit. Coverage is complete within the scan: 136 entries, 119 files probed, 40,444 bytes read, no probe issues and no generic runtime/framework candidates. Evidence `ev_0f763cdb22296ffa3ada22865e6da91c957eba6cc82be8c2169ded32c2fafca2`.
- Re-ran the same operation on QGIS 3.44.8 with a 2,048-entry limit. It examined 2,048 entries, probed 572 files and read 151,013 bytes, but traversal remains partial at the limit. No generic candidate was identified in the examined portion; this does not establish absence in unvisited paths. Evidence `ev_f361079ca3765064e1d707fd6741c837036b3a4ddc8c66570803045971e58569`.
- The live REA session reports no open native target and no Ghidra binding; `GHIDRA_INSTALL_DIR` is unset. These directory scans do not provide function-level call paths or feature behavior. The Navicat main-window observation and QGIS PE import evidence remain the only direct/reverse-engineering evidence recorded above; UI workflows and function traces remain open.

## 2026-11-10 QGIS complete-view inventory and processing CLI imports

- Located QGIS 3.44.8 at `C:\Program Files\QGIS 3.44.8`; its processing executable is `apps\qgis-ltr\bin\qgis_process.exe`.
- Re-ran REA `inspect_desktop_application` on the install root with a 10,000-entry limit and 2,000,000-byte probe budget. It examined all 8,175 enumerated entries (`complete-within-view`), evidence `ev_603dabc1884b8da7f35ef72a20448a2fc94daa6830450b9389d0170187d54954`. The retained inventory notes a 32 MiB metadata representation budget, so this is complete path enumeration within the view, not exhaustive per-file analysis. REA found no generic framework candidate; that result does not rule out custom, statically linked, or plugin-based frameworks.
- REA parsed the `qgis_process.exe` PE import table completely: 163,328 bytes, 19 DLL descriptors, 378 named imports, and no delay imports. Evidence `ev_fcde44fd02404ab33ccff701ec12add1fb2c826d833493ca68c68f3faa63bb81`. The static imports include QGIS Analysis/Core, GDAL 3.12, PROJ, GEOS, Qt, and the `QgsNativeAlgorithms`, `QgsPdalAlgorithms`, and `Qgs3DAlgorithms` processing-provider classes and methods such as `loadAlgorithms` and `supportedOutputVectorLayerExtensions`.
- These import names establish binary dependencies and class/interface references only. They do not prove that a provider is instantiated, that an algorithm executes, or which driver handles a particular vector conversion. No QGIS project, dataset, database connection, or user profile was opened or changed. SQL editor, result paging, import/export wizard behavior in Navicat and QGIS runtime workflow coverage remain open; Ghidra remains unconfigured.

## 2026-11-10 QGIS Processing runtime observation

- The bare `qgis_process.exe --help` invocation exited with Windows status `0xC0000135` because the installation's DLL search path was not initialized. Reading the installed `bin\qgis-ltr-bin.env` identified the shipped PATH, Python, GDAL, PROJ, and Qt environment. Supplying those values to the child process, setting `QT_QPA_PLATFORM=offscreen`, and using the project-local `QGIS_CUSTOM_CONFIG_PATH` allowed the CLI to run without opening the desktop or using the user's QGIS profile.
- 2026-11-10 `qgis_process --json list` was originally reported as 426 algorithms. A 2026-11-17 recount corrected the parser: provider algorithms are JSON object maps, not arrays; the current count is 438 (3D 13, GDAL 57, Native 316, PDAL 17, QGIS 35; Model and Script 0). The historical 426 value undercounted the 3D provider. The 2026-11-10 raw result remains at `.cache/qgis-process-list-20261110-default.json`, SHA-256 `D6EA8EAB5D308080298C8ACDCA00C1CF6B8002F3551275082D5AFDF4ABE63278`; current isolated runtime summary is `.cache/qgis-process-runtime-20261117.json`.
- `gdal:convertformat` help exposes vector `INPUT`/`OUTPUT`, an optional driver `OPTIONS` string, and `CONVERT_ALL_LAYERS` (default false). `native:reprojectlayer` exposes a target CRS and optional coordinate operation; `native:fixgeometries` exposes a selected repair method. These are direct CLI metadata observations, not UI behavior or guarantees that every output driver preserves every field/geometry.
- Ran `native:reprojectlayer` on a one-feature synthetic GeoJSON point `(127, 37)` explicitly tagged EPSG:4326 and wrote a GeoPackage at EPSG:3857. QGIS returned one feature; the packaged GDAL `ogrinfo` independently read EPSG:3857 and `POINT (14137575.3307457 4439106.78725059)`. Difference from the Web Mercator formula was `4.10e-8 m` in X and `6.52e-9 m` in Y (tolerance `1e-7 m`). Input/output fixtures are under `.cache/qgis-reproject-fixture-20261110.*`; they contain synthetic values only.
- This adds algorithm registry and one real reprojection result to the static inventory evidence. It does not inspect QGIS desktop import/export dialogs, Navicat SQL editor/result paging, or native function call paths; Ghidra remains unconfigured. No local corpus files or database connections were used in this run.

## 2026-11-11 Navicat PE resource evidence

- Opened the installed `navicat.exe` as a shipped-artifact PE with REA; SHA-256 remains `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`. The active session had no native analysis provider: Ghidra was not configured, and native function/string queries were unavailable. The target was closed after analysis.
- REA's offline PE resource parser returned complete coverage of 6,110 directory entries and 3,050 leaf resources. It counted 149 `RT_STRING` resources; read-only decoding of the English-language string tables yielded 1,083 non-empty strings. Terms map to SQL text editing, query creation, file import/export, and database settings. The same resources contain generic framework/component strings, so these are static feature clues only; they do not prove that a specific workflow is reachable or executed.
- Evidence: `ev_b1452b41b5221e37efa1718fab982547a110a9ff83df8d7231d528a280331e0f` (`inspect_pe_resources`, confidence observed, authority shipped-artifact). The full REA evidence session was exported to `.cache/rea-session-evidence-20261111.json` (14 records, 9,775,754 bytes). No profile, connection, database or Navicat setting was opened or changed.
- Design impact: retain SQL text editing and file-based import/export in the implementation scope; validate those workflows against a live Navicat session before treating the static strings as behavior. Result paging, object-tree expansion, and import/export wizard steps remain unobserved.

## 2026-11-11 当前 Navicat 安装身份复核与 QGIS 启动器 PE 复核

- 与本文件较早的已安装记录不一致：当前 `C:\Program Files\PremiumSoft\Navicat Premium 16` 路径不存在，常见 Program Files 安装目录和 Windows 卸载注册表也没有 Navicat 条目。`D:\software\Navicat_115254` 是一个 8 项目录，REA `inspect_desktop_application` 没有识别出运行时组件；目录中实际有 `setup_en_x64.exe`、说明文件和第三方 `Patch` 目录。本轮没有运行安装器、打开 Patch 内容、安装软件或访问其配置。
- REA PE 资源证据 `ev_dec3c9c815a0fe88cc8cb4783cd3665bad30f8f23e4a49daed57625e4ef706e9` 观察到该安装器为 x86 PE，100,704,952 字节，SHA-256 `3555f1f5e3f6b1b87ea517217771eb6053d2fcc6aa956a3707807fc36707d813`，完整读取 48 个资源目录项和 21 个叶资源。Windows 文件版本资源显示 ProductName `Navicat Premium 16`、ProductVersion `16.3.9`；REA 证据 `ev_501b862fd7e8457c416f43345d906a26991f205b8b5871dce79bf8410d56c828` 的 PKCS#7 结构中有 `PremiumSoft CyberTech Limited` 证书主题，但工具未验证密码学签名、证书链、时间戳或 Authenticode 覆盖，因此不能据此确认文件来源或完整性。
- QGIS 启动器 `C:\Program Files\QGIS 3.44.8\bin\qgis-ltr-bin.exe` 的 REA PE import 证据 `ev_f5a5703eff6bee77f53616c9bf681d64dcdb711417a213e3b1b8db1c57816bf9` 完整解析 13 个 DLL 描述符和 149 个导入，文件 177,152 字节、x64。它直接导入 Windows 启动/错误处理、MSVC Runtime 和 CRT；QGIS 核心、Qt、GDAL、PROJ、GEOS 的组件证据应以 `qgis_process.exe` 与 `qgis_core.dll` 的既有导入记录为准。启动器自身导入表不能证明桌面工作流或实际模块加载顺序。
- 本次静态 QGIS 启动器资源证据 `ev_d987f53c4c5d00054d2b197702fc78c30739cf88a7defbc058e6b94f5aad26dd` 覆盖 21 个资源目录项与 9 个资源，未提供可直接使用的版本资源解析结果；安装目录名及之前的 `qgis_process --json list` 运行输出仍是版本 `3.44.8-Solothurn` 的较强证据。REA QGIS 根目录扫描因 200 项上限而为 partial，不能据此声称完整安装清单。
- 研究边界：截至该次短时观察，Navicat 路径缺席使 SQL 编辑器、结果分页和向导等运行时研究无法继续；稍后的“Navicat 当前安装恢复核验”记录了安装路径重新出现，但窗口激活仍失败。此前 Navicat 主窗口截图、QGIS Processing CLI 算法登记和合成重投影仍有效。QGIS 启动器静态依赖分析只补充 PE 边界，不代替 QGIS 桌面 UI 或用户数据工作流观察。

## 2026-11-11 Navicat 当前安装恢复核验

- 当前文件系统中 `C:\Program Files\PremiumSoft\Navicat Premium 16\navicat.exe` 重新可见，文件 SHA-256 为 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`，与历史 16.3.9.0 安装记录一致；此观察更新并取代上一节“当前常见安装路径不存在”的短时状态。REA `inspect_desktop_application` 对此目录重新扫描 136 项，覆盖在扫描预算内完整，Evidence `ev_b5ffc6a3f42019d85459dda0f07f64d4717284ac87b41a006b95ab339f729341`。
- REA 当前重解析 `navicat.exe` import table：54 个 DLL 描述符、1,569 个导入、46 个 delay-load 导入（`ev_c450147203fbf8e0a05733104da934f19d0a591ad1d6d133edc60b1e59104d4c`）；PE resource table 为 6,110 个目录项、3,050 个叶资源（`ev_8f9232f79401563944282302373e5a75fe4f5f5edb5ef67a3064e32b68229d9e`）。哈希与 2026-11-09/11 的记录相同，资源表和目录枚举未显示当前 UI 交互。
- `Navicat Premium 16` 启动后窗口已由 Computer Use 列出，但两次重新枚举和激活都返回 `failed to activate captured window`；按技能恢复规则停止继续 UI 操作。未打开连接、SQL 编辑器或导入向导，也未读取保存密码。SQL 编辑、结果分页和向导运行时研究仍待窗口可捕获时补充。

## 2026-11-11 Navicat UI activation retry

- `@oai/sky` 当前应用枚举确认 `Navicat Premium 16` 可启动，进程窗口为 `Navicat Premium`；激活失败后重新枚举并按返回的最新 window/app 标识重试，仍返回 `failed to activate captured window`。遵循恢复规则停止桌面输入；没有打开数据库连接、SQL 编辑器或导入向导，也没有读取 Navicat 配置。
- 本轮不能新增 Navicat 工作流行为证据。已有静态 PE 资源/导入证据和旧主窗口截图仍不证明结果分页、对象树展开或导入导出向导的交互；需要可用的窗口捕获后再观察。

## 2026-11-11 Navicat PE resource type inventory

- 针对已核对哈希 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4` 的 `navicat.exe`，REA `inspect_pe_resources` 完整检查 6,110 个资源目录项、3,050 个资源。类型计数为 RT_CURSOR 58、RT_BITMAP 859、RT_ICON 108、RT_DIALOG 2、RT_STRING 149、RT_RCDATA 1,755、RT_GROUP_CURSOR 58、RT_GROUP_ICON 52、RT_VERSION 1、RT_MANIFEST 1。Evidence `ev_8f9232f79401563944282302373e5a75fe4f5f5edb5ef67a3064e32b68229d9e`。
- 这是静态 PE 资源清单；RCDATA 等资源载荷、语言回退、图标解码和窗口加载时机未由本次分析观察。它补充了资源数量，不改变对 SQL 编辑、结果分页、对象树展开或导入导出向导尚缺运行时行为证据的判断。

## 2026-11-12 Navicat/QGIS 安装身份与 REA Provider 复核

- Windows 开始菜单当前登记 `Navicat Premium 16` 和 `QGIS Desktop 3.44.8`。Navicat 安装路径为 `C:\Program Files\PremiumSoft\Navicat Premium 16`；QGIS 路径为 `C:\Program Files\QGIS 3.44.8`。本次只读取应用登记、文件元数据和 PE 文件身份，不访问数据库连接、密码或用户配置。
- REA 对 Navicat 目录检查 136 项，其中 119 个文件进行了有界探测，读取 40,444 字节；扫描范围内完整，没有 generic framework 候选，但这不表示不存在定制或静态链接框架。Evidence `ev_4be4ba0fc774844821473f816401289f95d246d754bb83e73add90303875ab74`。`navicat.exe` 当前 SHA-256 为 `2a52a1519c75844fc1bd7d19326ee1b6c7fb847564bbb832124340559734aac4`，与 2026-11-09 至 11-11 的安装身份一致。
- REA 对 QGIS 根目录枚举 8,175 项、探测 706 个文件并读取 183,876 字节；目录元数据达到 32 MiB 表示预算，文件探测覆盖为 partial，不能把剩余项解释为不存在。Evidence `ev_246aad8b7ad6838a39a1fad5da8334a8403f4cb2d55f06819d1a755cfb3462df`。此前 QGIS Processing CLI 的 426 个算法和合成 EPSG:4326→3857 重投影结果仍是 QGIS 功能验证的强证据；安装包目录/PE 扫描不补足桌面交互证据。
- 当前 REA `binary_session` 无活动 target。Windows x64 的 Ghidra Provider 因 `GHIDRA_INSTALL_DIR` 未配置而 unavailable；Hopper 不支持 Windows；IDA 和 Kuna 也未配置，且 Kuna 当前不接收 PE。于是本轮未取得 Navicat 函数调用路径或伪代码。不能用导入表/资源字符串替代实际 UI 行为证据。
- 本轮没有启动 Navicat 或 QGIS，不访问其用户数据。Navicat SQL 编辑器、对象树展开、结果分页和导入/导出向导仍缺当前运行时验证；QGIS 桌面导入/导出面板仍缺 UI 交互观察。已有 2026-10-30 Navicat 主窗口观察、QGIS Processing CLI 注册和真实合成重投影证据保持有效，但各自覆盖边界不变。

## 2026-11-12 REA 静态依赖复核

- 重新使用 REA `inspect_desktop_application` 检查 Navicat 安装目录，扫描范围内 136/136 项，未见扫描问题；Evidence `ev_c1ddb1f76b2db7f23e44d554b288a6b19c6246d0202a2ae049edf34be9bdeac5`。重新检查 QGIS 安装目录，枚举 8,175 项并探测 706 个文件；32 MiB 元数据预算使文件覆盖仍为 partial，Evidence `ev_6443296f912f209f3f17c26f88b3800c75944a16e6ddfc7e4d8291e908c59a87`。
- Navicat `navicat.exe` SHA-256 仍为 `2a52a1519c75844fc1bd7d19326ee1b6c7fb847564bbb832124340559734aac4`。REA PE import 扫描完整覆盖 54 个 DLL 描述符、1,569 个导入和 46 个 delay-load 导入，Evidence `ev_35394a5becc20b8ca734c142bcd9532e5d1893557f4ae97d88c8b5958d3f1055`；这些是静态目录条目，不证明导入已绑定或功能执行。
- QGIS 3.44.8 `qgis_process.exe` 完整列出 19 个 DLL、378 个导入；其静态依赖包含 QGIS Analysis/Core、GDAL 3.12、PROJ 9、GEOS C 和 Qt，Evidence `ev_fdfbeb7c9c419c00e4979748f1ec12892c7ebdb2b8642df2c5bed9885744deff`。`qgis_core.dll` 完整列出 49 个 DLL、4,550 个导入，包含 GDAL、PROJ、GEOS、SpatiaLite、SpatialIndex、PDAL 和 Qt，Evidence `ev_89aa8927e3d080f21f3bdb995c1f8ddd5c419e944d8ee9b71bb3bff170497a55`。PE imports 只能支持组件边界观察，不能推出特定菜单或处理流程调用了这些接口。
- REA `binary_session` 显示当前无活动 target；本机 Ghidra Provider 仍因未配置 `GHIDRA_INSTALL_DIR` 而不可用。没有取得函数级调用路径或伪代码。本轮未启动 Navicat/QGIS，没有接触数据库凭据或连接；运行时 UI/工作流未知项保持开放。

## 2026-11-12 QGIS Processing 本机文件转换复核

- 使用已安装 QGIS 3.44.8 的隔离环境运行 `qgis_process`，`QT_QPA_PLATFORM=offscreen`，并将 `QGIS_CUSTOM_CONFIG_PATH` 指向项目 `.cache`；未打开用户 QGIS 配置或桌面 UI。`gdal:convertformat` 的运行时帮助显示 `INPUT`/`OUTPUT`、可选 GDAL 创建 `OPTIONS` 与 `CONVERT_ALL_LAYERS` 参数，provider 为 GDAL 3.12.2。
- 以默认源编码行为分别把无 `.cpg` 的 `F:\temp\广绵扩容施工图路线(全线棒棒线)\广绵扩容施工图路线(全线棒棒线)2.shp` 和 `...1.shp` 输出到项目 `.cache/qgis-dbf-nul-output-20261112`。QGIS 和独立 `ogrinfo` 均成功；导出计数 5,431 与 5,300 分别匹配已审计源计数。
- DB Studio 静态 GDAL runtime 与 QGIS runtime 均报告 GDAL 3.12.2，但这是版本相同，不证明构建配置、驱动行为完全相同。计数只证明这两个 QGIS Processing 转换可完成，不证明属性值语义无损；第二个文件仍标记 `ascii-compatible`，第一个含高位字节并保留 `unknown`。未比较私有属性原文或推断源编码。
- 机器摘要 `.cache/qgis-dbf-nul-gdal-runtime-20261112.json` 仅记录版本、路径分类、计数和隔离标志；两个 GeoPackage 留在 `.cache/qgis-dbf-nul-output-20261112` 供后续对照。源文件未修改，无外部数据发送。
- 同步复核 REA `binary_session`：无活动 target；Windows x64 Ghidra 因 `GHIDRA_INSTALL_DIR` 未设置不可用，Hopper 不支持 Windows，IDA MCP 和 Kuna 未配置。以上 QGIS CLI 运行是独立运行证据，不替代 REA 函数调用路径或桌面 UI 证据。Navicat SQL 编辑器、结果分页和导入/导出向导，以及 QGIS 桌面交互仍未知。

## 2026-11-13 QGIS Processing PE evidence refresh

- REA `inspect_pe_imports` re-read the installed `C:\Program Files\QGIS 3.44.8\apps\qgis-ltr\bin\qgis_process.exe`: SHA-256 `554a4be89913535c2fa512851d483338cdde454bc7ad2526dade95aa00763920`, x64 PE32+, 19 import DLL descriptors and 378 functions; no delay imports. Evidence `ev_206cced8c35452f0be6d2cda33355143aea5d74cf613623d00264f05352f4702`.
- Static imports include QGIS Analysis/Core, GDAL 3.12, PROJ 9, GEOS C, Qt 5 and MSVC runtime modules. This is current binary dependency evidence only; it does not establish reachability or prove which processing workflow calls a specific function. Ghidra is still unconfigured, and Navicat/QGIS desktop workflow observations remain separate open items.

## 2026-11-13 REA live identity and provider recheck

- 只读复核 Navicat `navicat.exe`：版本 `16.3.9.0` / 产品版本 `16.3`，63,989,032 字节，SHA-256 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`。REA 对安装目录的本次摘要视图显示扫描范围 136/136 项已检查，Evidence `ev_108077084e96ecedb423a17182494bcf8de9cd3f028d1536e0fcf0916608e629`；该目录摘要不提供新的工作流行为证据。
- QGIS 根目录本次使用 1,200 项 `max_entries` 上限做有界检查，Evidence `ev_d22261781504c0bca449bf5b35556cdeb3283d1a9ed79ed9100551d1dfe3cb61`。本视图只覆盖所选条目预算，不能据此声称 8,175 项安装目录已完整扫描；既有 32 MiB 限制的完整度说明继续适用。
- 当前 REA `binary_session` 返回无活动 target、无 cleanup pending。其 Windows 主机 provider 清单仍没有可用的 PE 深度反汇编器；REA safe artifact graph 与 .NET 静态元数据能力可用，native macOS 分析能力因主机平台不可用。未取得 Navicat 函数级调用路径，也没有操作 Navicat/QGIS 窗口、连接或配置。
- 因而当前 Navicat 对象树、SQL 编辑器、结果分页和导入/导出向导的精确交互，以及 QGIS 桌面导入/导出面板，仍属于未观察项；此前 QGIS Processing CLI 运行证据不替代这些 UI 工作流。

## 2026-11-17 Navicat/QGIS REA inventory and QGIS runtime refresh

- REA `inspect_desktop_application` rechecked the current Navicat directory: 136/136 entries within the 200-entry budget, 119 files probed, 40,444 bytes read, no probe issues. `navicat.exe` remains 63,989,032 bytes with SHA-256 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`; current Windows ProductVersion metadata is `16.3` (the prior PE/version evidence identifies the 16.3.9 release). Evidence `ev_ed38435fd225048fe087763ea5a37d647c2804008327155db661dae931e5fddd`.
- The first REA QGIS inventory reached its explicit 1,200-entry cap: 572 files probed and 151,013 bytes read. Its coverage was partial; unvisited paths remained unknown. Evidence `ev_9a2f0938912ee6f15f192a059d4c3cd0caa1913c487f668023c08e8596c5bbbe`. The targeted `qgis_process.exe` remains 163,328 bytes, SHA-256 `554A4BE89913535C2FA512851D483338CDDE454BC7AD2526DADE95AA00763920`.
- With `QGIS_CUSTOM_CONFIG_PATH` isolated under project `.cache` and `QT_QPA_PLATFORM=offscreen`, QGIS Process reports QGIS 3.44.8-Solothurn revision `d25052deb8b`, GDAL 3.12.2, PROJ 9.8.0, GEOS 3.14.1 and 438 registered algorithms. The corrected count is a parser correction, not an algorithm addition. No QGIS or Navicat UI, profile, saved connection or database was opened. See [sanitized REA inventory](../.cache/rea-navicat-qgis-inventory-20261117.json) and [runtime summary](../.cache/qgis-process-runtime-20261117.json).

### 2026-11-17 expanded QGIS inventory

- A second read-only REA inventory used a 10,000-entry limit and enumerated all 8,175 entries in the current directory view. Its directory-view coverage is `complete-within-view`; directory digest is `14a575e9dc19391c2aac429c0897f2df5d24df7cb73a9cc9f7757d3c9322e0e2`. Summary Evidence is `ev_41d51bc173d408ee08a7c1cd3e203b015877eb1a9fc50cac3f6f29dd6ef2374e`, parent Evidence is `ev_822139ae7e38fb7950d8f049d3cb53d5c2862777481b7e51b33182f4a7fbce6e`.
- Source/file coverage remains partial: 706 files were probed and 183,876 bytes read before the 32 MiB representation budget; there were no probe issues. Child symlinks were not followed, special payloads were not read, and unread file bytes remain unknown. This supersedes the earlier 1,200-entry limit for directory enumeration only; it does not claim a complete content inventory or QGIS desktop workflow coverage.
- The sanitized inventory retains both snapshots and their separate coverage claims. No QGIS or Navicat UI, profile, saved connection or database was opened.

### 2026-11-17 Navicat manual and QGIS provider review

- Read the locally installed Navicat 16 PDF manual at `C:\Program Files\PremiumSoft\Navicat Premium 16\navicat.pdf`. Its contents list connection/object browsing, data viewing, SQL queries, data models, import/export, data transfer and synchronization, charts/dashboards, automation, backup/restore and server security. Some chapters carry edition restrictions. This is documented product scope, not proof that the local license enables every feature; no connection or saved profile was opened.
- The current bounded Navicat file inventory includes client components named `libpq.dll`, `libmariadb.dll`, `oci.dll`, `sqlite3.dll`, `mongoc-1.0.dll`, `bson-1.0.dll` and Redis libraries, plus `navicat.pdf`. File-view evidence: `ev_a8616412bca3308fe94c7a1d6c02a3edb4322ec56c54a19172074ab37c3d7f3a` and `ev_269216165ddd8cad37177c16a440444641908e0da865e92c6155dae7e0667339`. These filenames show shipped components only; they do not prove the corresponding provider is loaded or a workflow succeeds.
- The bounded QGIS app-directory inventory records provider paths for PostgreSQL, PostgreSQL raster, MSSQL, Oracle, SpatiaLite, HANA, GPX, delimited text, virtual layers/raster, WMS, WFS, WCS, ArcGIS, PDAL and GRASS. Evidence `ev_94c07a4d5b13269e876e1490eb66e39acc7f849ccda9219d926090e5f1cc1ade` covers the selected app-directory view; source/file coverage remains partial under the 32 MiB representation budget. A provider DLL path is package evidence only, not execution evidence.
- The official [QGIS 3.44 data-source documentation](https://docs.qgis.org/3.44/en/docs/user_manual/managing_data_source/opening_data.html) says DB Manager can connect to databases, browse structures, preview tables, add layers, and run SQL; it names PostgreSQL, SpatiaLite, GeoPackage, Oracle Spatial, MS SQL Server and virtual layers. The [supported-data guide](https://docs.qgis.org/3.44/en/docs/user_manual/managing_data_source/supported_data.html) describes PostgreSQL types, import paths and server-side filtering. These documents support the workflow boundary, not claims about DB Studio.
- Design consequence: keep relational browsing, SQL and common interchange at the center; make the requested file-format/PostGIS round trips reliable; add only GIS providers with explicit product demand and test coverage. Do not expand toward full QGIS service/provider parity or copy its UI/code. Runtime distribution and license review remain separate.

### 2026-11-18 focused Navicat/QGIS dependency recheck

- REA parsed the installed QGIS 3.44.8 `qgis_core.dll` PE import table completely (49 DLL descriptors, 4,550 imports). It declares imports from Qt 5, `gdal312.dll`, `proj_9.dll`, `geos_c.dll`, SQLite, SpatiaLite and spatialindex. The bundled `gdal312.dll` import table also parsed completely (57 DLL descriptors, 2,352 imports), including PROJ, GEOS, PostgreSQL `libpq`, MySQL `libmysql`, ODBC, SQLite and SpatiaLite. This supports the observed QGIS/GDAL/PROJ integration boundary; static imports do not prove which providers are loaded for any particular workflow. Evidence: `ev_2ca8d9020c36a597367d3b2a0c2a0542e5dba92340246bfd24891a9d00cfb968`, `ev_861e66b1aa13bc121ba4ef1005097c506004c00c8ddf1de8d6dfcf8c3e591fed`, and `ev_648b0442d97962f21942c7ed15499f9efa9d8087c3fdbd6c90b4586d7e389877`.
- REA also parsed the installed Navicat 16.3.9 x64 executable completely (54 DLL descriptors, 1,569 imports and 46 delay-load imports). Targeted client-library imports show `libpq.dll` depending on OpenSSL 1.1, `mongoc-1.0.dll` depending on BSON and OpenSSL, and Oracle `oci.dll` depending on the VC 2005 runtime. The installation inventory separately contains `libmariadb.dll`, `sqlite3.dll`, and the Oracle Instant Client. These are shipped-component and import-table observations, not proof of runtime loading, feature availability under the local license, or successful database workflows. Evidence: `ev_dd7e661ca0635852911ddc98ae055d76dc02c3fa2c07c50adc2e3ce87504233e`, `ev_4661510841b6e4116cf7a1b12dbc66e327e3fed7585e33ad1775b71285164366`, `ev_c27faf1551eee1f23d48da1b28d1d9cfd44b7e751e5a08de9abc10b31e17c851`, `ev_43abc159e052ce17cba098a159d76c4d06b7194836e464bbe398266670631e97`, and `ev_40fb0205aab815b4816037bda260ec12551a8716666dbd8a214b695a94a7cb2b`.
- Design consequence remains to keep DB Studio's database adapters, GDAL/OGR file engine, and PROJ CRS transforms as separate reusable layers. The installed QGIS dependency chain is a compatibility reference; DB Studio does not load or redistribute QGIS components.

## 2026-11-20 Navicat desktop observation boundary

- Launched the registered Navicat Premium 16 application from its Windows app identity. Windows resolved it to `C:\Program Files\PremiumSoft\Navicat Premium 16\navicat.exe`; the local file is 63,989,032 bytes, version `16.3.9.0`, SHA-256 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`, matching the previously examined executable.
- The first accessibility snapshot landed on a connection-configuration view and exposed a saved credential field. This crossed the project boundary against reading stored database passwords. I did not copy the field value into any file or command, use it, transmit it, or attempt to connect. I closed Navicat immediately; the window is no longer present. No configuration change was made.
- No new Navicat workflow behavior is claimed. The existing read-only main-window observation and static REA evidence remain the usable research record. Further Navicat UI inspection should use an isolated blank profile or another method that cannot surface saved credentials.

## 2026-11-21 Navicat static evidence refresh

- Rechecked the installed `navicat.exe`: 63,989,032 bytes, PE32+ amd64, SHA-256 `2A52A1519C75844FC1BD7D19326EE1B6C7FB847564BBB832124340559734AAC4`. REA parsed the import directories completely (54 DLL descriptors, 1,569 imports, 46 delay imports; Evidence `ev_a44247e31312680509ecaf2cb939730abe11f76c865b49f57b152ee81f3b39d0`) and the resource directory completely (6,110 directory entries, 3,050 resources; Evidence `ev_8f9232f79401563944282302373e5a75fe4f5f5edb5ef67a3064e32b68229d9e`). Non-icon resource payloads remain opaque; imports/resources do not prove a workflow is reachable or executed.
- Native export inventory is complete for the image and contains two entries, with no parse issues (parent Evidence `ev_b82644891bc28ff6ce87312c852b20b0a62201ddebb36fe758c098d50a08c770`). The bounded installation scan covers 136 entries, probes 119 files, and reads 40,444 bytes; it found no generic framework candidates (Evidence `ev_b57906dff0d0b0d5283b6b10e7501cca83a8c45c9097da212ef92ceb7909b2e9`).
- Function-level analysis remains unavailable on this host: Ghidra is not configured, Hopper is unsupported on Windows, IDA and Kuna are not configured, and REA could not launch its configured GNU `objdump` command (`ERR_REA_WINDOWS_NATIVE`). The header, section, and symbol queries failed before inspection, and no disassembly was collected. No Navicat code was executed, no saved profile or database was accessed, and no feature behavior is inferred from these inventories.
- Machine summary: [Navicat static inventory](../.cache/rea-navicat-static-inventory-20261121.json). The earlier [function probe](../.cache/rea-navicat-function-probe-20261121.json) remains blocked until a compatible deep-analysis provider is available.

## 2026-11-21 REA capability recheck

- Read the current REA binary-session capability inventory without opening a target. On this Windows host it exposes the safe artifact graph provider and .NET static metadata analysis; native macOS operations are unsupported, and no Windows native procedure/disassembly provider is available. No Navicat or QGIS executable was opened in this check. Navicat function-level behavior research therefore remains pending a compatible native analysis provider.
