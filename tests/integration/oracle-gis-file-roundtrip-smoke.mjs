import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CoreService } from "../../packages/core/dist/index.js";
import { decodeGeoPackageGeometry } from "../../packages/core/dist/geopackage.js";
import { oracleConfigFromEnvironment, SqliteAdapter } from "../../packages/database/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const tempRoot = path.join(root, ".cache", "gis-roundtrip");
mkdirSync(tempRoot, { recursive: true });
const runtimeRoot = path.join(root, "apps/desktop/resources/gdal");
const runtimeDirectory = path.join(runtimeRoot, "bin");
if (existsSync(runtimeDirectory)) {
  process.env.DBSTUDIO_GDAL_BIN = runtimeDirectory;
  process.env.GDAL_DATA = path.join(runtimeRoot, "data");
  process.env.PROJ_DATA = path.join(runtimeRoot, "proj");
}

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^("|')(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(path.join(root, "docker", ".env"));
const environment = {
  ...dockerEnv,
  ...process.env,
  ORACLE_USER: process.env.DBSTUDIO_TRANSFER_ORACLE_USER || dockerEnv.ORACLE_USER || "SYSTEM",
  ORACLE_PASSWORD: process.env.DBSTUDIO_TRANSFER_ORACLE_PASSWORD || dockerEnv.ORACLE_PASSWORD,
  ORACLE_CONNECT_STRING: process.env.DBSTUDIO_TRANSFER_ORACLE_CONNECT_STRING
    || `//${process.env.DBSTUDIO_TRANSFER_ORACLE_HOST || "127.0.0.1"}:${process.env.DBSTUDIO_TRANSFER_ORACLE_PORT || "21521"}/${process.env.DBSTUDIO_TRANSFER_ORACLE_SERVICE || "FREEPDB1"}`,
};
assert.ok(environment.ORACLE_PASSWORD, "Oracle test password must be configured in docker/.env or DBSTUDIO_TRANSFER_ORACLE_PASSWORD.");
const config = oracleConfigFromEnvironment(environment);
const core = CoreService.fromOracleConfig(config, environment);
const runId = randomBytes(5).toString("hex").toUpperCase();
const schema = config.user.toUpperCase();
const table = `GISF_${runId}`;
const zTable = `GIS3_${runId}`;
const measuredTable = `GISM_${runId}`;
const indexedTable = `GISI_${runId}`;
const cliIndexedTable = `GISC_${runId}`;
const cliMeasuredTable = `GSDM_${runId}`;
const zExportTable = `GISE_${runId}`;
const temporaryDirectory = await mkdtemp(path.join(tempRoot, "oracle-file-"));
const sourcePath = path.join(temporaryDirectory, "xy-points.geojson");
const zSourcePath = path.join(temporaryDirectory, "xyz-point.geojson");
const measuredCsvPath = path.join(temporaryDirectory, "measured-points.csv");
const measuredSourcePath = path.join(temporaryDirectory, "measured-points.gpkg");
const outsideExtentSourcePath = path.join(temporaryDirectory, "outside-index-extent.geojson");
const outputPath = path.join(temporaryDirectory, "oracle-export.gpkg");
const zOutputPath = path.join(temporaryDirectory, "oracle-z-export.gpkg");
const cliZOutputPath = path.join(temporaryDirectory, "oracle-z-cli-export.gpkg");
const report = {
  date: new Date().toISOString(),
  localDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()),
  purpose: "Oracle SDO_GEOMETRY GIS file import/export dimension checks against the project-isolated Oracle Free service.",
  sourceModified: false,
  externalDataSent: false,
  testTablesCleaned: false,
  results: [],
};
const cleanupErrors = [];

const featureCollection = {
  type: "FeatureCollection",
  name: "features",
  features: [
    { type: "Feature", id: 1, properties: { label: "成都", score: 1.25 }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
    { type: "Feature", id: 2, properties: { label: "上海", score: 2.5 }, geometry: { type: "Point", coordinates: [121.4737, 31.2304] } },
    { type: "Feature", id: 3, properties: { label: "无坐标", score: 3.75 }, geometry: null },
  ],
};
function quoted(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function countRows(name) {
  const result = await core.query(`SELECT COUNT(*) AS total FROM ${quoted(schema)}.${quoted(name)}`);
  return Number(result.rows[0]?.total ?? result.rows[0]?.TOTAL ?? 0);
}

function pointCoordinates(wkt) {
  const match = /^\s*POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)\s*$/i.exec(String(wkt));
  assert.ok(match, `expected a WKT Point, received ${String(wkt)}`);
  return [Number(match[1]), Number(match[2])];
}

function readField(row, name) {
  return Object.hasOwn(row, name) ? row[name] : row[name.toUpperCase()];
}

function inspectDimensionalWkb(value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length >= 5, "expected complete WKB geometry");
  const littleEndian = bytes[0] === 1;
  assert.ok(littleEndian || bytes[0] === 0, "expected valid WKB byte order");
  const readUInt32 = (offset) => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const readDouble = (offset) => littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
  const encodedType = readUInt32(1);
  let dimensions = 2;
  let baseType = encodedType;
  if (encodedType >= 3_000 && encodedType < 4_000) {
    dimensions = 4;
    baseType -= 3_000;
  } else if (encodedType >= 2_000 && encodedType < 3_000) {
    dimensions = 3;
    baseType -= 2_000;
  } else if (encodedType >= 1_000 && encodedType < 2_000) {
    dimensions = 3;
    baseType -= 1_000;
  }
  let offset = 5;
  const coordinates = [];
  const readCoordinate = () => {
    const tuple = Array.from({ length: dimensions }, (_, index) => readDouble(offset + index * 8));
    offset += dimensions * 8;
    coordinates.push(tuple);
  };
  if (baseType === 1) {
    readCoordinate();
  } else if (baseType === 2) {
    const count = readUInt32(offset);
    offset += 4;
    for (let index = 0; index < count; index += 1) readCoordinate();
  } else if (baseType === 3) {
    const ringCount = readUInt32(offset);
    offset += 4;
    for (let ring = 0; ring < ringCount; ring += 1) {
      const count = readUInt32(offset);
      offset += 4;
      for (let index = 0; index < count; index += 1) readCoordinate();
    }
  } else {
    throw new Error(`unexpected exported geometry type ${baseType}`);
  }
  assert.equal(offset, bytes.length, "expected no trailing dimensional WKB bytes");
  return { baseType, dimensions, coordinates };
}

try {
  await writeFile(sourcePath, JSON.stringify(featureCollection), "utf8");
  await writeFile(zSourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "features",
    features: [{ type: "Feature", properties: { label: "3D" }, geometry: { type: "Point", coordinates: [104, 30, 5] } }],
  }), "utf8");
  await writeFile(measuredCsvPath, [
    "id,wkt,label",
    '1,"POINT M (104 30 7)",XYM',
    '2,"POINT ZM (105 31 6 8)",XYZM',
  ].join("\n"), "utf8");
  await execFileAsync(path.join(runtimeDirectory, "ogr2ogr.exe"), [
    "-f", "GPKG", measuredSourcePath, measuredCsvPath,
    "-oo", "GEOM_POSSIBLE_NAMES=wkt",
    "-a_srs", "EPSG:4326",
  ], { cwd: root, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  await writeFile(outsideExtentSourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "features",
    features: [{ type: "Feature", properties: { label: "越界" }, geometry: { type: "Point", coordinates: [250, 30] } }],
  }), "utf8");
  await core.testConnection();
  const imported = await core.importGisToOracle(sourcePath, table, schema, { mode: "create" });
  assert.equal(imported.successfulFeatures, 3);
  assert.equal(imported.srid, 4326);
  report.results.push({ operation: "create", successfulFeatures: imported.successfulFeatures, srid: imported.srid });

  const rows = [];
  for await (const batch of core.queryStream(
    `SELECT DBMS_LOB.SUBSTR(dbstudio_source."label", 4000, 1) AS label, dbstudio_source."score" AS score, `
      + `dbstudio_source."geom".SDO_SRID AS srid, `
      + `DBMS_LOB.SUBSTR(MDSYS.SDO_UTIL.TO_WKTGEOMETRY(dbstudio_source."geom"), 4000, 1) AS wkt `
      + `FROM ${quoted(schema)}.${quoted(table)} dbstudio_source`,
    [],
    { batchSize: 2 },
  )) rows.push(...batch.rows);
  assert.equal(rows.length, 3);
  const valuesByLabel = new Map(rows.map((row) => [readField(row, "label"), Number(readField(row, "score"))]));
  assert.equal(valuesByLabel.get("成都"), 1.25);
  assert.equal(valuesByLabel.get("上海"), 2.5);
  assert.ok(rows.every((row) => readField(row, "wkt") === null || Number(readField(row, "srid")) === 4326));
  assert.ok(rows.some((row) => {
    const [x, y] = pointCoordinates(readField(row, "wkt"));
    return Math.abs(x - 104.0665) < 1e-8 && Math.abs(y - 30.5723) < 1e-8;
  }));
  report.results.push({ operation: "readback", rows: rows.length, xyMatched: true, srid: 4326 });

  const xyzImport = await core.importGisToOracle(zSourcePath, zTable, schema, { mode: "create" });
  assert.equal(xyzImport.successfulFeatures, 1);
  const xyzRows = await core.query(
    `SELECT dbstudio_source."geom".SDO_GTYPE AS gtype, dbstudio_source."geom".SDO_SRID AS srid, `
      + `v.x AS x, v.y AS y, v.z AS z, v.w AS w FROM ${quoted(schema)}.${quoted(zTable)} dbstudio_source `
      + `CROSS JOIN TABLE(MDSYS.SDO_UTIL.GETVERTICES(dbstudio_source."geom")) v`,
  );
  assert.equal(xyzRows.rows.length, 1);
  assert.equal(Number(readField(xyzRows.rows[0], "gtype")), 3001);
  assert.ok(Number.isSafeInteger(xyzImport.srid) && xyzImport.srid > 0);
  assert.equal(Number(readField(xyzRows.rows[0], "srid")), xyzImport.srid);
  assert.equal(Number(readField(xyzRows.rows[0], "x")), 104);
  assert.equal(Number(readField(xyzRows.rows[0], "y")), 30);
  assert.equal(Number(readField(xyzRows.rows[0], "z")), 5);
  report.results.push({ operation: "import-xyz", successfulFeatures: 1, gtype: 3001, srid: xyzImport.srid, coordinates: [104, 30, 5] });

  const measuredImport = await core.importGisToOracle(measuredSourcePath, measuredTable, schema, { mode: "create" });
  assert.equal(measuredImport.successfulFeatures, 2);
  const measuredRows = await core.query(
    `SELECT DBMS_LOB.SUBSTR(dbstudio_source."label", 4000, 1) AS label, dbstudio_source."geom".SDO_GTYPE AS gtype, `
      + `dbstudio_source."geom".SDO_SRID AS srid, v.x AS x, v.y AS y, v.z AS z, v.w AS w `
      + `FROM ${quoted(schema)}.${quoted(measuredTable)} dbstudio_source `
      + `CROSS JOIN TABLE(MDSYS.SDO_UTIL.GETVERTICES(dbstudio_source."geom")) v`,
  );
  const measuredByLabel = new Map(measuredRows.rows.map((row) => [readField(row, "label"), row]));
  const xymRow = measuredByLabel.get("XYM");
  const xyzmRow = measuredByLabel.get("XYZM");
  assert.ok(xymRow);
  assert.ok(xyzmRow);
  assert.equal(Number(readField(xymRow, "gtype")), 3301);
  assert.equal(Number(readField(xymRow, "srid")), 4326);
  assert.deepEqual(["x", "y", "z"].map((name) => Number(readField(xymRow, name))), [104, 30, 7]);
  assert.equal(readField(xymRow, "w"), null);
  assert.equal(Number(readField(xyzmRow, "gtype")), 4401);
  assert.equal(Number(readField(xyzmRow, "srid")), 4326);
  assert.deepEqual(["x", "y", "z", "w"].map((name) => Number(readField(xyzmRow, name))), [105, 31, 6, 8]);
  report.results.push({
    operation: "import-xym-and-xyzm",
    successfulFeatures: 2,
    readback: { XYM: { gtype: 3301, coordinates: [104, 30, 7] }, XYZM: { gtype: 4401, coordinates: [105, 31, 6, 8] } },
  });

  const indexed = await core.importGisToOracle(sourcePath, indexedTable.toLowerCase(), schema.toLowerCase(), {
    mode: "create",
    createSpatialIndex: true,
  });
  assert.equal(indexed.table, indexedTable, "spatial-index import normalizes Oracle identifiers to uppercase");
  assert.equal(indexed.geometryColumn, "GEOM");
  assert.equal(indexed.successfulFeatures, 3);
  const metadataRows = await core.query(
    "SELECT TABLE_NAME, COLUMN_NAME, SRID FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME = :1",
    [indexedTable],
  );
  assert.equal(metadataRows.rows.length, 1);
  assert.equal(readField(metadataRows.rows[0], "TABLE_NAME"), indexedTable);
  assert.equal(readField(metadataRows.rows[0], "COLUMN_NAME"), "GEOM");
  assert.equal(Number(readField(metadataRows.rows[0], "SRID")), 4326);
  const spatialIndexes = await core.query(
    "SELECT INDEX_NAME, DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [indexedTable],
  );
  assert.equal(spatialIndexes.rows.length, 1);
  assert.equal(String(readField(spatialIndexes.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(spatialIndexes.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "spatial-index", table: indexed.table, geometryColumn: indexed.geometryColumn, metadataRegistered: true, indexStatus: "VALID" });

  const indexedAppend = await core.importGisToOracle(sourcePath, indexedTable, schema, {
    mode: "append",
    createSpatialIndex: true,
  });
  assert.equal(indexedAppend.successfulFeatures, 3);
  assert.equal(await countRows(indexedTable), 6);
  const appendedIndex = await core.query(
    "SELECT DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [indexedTable],
  );
  assert.equal(appendedIndex.rows.length, 1);
  assert.equal(String(readField(appendedIndex.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(appendedIndex.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "indexed-append", appended: indexedAppend.successfulFeatures, total: 6, indexStatus: "VALID" });

  let outOfBoundsAppendRejected = false;
  try {
    await core.importGisToOracle(outsideExtentSourcePath, indexedTable, schema, {
      mode: "append",
      createSpatialIndex: true,
    });
  } catch (error) {
    outOfBoundsAppendRejected = /outside the existing metadata bounds/i.test(error instanceof Error ? error.message : String(error));
  }
  assert.ok(outOfBoundsAppendRejected, "Oracle indexed append must reject source extents outside registered bounds before insertion.");
  assert.equal(await countRows(indexedTable), 6, "out-of-bounds append must leave existing rows unchanged");
  report.results.push({ operation: "reject-indexed-append-outside-bounds", rejected: true, totalUnchanged: true });

  const indexedOverwritten = await core.importGisToOracle(sourcePath, indexedTable, schema, {
    mode: "overwrite",
    createSpatialIndex: true,
  });
  assert.equal(indexedOverwritten.successfulFeatures, 3);
  assert.equal(await countRows(indexedTable), 3);
  const overwrittenMetadata = await core.query(
    "SELECT TABLE_NAME, COLUMN_NAME, SRID FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME = :1",
    [indexedTable],
  );
  assert.equal(overwrittenMetadata.rows.length, 1, "overwrite must leave exactly one spatial metadata row on the replacement table");
  assert.equal(readField(overwrittenMetadata.rows[0], "TABLE_NAME"), indexedTable);
  assert.equal(Number(readField(overwrittenMetadata.rows[0], "SRID")), 4326);
  const overwrittenIndex = await core.query(
    "SELECT DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [indexedTable],
  );
  assert.equal(overwrittenIndex.rows.length, 1, "overwrite must leave exactly one spatial index on the replacement table");
  assert.equal(String(readField(overwrittenIndex.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(overwrittenIndex.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "indexed-overwrite", successfulFeatures: 3, total: 3, metadataRows: 1, indexStatus: "VALID" });

  let indexedOverwriteRejected = false;
  try {
    await core.importGisToOracle(zSourcePath, indexedTable, schema, {
      mode: "overwrite",
      createSpatialIndex: true,
    });
  } catch (error) {
    indexedOverwriteRejected = /XY geometr|Z\/M/i.test(error instanceof Error ? error.message : String(error));
  }
  assert.ok(indexedOverwriteRejected, "Oracle indexed overwrite must reject XYZ data before replacing the current XY-indexed table.");
  assert.equal(await countRows(indexedTable), 3, "failed overwrite must preserve the original indexed table");
  const preservedOverwriteIndex = await core.query(
    "SELECT DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [indexedTable],
  );
  assert.equal(preservedOverwriteIndex.rows.length, 1);
  assert.equal(String(readField(preservedOverwriteIndex.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(preservedOverwriteIndex.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "reject-indexed-overwrite-xyz", rejected: true, originalRowsPreserved: true, indexStatus: "VALID" });

  const cliEnvironment = {
    ...process.env,
    DBSTUDIO_DATABASE_TYPE: "oracle",
    ORACLE_USER: config.user,
    ORACLE_PASSWORD: config.password,
    ORACLE_HOST: "127.0.0.1",
    ORACLE_PORT: process.env.ORACLE_PORT || "21521",
    ORACLE_SERVICE_NAME: process.env.ORACLE_SERVICE_NAME || "FREEPDB1",
    DBSTUDIO_GDAL_BIN: runtimeDirectory,
  };
  const cliMeasuredResult = await execFileAsync(process.execPath, [
    path.join(root, "apps/cli/dist/index.js"), "gis", "import",
    "--file", measuredSourcePath,
    "--target", `${schema}.${cliMeasuredTable}`,
  ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cliMeasured = JSON.parse(cliMeasuredResult.stdout);
  assert.equal(cliMeasured.successfulFeatures, 2);
  const cliMeasuredRows = await core.query(
    `SELECT dbstudio_source."geom".SDO_GTYPE AS gtype, v.z AS z, v.w AS w `
      + `FROM ${quoted(schema)}.${quoted(cliMeasuredTable)} dbstudio_source `
      + `CROSS JOIN TABLE(MDSYS.SDO_UTIL.GETVERTICES(dbstudio_source."geom")) v`,
  );
  const cliMeasuredByGtype = new Map(cliMeasuredRows.rows.map((row) => [Number(readField(row, "gtype")), row]));
  const cliXym = cliMeasuredByGtype.get(3301);
  const cliXyzm = cliMeasuredByGtype.get(4401);
  assert.ok(cliXym);
  assert.ok(cliXyzm);
  assert.equal(Number(readField(cliXym, "z")), 7);
  assert.equal(readField(cliXym, "w"), null);
  assert.equal(Number(readField(cliXyzm, "z")), 6);
  assert.equal(Number(readField(cliXyzm, "w")), 8);
  report.results.push({ operation: "cli-import-xym-and-xyzm", successfulFeatures: 2, gtypes: [3301, 4401], coordinates: [[104, 30, 7], [105, 31, 6, 8]] });

  const cliResult = await execFileAsync(process.execPath, [
    path.join(root, "apps/cli/dist/index.js"), "gis", "import",
    "--file", sourcePath,
    "--target", `${schema}.${cliIndexedTable.toLowerCase()}`,
    "--create-spatial-index",
  ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cliImport = JSON.parse(cliResult.stdout);
  assert.equal(cliImport.table, cliIndexedTable);
  assert.equal(cliImport.successfulFeatures, 3);
  const cliIndex = await core.query(
    "SELECT DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [cliIndexedTable],
  );
  assert.equal(cliIndex.rows.length, 1);
  assert.equal(String(readField(cliIndex.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(cliIndex.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "cli-spatial-index", table: cliImport.table, inserted: cliImport.successfulFeatures, indexStatus: "VALID" });

  const cliOverwriteResult = await execFileAsync(process.execPath, [
    path.join(root, "apps/cli/dist/index.js"), "gis", "import",
    "--file", sourcePath,
    "--target", `${schema}.${cliIndexedTable}`,
    "--mode", "overwrite",
    "--create-spatial-index",
  ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cliOverwrite = JSON.parse(cliOverwriteResult.stdout);
  assert.equal(cliOverwrite.successfulFeatures, 3);
  assert.equal(await countRows(cliIndexedTable), 3);
  const cliOverwriteMetadata = await core.query(
    "SELECT TABLE_NAME, COLUMN_NAME, SRID FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME = :1",
    [cliIndexedTable],
  );
  assert.equal(cliOverwriteMetadata.rows.length, 1);
  const cliOverwriteIndex = await core.query(
    "SELECT DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [cliIndexedTable],
  );
  assert.equal(cliOverwriteIndex.rows.length, 1);
  assert.equal(String(readField(cliOverwriteIndex.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(cliOverwriteIndex.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "cli-indexed-overwrite", total: 3, metadataRows: 1, indexStatus: "VALID" });

  const cliAppendResult = await execFileAsync(process.execPath, [
    path.join(root, "apps/cli/dist/index.js"), "gis", "import",
    "--file", sourcePath,
    "--target", `${schema}.${cliIndexedTable}`,
    "--mode", "append",
    "--create-spatial-index",
  ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cliAppend = JSON.parse(cliAppendResult.stdout);
  assert.equal(cliAppend.successfulFeatures, 3);
  assert.equal(await countRows(cliIndexedTable), 6);
  const cliAppendIndex = await core.query(
    "SELECT DOMIDX_OPSTATUS, STATUS FROM USER_INDEXES WHERE TABLE_NAME = :1 AND INDEX_TYPE = 'DOMAIN'",
    [cliIndexedTable],
  );
  assert.equal(cliAppendIndex.rows.length, 1);
  assert.equal(String(readField(cliAppendIndex.rows[0], "DOMIDX_OPSTATUS")).toUpperCase(), "VALID");
  assert.equal(String(readField(cliAppendIndex.rows[0], "STATUS")).toUpperCase(), "VALID");
  report.results.push({ operation: "cli-indexed-append", appended: 3, total: 6, indexStatus: "VALID" });

  const appended = await core.importGisToOracle(sourcePath, table, schema, { mode: "append" });
  assert.equal(appended.successfulFeatures, 3);
  assert.equal(await countRows(table), 6);
  report.results.push({ operation: "append", appended: appended.successfulFeatures, total: 6 });

  const overwritten = await core.importGisToOracle(sourcePath, table, schema, { mode: "overwrite" });
  assert.equal(overwritten.successfulFeatures, 3);
  assert.equal(await countRows(table), 3);
  report.results.push({ operation: "overwrite", successfulFeatures: overwritten.successfulFeatures, total: 3 });

  const exported = await core.exportGisFromOracle(table, schema, outputPath);
  assert.equal(exported.operationReport?.featureCount, 3);
  const exportedGpkg = new SqliteAdapter({ path: outputPath, readOnly: true });
  try {
    const check = await exportedGpkg.query("SELECT COUNT(*) AS total, COUNT(geom) AS geometry_count FROM features");
    assert.equal(Number(check.rows[0]?.total), 3);
    assert.equal(Number(check.rows[0]?.geometry_count), 2);
  } finally {
    await exportedGpkg.close();
  }
  report.results.push({ operation: "export", featureCount: exported.operationReport?.featureCount, outputFormat: exported.format });

  await core.query(`CREATE TABLE ${quoted(schema)}.${quoted(zExportTable)} ("id" NUMBER, "geom" MDSYS.SDO_GEOMETRY, "label" VARCHAR2(32))`);
  const exportFixtures = [
    `VALUES (1, MDSYS.SDO_GEOMETRY(3001, 4326, MDSYS.SDO_POINT_TYPE(104, 30, 5), NULL, NULL), 'xyz-point')`,
    `VALUES (2, MDSYS.SDO_GEOMETRY(3301, 4326, MDSYS.SDO_POINT_TYPE(105, 31, 7), NULL, NULL), 'xym-point')`,
    `VALUES (3, MDSYS.SDO_GEOMETRY(4401, 4326, NULL, MDSYS.SDO_ELEM_INFO_ARRAY(1, 1, 1), MDSYS.SDO_ORDINATE_ARRAY(106, 32, 6, 8)), 'xyzm-point')`,
    `VALUES (4, MDSYS.SDO_GEOMETRY(3002, 4326, NULL, MDSYS.SDO_ELEM_INFO_ARRAY(1, 2, 1), MDSYS.SDO_ORDINATE_ARRAY(104, 30, 5, 105, 31, 6)), 'xyz-line')`,
    `VALUES (5, MDSYS.SDO_GEOMETRY(3303, 4326, NULL, MDSYS.SDO_ELEM_INFO_ARRAY(1, 1003, 1), MDSYS.SDO_ORDINATE_ARRAY(104, 30, 7, 105, 30, 8, 105, 31, 9, 104, 30, 7)), 'xym-polygon')`,
    `VALUES (6, MDSYS.SDO_GEOMETRY(4402, 4326, NULL, MDSYS.SDO_ELEM_INFO_ARRAY(1, 2, 1), MDSYS.SDO_ORDINATE_ARRAY(106, 32, 6, 8, 107, 33, 9, 11)), 'xyzm-line')`,
  ];
  for (const values of exportFixtures) {
    await core.query(`INSERT INTO ${quoted(schema)}.${quoted(zExportTable)} ("id", "geom", "label") ${values}`);
  }
  const dimensionalExport = await core.exportGisFromOracle(zExportTable, schema, zOutputPath);
  assert.equal(dimensionalExport.operationReport?.featureCount, exportFixtures.length);
  const dimensionalGpkg = new SqliteAdapter({ path: zOutputPath, readOnly: true });
  try {
    const metadata = await dimensionalGpkg.query("SELECT z, m FROM gpkg_geometry_columns WHERE table_name = 'features'");
    assert.equal(Number(metadata.rows[0]?.z), 2);
    assert.equal(Number(metadata.rows[0]?.m), 2);
    const geometries = await dimensionalGpkg.query("SELECT id, geom FROM features ORDER BY id");
    assert.equal(geometries.rows.length, exportFixtures.length);
    const expected = [
      { label: "xyz-point", type: 1, dimensions: 3, coordinates: [[104, 30, 5]] },
      { label: "xym-point", type: 1, dimensions: 3, coordinates: [[105, 31, 7]] },
      { label: "xyzm-point", type: 1, dimensions: 4, coordinates: [[106, 32, 6, 8]] },
      { label: "xyz-line", type: 2, dimensions: 3, coordinates: [[104, 30, 5], [105, 31, 6]] },
      { label: "xym-polygon", type: 3, dimensions: 3, coordinates: [[104, 30, 7], [105, 30, 8], [105, 31, 9], [104, 30, 7]] },
      { label: "xyzm-line", type: 2, dimensions: 4, coordinates: [[106, 32, 6, 8], [107, 33, 9, 11]] },
    ];
    for (let index = 0; index < expected.length; index += 1) {
      const geometry = decodeGeoPackageGeometry(geometries.rows[index]?.geom);
      assert.ok(geometry, `expected GeoPackage geometry for ${expected[index].label}`);
      const actual = inspectDimensionalWkb(geometry.wkb);
      assert.equal(actual.baseType, expected[index].type, `${expected[index].label} geometry type`);
      assert.equal(actual.dimensions, expected[index].dimensions, `${expected[index].label} dimension count`);
      assert.deepEqual(actual.coordinates, expected[index].coordinates, `${expected[index].label} ordinates`);
    }
  } finally {
    await dimensionalGpkg.close();
  }
  const cliDimensionalExportResult = await execFileAsync(process.execPath, [
    path.join(root, "apps/cli/dist/index.js"), "gis", "export",
    "--table", `${schema}.${zExportTable}`,
    "--output", cliZOutputPath,
  ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const cliDimensionalExport = JSON.parse(cliDimensionalExportResult.stdout);
  assert.equal(cliDimensionalExport.operationReport?.featureCount ?? cliDimensionalExport.featureCount, exportFixtures.length);
  const cliDimensionalGpkg = new SqliteAdapter({ path: cliZOutputPath, readOnly: true });
  try {
    const metadata = await cliDimensionalGpkg.query("SELECT z, m FROM gpkg_geometry_columns WHERE table_name = 'features'");
    assert.equal(Number(metadata.rows[0]?.z), 2);
    assert.equal(Number(metadata.rows[0]?.m), 2);
    const geometries = await cliDimensionalGpkg.query("SELECT id, geom FROM features ORDER BY id");
    assert.equal(geometries.rows.length, exportFixtures.length);
    for (let index = 0; index < geometries.rows.length; index += 1) {
      const geometry = decodeGeoPackageGeometry(geometries.rows[index]?.geom);
      assert.ok(geometry);
      const actual = inspectDimensionalWkb(geometry.wkb);
      const expected = [
        { baseType: 1, dimensions: 3, coordinates: [[104, 30, 5]] },
        { baseType: 1, dimensions: 3, coordinates: [[105, 31, 7]] },
        { baseType: 1, dimensions: 4, coordinates: [[106, 32, 6, 8]] },
        { baseType: 2, dimensions: 3, coordinates: [[104, 30, 5], [105, 31, 6]] },
        { baseType: 3, dimensions: 3, coordinates: [[104, 30, 7], [105, 30, 8], [105, 31, 9], [104, 30, 7]] },
        { baseType: 2, dimensions: 4, coordinates: [[106, 32, 6, 8], [107, 33, 9, 11]] },
      ][index];
      assert.deepEqual(actual, expected, `CLI dimensional export feature ${index + 1}`);
    }
  } finally {
    await cliDimensionalGpkg.close();
  }
  report.results.push({
    operation: "export-zm",
    featureCount: dimensionalExport.operationReport?.featureCount,
    cliFeatureCount: cliDimensionalExport.operationReport?.featureCount ?? cliDimensionalExport.featureCount,
    dimensions: ["XYZ", "XYM", "XYZM"],
    geometryTypes: ["Point", "LineString", "Polygon"],
    gpkgOptionalDimensions: { z: 2, m: 2 },
    ordinatesRoundTripMatched: true,
  });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
  await core.query("DELETE FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME IN (:1, :2)", [indexedTable, cliIndexedTable]);
  } catch {
    // The metadata row may not exist if import failed before registration.
  }
  for (const name of [table, zTable, measuredTable, indexedTable, cliIndexedTable, cliMeasuredTable, zExportTable]) {
    try {
      await core.query(`DROP TABLE ${quoted(schema)}.${quoted(name)} PURGE`);
    } catch {
      const remaining = (await core.listTables(schema).catch(() => [])).some((item) => item.name === name);
      if (remaining) cleanupErrors.push(name);
    }
  }
  const remainingSpatialMetadata = await core.query(
    "SELECT COUNT(*) AS total FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME IN (:1, :2)",
    [indexedTable, cliIndexedTable],
  ).catch(() => ({ rows: [{ TOTAL: -1 }] }));
  if (Number(remainingSpatialMetadata.rows[0]?.TOTAL ?? remainingSpatialMetadata.rows[0]?.total ?? -1) !== 0) {
    cleanupErrors.push("Oracle spatial metadata");
  }
  const remainingSpatialIndexes = await core.query(
    "SELECT COUNT(*) AS total FROM USER_INDEXES WHERE TABLE_NAME IN (:1, :2) AND INDEX_TYPE = 'DOMAIN'",
    [indexedTable, cliIndexedTable],
  ).catch(() => ({ rows: [{ TOTAL: -1 }] }));
  if (Number(remainingSpatialIndexes.rows[0]?.TOTAL ?? remainingSpatialIndexes.rows[0]?.total ?? -1) !== 0) {
    cleanupErrors.push("Oracle spatial indexes");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  report.testTablesCleaned = cleanupErrors.length === 0;
  report.cleanupErrors = cleanupErrors;
  const evidencePath = path.join(tempRoot, `oracle-gis-file-roundtrip-${report.localDate.replaceAll("-", "")}.json`);
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (cleanupErrors.length > 0) throw new Error(`Oracle GIS test tables could not be cleaned: ${cleanupErrors.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, schema, table, results: report.results }, null, 2)}\n`);
