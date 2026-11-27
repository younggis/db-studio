// Phase 1.4: minimal Electron E2E over CDP. The app is launched by the global
// setup with --remote-debugging-port=9222; tests attach to that page.
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = process.env.DBSTUDIO_E2E_ELECTRON
  || path.join(root, ".cache", "electron-rea-dev-runtime-20261117", "electron.exe");

let appProcess: ChildProcess | undefined;

test.beforeAll(async () => {
  if (!fs.existsSync(runtime)) throw new Error(`Electron runtime not found: ${runtime}`);
  try {
    await fetch("http://127.0.0.1:9222/json/list");
    throw new Error("CDP port 9222 already in use");
  } catch (error) { if (error instanceof Error && error.message.includes("already in use")) throw error; /* free */ }
  appProcess = spawn(runtime, ["--remote-debugging-port=9222", "--window-size=1600,1000", "."], {
    cwd: root, stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      if (Array.isArray(targets) && targets.some((target) => target.type === "page")) return;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Electron did not expose CDP within 30s");
});

test.afterAll(async () => {
  appProcess?.kill();
});

async function attach(): Promise<Page> {
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  if (!targets.some((item: { type: string }) => item.type === "page")) throw new Error("No page target in Electron CDP");
  const browser = await (await import("@playwright/test")).chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  return context.pages()[0] ?? (await context.newPage());
}

test("connection cards render and all UI patches are intact", async () => {
  const page = await attach();
  await expect(page.locator(".connection-card")).toHaveCount(7, { timeout: 20_000 });
  await expect(page.locator(".connection-tools").first()).toBeHidden();
  const rect = await page.locator(".connection-card").first().boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.click(rect!.x + 60, rect!.y + rect!.height / 2, { button: "right" });
  await expect(page.locator(".conn-ctx-item")).toHaveCount(3, { timeout: 10_000 });
  await expect(page.locator(".conn-ctx-item").first()).toHaveText("测试连接");
  await page.keyboard.press("Escape");
});

test("object tree shows Navicat Tables grouping and aligned icon/title", async () => {
  const page = await attach();
  await page.locator(".connection-select").first().click();
  await expect(page.locator(".sql-workbench .object-tree")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".tree-node-title").first()).toBeVisible();
  // Compare the actual glyph boxes, not just the fixed slots: antd gives the
  // title a 22px box with a 13.2px line-height, which previously pushed text
  // ~4px above the icon centre even though the slots looked centred.
  const glyphCenters = await page.evaluate(() => {
    const center = (element: Element | null | undefined) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return box.y + box.height / 2;
    };
    const nodes = Array.from(document.querySelectorAll(".sql-workbench .object-tree .ant-tree-treenode"))
      .filter((node) => node.querySelector(".tree-node-title-text"));
    return nodes.slice(0, 8).map((node) => {
      const slot = node.querySelector(".ant-tree-iconEle");
      const visual = slot?.querySelector("svg") || slot?.querySelector(".tree-group-icon")
        || slot?.querySelector(".tree-sub-icon") || slot?.firstElementChild;
      const text = node.querySelector(".tree-node-title-text");
      const a = center(visual);
      const b = center(text);
      return a === null || b === null ? null : Math.abs(a - b);
    }).filter((value): value is number => value !== null);
  });
  expect(glyphCenters.length).toBeGreaterThan(0);
  expect(Math.max(...glyphCenters)).toBeLessThan(1);
  // Alignment contract: fixed 16px arrow/icon slots, 28px rows, 6px gap, kbd badge.
  await expect(page.locator(".sql-workbench .tree-filter-kbd")).toHaveText("⌘P");
  const metrics = await page.evaluate(() => {
    const node = Array.from(document.querySelectorAll(".sql-workbench .object-tree .ant-tree-treenode"))
      .find((element) => (element as HTMLElement).offsetParent !== null
        && element.querySelector(".ant-tree-switcher") && element.querySelector(".ant-tree-node-content-wrapper"));
    const sw = node?.querySelector(".ant-tree-switcher");
    const iconSlot = node?.querySelector(".ant-tree-iconEle");
    const wrapper = node?.querySelector(".ant-tree-node-content-wrapper");
    return {
      row: node ? getComputedStyle(node).height : "",
      arrow: sw ? getComputedStyle(sw).width : "",
      iconSlot: iconSlot ? getComputedStyle(iconSlot).width : "",
      gap: wrapper ? getComputedStyle(wrapper).gap : "",
    };
  });
  expect(metrics).toEqual({ row: "28px", arrow: "16px", iconSlot: "16px", gap: "6px" });
  // Expand the public schema so the Navicat "Tables" group renders.
  const publicNode = page.locator(".sql-workbench .object-tree .ant-tree-treenode").filter({ hasText: "public" }).first();
  await expect(publicNode).toBeVisible({ timeout: 10_000 });
  // Metadata loading is async; retry the expand until the Tables group appears.
  await expect(async () => {
    if (!(await page.locator(".sql-workbench .object-tree").innerText()).includes("Tables")) {
      await publicNode.locator(".ant-tree-switcher").click();
    }
    expect(await page.locator(".sql-workbench .object-tree").innerText()).toContain("Tables");
  }).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });

  // Phase 3: no dead placeholder subgroups; Fields loads real column metadata.
  const treeText = await page.locator(".sql-workbench .object-tree").innerText();
  expect(treeText).not.toContain("Foreign Keys");
  expect(treeText).not.toContain("Triggers");
  const tablesGroup = page.locator(".sql-workbench .object-tree .ant-tree-treenode").filter({ hasText: "Tables" }).first();
  await tablesGroup.locator(".ant-tree-switcher").click();
  const firstTable = page.locator(".sql-workbench .object-tree .ant-tree-treenode").filter({ hasText: "dbstudio_demo" }).first();
  // The source-ized tree exposes real tables (no dead placeholder groups).
  await expect(firstTable).toBeVisible();
});

test("SQL editor supports multiple independent query windows", async () => {
  const page = await attach();
  await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 20_000 });
  const tabs = page.locator(".sql-workbench .wb-query-tabs .ant-tabs-tab");
  const editor = page.locator(".sql-workbench textarea[aria-label='SQL 编辑器']");
  await expect(tabs).toHaveCount(1);

  await editor.fill("SELECT 1 -- first");
  await page.locator(".sql-workbench .panel-toolbar").getByRole("button", { name: "新建查询" }).click();
  await expect(tabs).toHaveCount(2);
  await editor.fill("SELECT 2 -- second");

  await tabs.first().click();
  await expect(editor).toHaveValue("SELECT 1 -- first");
  await tabs.nth(1).click();
  await expect(editor).toHaveValue("SELECT 2 -- second");

  // Database context is per window: switching tabs moves the connection
  // selector with it, so the object browser never needs re-selection.
  const connSelect = page.locator(".sql-workbench .panel-toolbar .ant-select").first();
  const selectedConnection = async () => (await connSelect.locator(".ant-select-content").innerText()).trim();
  const firstConnection = await selectedConnection();
  await connSelect.click();
  await page.locator(".ant-select-item-option").nth(1).click();
  const secondConnection = await selectedConnection();
  expect(secondConnection).not.toBe(firstConnection);
  await tabs.first().click();
  expect(await selectedConnection()).toBe(firstConnection);
  await tabs.nth(1).click();
  expect(await selectedConnection()).toBe(secondConnection);

  // Closing a window keeps the other window's SQL intact.
  await tabs.nth(1).locator(".ant-tabs-tab-remove").click();
  await expect(tabs).toHaveCount(1);
  await expect(editor).toHaveValue("SELECT 1 -- first");
});

test("SQL editor and results are stacked with an object-browser context menu", async () => {
  const page = await attach();
  if (!(await page.locator(".sql-workbench").count())) {
    const sqlButton = page.getByRole("button", { name: "SQL 编辑器" }).first();
    if (await sqlButton.count()) await sqlButton.click();
  }
  await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 20_000 });

  const editorBox = await page.locator(".sql-workbench textarea[aria-label='SQL 编辑器']").boundingBox();
  const resultsBox = await page.locator(".sql-workbench .wb-results").boundingBox();
  expect(editorBox).not.toBeNull();
  expect(resultsBox).not.toBeNull();
  expect(resultsBox!.y).toBeGreaterThan(editorBox!.y + editorBox!.height);
  await expect(page.locator(".wb-sql-splitter")).toBeVisible();

  const rootNode = page.locator(".sql-workbench .object-tree .ant-tree-treenode")
    .filter({ hasText: "PostgreSQL" }).first();
  await rootNode.locator(".tree-node-title").click({ button: "right" });
  await expect(page.locator(".ant-dropdown-menu-item").first()).toBeVisible({ timeout: 10_000 });
  const labels = await page.locator(".ant-dropdown-menu-item").allInnerTexts();
  expect(labels.some((label) => label.includes("新建 SQL 查询"))).toBe(true);
  await page.keyboard.press("Escape");
});

test("spatial result viewer renders geometry columns", async () => {
  const page = await attach();
  if (!(await page.locator(".sql-workbench").count())) {
    const sqlButton = page.getByRole("button", { name: "SQL 编辑器" }).first();
    if (await sqlButton.count()) await sqlButton.click();
  }
  await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 20_000 });
  const connSelect = page.locator(".sql-workbench .panel-toolbar .ant-select").first();
  await connSelect.click();
  await page.locator(".ant-select-item-option").first().click();
  await page.locator(".sql-workbench textarea[aria-label='SQL 编辑器']")
    .fill("SELECT ST_GeomFromText('POLYGON((116 39,117 39,117 40,116 40,116 39))', 4326) AS geom, 9223372036854775807::bigint AS big, '{\"a\":1}'::json AS doc");
  await page.locator(".sql-workbench .panel-toolbar").getByRole("button", { name: "执行查询" }).click();
  await expect(page.locator(".sql-workbench .wb-results .ant-table-row")).toHaveCount(1, { timeout: 20_000 });

  await page.getByRole("button", { name: "空间结果预览" }).click();
  await expect(page.locator(".spatial-drawer .spatial-canvas")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".spatial-drawer .spatial-toolbar")).toContainText("geom");
  await expect(page.locator(".spatial-drawer .spatial-toolbar")).toContainText("1 / 1 行");

  // Clicking the interior of a polygon (not just its border) must select it,
  // and must never unmount the workbench (a Buffer reference used to blank it).
  const canvas = page.locator(".spatial-canvas");
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await expect(page.locator(".spatial-drawer .spatial-inspector")).toContainText("行号");
  await expect(page.locator(".spatial-drawer .spatial-inspector")).toContainText("big");
  await expect(page.locator(".sql-workbench")).toBeVisible();
  await page.locator(".ant-drawer-open .ant-drawer-close").first().click();
});

test("global workbench tokens are consistent across all pages", async () => {
  const page = await attach();

  // Read the authoritative tokens once; every page must compute the same values.
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      brand: style.getPropertyValue("--wb-brand").trim(),
      toolbar: style.getPropertyValue("--wb-bg-toolbar").trim(),
      fontSize: style.getPropertyValue("--wb-font-size").trim(),
      controlH: style.getPropertyValue("--wb-control-h").trim(),
    };
  });
  expect(tokens).toEqual({
    brand: "#1677ff",
    toolbar: "#f3f4f6",
    fontSize: "12px",
    controlH: "26px",
  });

  const sample = async () => page.evaluate(() => {
    const shell = document.querySelector(".shell");
    const status = document.querySelector(".compiled-wb-statusbar .wb-statusbar, .wb-app .wb-statusbar");
    return {
      font: shell ? getComputedStyle(shell).fontSize : "",
      toolbarBg: document.querySelector(".topbar, .wb-toolbar")
        ? getComputedStyle(document.querySelector(".topbar, .wb-toolbar")!).backgroundColor : "",
      statusH: status ? getComputedStyle(status).height : "",
    };
  });

  // SQL page (compiled shell, bridged to shared components).
  await page.locator(".connection-select").first().click();
  await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 20_000 });
  const sql = await sample();
  expect(sql.font).toBe("12px");
  expect(sql.statusH).toBe("24px");
  await expect(page.locator(".sql-workbench.wb-app")).toBeVisible();
  await expect(page.locator(".panel-toolbar.wb-toolbar")).toBeVisible();
  // Every compiled-shell action button adopts the shared WbToolButton class.
  const compiledButtons = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".sql-workbench .panel-toolbar .wb-tool-btn"));
    return { total: buttons.length, shared: buttons.filter((b) => b.classList.contains("wb-tool-btn")).length };
  });
  expect(compiledButtons.total).toBeGreaterThan(0);
  expect(compiledButtons.shared).toBe(compiledButtons.total);
  await expect(page.locator(".sql-workbench .wb-statusbar")).toBeVisible();

  // MongoDB page (real WbWorkbench tree).
  const mongoCard = page.locator(".connection-card").filter({ hasText: "MongoDB" }).first();
  if (await mongoCard.count()) await mongoCard.locator("button").first().click();
  await page.getByRole("button", { name: "Mongo 文档" }).first().click();
  await expect(page.locator(".wb-app.mongo-page")).toBeVisible({ timeout: 10_000 });
  const mongo = await sample();
  expect(mongo.font).toBe("12px");
  expect(mongo.statusH).toBe("24px");

  // GIS page (real WbWorkbench tree).
  await page.getByRole("button", { name: "GIS 交换" }).first().click();
  await expect(page.locator(".wb-app.gis-exchange")).toBeVisible({ timeout: 10_000 });
  const gis = await sample();
  expect(gis.font).toBe("12px");
  expect(gis.statusH).toBe("24px");

  // Restore a SQL connection so tool-launcher buttons are enabled again.
  const pgCard = page.locator(".connection-card").filter({ hasText: "PostgreSQL" }).first();
  if (await pgCard.count()) await pgCard.locator("button").first().click();
});

test("phase 3 launcher opens spatial index and layer health panels", async () => {
  const page = await attach();
  await expect(page.locator(".phase3-launcher")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "索引诊断" })).toBeVisible();
  await page.getByRole("button", { name: "索引诊断" }).click();
  await expect(page.locator(".ant-drawer-title")).toContainText("空间索引诊断", { timeout: 10_000 });
  await page.locator(".ant-drawer-close").first().click();
  await expect(page.getByRole("button", { name: "图层体检" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "备份恢复" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "结构同步" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "数据同步" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "表设计器" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "自动化调度" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "BI 图表" })).toBeEnabled();
});

test("GIS exchange page has import/export segmented flow", async () => {
  const page = await attach();
  const gisButton = page.getByRole("button", { name: "GIS 交换" }).first();
  await expect(gisButton).toBeVisible({ timeout: 20_000 });
  await gisButton.click();
  await expect(page.locator(".gis-exchange")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".gx-dropzone")).toBeVisible();
  // switch to export mode
  await page.locator(".gis-exchange .ant-segmented-item").nth(1).click();
  await expect(page.locator(".gx-format-pill")).toHaveCount(5, { timeout: 10_000 });
});

test("MongoDB documents page has compact query bar and view switcher", async () => {
  const page = await attach();
  // select the MongoDB connection before opening the documents page
  const mongoCard = page.locator(".connection-card").filter({ hasText: "MongoDB" }).first();
  await expect(mongoCard).toBeVisible({ timeout: 20_000 });
  await mongoCard.locator("button").first().click();
  await page.getByRole("button", { name: "Mongo 文档" }).first().click();
  await expect(page.locator(".mongo-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".mongo-labeled-prefix")).toHaveCount(2);
  await expect(page.locator(".json-mini")).toHaveCount(3);
  await expect(page.locator(".mongo-view-switch .ant-segmented-item")).toHaveCount(3);
  await expect(page.locator(".mongo-template")).toHaveCount(3);
  // switching to Aggregate replaces the three editors with a pipeline editor
  await page.locator(".mongo-mode-switch .ant-segmented-item").nth(1).click();
  await expect(page.locator(".mongo-page .json-mini-label")).toHaveText("Aggregate Pipeline");
});

test("topbar tool drawers close back to the workbench", async () => {
  const page = await attach();
  // The previous test leaves the MongoDB page open; return to SQL first.
  const sqlButton = page.getByRole("button", { name: "SQL 编辑器" }).first();
  if (await sqlButton.count()) await sqlButton.click();
  await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 20_000 });
  for (const name of ["BI 图表", "自动化调度"]) {
    await page.getByRole("button", { name }).first().click();
    await expect(page.locator(".ant-drawer-open .ant-drawer-title")).toBeVisible({ timeout: 10_000 });
    if (name === "BI 图表") await expect(page.locator(".bi-panel")).toBeVisible();
    await page.locator(".ant-drawer-open .ant-drawer-close").first().click();
    await expect(page.locator(".ant-drawer-mask")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 10_000 });
    // antd keeps drawer roots mounted after close. Their background must stay
    // transparent, otherwise a full-screen white layer hides the workbench.
    const backgrounds = await page.locator(".ant-drawer").evaluateAll(
      (els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(backgrounds.length).toBeGreaterThan(0);
    expect(backgrounds.every((bg) => bg === "rgba(0, 0, 0, 0)")).toBe(true);
  }
});

test("SQL page opens AI assistant and history drawers", async () => {
  const page = await attach();
  // Ensure we are on the SQL page without clicking a button the SQL overlay
  // itself may be covering (the overlay is already active in some run orders).
  if (!(await page.locator(".sql-workbench").count())) {
    const sqlButton = page.getByRole("button", { name: "SQL 编辑器" }).first();
    if (await sqlButton.count()) await sqlButton.click();
  }
  await expect(page.locator(".sql-workbench")).toBeVisible({ timeout: 20_000 });
  const aiButton = page.locator(".panel-toolbar").getByRole("button", { name: "AI 助手" }).first();
  await expect(aiButton).toBeVisible({ timeout: 20_000 });
  await aiButton.click();
  await expect(page.locator(".ai-drawer-title")).toContainText("AI SQL Assistant", { timeout: 10_000 });
  await page.locator(".ant-drawer-open .ant-drawer-close").first().click();
  const history = page.locator(".toolbar-actions").getByRole("button", { name: "历史" });
  await expect(history).toBeVisible({ timeout: 10_000 });
  await history.click();
  await expect(page.locator(".query-history-drawer")).toBeVisible({ timeout: 10_000 });
});
