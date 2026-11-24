import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const fixture = path.join(root, "tests", "fixtures", "points.geojson");
const localEnvPath = path.join(root, "docker", ".env");

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

assert.ok(environment.PGDATABASE, "Set PGDATABASE or configure docker/.env first.");
assert.ok(environment.PGUSER, "Set PGUSER or configure docker/.env first.");
assert.ok(environment.PGPASSWORD, "Set PGPASSWORD or configure docker/.env first.");
assert.ok(existsSync(cli), "Build the CLI first with `pnpm run build`.");
assert.ok(existsSync(fixture), "The GIS integration fixture is missing.");
assert.ok(gdalBin && existsSync(path.join(gdalBin, process.platform === "win32" ? "ogrinfo.exe" : "ogrinfo")),
  "Set DBSTUDIO_GDAL_BIN to a GDAL/OGR bin directory.");

const ogrinfo = path.join(gdalBin, process.platform === "win32" ? "ogrinfo.exe" : "ogrinfo");
const runId = `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const outputDir = path.join(root, ".cache", `postgis-roundtrip-${runId}`);
mkdirSync(outputDir, { recursive: true });
const temporaryGisTables = new Set();

function invokeDbStudio(args, parseJson = false) {
  try {
      const output = execFileSync(process.execPath, [cli, ...args], {
        cwd: root,
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }).trim();
      return parseJson ? JSON.parse(output) : output;
    } catch (error) {
      const details = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`dbstudio ${args[0]} ${args[1]} failed${details ? `:\n${details}` : "."}`);
    }
  }

  function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  function closeEnough(actual, expected, tolerance, label) {
    assert.ok(Math.abs(Number(actual) - expected) <= tolerance,
      `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }

  let result;
  let primaryError;
  try {
  const health = invokeDbStudio([
    "query", "run", "--sql", "SELECT current_database() AS database, current_setting('server_version') AS server_version",
    "--format", "json",
  ], true);
  assert.equal(health.rowCount, 1, "PostGIS connection must answer a query.");

  const dataTable = `dbdt_${runId}`;
  const csvTable = `${dataTable}_csv`;
  const jsonTable = `${dataTable}_json`;
  const xlsxTable = `${dataTable}_xlsx`;
  const dataRows = [
    { id: 1, label: "甲,中文", note: "line one\nline two" },
    { id: 2, label: "乙", note: null },
  ];
  const dataExport = {};
  try {
    for (const table of [dataTable, csvTable, jsonTable, xlsxTable]) {
      invokeDbStudio([
        "query", "run", "--sql",
        `CREATE TABLE public.${quoteIdentifier(table)} (id integer PRIMARY KEY, label text NOT NULL, note text)`,
        "--format", "json",
      ], true);
    }
    for (const row of dataRows) {
      invokeDbStudio([
        "query", "run", "--sql",
        `INSERT INTO public.${quoteIdentifier(dataTable)} (id, label, note) VALUES ($1, $2, $3)`,
        "--params", JSON.stringify([row.id, row.label, row.note]), "--format", "json",
      ], true);
    }

    const csvPath = path.join(outputDir, "table-data.csv");
    const jsonPath = path.join(outputDir, "table-data.json");
    const xlsxPath = path.join(outputDir, "table-data.xlsx");
    const csvSummary = invokeDbStudio([
      "data", "export", "--table", dataTable, "--schema", "public", "--output", csvPath, "--format", "csv",
    ], true);
    const jsonSummary = invokeDbStudio([
      "data", "export", "--table", dataTable, "--schema", "public", "--output", jsonPath, "--format", "json",
    ], true);
    const xlsxSummary = invokeDbStudio([
      "data", "export", "--table", dataTable, "--schema", "public", "--output", xlsxPath, "--format", "xlsx",
    ], true);
    assert.equal(csvSummary.rowCount, 2, "PostgreSQL CSV export row count mismatch.");
    assert.equal(jsonSummary.rowCount, 2, "PostgreSQL JSON export row count mismatch.");
    assert.equal(xlsxSummary.rowCount, 2, "PostgreSQL XLSX export row count mismatch.");

    const csvImport = invokeDbStudio([
      "data", "import", "--table", csvTable, "--schema", "public", "--input", csvPath, "--format", "csv",
    ], true);
    const jsonImport = invokeDbStudio([
      "data", "import", "--table", jsonTable, "--schema", "public", "--input", jsonPath, "--format", "json",
    ], true);
    const xlsxImport = invokeDbStudio([
      "data", "import", "--table", xlsxTable, "--schema", "public", "--input", xlsxPath, "--format", "xlsx",
    ], true);
    assert.equal(csvImport.insertedRows, 2, "PostgreSQL CSV import row count mismatch.");
    assert.equal(jsonImport.insertedRows, 2, "PostgreSQL JSON import row count mismatch.");
    assert.equal(xlsxImport.insertedRows, 2, "PostgreSQL XLSX import row count mismatch.");

    for (const table of [csvTable, jsonTable, xlsxTable]) {
      const roundTrip = invokeDbStudio([
        "query", "run", "--sql",
        `SELECT id, label, note FROM public.${quoteIdentifier(table)} ORDER BY id`,
        "--format", "json",
      ], true);
      assert.deepEqual(roundTrip.rows, dataRows, `PostgreSQL ${table} data transfer changed the values.`);
    }
    dataExport.csvAndJsonRows = 2;
    dataExport.xlsxRows = 2;
    dataExport.nullAndMultilinePreserved = true;
  } finally {
    for (const table of [csvTable, jsonTable, xlsxTable, dataTable]) {
      try {
        invokeDbStudio(["query", "run", "--sql", `DROP TABLE IF EXISTS public.${quoteIdentifier(table)}`, "--format", "json"], true);
      } catch {
        // Preserve the data-transfer failure if cleanup cannot reach the isolated test service.
      }
    }
  }

  const formats = [
    { key: "csv", extension: ".csv" },
    { key: "shp", extension: ".shp" },
    { key: "geojson", extension: ".geojson" },
    { key: "kml", extension: ".kml" },
    { key: "tab", extension: ".tab" },
    { key: "gpkg", extension: ".gpkg" },
  ];
  const report = [];

  const legacyCsvTable = `dbcsv_${runId}`;
  temporaryGisTables.add(legacyCsvTable);
  const legacyCsv = path.join(outputDir, "legacy-cp936.csv");
  writeFileSync(legacyCsv, Buffer.concat([
    Buffer.from('WKT,name,note,SSB-RSRP(dBm)\r\n"POINT (121.5 31.2)",', "ascii"),
    Buffer.from("B1B1BEA9CAD0C2B7", "hex"),
    Buffer.from(",", "ascii"),
    Buffer.from("C3FBB3C6", "hex"),
    Buffer.from(",-90", "ascii"),
    Buffer.from("\r\n", "ascii"),
  ]));
  const csvSourceInfo = invokeDbStudio(["gis", "inspect", "--file", legacyCsv], true);
  assert.equal(csvSourceInfo.driver, "CSV");
  assert.equal(csvSourceInfo.encoding.source, "unknown", "A CSV without a BOM must require an explicit source encoding.");
  invokeDbStudio([
    "gis", "import", "--file", legacyCsv, "--target", `public.${legacyCsvTable}`,
    "--source-encoding", "GBK", "--source-crs", "EPSG:4326", "--target-crs", "EPSG:3857",
  ]);
  const csvGeometryColumns = invokeDbStudio([
    "query", "run", "--sql",
    `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema='public' AND f_table_name='${legacyCsvTable}'`,
    "--format", "json",
  ], true);
  const csvGeometryColumn = csvGeometryColumns.rows[0]?.f_geometry_column;
  assert.ok(csvGeometryColumn, "Legacy CSV import did not register a PostGIS geometry column.");
  const csvMetrics = invokeDbStudio([
    "query", "run", "--sql",
    `SELECT count(*) AS total, count(*) FILTER (WHERE ${quoteIdentifier(csvGeometryColumn)} IS NOT NULL) AS geometries, count(*) FILTER (WHERE ${quoteIdentifier("name")}='北京市路') AS decoded_name, count(*) FILTER (WHERE ${quoteIdentifier("SSB-RSRP(dBm)")}='-90') AS preserved_punctuated_field, min(ST_SRID(${quoteIdentifier(csvGeometryColumn)})) AS srid FROM public.${quoteIdentifier(legacyCsvTable)}`,
    "--format", "json",
  ], true);
  const csvRow = csvMetrics.rows[0];
  assert.equal(Number(csvRow.total), 1, "Legacy CSV import feature count mismatch.");
  assert.equal(Number(csvRow.geometries), 1, "Legacy CSV X/Y coordinates were not imported as geometry.");
  assert.equal(Number(csvRow.decoded_name), 1, "Legacy CSV Chinese attribute was not decoded correctly.");
  assert.equal(Number(csvRow.preserved_punctuated_field), 1, "Legacy CSV field names with PostgreSQL-special punctuation were changed during import.");
  assert.equal(Number(csvRow.srid), 3857, "Legacy CSV coordinates were not transformed to EPSG:3857.");
  report.push({ format: "csv-legacy-cp936", sourceEncoding: "CP936", importedFeatures: 1, decodedChineseAttribute: true, importedSrid: 3857 });

  const heuristicCsvTable = `dbcsv_auto_${runId}`;
  temporaryGisTables.add(heuristicCsvTable);
  const heuristicCsv = path.join(outputDir, "legacy-cp936-high-confidence.csv");
  writeFileSync(heuristicCsv, Buffer.concat([
    Buffer.from("WKT,name\r\n", "ascii"),
    ...Array.from({ length: 120 }, (_, index) => Buffer.concat([
      Buffer.from(`"POINT (${121.5 + index / 10000} 31.2)",`, "ascii"),
      Buffer.from("D6D0CEC4B5C0C2B7", "hex"),
      Buffer.from("\r\n", "ascii"),
    ])),
  ]));
  const heuristicCsvInfo = invokeDbStudio(["gis", "inspect", "--file", heuristicCsv], true);
  assert.equal(heuristicCsvInfo.encoding.source, "heuristic");
  assert.equal(heuristicCsvInfo.encoding.detectedEncoding, "GB18030");
  invokeDbStudio([
    "gis", "import", "--file", heuristicCsv, "--target", `public.${heuristicCsvTable}`,
    "--source-crs", "EPSG:4326", "--target-crs", "EPSG:3857",
  ]);
  const heuristicGeometryColumns = invokeDbStudio([
    "query", "run", "--sql",
    `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema='public' AND f_table_name='${heuristicCsvTable}'`,
    "--format", "json",
  ], true);
  const heuristicGeometryColumn = heuristicGeometryColumns.rows[0]?.f_geometry_column;
  assert.ok(heuristicGeometryColumn, "Heuristic CSV import did not register a PostGIS geometry column.");
  const heuristicMetrics = invokeDbStudio([
    "query", "run", "--sql",
    `SELECT count(*) AS total, count(*) FILTER (WHERE ${quoteIdentifier("name")}='中文道路') AS decoded_name, count(*) FILTER (WHERE ST_SRID(${quoteIdentifier(heuristicGeometryColumn)})=3857) AS projected FROM public.${quoteIdentifier(heuristicCsvTable)}`,
    "--format", "json",
  ], true);
  const heuristicRow = heuristicMetrics.rows[0];
  assert.equal(Number(heuristicRow.total), 120);
  assert.equal(Number(heuristicRow.decoded_name), 120);
  assert.equal(Number(heuristicRow.projected), 120);
  report.push({ format: "csv-high-confidence-heuristic", sourceEncoding: "GB18030", importedFeatures: 120, decodedChineseAttributes: 120, projectedToSrid: 3857 });

  const precisionTable = `dbpr_${runId}`;
  temporaryGisTables.add(precisionTable);
  const preciseCoordinates = [121.12345678901234, 31.12345678901234, 12.345678901234567];
  invokeDbStudio([
    "query", "run", "--sql",
    `CREATE TABLE public.${quoteIdentifier(precisionTable)} (id integer PRIMARY KEY, geom geometry(PointZ,4326))`,
    "--format", "json",
  ], true);
  invokeDbStudio([
    "query", "run", "--sql",
    `INSERT INTO public.${quoteIdentifier(precisionTable)} (id, geom) VALUES (1, ST_SetSRID(ST_MakePoint($1, $2, $3), 4326))`,
    "--params", JSON.stringify(preciseCoordinates), "--format", "json",
  ], true);
  const precisionOutput = path.join(outputDir, "binary64-precision.geojson");
  invokeDbStudio([
    "gis", "export", "--table", `public.${precisionTable}`, "--output", precisionOutput,
    "--target-crs", "EPSG:4326",
  ], true);
  const precisionGeoJson = JSON.parse(readFileSync(precisionOutput, "utf8"));
  assert.deepEqual(
    precisionGeoJson.features[0]?.geometry?.coordinates,
    preciseCoordinates,
    "PostGIS GeoJSON export must preserve finite binary64 XYZ coordinates without default seven-place rounding.",
  );
  dataExport.geoJsonPrecisionRoundtrip = true;

  const bigintTable = `dbbi_${runId}`;
  temporaryGisTables.add(bigintTable);
  invokeDbStudio([
    "query", "run", "--sql",
    `CREATE TABLE public.${quoteIdentifier(bigintTable)} (large_id bigint PRIMARY KEY, label text NOT NULL, geom geometry(Point,4326))`,
    "--format", "json",
  ], true);
  invokeDbStudio([
    "query", "run", "--sql",
    `INSERT INTO public.${quoteIdentifier(bigintTable)} (large_id, label, geom) VALUES (9007199254740993, '边界整数', ST_SetSRID(ST_MakePoint(102.25, 27.5), 4326))`,
    "--format", "json",
  ], true);
  const bigintOutput = path.join(outputDir, "integer64-boundary.geojson");
  const bigintExport = invokeDbStudio([
    "gis", "export", "--table", `public.${bigintTable}`, "--output", bigintOutput,
    "--target-crs", "EPSG:4326",
  ], true);
  const bigintGeoJsonText = readFileSync(bigintOutput, "utf8");
  assert.equal(bigintExport.operationReport?.successfulFeatures, 1, "PostGIS BIGINT boundary export feature count mismatch.");
  assert.match(
    bigintGeoJsonText,
    /"large_id"\s*:\s*9007199254740993(?:[\s,}])/,
    "PostGIS GeoJSON export must preserve BIGINT values above Number.MAX_SAFE_INTEGER exactly.",
  );
  assert.match(bigintGeoJsonText, /"label"\s*:\s*"边界整数"/, "PostGIS BIGINT boundary export lost its Unicode attribute.");
  dataExport.bigintIntegerRoundtrip = true;

  const reservedColumnsTable = `dbgpkg_${runId}`;
  temporaryGisTables.add(reservedColumnsTable);
  invokeDbStudio([
    "query", "run", "--sql",
    `CREATE TABLE public.${quoteIdentifier(reservedColumnsTable)} (id integer PRIMARY KEY, fid text NOT NULL, geom text NOT NULL, route varchar(10) NOT NULL, shape geometry(Point,4326))`,
    "--format", "json",
  ], true);
  for (const row of [
    { id: 1, fid: "source-one", geom: "attribute-one", route: "线路甲乙丙丁", x: 121.5, y: 31.2 },
    { id: 2, fid: "source-two", geom: "attribute-two", route: "线路甲乙丙戊", x: 121.6, y: 31.3 },
  ]) {
    invokeDbStudio([
      "query", "run", "--sql",
      `INSERT INTO public.${quoteIdentifier(reservedColumnsTable)} (id, fid, geom, route, shape) VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))`,
      "--params", JSON.stringify([row.id, row.fid, row.geom, row.route, row.x, row.y]), "--format", "json",
    ], true);
  }
  const reservedColumnsPath = path.join(outputDir, "reserved-columns.gpkg");
  const reservedColumnsExport = invokeDbStudio([
    "gis", "export", "--table", `public.${reservedColumnsTable}`, "--output", reservedColumnsPath,
  ], true);
  assert.ok(reservedColumnsExport.operationReport?.warnings?.some((warning) => warning.includes('feature id column will be named')),
    "GeoPackage export should report that the fid feature-id column was renamed to preserve its source attribute.");
  assert.ok(reservedColumnsExport.operationReport?.warnings?.some((warning) => warning.includes('geometry column will be named')),
    "GeoPackage export should report that the geom geometry column was renamed to preserve its source attribute.");
  const reservedColumnsInfo = invokeDbStudio(["gis", "inspect", "--file", reservedColumnsPath], true);
  const reservedColumnsLayer = reservedColumnsInfo.layers[0];
  assert.ok(reservedColumnsLayer.fields.some((field) => field.name === "fid"), "GeoPackage export lost its source fid attribute.");
  assert.ok(reservedColumnsLayer.fields.some((field) => field.name === "geom"), "GeoPackage export lost its source geom attribute.");
  assert.ok(reservedColumnsLayer.geometryFields?.some((field) => field.name && field.name.toLowerCase() !== "geom"),
    "GeoPackage geometry column should have a unique name when the source has a geom attribute.");
  const reservedColumnsGeoJsonPath = path.join(outputDir, "reserved-columns.geojson");
  invokeDbStudio(["gis", "convert", "--input", reservedColumnsPath, "--output", reservedColumnsGeoJsonPath]);
  const reservedColumnsGeoJson = JSON.parse(readFileSync(reservedColumnsGeoJsonPath, "utf8"));
  assert.equal(reservedColumnsGeoJson.features.length, 2, "GeoPackage reserved-column export feature count mismatch.");
  assert.deepEqual(reservedColumnsGeoJson.features.map((feature) => feature.properties.fid), ["source-one", "source-two"],
    "PostGIS fid source attributes must survive GeoPackage export.");
  assert.deepEqual(reservedColumnsGeoJson.features.map((feature) => feature.properties.geom), ["attribute-one", "attribute-two"],
    "PostGIS geom source attributes must survive GeoPackage export.");
  const reservedColumnsTabPath = path.join(outputDir, "reserved-columns.tab");
  const reservedColumnsTabExport = invokeDbStudio([
    "gis", "export", "--table", `public.${reservedColumnsTable}`, "--output", reservedColumnsTabPath,
  ], true);
  assert.equal(reservedColumnsTabExport.operationReport?.successfulFeatures, 2, "PostGIS MapInfo export feature count mismatch.");
  const reservedColumnsTabGeoJsonPath = path.join(outputDir, "reserved-columns-tab.geojson");
  invokeDbStudio(["gis", "convert", "--input", reservedColumnsTabPath, "--output", reservedColumnsTabGeoJsonPath, "--source-encoding", "UTF-8"]);
  const reservedColumnsTabGeoJson = JSON.parse(readFileSync(reservedColumnsTabGeoJsonPath, "utf8"));
  assert.equal(reservedColumnsTabGeoJson.features.length, 2, "PostGIS MapInfo export round-trip feature count mismatch.");
  assert.deepEqual(reservedColumnsTabGeoJson.features.map((feature) => feature.properties.route), ["线路甲乙丙丁", "线路甲乙丙戊"],
    "PostGIS varchar attributes must not be truncated by the MapInfo field width.");
  dataExport.geoPackageReservedColumns = { features: 2, fidAttributePreserved: true, geomAttributePreserved: true };
  dataExport.mapInfoStringWidth = { features: 2, longVarcharValuesPreserved: true };

  for (const format of formats) {
    const table = `dbsrt_${runId}_${format.key}`;
    temporaryGisTables.add(table);
    const source = path.join(outputDir, `source-${format.key}${format.extension}`);
    const exported = path.join(outputDir, `from-postgis-${format.key}${format.extension}`);
    const sourceInput = format.key === "geojson" ? fixture : source;
    const importedTable = `public.${table}`;

    if (format.key !== "geojson") {
      invokeDbStudio([
        "gis", "convert", "--input", fixture, "--output", source,
        "--target-crs", "EPSG:4326",
      ]);
    }

    const sourceInfo = invokeDbStudio(["gis", "inspect", "--file", sourceInput], true);
    assert.equal(sourceInfo.layers.length, 1, `${format.key}: expected a single fixture layer.`);
    assert.equal(sourceInfo.layers[0].featureCount, 2, `${format.key}: source fixture must contain two features.`);
    assert.ok(sourceInfo.layers[0].crs, `${format.key}: source CRS must be known before transformation.`);

    const importArgs = [
      "gis", "import", "--file", sourceInput, "--target", importedTable,
      "--target-crs", "EPSG:3857",
    ];
    if (format.key === "csv") importArgs.push("--source-encoding", "UTF-8");
    invokeDbStudio(importArgs);

    const geometryColumns = invokeDbStudio([
      "query", "run", "--sql",
      `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema='public' AND f_table_name='${table}'`,
      "--format", "json",
    ], true);
    const geometryColumn = geometryColumns.rows[0]?.f_geometry_column;
    assert.ok(geometryColumn, `${format.key}: PostGIS geometry column was not registered.`);

    const columns = invokeDbStudio([
      "tables", "columns", "--table", table, "--schema", "public",
    ], true);
    const nameColumn = columns.find((column) => column.name === "名称");
    assert.ok(nameColumn, `${format.key}: table-column inspection lost the Chinese attribute field.`);
    assert.ok(nameColumn.dataType, `${format.key}: attribute data type was not reported.`);
    assert.equal(typeof nameColumn.nullable, "boolean", `${format.key}: nullability must be reported.`);
    assert.ok(Number(nameColumn.ordinalPosition) > 0, `${format.key}: field order must be reported.`);
    assert.ok(columns.some((column) => column.primaryKey), `${format.key}: primary key was not reported.`);

    const geometry = quoteIdentifier(geometryColumn);
    const attributes = quoteIdentifier("名称");
    const tableIdentifier = `public.${quoteIdentifier(table)}`;
    const metrics = invokeDbStudio([
      "query", "run", "--sql",
      `SELECT count(*) AS total, count(*) FILTER (WHERE ${geometry} IS NULL) AS null_geometries, min(ST_SRID(${geometry})) AS srid, count(*) FILTER (WHERE ${attributes}='甲') AS value_a, count(*) FILTER (WHERE ${attributes}='乙') AS value_b, round(max(ST_X(${geometry})) FILTER (WHERE ${attributes}='甲')::numeric, 2) AS x, round(max(ST_Y(${geometry})) FILTER (WHERE ${attributes}='甲')::numeric, 2) AS y FROM ${tableIdentifier}`,
      "--format", "json",
    ], true);
    const row = metrics.rows[0];
    assert.equal(Number(row.total), 2, `${format.key}: PostGIS feature count mismatch.`);
    assert.equal(Number(row.null_geometries), 1, `${format.key}: null geometry must be preserved.`);
    assert.equal(Number(row.srid), 3857, `${format.key}: coordinates must be stored in EPSG:3857.`);
    assert.equal(Number(row.value_a), 1, `${format.key}: Chinese attribute 甲 was lost.`);
    assert.equal(Number(row.value_b), 1, `${format.key}: Chinese attribute 乙 was lost.`);
    closeEnough(row.x, 139149.36, 0.05, `${format.key} EPSG:3857 X`);
    closeEnough(row.y, 278387.08, 0.05, `${format.key} EPSG:3857 Y`);

    const exportResult = invokeDbStudio([
      "gis", "export", "--table", importedTable, "--output", exported,
      "--target-crs", "EPSG:4326",
    ], true);
    const formatWarnings = exportResult.operationReport?.warnings ?? [];
    if (format.key === "shp") assert.ok(formatWarnings.some((warning) => warning.includes("DBF")), "Shapefile export should report DBF constraints.");
    else if (format.key === "geojson") assert.ok(formatWarnings.some((warning) => warning.includes("RFC 7946") && warning.includes("17 decimal places")), "GeoJSON export should report RFC 7946 CRS and its round-trip precision policy.");
    else if (format.key === "kml") assert.ok(formatWarnings.some((warning) => warning.includes("EPSG:4326")), "KML export should report its output CRS.");
    else if (format.key === "tab") assert.ok(formatWarnings.some((warning) => warning.includes("MapInfo TAB")), "MapInfo TAB export should report field constraints.");
    else if (format.key === "csv") {
      assert.ok(formatWarnings.some((warning) => warning.includes("WKT") && warning.includes(".prj/.csvt")), "CSV export should explain its WKT geometry and required sidecars.");
      assert.ok(existsSync(exported.replace(/\.csv$/i, ".csvt")), "CSV export should create a field-type sidecar.");
      assert.ok(existsSync(exported.replace(/\.csv$/i, ".prj")), "CSV export should create a CRS sidecar.");
    }
    else assert.deepEqual(formatWarnings, [], "GeoPackage export should not report unsupported output constraints.");
    const exportedInfo = invokeDbStudio(["gis", "inspect", "--file", exported], true);
    const exportedLayer = exportedInfo.layers[0];
    assert.equal(exportedLayer.featureCount, 2, `${format.key}: exported feature count mismatch.`);
    assert.ok(exportedLayer.crs, `${format.key}: exported CRS was not reported.`);
    assert.ok(exportedLayer.fields.some((field) => field.name === "名称"),
      `${format.key}: exported Chinese field name was lost.`);
    if (format.key === "csv") {
      assert.ok(exportedLayer.geometryType, "CSV export should expose its WKT column as geometry.");
      assert.match(readFileSync(exported, "utf8").split(/\r?\n/, 1)[0] ?? "", /^(?:WKT|geom_WKT),/,
        "CSV export should write geometry in a WKT column, disambiguating a conflicting WKT attribute.");
    }
    closeEnough(exportedLayer.extent.minX, 1.25, 0.00001, `${format.key} output longitude`);
    closeEnough(exportedLayer.extent.minY, 2.5, 0.00001, `${format.key} output latitude`);

    const featureDump = execFileSync(ogrinfo, ["-ro", "-al", "-q", "-geom=NO", exported], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.match(featureDump, /名称 \(String\) = 甲/, `${format.key}: exported value 甲 was not readable.`);
    assert.match(featureDump, /名称 \(String\) = 乙/, `${format.key}: exported value 乙 was not readable.`);

    report.push({
      format: format.key,
      table: importedTable,
      inputFeatures: sourceInfo.layers[0].featureCount,
      importedFeatures: Number(row.total),
      nullGeometries: Number(row.null_geometries),
      importedSrid: Number(row.srid),
      transformedX: Number(row.x),
      transformedY: Number(row.y),
      exportedFeatures: exportedLayer.featureCount,
      exportedCrs: exportedLayer.crs.startsWith("EPSG:") ? exportedLayer.crs : "WKT",
      formatWarnings,
      inspectedColumns: columns.length,
      outputDirectory: outputDir,
    });
  }

  const sourceCrsOnlyTable = `dbsrc_${runId}`;
  temporaryGisTables.add(sourceCrsOnlyTable);
  invokeDbStudio([
    "gis", "import", "--file", fixture, "--target", `public.${sourceCrsOnlyTable}`,
    "--source-crs", "EPSG:4326",
  ]);
  const sourceCrsOnlyGeometry = invokeDbStudio([
    "query", "run", "--sql",
    `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema='public' AND f_table_name='${sourceCrsOnlyTable}'`,
    "--format", "json",
  ], true);
  const sourceCrsOnlyGeometryColumn = sourceCrsOnlyGeometry.rows[0]?.f_geometry_column;
  assert.ok(sourceCrsOnlyGeometryColumn, "Source-CRS-only import did not register a PostGIS geometry column.");
  const sourceCrsOnlyGeometryIdentifier = quoteIdentifier(sourceCrsOnlyGeometryColumn);
  const sourceCrsOnlyMetrics = invokeDbStudio([
    "query", "run", "--sql",
    `SELECT count(*) AS total, min(ST_SRID(${sourceCrsOnlyGeometryIdentifier})) AS srid, round(max(ST_X(${sourceCrsOnlyGeometryIdentifier}))::numeric, 2) AS x, round(max(ST_Y(${sourceCrsOnlyGeometryIdentifier}))::numeric, 2) AS y FROM public.${quoteIdentifier(sourceCrsOnlyTable)}`,
    "--format", "json",
  ], true);
  const sourceCrsOnlyRow = sourceCrsOnlyMetrics.rows[0];
  assert.equal(Number(sourceCrsOnlyRow.total), 2, "Source-CRS-only import feature count mismatch.");
  assert.equal(Number(sourceCrsOnlyRow.srid), 4326, "Source-CRS-only import must assign EPSG:4326.");
  closeEnough(sourceCrsOnlyRow.x, 1.25, 0.00001, "Source-CRS-only X must not be transformed");
  closeEnough(sourceCrsOnlyRow.y, 2.5, 0.00001, "Source-CRS-only Y must not be transformed");

  result = {
    database: health.rows[0].database,
    serverVersion: health.rows[0].server_version,
    tableDataTransfer: dataExport,
    sourceCrsOnlyImport: {
      table: `public.${sourceCrsOnlyTable}`,
      featureCount: Number(sourceCrsOnlyRow.total),
      srid: Number(sourceCrsOnlyRow.srid),
      x: Number(sourceCrsOnlyRow.x),
      y: Number(sourceCrsOnlyRow.y),
    },
    results: report,
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  for (const table of temporaryGisTables) {
    try {
      invokeDbStudio(["query", "run", "--sql", `DROP TABLE IF EXISTS public.${quoteIdentifier(table)}`, "--format", "json"], true);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    rmSync(outputDir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    const summary = cleanupErrors.map((error) => error.message).join("; ");
    if (primaryError) process.stderr.write(`Integration cleanup also failed: ${summary}\n`);
    else throw new AggregateError(cleanupErrors, `Integration cleanup failed: ${summary}`);
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
