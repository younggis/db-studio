# 编译产物补丁 SOP（过渡期）

> 适用范围：`apps/desktop/src`、`apps/desktop/electron` 缺失期间，对 `apps/desktop/dist` 编译产物做 UI 修补。
> 失效条件：源码恢复并完成补丁回写后，本 SOP 作废，所有改动必须通过源码 + `pnpm build` 落地。

## 原则

1. **优先 CSS**。能靠 CSS 解决的（颜色、行高、缩进、对齐、隐藏元素）不改 JS。
2. **JS 只追加，不改写 JSX**。压缩后的 JSX 括号极难安全改写；此前直接包裹 `Dropdown` 导致 `SyntaxError: Unexpected token '}'` 与页面白屏。
3. **不碰闭包内部符号**。需要触发原组件行为时，用 DOM 查询调用已有按钮的 `.click()`，而不是复制闭包逻辑。
4. **每步可回滚**。修改前保存原件与校验和。

## 流程

### 1. 备份

```powershell
$assets = "apps\desktop\dist\renderer\assets"
Copy-Item "$assets\App-*.js" ".cache\patch-backup\App-D3avBeWb.js.bak" -Force
Copy-Item "$assets\index-*.css" ".cache\patch-backup\index.css.bak" -Force
Get-FileHash "$assets\App-*.js" | Select-Object Hash
```

asar 备份（若需重装到已打包版本）：

```powershell
$asarCli = "node_modules\.pnpm\@electron+asar@3.4.1\node_modules\@electron\asar\bin\asar.js"
node $asarCli extract apps\desktop\release-*\win-unpacked\resources\app.asar .cache\asar-backup
```

### 2. 修改

- 用独立 `.mjs` 脚本做精确 `replace`，脚本存 `.cache/`，不入库。
- JS 补丁在文件末尾追加（ESM 顶层语句），格式：

```js
/* patchName YYYY-MM-DD - short description */
(function () {
  if (window.__patchInstalled) return;
  window.__patchInstalled = true;
  // ...
})();
```

- CSS 补丁在文件末尾追加带标记的注释块，便于后续删除。

### 3. 静态验证（必须）

```powershell
node --check apps\desktop\dist\renderer\assets\App-*.js
```

输出中不能出现 `SyntaxError`。注意 PowerShell 会把压缩单行文件整个打印出来，用 `Select-String -Pattern 'SyntaxError|Unexpected'` 过滤。

### 4. asar 内容断言（打包后）

```powershell
$asarCli = "node_modules\.pnpm\@electron+asar@3.4.1\node_modules\@electron\asar\bin\asar.js"
node $asarCli extract <新的 app.asar> .cache\asar-verify
Select-String -Path .cache\asar-verify\dist\renderer\assets\App-*.js -Pattern 'patchName' -SimpleMatch
```

四项 UI 补丁的断言标记：
- `icon alignment fix`（CSS）
- `navicat tree patch`（CSS）/ `navicatTransform`（JS）
- `connection right-click menu`（CSS）/ `connContextMenuSafe`（JS）

### 5. CDP 冒烟（必须）

启动带 Inspector 的 Electron 运行时：

```powershell
$exe = (Resolve-Path ".cache\electron-rea-dev-runtime-20261117\electron.exe").Path
Start-Process $exe -ArgumentList "--remote-debugging-port=9222","--window-size=1600,1000","."
```

用 CDP 检查：
- `document.querySelectorAll('.connection-card').length > 0`（页面渲染成功）
- 右键连接卡片 → `.conn-ctx-menu` 可见且含 3 项
- 对象树 `.ant-tree-iconEle` 与 `.tree-node-title` 的 y 差 ≤ 2px
- 无 console error

### 6. 构建与安装

```powershell
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*electron*" } | Stop-Process -Force
pnpm --filter @db-studio/desktop exec electron-builder --win msi --config electron-builder.<new>.cjs
```

构建到**新输出目录**，保留上一版作为回退。安装后更新桌面快捷方式。

## 故障处理

| 现象 | 处理 |
|---|---|
| `node --check` 报 `Unexpected token '}'` | 立即从备份恢复，不要用「再补一个括号」的方式硬修 |
| CDP 显示 `cards: 0` / 页面空白 | 同上，恢复后重做；不要继续安装 |
| 修改后界面无变化 | CDP 用 `Network.setCacheDisabled` + `Page.reload({ignoreCache:true})` 排除缓存 |
| asar 内容断言失败 | 检查 electron-builder 配置是否从正确 dist 打包（asar integrity 会使手工改 asar 失效，必须重新构建） |
