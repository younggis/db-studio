import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerEnvText = await readFile(path.join(root, "docker", ".env"), "utf8");
const dockerEnv = Object.fromEntries(dockerEnvText.split(/\r?\n/)
  .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
  .filter(Boolean)
  .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]));
const audit = JSON.parse(await readFile(path.join(root, ".cache", "local-gis-data-audit-20261119-refresh.json"), "utf8"));
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

const candidates = ["CP936", "CP950", "UTF-8"];
const sources = [
  { key: "grid", source: "F:/temp/grid.tab" },
  { key: "ha螺沟_property_points", source: "F:/temp/海螺沟_物业点.tab" },
  { key: "t_gis_high_speed_segment", source: "F:/temp/t_gis_high_speed_segment.tab" },
];
const cliEntry = path.join(root, "apps", "cli", "dist", "index.js");
const core = CoreService.fromEnvironment(environment);
const results = [];

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function componentManifest(source) {
  const directory = path.dirname(source);
  const base = path.basename(source, path.extname(source)).toLowerCase();
  const names = (await readdir(directory)).filter((name) => path.parse(name).name.toLowerCase() === base);
  const manifest = {};
  for (const name of names) {
    const filePath = path.join(directory, name);
    if ((await stat(filePath)).isFile()) manifest[name] = await sha256(filePath);
  }
  return manifest;
}

function errorClass(stderr = "") {
  if (/ReadBytes\(\).*past end of data block/i.test(stderr)) return "read-past-end";
  if (/Too big nCoordDataSize/i.test(stderr)) return "coordinate-block-size";
  return "other-gdal-import-error";
}

await core.query("SELECT 1 AS ready");
const sourceManifestsBefore = Object.fromEntries(await Promise.all(sources.map(async ({ key, source }) => [key, await componentManifest(source)])));
let tempRoot;
try {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "dbstudio-tab-encoding-matrix-"));
  for (const { key, source } of sources) {
    for (const encoding of candidates) {
      const table = `dbstudio_tabcand_${key.replace(/[^a-z0-9_]/gi, "_")}_${encoding.replace(/[^a-z0-9]/gi, "").toLowerCase()}_${randomBytes(3).toString("hex")}`;
      const result = { source, encoding, targetTable: `public.${table}`, externalDataSent: false };
      try {
        const imported = spawnSync(process.execPath, [
          cliEntry,
          "gis", "import",
          "--connection", "environment",
          "--file", source,
          "--target", `public.${table}`,
          "--source-encoding", encoding,
        ], {
          cwd: root,
          env: environment,
          encoding: "utf8",
          windowsHide: true,
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        result.cliExitCode = imported.status;
        if (imported.error) {
          result.status = "failed";
          result.errorClass = imported.error.code === "ETIMEDOUT" ? "timeout" : "cli-spawn-error";
        } else if (imported.status !== 0) {
          result.status = "failed";
          result.errorClass = errorClass(imported.stderr);
        } else {
          const importReport = JSON.parse(imported.stdout);
          const postgisRows = await core.query(`SELECT COUNT(*)::int AS feature_count FROM public."${table}"`);
          const featureCount = Number(postgisRows.rows[0]?.feature_count ?? -1);
          result.importFeatureCount = importReport.featureCount;
          result.databaseFeatureCount = featureCount;
          assert.equal(featureCount, importReport.featureCount);
          const outputDirectory = path.join(tempRoot, `${key}-${encoding.replace(/[^a-z0-9]/gi, "-")}`);
          await mkdir(outputDirectory, { recursive: true });
          const output = path.join(outputDirectory, `${key}.tab`);
          const exportReport = await core.exportGisFromPostgres(`public.${table}`, output, { targetEncoding: encoding });
          const readback = await core.inspectGisFile(output, { sourceEncoding: encoding });
          result.exportFeatureCount = exportReport.featureCount;
          result.readbackFeatureCount = readback.featureCount;
          assert.equal(exportReport.featureCount, importReport.featureCount);
          assert.equal(readback.featureCount, importReport.featureCount);
          result.status = "count-roundtrip-passed";
        }
      } catch (error) {
        result.status = "failed";
        if (error?.code === "ERR_ASSERTION" || error?.name === "AssertionError") result.errorClass = "roundtrip-count-mismatch";
        else if (!result.errorClass) result.errorClass = "gdal-or-postgis-error";
      } finally {
        try {
          await core.query(`DROP TABLE IF EXISTS public."${table}"`);
          result.tableCleaned = true;
        } catch {
          result.tableCleaned = false;
        }
      }
      results.push(result);
    }
  }
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

const sourceManifestsAfter = Object.fromEntries(await Promise.all(sources.map(async ({ key, source }) => [key, await componentManifest(source)])));
const sourceComponentsUnchanged = JSON.stringify(sourceManifestsBefore) === JSON.stringify(sourceManifestsAfter);
assert.equal(sourceComponentsUnchanged, true);
assert.ok(results.every((result) => result.tableCleaned === true));

const report = {
  generatedAt: new Date().toISOString(),
  status: "completed",
  host: "127.0.0.1",
  port: Number(environment.PGPORT),
  gdalBin,
  entrypoint: "CLI import; CoreService count/export/readback",
  candidateOnly: true,
  sourceEncodingProven: false,
  candidates,
  results,
  temporaryTablesCleaned: true,
  temporaryExportsCleaned: true,
  sourceComponentsUnchanged,
  externalDataSent: false,
  note: "An import error blocks a complete PostGIS roundtrip; error classes are recorded without attribute values or raw file contents.",
};
const reportPath = path.join(root, ".cache", "gis-roundtrip", "neutral-tab-postgis-encoding-matrix-20261120.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: report.status,
  reportPath,
  candidateOnly: report.candidateOnly,
  sourceEncodingProven: report.sourceEncodingProven,
  sourceComponentsUnchanged,
  results: results.map(({ source, encoding, status, errorClass, importFeatureCount, databaseFeatureCount, exportFeatureCount, readbackFeatureCount, tableCleaned }) => ({ source, encoding, status, errorClass, importFeatureCount, databaseFeatureCount, exportFeatureCount, readbackFeatureCount, tableCleaned })),
}));
