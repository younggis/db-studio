import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const parseEnv = (contents) => Object.fromEntries(contents.split(/\r?\n/)
  .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/))
  .filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(["'])(.*)\1$/, "$2")]));
const dockerEnv = parseEnv(await readFile(path.join(root, "docker/.env"), "utf8"));
const gdalBin = path.join(root, "apps/desktop/resources/gdal/bin");
const cli = path.join(root, "apps/cli/dist/index.js");
assert.ok(existsSync(path.join(gdalBin, "ogrinfo.exe")), "The staged GDAL runtime is missing.");
assert.ok(existsSync(cli), "Build the CLI before running this smoke test.");

const environment = {
  ...process.env,
  ...dockerEnv,
  DBSTUDIO_DATABASE_TYPE: "postgres",
  DBSTUDIO_GDAL_BIN: gdalBin,
  PGHOST: "127.0.0.1",
  PGPORT: process.env.PGPORT ?? dockerEnv.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? dockerEnv.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? dockerEnv.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? dockerEnv.DBSTUDIO_PG_PASSWORD,
};
delete environment.DBSTUDIO_DATABASE_URL;
delete environment.DATABASE_URL;
assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD,
  "Configure the isolated PostGIS credentials in docker/.env or environment variables.");

const artifactDirectory = path.join(root, ".cache", "gis-roundtrip");
await mkdir(artifactDirectory, { recursive: true });
const runId = randomBytes(4).toString("hex");
const temporaryDirectory = await mkdtemp(path.join(artifactDirectory, `gis-export-bbox-postgis-${runId}-`));
const sourcePath = path.join(temporaryDirectory, "bbox-source.geojson");
const coreOutput = path.join(temporaryDirectory, "core-filtered.geojson");
const cliOutput = path.join(temporaryDirectory, "cli-filtered.geojson");
const table = `gis_export_bbox_${runId}`;
const reportPath = path.join(artifactDirectory, `gis-export-spatial-filter-postgis-${runId}.json`);
const bbox = { minX: 104, minY: 30.5, maxX: 104.2, maxY: 30.7 };
const bboxArgument = [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].join(",");
const core = CoreService.fromEnvironment(environment);
const report = {
  date: new Date().toISOString(),
  engine: "postgres/postgis",
  bbox,
  sourceFeatures: 2,
  sourceIds: [17, 18],
  sourceModified: false,
  externalDataSent: false,
  status: "running",
};
let tableCreated = false;
let cleanupErrors = [];

try {
  await writeFile(sourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "bbox_source",
    features: [
      { type: "Feature", properties: { id: 17, label: "inside" }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
      { type: "Feature", properties: { id: 18, label: "outside" }, geometry: { type: "Point", coordinates: [103.567, 30.9] } },
    ],
  }), "utf8");
  const imported = await core.importGisToPostgres(sourcePath, `public.${table}`, { mode: "create" });
  tableCreated = true;
  assert.equal(imported.successfulFeatures, 2, "Synthetic PostGIS source table was not created with both features.");

  const coreExport = await core.exportGisFromPostgres(`public.${table}`, coreOutput, { spatialFilter: bbox });
  const coreDocument = JSON.parse(await readFile(coreOutput, "utf8"));
  const coreIds = coreDocument.features.map((feature) => Number(feature.properties.id));
  assert.equal(coreExport.operationReport?.successfulFeatures, 1, "Core export did not report one selected feature.");
  assert.deepEqual(coreIds, [17], "Core export included the out-of-range feature or omitted the in-range feature.");

  const cliStdout = execFileSync(process.execPath, [
    cli, "gis", "export", "--connection", "environment",
    "--table", `public.${table}`, "--output", cliOutput,
    "--bbox", bboxArgument,
  ], { cwd: root, env: environment, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cliExport = JSON.parse(cliStdout);
  const cliDocument = JSON.parse(await readFile(cliOutput, "utf8"));
  const cliIds = cliDocument.features.map((feature) => Number(feature.properties.id));
  assert.equal(cliExport.operationReport?.successfulFeatures, 1, "CLI export did not report one selected feature.");
  assert.deepEqual(cliIds, [17], "CLI export included the out-of-range feature or omitted the in-range feature.");

  report.coreExportFeatureCount = coreExport.operationReport?.successfulFeatures;
  report.coreSelectedIds = coreIds;
  report.cliExportFeatureCount = cliExport.operationReport?.successfulFeatures;
  report.cliSelectedIds = cliIds;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.errorClass = error instanceof Error ? error.name : "UnknownError";
  throw error;
} finally {
  if (tableCreated) {
    try {
      await core.query(`DROP TABLE IF EXISTS public."${table.replaceAll('"', '""')}"`);
      const remaining = await core.query(`SELECT to_regclass('public.${table}') AS relation`);
      if (remaining.rows[0]?.relation != null) cleanupErrors.push("postgis-test-table-remains");
    } catch {
      cleanupErrors.push("postgis-test-table-cleanup-failed");
    }
  }
  try { await rm(temporaryDirectory, { recursive: true, force: true }); }
  catch { cleanupErrors.push("temporary-directory-cleanup-failed"); }
  report.testTableCleaned = cleanupErrors.length === 0;
  report.temporaryFilesCleaned = !existsSync(temporaryDirectory);
  report.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) report.status = "failed";
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({
  status: report.status,
  engine: report.engine,
  coreExportFeatureCount: report.coreExportFeatureCount,
  coreSelectedIds: report.coreSelectedIds,
  cliExportFeatureCount: report.cliExportFeatureCount,
  cliSelectedIds: report.cliSelectedIds,
  testTableCleaned: report.testTableCleaned,
  temporaryFilesCleaned: report.temporaryFilesCleaned,
  externalDataSent: report.externalDataSent,
  evidence: path.relative(root, reportPath),
}, null, 2));
if (report.status !== "passed" || !report.testTableCleaned || !report.temporaryFilesCleaned) process.exitCode = 1;
