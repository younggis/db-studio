import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteAdapter } from "../../packages/database/dist/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeBin = path.join(root, "apps/desktop/resources/gdal/bin");
const cliPath = path.join(root, "apps/cli/dist/index.js");
const outputDirectory = path.join(root, ".cache/gis-roundtrip");
const evidencePath = path.join(outputDirectory, "sqlite-spatialite-gis-acceptance-20261122.json");
process.env.DBSTUDIO_GDAL_BIN = runtimeBin;
process.env.PATH = [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter);

const temporaryDirectory = await mkdtemp(path.join(outputDirectory, "sqlite-gis-roundtrip-"));
const evidence = {
  date: "2026-11-22",
  status: "running",
  runtime: runtimeBin,
  sourceData: "synthetic GeoJSON only",
  externalDataSent: false,
  sourceFilesModified: false,
  checks: {},
};

async function runCli(databasePath, args) {
  const env = {
    ...process.env,
    DBSTUDIO_DATABASE_TYPE: "sqlite",
    DBSTUDIO_SQLITE_PATH: databasePath,
  };
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function withDatabase(databasePath, action) {
  const adapter = new SqliteAdapter({ path: databasePath });
  try { return await action(adapter); }
  finally { await adapter.close(); }
}

try {
  await mkdir(outputDirectory, { recursive: true });
  const sourcePath = path.join(temporaryDirectory, "source.geojson");
  const source = {
    type: "FeatureCollection",
    name: "synthetic_roads",
    features: [
      { type: "Feature", properties: { id: 11, name: "成都东站", score: 1.25 }, geometry: { type: "Point", coordinates: [104, 30] } },
      { type: "Feature", properties: { id: 12, name: "绵阳站", score: 2.5 }, geometry: { type: "Point", coordinates: [106, 32] } },
    ],
  };
  await writeFile(sourcePath, JSON.stringify(source), "utf8");
  const fieldArgs = ["--field-map", "name=display_name", "--field-type", "id=integer64"];
  const filterArgs = ["--bbox", "103.5,29.5,104.5,30.5"];

  const spatialitePath = path.join(temporaryDirectory, "spatialite.sqlite");
  const create = await runCli(spatialitePath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "create",
    "--source-encoding", "UTF-8", "--create-spatial-index", ...fieldArgs, ...filterArgs,
  ]);
  assert.equal(create.engine, "sqlite");
  assert.equal(create.storage, "spatialite");
  assert.equal(create.successfulFeatures, 1);
  const spatialiteFirst = await withDatabase(spatialitePath, async (db) => {
    const rows = await db.query("SELECT id, display_name, score FROM roads ORDER BY id");
    const metadata = await db.query("SELECT spatial_index_enabled FROM geometry_columns WHERE lower(f_table_name) = 'roads'");
    const indexes = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) LIKE 'idx_roads_%'");
    return { rows: rows.rows, metadata: metadata.rows, indexes: indexes.rows };
  });
  assert.equal(spatialiteFirst.rows.length, 1);
  assert.equal(spatialiteFirst.rows[0].display_name, "成都东站");
  assert.equal(Number(spatialiteFirst.metadata[0]?.spatial_index_enabled), 1);
  assert.ok(spatialiteFirst.indexes.length > 0);

  const append = await runCli(spatialitePath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "append",
    "--source-encoding", "UTF-8", ...fieldArgs, ...filterArgs,
  ]);
  assert.equal(append.successfulFeatures, 1);
  const afterAppend = await withDatabase(spatialitePath, async (db) => db.query("SELECT count(*) AS count FROM roads"));
  assert.equal(Number(afterAppend.rows[0]?.count), 2);

  const exportPath = path.join(temporaryDirectory, "spatialite-export.gpkg");
  const exported = await runCli(spatialitePath, [
    "gis", "export", "--table", "roads", "--output", exportPath,
    "--field-map", "display_name=export_name",
  ]);
  assert.equal(exported.operationReport?.successfulFeatures, 2);
  const exportedInfo = await execFileAsync(path.join(runtimeBin, "ogrinfo.exe"), ["-json", "-ro", "-so", "-al", exportPath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const exportedLayer = JSON.parse(exportedInfo.stdout).layers.find((layer) => layer.name === "spatialite-export");
  assert.equal(exportedLayer.featureCount, 2);
  assert.ok(exportedLayer.fields.some((field) => field.name === "export_name"));

  const overwrite = await runCli(spatialitePath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "overwrite",
    "--source-encoding", "UTF-8", "--create-spatial-index", ...fieldArgs, ...filterArgs,
  ]);
  assert.equal(overwrite.successfulFeatures, 1);
  const afterOverwrite = await withDatabase(spatialitePath, async (db) => db.query("SELECT count(*) AS count FROM roads"));
  assert.equal(Number(afterOverwrite.rows[0]?.count), 1);
  evidence.checks.spatialite = {
    create: create.successfulFeatures,
    append: append.successfulFeatures,
    countAfterAppend: Number(afterAppend.rows[0]?.count),
    overwrite: overwrite.successfulFeatures,
    countAfterOverwrite: Number(afterOverwrite.rows[0]?.count),
    mappedChineseValue: spatialiteFirst.rows[0].display_name,
    spatialIndexEnabled: Number(spatialiteFirst.metadata[0]?.spatial_index_enabled),
    indexTableCount: spatialiteFirst.indexes.length,
    exportFeatures: exportedLayer.featureCount,
    exportFieldMapping: "display_name -> export_name",
    sha256: createHash("sha256").update(await (await import("node:fs/promises")).readFile(spatialitePath)).digest("hex"),
  };

  const geopackagePath = path.join(temporaryDirectory, "container.gpkg");
  const gpkgImport = await runCli(geopackagePath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "create",
    "--source-encoding", "UTF-8", "--create-spatial-index", ...filterArgs,
  ]);
  assert.equal(gpkgImport.storage, "geopackage");
  assert.equal(gpkgImport.successfulFeatures, 1);
  const gpkgAppend = await runCli(geopackagePath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "append",
    "--source-encoding", "UTF-8", ...filterArgs,
  ]);
  assert.equal(gpkgAppend.successfulFeatures, 1);
  const gpkgAfterAppend = await withDatabase(geopackagePath, async (db) => {
    const count = await db.query("SELECT count(*) AS count FROM roads");
    const metadata = await db.query("SELECT geometry_type_name, srs_id FROM gpkg_geometry_columns WHERE table_name = 'roads'");
    const indexes = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) LIKE 'rtree_roads_%'");
    return { count: Number(count.rows[0]?.count), metadata: metadata.rows, indexes: indexes.rows };
  });
  assert.equal(gpkgAfterAppend.count, 2);
  assert.equal(gpkgAfterAppend.metadata[0]?.geometry_type_name, "GEOMETRY");
  assert.ok(gpkgAfterAppend.indexes.length > 0);
  const gpkgExportPath = path.join(temporaryDirectory, "gpkg-export.geojson");
  const gpkgExport = await runCli(geopackagePath, ["gis", "export", "--table", "roads", "--output", gpkgExportPath]);
  assert.equal(gpkgExport.operationReport?.successfulFeatures, 2);

  const gpkgOverwrite = await runCli(geopackagePath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "overwrite",
    "--source-encoding", "UTF-8", "--create-spatial-index", ...filterArgs,
  ]);
  assert.equal(gpkgOverwrite.successfulFeatures, 1);
  const gpkgAfterOverwrite = await withDatabase(geopackagePath, async (db) => {
    const count = await db.query("SELECT count(*) AS count FROM roads");
    const metadata = await db.query("SELECT geometry_type_name, srs_id FROM gpkg_geometry_columns WHERE table_name = 'roads'");
    const indexes = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) LIKE 'rtree_roads_%'");
    return { count: Number(count.rows[0]?.count), metadata: metadata.rows, indexes: indexes.rows };
  });
  assert.equal(gpkgAfterOverwrite.count, 1);
  assert.equal(gpkgAfterOverwrite.metadata[0]?.geometry_type_name, "GEOMETRY");
  assert.ok(gpkgAfterOverwrite.indexes.length > 0);
  const gpkgOverwriteExportPath = path.join(temporaryDirectory, "gpkg-overwrite-export.geojson");
  const gpkgOverwriteExport = await runCli(geopackagePath, ["gis", "export", "--table", "roads", "--output", gpkgOverwriteExportPath]);
  assert.equal(gpkgOverwriteExport.operationReport?.successfulFeatures, 1);
  evidence.checks.geopackage = {
    importFeatures: gpkgImport.successfulFeatures,
    append: gpkgAppend.successfulFeatures,
    countAfterAppend: gpkgAfterAppend.count,
    overwrite: gpkgOverwrite.successfulFeatures,
    countAfterOverwrite: gpkgAfterOverwrite.count,
    geometryType: gpkgAfterOverwrite.metadata[0]?.geometry_type_name,
    srid: gpkgAfterOverwrite.metadata[0]?.srs_id,
    rtreeTablesAfterAppend: gpkgAfterAppend.indexes.length,
    rtreeTablesAfterOverwrite: gpkgAfterOverwrite.indexes.length,
    exportFeatures: gpkgExport.operationReport?.successfulFeatures,
    overwriteExportFeatures: gpkgOverwriteExport.operationReport?.successfulFeatures,
  };

  const plainPath = path.join(temporaryDirectory, "plain.sqlite");
  await withDatabase(plainPath, async (db) => {
    await db.query("CREATE TABLE keep_me (value TEXT)");
    await db.query("INSERT INTO keep_me(value) VALUES (?)", ["unchanged"]);
  });
  let plainError = "";
  try {
    await runCli(plainPath, ["gis", "import", "--file", sourcePath, "--target", "should_not_write", "--source-encoding", "UTF-8"]);
  } catch (error) {
    plainError = String(error.stderr ?? error.message);
  }
  assert.match(plainError, /no SpatiaLite or GeoPackage geometry metadata/i);
  const plainState = await withDatabase(plainPath, async (db) => {
    const preserved = await db.query("SELECT value FROM keep_me");
    const destination = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_write'");
    return { preserved: preserved.rows, destination: destination.rows };
  });
  assert.equal(plainState.preserved.length, 1);
  assert.equal(plainState.preserved[0]?.value, "unchanged");
  assert.equal(plainState.destination.length, 0);

  let appendInitializationError = "";
  try {
    await runCli(plainPath, [
      "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "append",
      "--source-encoding", "UTF-8", "--initialize-spatialite",
    ]);
  } catch (error) {
    appendInitializationError = String(error.stderr ?? error.message);
  }
  assert.match(appendInitializationError, /create mode/i);

  let collisionInitializationError = "";
  try {
    await runCli(plainPath, [
      "gis", "import", "--file", sourcePath, "--target", "keep_me", "--mode", "create",
      "--source-encoding", "UTF-8", "--initialize-spatialite",
    ]);
  } catch (error) {
    collisionInitializationError = String(error.stderr ?? error.message);
  }
  assert.match(collisionInitializationError, /already exists/i);

  const beforeInitialization = await withDatabase(plainPath, async (db) => {
    const metadata = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='geometry_columns'");
    const target = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='roads'");
    return { geometryColumns: metadata.rows.length, roads: target.rows.length };
  });
  assert.equal(beforeInitialization.geometryColumns, 0);
  assert.equal(beforeInitialization.roads, 0);

  const initializedImport = await runCli(plainPath, [
    "gis", "import", "--file", sourcePath, "--target", "roads", "--mode", "create",
    "--source-encoding", "UTF-8", "--initialize-spatialite", "--create-spatial-index",
  ]);
  assert.equal(initializedImport.storage, "spatialite");
  assert.equal(initializedImport.successfulFeatures, 2);
  const initializedState = await withDatabase(plainPath, async (db) => {
    const preserved = await db.query("SELECT value FROM keep_me");
    const count = await db.query("SELECT count(*) AS count FROM roads");
    const metadata = await db.query("SELECT spatial_index_enabled FROM geometry_columns WHERE lower(f_table_name) = 'roads'");
    const indexes = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) LIKE 'idx_roads_%'");
    return { preserved: preserved.rows, count: Number(count.rows[0]?.count), metadata: metadata.rows, indexes: indexes.rows };
  });
  assert.equal(initializedState.preserved[0]?.value, "unchanged");
  assert.equal(initializedState.count, 2);
  assert.equal(Number(initializedState.metadata[0]?.spatial_index_enabled), 1);
  assert.ok(initializedState.indexes.length > 0);
  const initializedExportPath = path.join(temporaryDirectory, "initialized-spatialite-export.geojson");
  const initializedExport = await runCli(plainPath, ["gis", "export", "--table", "roads", "--output", initializedExportPath]);
  assert.equal(initializedExport.operationReport?.successfulFeatures, 2);

  evidence.checks.plainSqliteGuard = {
    rejectedWithoutOptIn: true,
    appendModeRejectedBeforeInitialization: true,
    tableCollisionRejectedBeforeInitialization: true,
    existingRowsPreserved: true,
    destinationCreated: false,
    explicitlyInitialized: true,
    importedFeatures: initializedImport.successfulFeatures,
    spatialIndexEnabled: Number(initializedState.metadata[0]?.spatial_index_enabled),
    indexTableCount: initializedState.indexes.length,
    exportFeatures: initializedExport.operationReport?.successfulFeatures,
  };
  evidence.status = "passed";
  evidence.spatialiteDatabaseSha256 = evidence.checks.spatialite.sha256;
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error?.stack ?? error);
  throw error;
} finally {
  await mkdir(outputDirectory, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({ evidencePath, ...evidence }, null, 2));
