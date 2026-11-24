import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerEnvPath = path.join(root, "docker", ".env");
const dockerEnvText = await readFile(dockerEnvPath, "utf8");
const dockerEnv = Object.fromEntries(dockerEnvText.split(/\r?\n/)
  .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
  .filter(Boolean)
  .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]));
const auditPath = path.join(root, ".cache", "local-gis-data-audit-20261119-refresh.json");
const audit = JSON.parse(await readFile(auditPath, "utf8"));
const gdalBin = process.env.DBSTUDIO_GDAL_BIN ?? audit.gdalBin;
const envValue = (key, dockerKey = key) => process.env[key] ?? dockerEnv[dockerKey];
const environment = {
  ...process.env,
  DBSTUDIO_DATABASE_TYPE: "postgres",
  DBSTUDIO_GDAL_BIN: gdalBin,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: envValue("PGPORT", "DBSTUDIO_POSTGIS_PORT") ?? "25432",
  PGDATABASE: envValue("PGDATABASE", "DBSTUDIO_PG_DATABASE"),
  PGUSER: envValue("PGUSER", "DBSTUDIO_PG_USER"),
  PGPASSWORD: envValue("PGPASSWORD", "DBSTUDIO_PG_PASSWORD"),
};
environment.PATH = `${gdalBin}${path.delimiter}${environment.PATH ?? ""}`;
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD, "Isolated PostGIS test connection settings are missing.");

const datasets = [
  {
    key: "city_road",
    source: process.env.DBSTUDIO_GIS_UTF8_CITY_SOURCE ?? "F:/GeoData/city_road.shp",
    featureCount: 366_620,
    repairedCells: { CITY: 19_440 },
  },
  {
    key: "bonc_small_grid_outline",
    source: process.env.DBSTUDIO_GIS_UTF8_BONC_SOURCE ?? "F:/temp/bonc_small_grid_outline.shp",
    featureCount: 91_204,
    repairedCells: { COUNTY: 1_560, SMALLAREA: 26 },
  },
];

async function findDbf(source) {
  const directory = path.dirname(source);
  const base = path.basename(source, path.extname(source)).toLowerCase();
  const entry = (await readdir(directory)).find((name) => name.toLowerCase() === `${base}.dbf`);
  assert.ok(entry, `DBF companion is missing for ${path.basename(source)}.`);
  return path.join(directory, entry);
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

const core = CoreService.fromEnvironment(environment);
const cliEntry = path.join(root, "apps", "cli", "dist", "index.js");
const results = [];
let phase = "connect";
let failure;

try {
  await core.query("SELECT 1 AS ready");
  for (const dataset of datasets) {
    phase = `import-${dataset.key}`;
    const table = `dbstudio_utf8tail_${dataset.key}_${randomBytes(4).toString("hex")}`;
    const dbf = await findDbf(dataset.source);
    const sourceHashBefore = await sha256(dbf);
    const result = {
      source: dataset.source,
      sourceDbfBytes: (await stat(dbf)).size,
      sourceDbfSha256Before: sourceHashBefore,
      expectedFeatureCount: dataset.featureCount,
      expectedRepairedCells: dataset.repairedCells,
      targetTable: `public.${table}`,
      externalDataSent: false,
    };
    try {
      const cliImport = spawnSync(process.execPath, [
        cliEntry,
        "gis",
        "import",
        "--connection",
        "environment",
        "--file",
        dataset.source,
        "--target",
        `public.${table}`,
        "--source-encoding",
        "UTF-8",
        "--replace-incomplete-utf8-tails",
      ], {
        cwd: root,
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(cliImport.error, undefined, "GIS CLI process failed to start.");
      assert.equal(cliImport.status, 0, `GIS CLI import exited with status ${cliImport.status}.`);
      const importReport = JSON.parse(cliImport.stdout);
      result.entrypoint = "cli";
      result.importFeatureCount = importReport.featureCount;
      result.successfulFeatures = importReport.successfulFeatures;
      result.warnings = importReport.warnings ?? [];

      phase = `verify-${dataset.key}`;
      const fieldCounts = Object.keys(dataset.repairedCells).map((field) =>
        `COUNT(*) FILTER (WHERE COALESCE(to_jsonb(t)->>'${field}', to_jsonb(t)->>'${field.toLowerCase()}') LIKE '%?%')::int AS "${field.toLowerCase()}"`,
      );
      const counts = await core.query(
        `SELECT COUNT(*)::int AS feature_count, ${fieldCounts.join(", ")} FROM public."${table}" t`,
      );
      const row = counts.rows[0] ?? {};
      result.databaseFeatureCount = Number(row.feature_count);
      result.databaseRepairedCells = Object.fromEntries(Object.keys(dataset.repairedCells)
        .map((field) => [field, Number(row[field.toLowerCase()])]));
      assert.equal(result.databaseFeatureCount, dataset.featureCount);
      for (const [field, expected] of Object.entries(dataset.repairedCells)) {
        assert.equal(result.databaseRepairedCells[field], expected);
      }
      for (const [field, count] of Object.entries(dataset.repairedCells)) {
        assert.ok(result.warnings.some((warning) => warning.includes(`${field}: ${count} record(s)`)));
      }
      result.status = "passed";
    } finally {
      phase = `cleanup-${dataset.key}`;
      await core.query(`DROP TABLE IF EXISTS public."${table}"`);
      result.tableCleaned = true;
      const sourceHashAfter = await sha256(dbf);
      result.sourceDbfSha256After = sourceHashAfter;
      result.sourceDbfUnchanged = sourceHashBefore === sourceHashAfter;
      assert.equal(result.sourceDbfUnchanged, true);
      results.push(result);
    }
  }
} catch (error) {
  failure = { phase, type: error?.constructor?.name ?? "Error" };
}

const report = {
  generatedAt: new Date().toISOString(),
  status: failure ? "failed" : "passed",
  host: "127.0.0.1",
  port: Number(environment.PGPORT),
  gdalBin,
  entrypoint: "cli",
  results,
  failure,
  externalDataSent: false,
};
const reportPath = path.join(root, ".cache", "gis-roundtrip", "utf8-tail-repair-postgis-smoke-20261119.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: report.status, reportPath, results: results.map(({ source, databaseFeatureCount, databaseRepairedCells, sourceDbfUnchanged, tableCleaned, status }) => ({ source, databaseFeatureCount, databaseRepairedCells, sourceDbfUnchanged, tableCleaned, status })), failure }));
if (failure) process.exitCode = 1;
