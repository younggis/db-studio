# 发布形态策略（2026-11-25）

> 依据优化规划阶段 5.3「安装形态收敛」。

## 唯一发布形态：MSI

- 发布说明、README、快捷方式目标只引用 `release-static-gdal-geos-msi-*` 目录下的 `.msi`。
- 历史 NSIS 配置（8 个 `electron-builder.*nsis*.cjs`）已归档到 `apps/desktop/archived-nsis-configs/`，不再参与构建。
- 原因：NSIS 在本环境出现「无效的系统 DLL 重定位」且无法完成安装版 GUI 验收；MSI 已成功安装并通过 CDP 冒烟。

## 当前发布产物

| 项 | 值 |
|---|---|
| 最新 MSI | `apps/desktop/release-static-gdal-geos-msi-connmenu-20261124/DB Studio 0.1.0.msi`（199,050,037 字节） |
| 桌面快捷方式 | `DB Studio 最新版.lnk` → 上述目录的 `win-unpacked/DB Studio.exe` |
| CI | `.github/workflows/ci.yml`：verify + integration；发布构建与测试分离 |

## 仍需外部条件（不在本仓库内完成）

- **5.1 GDAL 裁剪**：需重建随包运行时并跑全量 GIS 集成，属于独立发布工程。
- **5.2 许可证审计**：需法务签署、逐依赖 NOTICE/源码 offer 结论（28 个 NOASSERTION）。
- **5.4 代码签名**：需购买/配置代码签名证书并接入 CI 发布流水线。
- **5.5 干净系统验收**：需全新 Windows VM / 沙箱环境。

这四项无法仅靠代码改动关闭，记录在案，不在本次「逐条完成」范围内重复尝试。
