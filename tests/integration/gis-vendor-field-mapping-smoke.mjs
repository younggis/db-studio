import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CoreService } from "../../packages/core/dist/index.js";
import {
  MariaDbAdapter,
  MySqlAdapter,
  OracleAdapter,
  SqlServerAdapter,
  mariaDbConfigFromEnvironment,
  mysqlConfigFromEnvironment,
  oracleConfigFromEnvironment,
  sqlServerConfigFromEnvironment,
} from "../../packages/database/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const runtimeDirectory = path.join(root, "apps/desktop/resources/gdal/bin");
const cliPath = path.join(root, "apps/cli/dist/index.js");
if (!existsSync(runtimeDirectory)) throw new Error("The staged GDAL runtime is missing; build or restore it before running this test.");
const dockerEnvPath = path.join(root, "docker/.env");

function parseEnvFile(contents) {
  const env = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    env[match[1]] = value;
  }
  return env;
}

function quoteIdentifier(engine, identifier) {
  if (engine === "mysql" || engine === "mariadb") return `\`${identifier.replaceAll("`", "``")}\``;
  if (engine === "sqlserver") return `[${identifier.replaceAll("]", "]]")}]`;
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(engine, schema, table) {
  return `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`;
}

function readCell(row, name) {
  if (Object.hasOwn(row, name)) return row[name];
  const key = Object.keys(row).find((candidate) => candidate.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
  return key === undefined ? undefined : row[key];
}

function normalizeTime(value) {
  if (value instanceof Date) {
    return [value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()]
      .map((part) => String(part).padStart(2, "0")).join(":");
  }
  const match = /^\s*(\d{1,2}:\d{2}:\d{2})/.exec(String(value ?? ""));
  return match?.[1];
}

function normalizeDate(value) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? "");
  return /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
}

function normalizeDateTime(value) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? "");
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?/.exec(text);
  return match ? `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(3, "0").slice(0, 3)}` : undefined;
}

function temporalProjection(engine, columnName, temporalType) {
  const column = quoteIdentifier(engine, columnName);
  if (temporalType === "date") {
    if (engine === "mysql" || engine === "mariadb") return `DATE_FORMAT(${column}, '%Y-%m-%d') AS ${column}`;
    if (engine === "sqlserver") return `CONVERT(varchar(10), ${column}, 23) AS ${column}`;
    return `TO_CHAR(${column}, 'YYYY-MM-DD') AS ${column}`;
  }
  if (engine === "mysql" || engine === "mariadb") return `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%f') AS ${column}`;
  if (engine === "sqlserver") return `CONVERT(varchar(23), ${column}, 121) AS ${column}`;
  return `TO_CHAR(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3') AS ${column}`;
}

async function assertImportedGeometryValid(target, schema, table, outputPath) {
  const exportOptions = { sourceCrs: "EPSG:4326" };
  const exported = target.engine === "oracle"
    ? await target.core.exportGisFromOracle(table, schema, outputPath, exportOptions)
    : target.engine === "sqlserver"
      ? await target.core.exportGisFromSqlServer(table, schema, outputPath, exportOptions)
      : await target.core.exportGisFromMysqlFamily(table, schema, outputPath, exportOptions);
  assert.equal(exported.layers[0]?.featureCount, 1, `${target.engine} MakeValid export lost its feature`);
  const layerName = exported.layers[0]?.name;
  assert.ok(layerName, `${target.engine} MakeValid export has no layer`);
  const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
  const sql = `SELECT ST_IsValid(${quote("geom")}) AS geometry_valid FROM ${quote(layerName)}`;
  const { stdout } = await execFileAsync(path.join(runtimeDirectory, "ogrinfo.exe"), [
    "-ro", "-dialect", "SQLite", "-sql", sql, outputPath,
  ], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /geometry_valid\s+\([^)]*\)\s*=\s*1\b/i,
    `${target.engine} MakeValid geometry remained invalid after database readback`);
}

async function readGpkgFeatureIds(outputPath, layerName) {
  const sql = `SELECT "feature_no" FROM "${layerName.replaceAll('"', '""')}" ORDER BY "feature_no"`;
  const { stdout } = await execFileAsync(path.join(runtimeDirectory, "ogrinfo.exe"), [
    "-ro", "-dialect", "SQLite", "-sql", sql, outputPath,
  ], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 });
  return [...stdout.matchAll(/feature_no\s+\([^)]*\)\s*=\s*(-?\d+)/gi)].map((match) => Number(match[1]));
}

function expectType(columns, name, pattern) {
  const column = columns.find((item) => item.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
  assert.ok(column, `mapped column ${name} is missing`);
  assert.match(column.dataType, pattern, `mapped column ${name} has unexpected database type ${column.dataType}`);
}

const dockerEnv = parseEnvFile(await readFile(dockerEnvPath, "utf8"));
const testRunId = randomBytes(4).toString("hex").toUpperCase();
const artifactDirectory = path.join(root, ".cache", "gis-roundtrip");
await mkdir(artifactDirectory, { recursive: true });
const sourceDirectory = await mkdtemp(path.join(artifactDirectory, "vendor-field-map-"));
const sourcePath = path.join(sourceDirectory, "synthetic.geojson");
const invalidGeometryPath = path.join(sourceDirectory, "invalid-polygon.geojson");
const utf8TailJsonPath = path.join(sourceDirectory, "utf8-tail-source.geojson");
const utf8TailShapePath = path.join(sourceDirectory, "utf8-tail-source.shp");
const evidencePath = path.join(artifactDirectory, `gis-vendor-field-mapping-${testRunId.toLowerCase()}.json`);
const mappings = [
  { source: "source_id", target: "feature_no", targetType: "integer64" },
  { source: "source_name", target: "display_name", targetType: "string" },
  { source: "source_speed", target: "speed_value", targetType: "real" },
  { source: "source_time", target: "service_time", targetType: "time" },
  { source: "source_date", target: "service_date", targetType: "date" },
  { source: "source_datetime", target: "service_datetime", targetType: "datetime" },
];
const report = {
  date: new Date().toISOString(),
  purpose: "Live GIS field mapping, temporal value roundtrip, MakeValid repair, UTF-8 tail repair, and source-coordinate bounding-box filtering through isolated MySQL, MariaDB, SQL Server, and Oracle imports.",
  sourceModified: false,
  externalDataSent: false,
  testTablesCleaned: false,
  utf8TailSourceUnchanged: false,
  results: [],
};
const cleanupErrors = [];
let utf8TailSourceHashes = {};

await writeFile(sourcePath, JSON.stringify({
  type: "FeatureCollection",
  name: "field_mapping_source",
  features: [
    { type: "Feature", properties: { source_id: 17, source_name: "成都", source_speed: 42.5, source_time: "09:30:15", source_date: "2026-11-22", source_datetime: "2026-11-22T09:30:15.123" }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
    { type: "Feature", properties: { source_id: 18, source_name: "青城山", source_speed: 31.25, source_time: "12:45:30", source_date: "2026-11-22", source_datetime: "2026-11-22T12:45:30.456" }, geometry: { type: "Point", coordinates: [103.567, 30.9] } },
  ],
}), "utf8");
await writeFile(invalidGeometryPath, JSON.stringify({
  type: "FeatureCollection",
  name: "invalid_polygon_source",
  features: [
    { type: "Feature", properties: { feature_no: 1, place_name: "bowtie" }, geometry: { type: "Polygon", coordinates: [[[104, 30], [104.1, 30.1], [104, 30.1], [104.1, 30], [104, 30]]] } },
  ],
}), "utf8");
const gisEnvironment = { ...process.env, DBSTUDIO_GDAL_BIN: runtimeDirectory };
const mysqlConfig = mysqlConfigFromEnvironment(dockerEnv);
const mariaConfig = mariaDbConfigFromEnvironment(dockerEnv);
const sqlserverEnvironment = {
  ...dockerEnv,
  SQLSERVER_HOST: "127.0.0.1",
  SQLSERVER_PORT: dockerEnv.SQLSERVER_PORT || "21433",
  SQLSERVER_DATABASE: "dbstudio_test",
  SQLSERVER_USER: "sa",
  SQLSERVER_PASSWORD: dockerEnv.SQLSERVER_SA_PASSWORD,
  SQLSERVER_ENCRYPT: "true",
  SQLSERVER_TRUST_SERVER_CERTIFICATE: "true",
};
const sqlserverConfig = sqlServerConfigFromEnvironment(sqlserverEnvironment);
const oracleEnvironment = {
  ...dockerEnv,
  ORACLE_USER: dockerEnv.ORACLE_USER || "SYSTEM",
  ORACLE_PASSWORD: dockerEnv.ORACLE_PASSWORD,
  ORACLE_HOST: "127.0.0.1",
  ORACLE_PORT: dockerEnv.ORACLE_PORT || "21521",
  ORACLE_SERVICE_NAME: dockerEnv.ORACLE_SERVICE_NAME || "FREEPDB1",
};
delete oracleEnvironment.ORACLE_CONNECT_STRING;
delete oracleEnvironment.DBSTUDIO_ORACLE_CONNECT_STRING;
const oracleConfig = oracleConfigFromEnvironment(oracleEnvironment);

const targets = [
  { engine: "mysql", config: mysqlConfig, schema: mysqlConfig.database, core: new CoreService(() => new MySqlAdapter(mysqlConfig), gisEnvironment, false, "mysql") },
  { engine: "mariadb", config: mariaConfig, schema: mariaConfig.database, core: new CoreService(() => new MariaDbAdapter(mariaConfig), gisEnvironment, false, "mariadb") },
  { engine: "sqlserver", config: sqlserverConfig, schema: "dbo", core: new CoreService(() => new SqlServerAdapter(sqlserverConfig), gisEnvironment, false, "sqlserver") },
  { engine: "oracle", config: oracleConfig, schema: oracleConfig.user.toLocaleUpperCase("en-US"), core: new CoreService(() => new OracleAdapter(oracleConfig), gisEnvironment, false, "oracle") },
];

try {
  await writeFile(utf8TailJsonPath, JSON.stringify({
    type: "FeatureCollection",
    name: "utf8_tail_source",
    features: [
      { type: "Feature", properties: { CITY: "成都" }, geometry: { type: "Point", coordinates: [104.0665, 30.5723] } },
    ],
  }), "utf8");
  await execFileAsync(path.join(runtimeDirectory, "ogr2ogr.exe"), [
    "-f", "ESRI Shapefile", "-lco", "ENCODING=UTF-8", "-nln", "utf8_tail_source", utf8TailShapePath, utf8TailJsonPath,
  ], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 });
  const utf8TailDbfPath = path.join(sourceDirectory, "utf8-tail-source.dbf");
  const utf8TailDbf = await readFile(utf8TailDbfPath);
  const truncatedSequence = Buffer.from([0xe9, 0x83, 0xbd]);
  const truncatedOffset = utf8TailDbf.indexOf(truncatedSequence);
  assert.ok(truncatedOffset >= 0, "Synthetic UTF-8 Shapefile did not contain the expected final character bytes");
  assert.equal(utf8TailDbf.indexOf(truncatedSequence, truncatedOffset + 1), -1, "Synthetic UTF-8 Shapefile contains an ambiguous mutation target");
  utf8TailDbf[truncatedOffset + 2] = 0x20;
  await writeFile(utf8TailDbfPath, utf8TailDbf);
  const utf8TailSourceFiles = (await readdir(sourceDirectory))
    .filter((name) => name.toLocaleLowerCase("en-US").startsWith("utf8-tail-source.")).sort();
  utf8TailSourceHashes = Object.fromEntries(await Promise.all(utf8TailSourceFiles.map(async (name) => [
    name, createHash("sha256").update(await readFile(path.join(sourceDirectory, name))).digest("hex"),
  ])));
  for (const target of targets) {
    assert.ok(target.schema, `${target.engine} test database/schema is not configured`);
    const table = target.engine === "oracle"
      ? `GISFM_${testRunId}`
      : `gisfm_${target.engine}_${testRunId.toLocaleLowerCase("en-US")}`;
    const filteredTable = target.engine === "oracle"
      ? "GISFM_" + testRunId + "_B"
      : "gisfm_" + target.engine + "_" + testRunId.toLocaleLowerCase("en-US") + "_bbox";
    const makeValidCoreTable = target.engine === "oracle"
      ? `GISMV_${testRunId}_C`
      : `gismv_${target.engine}_${testRunId.toLocaleLowerCase("en-US")}_core`;
    const makeValidCliTable = target.engine === "oracle"
      ? `GISMV_${testRunId}_L`
      : `gismv_${target.engine}_${testRunId.toLocaleLowerCase("en-US")}_cli`;
    const utf8TailCoreTable = target.engine === "oracle"
      ? `GISTL_${testRunId}_C`
      : `gistl_${target.engine}_${testRunId.toLocaleLowerCase("en-US")}_core`;
    const utf8TailCliTable = target.engine === "oracle"
      ? `GISTL_${testRunId}_L`
      : `gistl_${target.engine}_${testRunId.toLocaleLowerCase("en-US")}_cli`;
    const qualified = qualifiedTable(target.engine, target.schema, table);
    const qualifiedFiltered = qualifiedTable(target.engine, target.schema, filteredTable);
    const utf8TailColumnProjection = target.engine === "oracle"
      ? `DBMS_LOB.SUBSTR(${quoteIdentifier(target.engine, "CITY")}, 4000, 1) AS ${quoteIdentifier(target.engine, "CITY")}`
      : quoteIdentifier(target.engine, "CITY");
    let cleanupVerified = false;
    try {
      await target.core.testConnection();
      const reportRow = target.engine === "oracle"
        ? await target.core.importGisToOracle(sourcePath, table, target.schema, { mode: "create", fieldMappings: mappings })
        : target.engine === "sqlserver"
          ? await target.core.importGisToSqlServer(sourcePath, table, target.schema, { mode: "create", fieldMappings: mappings })
          : await target.core.importGisToMysqlFamily(sourcePath, table, target.schema, { mode: "create", fieldMappings: mappings });
      assert.equal(reportRow?.successfulFeatures, 2, `${target.engine} import did not insert two features`);
      assert.equal(reportRow?.srid, 4326, `${target.engine} import did not preserve EPSG:4326`);

      const columns = await target.core.getTableColumns(table, target.schema);
      expectType(columns, "feature_no", /BIGINT|NUMBER/i);
      expectType(columns, "display_name", /TEXT|CLOB|NVARCHAR/i);
      expectType(columns, "speed_value", /DOUBLE|REAL|FLOAT|BINARY_DOUBLE/i);
      expectType(columns, "service_time", /TIME|VARCHAR2/i);
      expectType(columns, "service_date", /\bDATE\b/i);
      expectType(columns, "service_datetime", /DATETIME|TIMESTAMP/i);
      const selectedColumns = ["feature_no", "display_name", "speed_value", "service_time"].map((name) => {
        const quoted = quoteIdentifier(target.engine, name);
        const column = columns.find((item) => item.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
        return target.engine === "oracle" && /\bCLOB\b/i.test(column?.dataType ?? "")
          ? `DBMS_LOB.SUBSTR(${quoted}, 4000, 1) AS ${quoted}`
          : quoted;
      });
      selectedColumns.push(temporalProjection(target.engine, "service_date", "date"));
      selectedColumns.push(temporalProjection(target.engine, "service_datetime", "datetime"));
      const result = await target.core.query(
        `SELECT ${selectedColumns.join(", ")} `
          + `FROM ${qualified} ORDER BY ${quoteIdentifier(target.engine, "feature_no")}`,
      );
      assert.equal(result.rows.length, 2, `${target.engine} readback returned the wrong row count`);
      assert.deepEqual(result.rows.map((row) => Number(readCell(row, "feature_no"))), [17, 18]);
      assert.deepEqual(result.rows.map((row) => readCell(row, "display_name")), ["成都", "青城山"]);
      assert.deepEqual(result.rows.map((row) => Number(readCell(row, "speed_value"))), [42.5, 31.25]);
      assert.deepEqual(result.rows.map((row) => normalizeTime(readCell(row, "service_time"))), ["09:30:15", "12:45:30"]);
      assert.deepEqual(result.rows.map((row) => normalizeDate(readCell(row, "service_date"))), ["2026-11-22", "2026-11-22"]);
      assert.deepEqual(result.rows.map((row) => normalizeDateTime(readCell(row, "service_datetime"))), ["2026-11-22T09:30:15.123", "2026-11-22T12:45:30.456"]);
      const spatialFilter = { minX: 104, minY: 30.5, maxX: 104.2, maxY: 30.7 };
      const cliEnvironment = {
        ...process.env,
        ...dockerEnv,
        DBSTUDIO_DATABASE_TYPE: target.engine,
        DBSTUDIO_GDAL_BIN: runtimeDirectory,
        ...(target.engine === "sqlserver" ? sqlserverEnvironment : {}),
        ...(target.engine === "oracle" ? oracleEnvironment : {}),
      };
      const mappingArgs = mappings.flatMap((mapping) => [
        "--field-map", mapping.source + "=" + mapping.target,
        "--field-type", mapping.source + "=" + mapping.targetType,
      ]);
      const cliImport = await execFileAsync(process.execPath, [
        cliPath, "gis", "import",
        "--connection", "environment",
        "--file", sourcePath,
        "--target", target.schema + "." + filteredTable,
        "--mode", "create",
        "--source-encoding", "UTF-8",
        "--bbox", [spatialFilter.minX, spatialFilter.minY, spatialFilter.maxX, spatialFilter.maxY].join(","),
        ...mappingArgs,
      ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 1024 * 1024 });
      const filteredReport = JSON.parse(cliImport.stdout);
      assert.equal(filteredReport.successfulFeatures, 1, target.engine + " bbox import did not select exactly one feature");
      assert.equal(filteredReport.srid, 4326, target.engine + " bbox import changed the source SRID");
      const filteredRows = await target.core.query(
        "SELECT " + quoteIdentifier(target.engine, "feature_no") + " FROM " + qualifiedFiltered
          + " ORDER BY " + quoteIdentifier(target.engine, "feature_no"),
      );
      assert.deepEqual(filteredRows.rows.map((row) => Number(readCell(row, "feature_no"))), [17],
        target.engine + " bbox import included an out-of-range feature or excluded the in-range feature");

      const exportFilter = { minX: 104, minY: 30.5, maxX: 104.2, maxY: 30.7 };
      const exportBbox = [exportFilter.minX, exportFilter.minY, exportFilter.maxX, exportFilter.maxY].join(",");
      const coreExportPath = path.join(sourceDirectory, `${target.engine}-core-export-bbox.gpkg`);
      const coreExportOptions = { sourceCrs: "EPSG:4326", targetLayerName: "bbox_filtered", spatialFilter: exportFilter };
      const coreExport = target.engine === "oracle"
        ? await target.core.exportGisFromOracle(table, target.schema, coreExportPath, coreExportOptions)
        : target.engine === "sqlserver"
          ? await target.core.exportGisFromSqlServer(table, target.schema, coreExportPath, coreExportOptions)
          : await target.core.exportGisFromMysqlFamily(table, target.schema, coreExportPath, coreExportOptions);
      const mysqlSourceGeometry = target.engine === "mysql"
        ? (await target.core.query(`SELECT ${quoteIdentifier(target.engine, "feature_no")}, ST_AsText(${quoteIdentifier(target.engine, "geom")}, 'axis-order=long-lat') AS geom_wkt, ST_SRID(${quoteIdentifier(target.engine, "geom")}) AS geom_srid FROM ${qualified} ORDER BY ${quoteIdentifier(target.engine, "feature_no")}`)).rows
        : undefined;
      assert.equal(coreExport.operationReport?.successfulFeatures, 1,
        `${target.engine} Core export bbox did not select one feature: ${JSON.stringify({ mysqlSourceGeometry, report: { featureCount: coreExport.operationReport?.featureCount, successfulFeatures: coreExport.operationReport?.successfulFeatures }, outputLayers: coreExport.layers.map(({ name, featureCount, extent }) => ({ name, featureCount, extent })) })}`);
      assert.deepEqual(await readGpkgFeatureIds(coreExportPath, "bbox_filtered"), [17],
        `${target.engine} Core export bbox selected the wrong feature`);

      const cliExportPath = path.join(sourceDirectory, `${target.engine}-cli-export-bbox.gpkg`);
      const cliExportResult = await execFileAsync(process.execPath, [
        cliPath, "gis", "export",
        "--connection", "environment",
        "--table", target.schema + "." + table,
        "--output", cliExportPath,
        "--target-layer", "bbox_filtered",
        "--source-crs", "EPSG:4326",
        "--bbox", exportBbox,
      ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 1024 * 1024 });
      const cliExport = JSON.parse(cliExportResult.stdout);
      assert.equal(cliExport.operationReport?.successfulFeatures, 1,
        `${target.engine} CLI export bbox did not select one feature`);
      assert.deepEqual(await readGpkgFeatureIds(cliExportPath, "bbox_filtered"), [17],
        `${target.engine} CLI export bbox selected the wrong feature`);

      const makeValidCoreReport = target.engine === "oracle"
        ? await target.core.importGisToOracle(invalidGeometryPath, makeValidCoreTable, target.schema, { mode: "create", makeValid: true })
        : target.engine === "sqlserver"
          ? await target.core.importGisToSqlServer(invalidGeometryPath, makeValidCoreTable, target.schema, { mode: "create", makeValid: true })
          : await target.core.importGisToMysqlFamily(invalidGeometryPath, makeValidCoreTable, target.schema, { mode: "create", makeValid: true });
      assert.equal(makeValidCoreReport.successfulFeatures, 1, `${target.engine} Core MakeValid import lost its feature`);
      assert.ok(makeValidCoreReport.warnings?.some((warning) => warning.includes("GDAL MakeValid")),
        `${target.engine} MakeValid warning was not returned`);
      const makeValidCoreExport = path.join(sourceDirectory, `${target.engine}-makevalid-core.gpkg`);
      await assertImportedGeometryValid(target, target.schema, makeValidCoreTable, makeValidCoreExport);

      const makeValidCliImport = await execFileAsync(process.execPath, [
        cliPath, "gis", "import",
        "--connection", "environment",
        "--file", invalidGeometryPath,
        "--target", target.schema + "." + makeValidCliTable,
        "--mode", "create",
        "--source-encoding", "UTF-8",
        "--make-valid",
      ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 1024 * 1024 });
      const makeValidCliReport = JSON.parse(makeValidCliImport.stdout);
      assert.equal(makeValidCliReport.successfulFeatures, 1, `${target.engine} CLI MakeValid import lost its feature`);
      assert.ok(makeValidCliReport.warnings?.some((warning) => warning.includes("GDAL MakeValid")),
        `${target.engine} CLI MakeValid warning was not returned`);
      const makeValidCliExport = path.join(sourceDirectory, `${target.engine}-makevalid-cli.gpkg`);
      await assertImportedGeometryValid(target, target.schema, makeValidCliTable, makeValidCliExport);

      const utf8TailCoreReport = target.engine === "oracle"
        ? await target.core.importGisToOracle(utf8TailShapePath, utf8TailCoreTable, target.schema, { mode: "create", sourceEncoding: "UTF-8", replaceIncompleteUtf8Tails: true })
        : target.engine === "sqlserver"
          ? await target.core.importGisToSqlServer(utf8TailShapePath, utf8TailCoreTable, target.schema, { mode: "create", sourceEncoding: "UTF-8", replaceIncompleteUtf8Tails: true })
          : await target.core.importGisToMysqlFamily(utf8TailShapePath, utf8TailCoreTable, target.schema, { mode: "create", sourceEncoding: "UTF-8", replaceIncompleteUtf8Tails: true });
      assert.equal(utf8TailCoreReport.successfulFeatures, 1, `${target.engine} Core UTF-8 tail repair lost its feature`);
      assert.ok(utf8TailCoreReport.warnings?.some((warning) => warning.includes("CITY: 1 record(s)") && warning.includes("source files are unchanged")),
        `${target.engine} Core UTF-8 tail repair warning did not identify the repaired field and unchanged source`);
      const utf8TailCoreRows = await target.core.query(
        `SELECT ${utf8TailColumnProjection} FROM ${qualifiedTable(target.engine, target.schema, utf8TailCoreTable)}`,
      );
      assert.deepEqual(utf8TailCoreRows.rows.map((row) => String(readCell(row, "CITY")).trimEnd()), ["成?"],
        `${target.engine} Core UTF-8 tail repair did not preserve the complete prefix and replace only the truncated terminal code point`);

      const utf8TailCliImport = await execFileAsync(process.execPath, [
        cliPath, "gis", "import",
        "--connection", "environment",
        "--file", utf8TailShapePath,
        "--target", target.schema + "." + utf8TailCliTable,
        "--mode", "create",
        "--source-encoding", "UTF-8",
        "--replace-incomplete-utf8-tails",
      ], { cwd: root, env: cliEnvironment, windowsHide: true, maxBuffer: 1024 * 1024 });
      const utf8TailCliReport = JSON.parse(utf8TailCliImport.stdout);
      assert.equal(utf8TailCliReport.successfulFeatures, 1, `${target.engine} CLI UTF-8 tail repair lost its feature`);
      assert.ok(utf8TailCliReport.warnings?.some((warning) => warning.includes("CITY: 1 record(s)") && warning.includes("source files are unchanged")),
        `${target.engine} CLI UTF-8 tail repair warning did not identify the repaired field and unchanged source`);
      const utf8TailCliRows = await target.core.query(
        `SELECT ${utf8TailColumnProjection} FROM ${qualifiedTable(target.engine, target.schema, utf8TailCliTable)}`,
      );
      assert.deepEqual(utf8TailCliRows.rows.map((row) => String(readCell(row, "CITY")).trimEnd()), ["成?"],
        `${target.engine} CLI UTF-8 tail repair did not preserve the complete prefix and replace only the truncated terminal code point`);
      report.results.push({
        engine: target.engine,
        featureCount: reportRow.successfulFeatures,
        srid: reportRow.srid,
        filteredFeatureCount: filteredReport.successfulFeatures,
        filteredIdsMatched: true,
        coreExportBboxFeatureCount: coreExport.operationReport?.successfulFeatures,
        coreExportBboxIdMatched: true,
        cliExportBboxFeatureCount: cliExport.operationReport?.successfulFeatures,
        cliExportBboxIdMatched: true,
        mappedColumns: ["feature_no", "display_name", "speed_value", "service_time", "service_date", "service_datetime"],
        mappedTypeChecks: true,
        mappedTypes: Object.fromEntries(columns.filter((column) => ["feature_no", "display_name", "speed_value", "service_time", "service_date", "service_datetime"].includes(column.name.toLocaleLowerCase("en-US"))).map((column) => [column.name, column.dataType])),
        rowValuesMatched: true,
        timeValuesMatched: true,
        dateValuesMatched: true,
        datetimeValuesMatched: true,
        makeValidCoreMatched: true,
        makeValidCliMatched: true,
        utf8TailCoreMatched: true,
        utf8TailCliMatched: true,
        status: "passed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.results.push({ engine: target.engine, status: "failed", errorClass: message.split(/\s+/).slice(0, 3).join(" ") });
      const safeMessage = message.length > 600 ? `${message.slice(0, 600)}…` : message;
      throw new Error(`${target.engine} GIS field-mapping acceptance failed: ${safeMessage}`);
    } finally {
      try {
        const ownedTables = [table, filteredTable, makeValidCoreTable, makeValidCliTable, utf8TailCoreTable, utf8TailCliTable];
        for (const ownedTable of ownedTables) {
          const existing = (await target.core.listTables(target.schema))
            .some((item) => item.name.toLocaleLowerCase("en-US") === ownedTable.toLocaleLowerCase("en-US"));
          if (!existing) continue;
          const qualifiedOwned = qualifiedTable(target.engine, target.schema, ownedTable);
          const drop = target.engine === "oracle"
            ? `DROP TABLE ${qualifiedOwned} PURGE`
            : `DROP TABLE IF EXISTS ${qualifiedOwned}`;
          await target.core.query(drop);
        }
        const remainingTables = await target.core.listTables(target.schema);
        cleanupVerified = ![table, filteredTable, makeValidCoreTable, makeValidCliTable, utf8TailCoreTable, utf8TailCliTable].some((cleanupTable) =>
          remainingTables.some((item) => item.name.toLocaleLowerCase("en-US") === cleanupTable.toLocaleLowerCase("en-US")));
        if (!cleanupVerified) cleanupErrors.push(`${target.engine}:temporary-table-remains`);
      } catch {
        cleanupErrors.push(`${target.engine}:cleanup-check-failed`);
      }
      report.results.at(-1).testTableCleaned = cleanupVerified;
    }
  }
  report.status = cleanupErrors.length === 0 ? "passed" : "failed";
  report.testTablesCleaned = cleanupErrors.length === 0 && report.results.every((item) => item.testTableCleaned);
  report.cleanupErrors = cleanupErrors;
} finally {
  if (report.status === undefined) {
    report.status = "failed";
    report.testTablesCleaned = report.results.length === targets.length && report.results.every((item) => item.testTableCleaned);
    report.cleanupErrors = cleanupErrors;
  }
  try {
    const currentFiles = (await readdir(sourceDirectory)).filter((name) => name.toLocaleLowerCase("en-US").startsWith("utf8-tail-source."));
    currentFiles.sort();
    const currentHashes = Object.fromEntries(await Promise.all(currentFiles.map(async (name) => [
      name, createHash("sha256").update(await readFile(path.join(sourceDirectory, name))).digest("hex"),
    ])));
    report.utf8TailSourceUnchanged = Object.keys(utf8TailSourceHashes).length > 0
      && JSON.stringify(currentHashes) === JSON.stringify(utf8TailSourceHashes);
  } catch {
    report.utf8TailSourceUnchanged = false;
  }
  await rm(sourceDirectory, { recursive: true, force: true });
  report.sourceRemoved = !existsSync(sourceDirectory) && !existsSync(sourcePath) && !existsSync(invalidGeometryPath);
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

  console.log(JSON.stringify({ status: report.status, engines: report.results.map((item) => ({ engine: item.engine, status: item.status, rowValuesMatched: item.rowValuesMatched ?? false, filteredIdsMatched: item.filteredIdsMatched ?? false, makeValidCoreMatched: item.makeValidCoreMatched ?? false, makeValidCliMatched: item.makeValidCliMatched ?? false, utf8TailCoreMatched: item.utf8TailCoreMatched ?? false, utf8TailCliMatched: item.utf8TailCliMatched ?? false, testTableCleaned: item.testTableCleaned ?? false })), sourceRemoved: report.sourceRemoved, testTablesCleaned: report.testTablesCleaned, utf8TailSourceUnchanged: report.utf8TailSourceUnchanged, externalDataSent: report.externalDataSent, evidence: path.relative(root, evidencePath) }, null, 2));
  if (report.status !== "passed" || !report.sourceRemoved || !report.testTablesCleaned || !report.utf8TailSourceUnchanged) process.exitCode = 1;
