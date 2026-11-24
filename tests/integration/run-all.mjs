// Phase 1.2: unified integration runner. Discovers every test:integration:*
// script from package.json, executes them (optionally filtered) and emits one
// stable JSON report so results can be compared across machines and CI runs.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const filterIndex = args.indexOf("--filter");
const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined;
const listOnly = args.includes("--list");
const continueOnFailure = !args.includes("--fail-fast");
const maxOutput = 64 * 1024;

let scripts = Object.entries(packageJson.scripts)
  .filter(([name]) => name.startsWith("test:integration:") && name !== "test:integration:all")
  .sort(([a], [b]) => a.localeCompare(b));
if (filter) scripts = scripts.filter(([name]) => name.includes(filter));
if (!scripts.length) throw new Error(`No integration scripts matched${filter ? ` filter "${filter}"` : ""}.`);

if (listOnly) {
  for (const [name] of scripts) process.stdout.write(`${name}\n`);
  process.exit(0);
}

function run(command) {
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { if (stdout.length < maxOutput) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (stderr.length < maxOutput) stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` }));
  });
}

const results = [];
const startedAt = Date.now();
process.stdout.write(`Running ${scripts.length} integration script(s)${filter ? ` matching "${filter}"` : ""}\n`);
for (const [name, command] of scripts) {
  const t0 = Date.now();
  const { code, stdout, stderr } = await run(command);
  const durationMs = Date.now() - t0;
  const status = code === 0 ? "passed" : "failed";
  results.push({ name, command, status, code, durationMs, stdout: stdout.trim(), stderr: stderr.trim() });
  process.stdout.write(`  ${status === "passed" ? "PASS" : "FAIL"} ${name} (${durationMs}ms)\n`);
  if (status === "failed" && !continueOnFailure) break;
}

const summary = {
  generatedAt: new Date().toISOString(),
  totalDurationMs: Date.now() - startedAt,
  filter: filter ?? null,
  total: results.length,
  passed: results.filter((item) => item.status === "passed").length,
  failed: results.filter((item) => item.status === "failed").length,
  results,
};
mkdirSync(path.join(root, ".cache"), { recursive: true });
const reportPath = path.join(root, ".cache", `integration-report-${Date.now()}.json`);
writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  total: summary.total, passed: summary.passed, failed: summary.failed,
  reportPath: path.relative(root, reportPath),
}, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
