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
  await expect(page.locator(".object-tree")).toBeVisible({ timeout: 20_000 });
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
    const nodes = Array.from(document.querySelectorAll(".object-tree .ant-tree-treenode"))
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
  await expect(page.locator(".tree-filter-kbd")).toHaveText("⌘P");
  const metrics = await page.evaluate(() => {
    const node = Array.from(document.querySelectorAll(".object-tree .ant-tree-treenode"))
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
  const publicNode = page.locator(".ant-tree-treenode").filter({ hasText: "public" }).first();
  await expect(publicNode).toBeVisible({ timeout: 10_000 });
  // Metadata loading is async; retry the expand until the Tables group appears.
  await expect(async () => {
    if (!(await page.locator(".object-tree").innerText()).includes("Tables")) {
      await publicNode.locator(".ant-tree-switcher").click();
    }
    expect(await page.locator(".object-tree").innerText()).toContain("Tables");
  }).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });

  // Phase 3: no dead placeholder subgroups; Fields loads real column metadata.
  const treeText = await page.locator(".object-tree").innerText();
  expect(treeText).not.toContain("Foreign Keys");
  expect(treeText).not.toContain("Triggers");
  const tablesGroup = page.locator(".ant-tree-treenode").filter({ hasText: "Tables" }).first();
  await tablesGroup.locator(".ant-tree-switcher").click();
  const firstTable = page.locator(".ant-tree-treenode").filter({ hasText: "dbstudio_demo" }).first();
  if (await firstTable.count()) {
    await firstTable.locator(".ant-tree-switcher").click();
    const fieldsNode = page.locator(".ant-tree-treenode").filter({ hasText: "Fields" }).first();
    await expect(fieldsNode).toBeVisible({ timeout: 10_000 });
    await fieldsNode.locator(".ant-tree-switcher").click();
    // Fields are rendered compactly with a separate type label and PK badge.
    await expect(page.locator(".tree-field").first()).toBeVisible({ timeout: 10_000 });
  }
});

test("phase 3 launcher opens spatial index and layer health panels", async () => {
  const page = await attach();
  await expect(page.locator(".phase3-launcher")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "索引诊断" })).toBeVisible();
  await page.getByRole("button", { name: "索引诊断" }).click();
  await expect(page.locator(".ant-drawer-title")).toContainText("空间索引诊断", { timeout: 10_000 });
  await page.locator(".ant-drawer-close").first().click();
  await expect(page.getByRole("button", { name: "图层体检" })).toBeEnabled();
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

test("SQL page opens AI assistant and history drawers", async () => {
  const page = await attach();
  // ensure we are on the SQL page regardless of the previous test
  const sqlButton = page.getByRole("button", { name: "SQL 编辑器" }).first();
  if (await sqlButton.count()) await sqlButton.click();
  const aiButton = page.locator(".panel-toolbar").getByRole("button", { name: "AI 助手" }).first();
  await expect(aiButton).toBeVisible({ timeout: 20_000 });
  await aiButton.click();
  await expect(page.locator(".ai-drawer-title")).toContainText("AI SQL Assistant", { timeout: 10_000 });
  await page.locator(".ant-drawer-close").first().click();
  const history = page.locator(".toolbar-actions").getByRole("button", { name: "历史" });
  await expect(history).toBeVisible({ timeout: 10_000 });
  await history.click();
  await expect(page.locator(".query-history-drawer")).toBeVisible({ timeout: 10_000 });
});
