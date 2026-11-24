# 对象树 Navicat 风格改造（2026-11-24）

## 参考依据

用户提供的 Navicat 对象树截图显示：服务器 → localhost → 数据库 → Schema(public) → **Tables 分组** → 表 → 表下可展开 Fields / Indexes / Foreign Keys / Uniques / Checks / Rules / Triggers；选中行整行浅蓝高亮；行高约 18px；缩进约 16px；类型化图标。

REA 研究见 `.cache/navicat-context-menu-research.md`（RT_MENU 不存在，菜单运行时构造；手册截图中的弹出菜单无逐项图标、分隔线分组）。

## 实施（编译产物层）

由于 `apps/desktop/src` 与 `apps/desktop/electron` 源码目录在本会话中意外丢失（见 `docs/incident-source-loss-20261124.md`），本次改动直接作用于已构建的编译产物：

- `apps/desktop/dist/renderer/assets/index-*.css` 末尾追加 Navicat 风格规则：
  - 树节点行高 20px、字体 11px、缩进 12px
  - hover 浅蓝 `#eaf4fb`、选中整行 `#cce8ff` + 蓝边 + 深蓝字
  - 数据库绿 / Schema 灰蓝 / 表蓝色图标
- `apps/desktop/dist/renderer/assets/DatabaseObjectTree-BUT6wZ0A.js`：
  - 注入 `navicatTransform`，把每个 Schema 下的表包进 `Tables` 分组节点
  - 每个表节点添加 7 个只读子节点（Fields / Indexes / Foreign Keys / Uniques / Checks / Rules / Triggers），`selectable:false; disabled:true`，仅作为视觉层级展示，避免误导为可操作功能
  - 保留原有右键菜单与双击载入 SQL 行为

## 验证

- CDP 禁用缓存后重载：树中出现 `Tables` 分组节点，标题序列 `PostgreSQL / PostGIS, ai_rag_acceptance_20261102, ogr_system_tables, public, Tables, tiger, topology`
- 行高 20px；选中行样式已写入 CSS
- 重建 MSI（199,050,037 字节）并安装；桌面「DB Studio 最新版」快捷方式指向 `release-static-gdal-geos-msi-navicat-tree-20261124/win-unpacked/DB Studio.exe`

## 注意

- 这种直接改编译产物的方式脆弱：一旦源码恢复并重新 `pnpm build`，上述补丁会被覆盖，需要在源码中重新实现。
- 表下的 7 个子节点是视觉占位，不提供真实字段/索引数据；如需真实展示，须在源码恢复后实现懒加载列/索引元数据。
