# 对象树右键菜单改造（2026-11-24）

## 问题

原对象树在每个表节点行内平铺 5~6 个 20px 小按钮（查询前100条/导入/导出/传输/编辑/查看字段），在窄侧栏里挤成一排、视觉噪音大且容易误点。

## REA 参考 Navicat 的结论

- REA `inspect_pe_resources` 对 `navicat.exe` 完整枚举 3050 个资源：**没有 RT_MENU 资源**——Qt 应用运行时构造菜单，故不能从 PE 资源直接拿到菜单定义（证据 `ev_8950c7c7bd5b182cf6e933e3bb860bee1d8a47f692b11b4fca020a733190e594`）。
- 手册截图实际拍到的是列头/透视表弹出菜单（PDF p.217–220、p.107）：**无逐项图标**，约 165px 宽、24px 行高，分隔线分组，破坏性动作在末尾，需输入的项以 `…` 结尾；当前项整行蓝色高亮。手册正文提取出 207 条右键/弹窗词汇。
- 详见 `.cache/navicat-context-menu-research.md`。注意：手册中没有对象树右键菜单的展开态截图，节点菜单顺序属于基于词汇与截图模式的设计提案，不是 Navicat 实测顺序。

## 实施

- `DatabaseObjectTree.tsx`：新增 `getContextMenuItems` 回调属性，用 antd `Dropdown trigger={["contextMenu"]}` 包裹每个节点的标题；`titleRender` 兼容 `title` 为函数的情况。行内按钮全部移除，`tree-node-title` 占满整行。
- `App.tsx`：`getTreeNodeMenuItems(node)` 按节点 key 区分连接 / Schema / 表，返回三类短菜单：
  - 连接：新建 SQL 查询 / 搜索数据库对象… / 测试连接 / — / 刷新 / 删除连接…
  - Schema：从文件新建表… / — / 刷新
  - 表：查询前 100 条 / 编辑表数据… / 查看字段… / — / 导入 CSV/JSON/Excel… / 导出… / 传输到其他连接… / — / 刷新
- 菜单样式对齐 Navicat：无逐项图标、`…` 表示打开对话框、分隔线分组、删除项红色置底、圆角与轻阴影。
- 双击表节点仍保留"载入前 100 条 SQL"的快捷行为（与 Navicat 的 Open Table 独立 affordance 一致）。

## 验证

- CDP：对象树内行内按钮数为 0；连接节点右键显示 5 项菜单；Schema 节点右键显示 2 项；表节点右键显示 7 项，文案与分组正确。
- `pnpm test` 442 通过 / 6 跳过、`typecheck`、`build` 通过。
- 重建 MSI（199,062,325 字节，`app.asar` 哈希 `52C1C4DA8E971766F3655C1F157D53925CF2FE83012C239FDA8D21BDD69DB757`）并安装，桌面「DB Studio 最新版」快捷方式已指向该 exe。
