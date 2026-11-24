# GUI 演示数据说明（2026-11-23）

已在本机桌面应用的默认用户目录写入 7 个数据库连接与查询历史/收藏，并重建安装当前源码 MSI（安装后 `app.asar` 哈希与构建载荷一致：`97CF6C3D9AB215737479086CB94ABADA5EEA25B5061E171D1F01CA0D62FF0AB6`）。

## 打开方式

直接启动已安装的 `DB Studio`（`C:\Users\young\AppData\Local\Programs\@db-studiodesktop\DB Studio.exe`）。左侧「连接」栏会列出以下 7 项；点击任一连接即可查看对象树并执行 SQL。

## 连接与演示数据

| 序号 | 连接名称 | 引擎 | 地址 | 可执行查询返回 |
|---|---|---|---|---|
| ① | PostgreSQL / PostGIS | postgres | 127.0.0.1:25432 | `SELECT id, name, note FROM public.dbstudio_demo ORDER BY id` → 3 行（成都/绵阳/重庆） |
| ② | MySQL 8.4 | mysql | 127.0.0.1:23306 | `SELECT id, name, note FROM dbstudio_demo ORDER BY id` → 3 行 |
| ③ | MariaDB 11.4 | mariadb | 127.0.0.1:23307 | 同上 → 3 行 |
| ④ | SQL Server 2022 | sqlserver | 127.0.0.1:21433 | `SELECT id, name, note FROM dbo.dbstudio_demo ORDER BY id` → 3 行 |
| ⑤ | Oracle 26ai Free | oracle | 127.0.0.1:21521/FREEPDB1 | `SELECT id, name, note FROM dbstudio_demo ORDER BY id` → 3 行（大写列名） |
| ⑥ | MongoDB 7 | mongodb | 127.0.0.1:27018 | 集合 `dbstudio_demo` 含 3 个文档 |
| ⑦ | SQLite（本地文件） | sqlite | `.cache/demo-databases/demo.sqlite` | `SELECT id, name FROM cities ORDER BY id` → 3 行；另有 `employees` 表 4 行 |

## 查询历史与收藏

点击顶部「历史」抽屉：

- 历史：6 条（6 个 SQL 引擎各一条），outcome=success、rowCount=3
- 收藏：6 条（SQL 引擎），标题格式「<连接名> · 演示查询」
- MongoDB 查询请在 MongoDB 页面的文档查询区进行；它不是 SQL，未放入 SQL 编辑器历史，避免误在其它连接执行报 ORA-00900。所有历史 SQL 末尾已去掉分号，Oracle 可直接执行。

点击任一历史/收藏可载入 SQL 编辑器；SQL 引擎的查询均已在应用 IPC 层实测返回 3 行中文数据。

## 验证记录

通过应用自身的 CDP 回放（当前源码构建 + 同一用户目录）确认：

- `connections:list` 返回 7 项，侧边栏 ①–⑦ 全部可见
- `connections:test` 对 7 项全部成功，返回各库版本（PG 16.15 / MySQL 8.4.13 / MariaDB 11.4.13 / SQL Server 16.0.4305.5 / Oracle 23.0.0.0.0 / MongoDB 7.0.45 / SQLite 3.53.4）
- `database:query` 对 6 个 SQL 引擎均返回 3 行正确中文数据；`mongo:find` 返回 3 个文档
- `query-history:list` 返回 6 条历史、6 条收藏；Oracle 历史 SQL 经 IPC 执行返回 3 行（ID=1 成都）

原始用户配置已备份至 `.cache/userdata-backup-20261123/`（connections.enc、query-history.enc）。

## 说明

连接密码由 Windows DPAPI 以当前用户身份加密保存，格式与桌面应用自身写入的完全一致（相同头部与加密方式），因此安装版可直接读取。MongoDB 使用 root 账号 URI；SQLite 指向本地演示文件。
