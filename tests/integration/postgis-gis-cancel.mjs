import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const localEnvPath = path.join(root, "docker", ".env");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const gdalModule = path.join(root, "packages", "gis", "dist", "index.js");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(["'])(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(localEnvPath);
const gdalBin = process.env.DBSTUDIO_GDAL_BIN
  ?? (process.platform === "win32" ? "C:\\Program Files\\QGIS 3.44.8\\bin" : "");
const environment = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? dockerEnv.DBSTUDIO_POSTGIS_PORT ?? "25432",
  PGDATABASE: process.env.PGDATABASE ?? dockerEnv.DBSTUDIO_PG_DATABASE,
  PGUSER: process.env.PGUSER ?? dockerEnv.DBSTUDIO_PG_USER,
  PGPASSWORD: process.env.PGPASSWORD ?? dockerEnv.DBSTUDIO_PG_PASSWORD,
  DBSTUDIO_GDAL_BIN: gdalBin,
};
const gdalRoot = path.resolve(gdalBin, "..");
const localGdalData = [path.join(gdalRoot, "data"), path.join(gdalRoot, "share", "gdal")]
  .find((directory) => existsSync(directory));
const localProjData = [path.join(gdalRoot, "proj"), path.join(gdalRoot, "share", "proj")]
  .find((directory) => existsSync(path.join(directory, "proj.db")));
if (!environment.GDAL_DATA && localGdalData) environment.GDAL_DATA = localGdalData;
if (!environment.PROJ_DATA && localProjData) environment.PROJ_DATA = localProjData;
if (!environment.PROJ_LIB && localProjData) environment.PROJ_LIB = localProjData;

assert.ok(environment.PGDATABASE && environment.PGUSER && environment.PGPASSWORD,
  "Configure the isolated PostGIS service in docker/.env or set PostgreSQL environment variables.");
assert.ok(existsSync(cli) && existsSync(gdalModule), "Build the workspace before running this integration test.");
assert.ok(gdalBin && existsSync(path.join(gdalBin, process.platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr")),
  "Set DBSTUDIO_GDAL_BIN to a GDAL/OGR bin directory.");

const runId = `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const sourceTable = `dbsc_${runId}_source`;
const cancelledTable = `dbsc_${runId}_cancelled`;
const outputDirectory = path.join(root, ".cache", `postgis-cancel-${runId}`);
const input = path.join(outputDirectory, "source.gpkg");
const cancelledExport = path.join(outputDirectory, "cancelled.gpkg");
mkdirSync(outputDirectory, { recursive: true });

function query(sql) {
  try {
    const output = execFileSync(process.execPath, [cli, "query", "run", "--sql", sql, "--format", "json"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(output);
  } catch (error) {
    const details = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`PostGIS query failed${details ? `:\n${details}` : "."}`);
  }
}

const { GdalService, GisOperationError } = await import(pathToFileURL(gdalModule).href);
const gis = new GdalService(environment);
const connection = {
  host: environment.PGHOST,
  port: Number(environment.PGPORT),
  database: environment.PGDATABASE,
  user: environment.PGUSER,
  password: environment.PGPASSWORD,
};
const featureCount = 200_000;
let cancelAt = null;

try {
  query(`CREATE TABLE public."${sourceTable}" AS SELECT n::integer AS id, ST_SetSRID(ST_MakePoint(n / 1000.0, n / 1000.0), 4326)::geometry(Point, 4326) AS geom FROM generate_series(1, ${featureCount}) AS n`);
  const exported = await gis.exportFromPostgres(`public.${sourceTable}`, input, connection);
  assert.equal(exported.operationReport?.successfulFeatures, featureCount, "The large source dataset did not export completely.");

  const controller = new AbortController();
  let operationError;
  try {
    await gis.importToPostgres(input, `public.${cancelledTable}`, connection, {}, {
      signal: controller.signal,
      onProgress: (percent) => {
        if (percent >= 10 && cancelAt === null) {
          cancelAt = percent;
          controller.abort();
        }
      },
    });
  } catch (error) {
    operationError = error;
  }

  assert.ok(operationError instanceof GisOperationError, "Cancelling the running import must return a structured GIS error.");
  assert.equal(operationError.report.status, "cancelled", "The GIS import did not report cancellation.");
  assert.ok(cancelAt !== null && cancelAt < 100, "The cancellation callback must run before the import completes.");

  const remaining = query(`SELECT to_regclass('public.${cancelledTable}') AS relation`);
  assert.equal(remaining.rows[0]?.relation, null, "The dataset transaction must roll back its partially imported table.");

  const exportController = new AbortController();
  let exportCancelledAt = null;
  let exportError;
  try {
    await gis.exportFromPostgres(`public.${sourceTable}`, cancelledExport, connection, {}, {
      signal: exportController.signal,
      onProgress: (percent) => {
        if (percent >= 10 && exportCancelledAt === null) {
          exportCancelledAt = percent;
          exportController.abort();
        }
      },
    });
  } catch (error) {
    exportError = error;
  }
  assert.ok(exportError instanceof GisOperationError, "Cancelling the running export must return a structured GIS error.");
  assert.equal(exportError.report.status, "cancelled", "The GIS export did not report cancellation.");
  assert.ok(exportCancelledAt !== null && exportCancelledAt < 100, "The export cancellation callback must run before completion.");
  assert.equal(existsSync(cancelledExport), false, "A cancelled export must never leave a partial final file.");
  assert.deepEqual(readdirSync(outputDirectory), ["source.gpkg"], "A cancelled export must remove its staging directory and files.");

  process.stdout.write(JSON.stringify({
    result: "passed",
    sourceFeatures: featureCount,
    importCancelledAtPercent: cancelAt,
    importStatus: operationError.report.status,
    partialTableAfterRollback: remaining.rows[0]?.relation,
    exportCancelledAtPercent: exportCancelledAt,
    exportStatus: exportError.report.status,
    partialExportAfterCleanup: existsSync(cancelledExport),
  }, null, 2) + "\n");
} finally {
  try { query(`DROP TABLE IF EXISTS public."${cancelledTable}"`); } catch { /* Keep the original test failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${sourceTable}"`); } catch { /* Keep the original test failure. */ }
  rmSync(outputDirectory, { recursive: true, force: true });
}
