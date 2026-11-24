import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const reportPath = process.env.DBSTUDIO_LOCAL_GIS_AUDIT_REPORT
  || path.join(root, ".cache", "local-gis-data-audit-20261102.json");
const envPath = path.join(root, "docker", ".env");
const requiredExtensions = [".shp", ".geojson", ".kml", ".tab", ".gpkg"];
const sourceReport = JSON.parse(readFileSync(reportPath, "utf8"));
const dockerEnv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(["'])(.*)\1$/, "$2")]))
  : {};
const environment = {
  ...process.env,
  DBSTUDIO_GDAL_BIN: sourceReport.gdalBin,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? dockerEnv.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? dockerEnv.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? dockerEnv.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? dockerEnv.DBSTUDIO_PG_PASSWORD,
};
environment.PATH = `${sourceReport.gdalBin}${path.delimiter}${environment.PATH ?? ""}`;
assert.ok(existsSync(cli), "Build the CLI before running this integration check.");
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Configure the authorized project PostGIS test service first.");

const tempRoot = path.join(os.tmpdir(), `dbstudio-local-gis-roundtrip-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(tempRoot, { recursive: false });
const core = CoreService.fromEnvironment(environment);
const nonce = randomBytes(4).toString("hex");
const selected = [];
const createdTables = [];
let phase = "select-samples";

function sourcePathFor(dataset) {
  return sourceReport.roots.map((candidateRoot) => path.resolve(candidateRoot, dataset.relativePath)).find((candidate) => existsSync(candidate));
}

function dataBundleSize(sourcePath) {
  const directory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath)).toLowerCase();
  return readdirSync(directory).reduce((sum, entry) => {
    if (path.basename(entry, path.extname(entry)).toLowerCase() !== stem) return sum;
    try { return sum + statSync(path.join(directory, entry)).size; } catch { return sum; }
  }, 0);
}

for (const extension of requiredExtensions) {
  const candidates = sourceReport.datasets.flatMap((dataset) => {
    if (dataset.extension !== extension || dataset.status !== "inspected" || dataset.encoding?.source !== "metadata") return [];
    const layer = (dataset.layers ?? []).find((item) => item.status === "decoded" && Number(item.featureCount) >= 5 && Number(item.featureCount) <= 10_000);
    if (!layer || dataset.layers.length !== 1) return [];
    const sourcePath = sourcePathFor(dataset);
    if (!sourcePath) return [];
    const bytes = dataBundleSize(sourcePath);
    if (bytes > 20 * 1024 * 1024) return [];
    return [{ dataset, layer, sourcePath, bytes }];
  });
  candidates.sort((left, right) => left.bytes - right.bytes);
  assert.ok(candidates.length, `No bounded, decoded ${extension} sample with declared encoding was found.`);
  selected.push({ extension, ...candidates[0] });
}

function runCli(args) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return output.trim() ? JSON.parse(output) : undefined;
  } catch (error) {
    const raw = String(error?.stderr ?? error?.message ?? "CLI command failed");
    const safe = raw.replaceAll(root, "<workspace>").replaceAll(tempRoot, "<temporary-output>");
    throw new Error(safe.split(/\r?\n/)[0].slice(0, 300));
  }
}

function query(sql) {
  return runCli(["query", "run", "--sql", sql, "--format", "json"]);
}

function tableRef(table) {
  return `public."${table}"`;
}

async function main() {
  const results = [];
  for (const sample of selected) {
    phase = `import-${sample.extension}`;
    const table = `dbsa_local_${nonce}_${sample.extension.slice(1).replace(/[^a-z0-9]/gi, "_")}`;
    createdTables.push(table);
    const importArgs = ["gis", "import", "--connection", "environment", "--file", sample.sourcePath, "--target", `public.${table}`];
    const encoding = sample.dataset.encoding?.declaredEncoding;
    if (encoding) importArgs.push("--source-encoding", encoding);
    runCli(importArgs);

    const output = path.join(tempRoot, `${table}${sample.extension}`);
    phase = `export-${sample.extension}`;
    runCli(["gis", "export", "--connection", "environment", "--table", `public.${table}`, "--output", output]);
    assert.ok(existsSync(output), `The ${sample.extension} export was not created.`);

    phase = `verify-${sample.extension}`;
    const exported = await core.inspectGisFile(output);
    assert.equal(exported.layers.length, 1, `The ${sample.extension} export should contain one layer.`);
    const preview = await core.previewGisAttributes(output, { sourceLayer: exported.layers[0].name, limit: 1 });
    assert.equal(preview.requiresUserChoice, false, `The ${sample.extension} export needs an unresolved encoding choice.`);
    const exportedCount = Number(preview.featureCount);
    assert.equal(exportedCount, Number(sample.layer.featureCount), `The ${sample.extension} roundtrip changed its feature count.`);
    results.push({ extension: sample.extension, sourceFeatures: Number(sample.layer.featureCount), exportedFeatures: exportedCount, sourceEncoding: encoding });
  }

  phase = "verify-postgis-counts";
  const countsSql = createdTables.map((table) =>
    `SELECT '${table}' AS table_name, count(*)::bigint AS feature_count FROM ${tableRef(table)}`,
  ).join(" UNION ALL ");
  const counts = query(countsSql);
  const byTable = new Map(counts.rows.map((row) => [row.table_name, Number(row.feature_count)]));
  for (let index = 0; index < selected.length; index += 1) {
    const table = createdTables[index];
    const featureCount = byTable.get(table);
    assert.equal(featureCount, Number(selected[index].layer.featureCount), `The ${selected[index].extension} import changed its feature count.`);
    results[index].postgisFeatures = featureCount;
  }
  return results;
}

let primaryError;
try {
  const results = await main();
  process.stdout.write(`${JSON.stringify({ formats: results, allCountsPreserved: true })}\n`);
} catch (error) {
  primaryError = error;
  process.stderr.write(`${JSON.stringify({ phase, error: error instanceof Error ? error.message : "roundtrip failed" })}\n`);
  process.exitCode = 1;
} finally {
  for (const table of createdTables) {
    try { query(`DROP TABLE IF EXISTS ${tableRef(table)}`); }
    catch {
      if (!primaryError) {
        primaryError = new Error("PostGIS roundtrip cleanup failed.");
        process.stderr.write(`${JSON.stringify({ phase: "cleanup", error: primaryError.message })}\n`);
        process.exitCode = 1;
      }
    }
  }
  if (createdTables.length) {
    try {
      const checkSql = createdTables.map((table) =>
        `SELECT '${table}' AS table_name, to_regclass('public.${table}') IS NULL AS removed`,
      ).join(" UNION ALL ");
      const cleanup = query(checkSql);
      if (cleanup.rows.some((row) => row.removed !== true)) throw new Error("A temporary PostGIS table remains.");
    } catch {
      process.stderr.write(`${JSON.stringify({ phase: "cleanup-verification", error: "Temporary PostGIS tables were not fully removed." })}\n`);
      process.exitCode = 1;
    }
  }
  try { rmSync(tempRoot, { recursive: true, force: true }); }
  catch {
    process.stderr.write(`${JSON.stringify({ phase: "temporary-output-cleanup", error: "Temporary GIS exports could not be removed." })}\n`);
    process.exitCode = 1;
  }
}
