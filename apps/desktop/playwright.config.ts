import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Electron E2E boots the local build with a CDP port and attaches over CDP,
// mirroring the existing manual CDP verification flow.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: path.join(dir, "test-results/e2e-report.json") }]],
  use: { baseURL: "http://127.0.0.1:9222", trace: "off" },
});
