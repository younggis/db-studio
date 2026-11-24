import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GdalService } from "../../packages/gis/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "apps", "cli", "dist", "index.js");
const fixture = path.join(root, "tests", "fixtures", "points.geojson");
const geometryFixture = path.join(root, "tests", "fixtures", "gis-geometry-coverage.geojson");
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

const executable = (name) => path.join(gdalBin, process.platform === "win32" ? `${name}.exe` : name);
const ogr2ogr = executable("ogr2ogr");
const ogrinfo = executable("ogrinfo");
assert.ok(gdalBin && existsSync(ogr2ogr) && existsSync(ogrinfo), "Set DBSTUDIO_GDAL_BIN to a GDAL/OGR bin directory.");

const runId = `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const outputDir = path.join(root, ".cache", `postgis-multilayer-${runId}`);
const gpkgPath = path.join(outputDir, "two-layers.gpkg");
const mappingSourcePath = path.join(outputDir, "mapping-source.geojson");
const geometryCoveragePath = path.join(outputDir, "geometry-coverage.gpkg");
const geometryCoverageExportGpkgPath = path.join(outputDir, "geometry-coverage-export.gpkg");
const geometryCoverageGeoJsonPath = path.join(outputDir, "geometry-coverage-export.geojson");
const makeValidZmCsvPath = path.join(outputDir, "make-valid-zm.csv");
const makeValidZmSourcePath = path.join(outputDir, "make-valid-zm.gpkg");
const mixedGeometrySourcePath = path.join(outputDir, "mixed-line-geometries.geojson");
const mixedGeometryVrtPath = path.join(outputDir, "declared-line-layer.vrt");
const mixedDimensionSourcePath = path.join(outputDir, "mixed-dimensions.csv");
const mixedDimensionVrtPath = path.join(outputDir, "mixed-dimensions.vrt");
const mixedDimensionExportGpkgPath = path.join(outputDir, "mixed-dimensions-export.gpkg");
const extentFilterSourcePath = path.join(outputDir, "extent-filter.geojson");
const tabFieldRoundtripPath = path.join(outputDir, "tab-field-roundtrip.tab");
const encodingSourceGeoJsonPath = path.join(outputDir, "windows-1252-source.geojson");
const encodingSourceShapefilePath = path.join(outputDir, "windows-1252-source.shp");
const encodingExportShapefilePath = path.join(outputDir, "windows-1252-export.shp");
const tableName = `dbdt_multi_${runId}`;
const geometryCoverageTable = `dbdt_geom_${runId}`;
const repairedGeometryTable = `dbdt_geom_valid_${runId}`;
const repairedZmTable = `dbdt_geom_valid_zm_${runId}`;
const repairedHoleTable = `dbdt_geom_hole_${runId}`;
const mixedGeometryTable = `dbdt_mixed_${runId}`;
const importModeTable = `dbdt_modes_${runId}`;
const mixedDimensionTable = `dbdt_dims_${runId}`;
const mixedDimensionRoundtripTable = `dbdt_dims_rt_${runId}`;
const extentFilterTable = `dbdt_extent_${runId}`;
const encodingImportTable = `dbdt_encoding_${runId}`;
const encodingRoundtripTable = `dbdt_encoding_rt_${runId}`;
const tabFieldSourceTable = `dbdt_tab_fields_${runId}`;
const tabFieldRoundtripTable = `dbdt_tab_rt_${runId}`;
mkdirSync(outputDir, { recursive: true });
environment.DBSTUDIO_CONFIG_HOME = path.join(outputDir, "cli-config");
environment.DBSTUDIO_TEST_PG_PASSWORD = environment.PGPASSWORD;
const gis = new GdalService(environment);
const connectionName = `postgis-${runId}`;

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: root, env: environment, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? "").trim(),
    };
  }
}

function invokeDbStudio(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `dbstudio ${args[0]} ${args[1]} failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function query(sql, connection = "environment") {
  return invokeDbStudio(["query", "run", "--connection", connection, "--sql", sql, "--format", "json"]);
}

try {
  const savedProfile = invokeDbStudio([
    "connections", "add", "--name", connectionName, "--engine", "postgres", "--host", environment.PGHOST,
    "--port", environment.PGPORT, "--database", environment.PGDATABASE, "--user", environment.PGUSER,
    "--password-env", "DBSTUDIO_TEST_PG_PASSWORD",
  ]);
  assert.equal(savedProfile.name, connectionName);
  const profileFile = path.join(environment.DBSTUDIO_CONFIG_HOME, "connections.json");
  assert.equal(existsSync(profileFile), true);
  assert.equal(readFileSync(profileFile, "utf8").includes(environment.PGPASSWORD), false, "Saved profiles must never contain the password value.");
  const savedConnectionTest = invokeDbStudio(["connections", "test", "--connection", connectionName]);
  assert.equal(savedConnectionTest.database, environment.PGDATABASE);

  const noCrsShapefile = path.join(outputDir, "no-crs.shp");
  execFileSync(ogr2ogr, ["-f", "ESRI Shapefile", noCrsShapefile, fixture], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  rmSync(path.join(outputDir, "no-crs.prj"), { force: true });
  const noCrsInfo = invokeDbStudio(["gis", "inspect", "--file", noCrsShapefile]);
  assert.ok(noCrsInfo.warnings?.some((warning) => warning.includes("CRS sidecar missing")));
  assert.ok(!noCrsInfo.layers[0]?.crs, "A Shapefile without CRS sidecars must remain unreferenced.");

  const unlabelledTransform = runCli([
    "gis", "convert", "--input", noCrsShapefile,
    "--output", path.join(outputDir, "no-crs-transform.geojson"),
    "--target-crs", "EPSG:4326",
  ]);
  assert.notEqual(unlabelledTransform.status, 0, "Transforming an unreferenced Shapefile must require an explicit source CRS.");
  assert.match(
    `${unlabelledTransform.stderr}\n${unlabelledTransform.stdout}`,
    /Source CRS is missing\. Specify --source-crs before transforming coordinates\./,
  );

  const explicitSourceOutput = path.join(outputDir, "no-crs-explicit-source.geojson");
  const explicitSourceTransform = runCli([
    "gis", "convert", "--input", noCrsShapefile, "--output", explicitSourceOutput,
    "--source-crs", "EPSG:32651", "--target-crs", "EPSG:4326",
  ]);
  assert.equal(explicitSourceTransform.status, 0, `An explicit source CRS should permit transformation:\n${explicitSourceTransform.stderr || explicitSourceTransform.stdout}`);
  const explicitSourceGeoJson = JSON.parse(readFileSync(explicitSourceOutput, "utf8"));
  const explicitSourceCoordinates = explicitSourceGeoJson.features.find((feature) => feature.geometry)?.geometry.coordinates;
  assert.ok(Array.isArray(explicitSourceCoordinates) && explicitSourceCoordinates.length >= 2);
  assert.ok(Math.abs(explicitSourceCoordinates[0] - 121.5) > 1, "Applying the supplied UTM CRS must transform coordinates rather than only relabel them.");
  assert.ok(Math.abs(explicitSourceCoordinates[1] - 31.2) > 1, "Applying the supplied UTM CRS must transform latitude rather than only relabel it.");

  const missingCoreShapefile = path.join(outputDir, "missing-core.shp");
  execFileSync(ogr2ogr, ["-f", "ESRI Shapefile", missingCoreShapefile, fixture], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  rmSync(path.join(outputDir, "missing-core.shx"), { force: true });
  rmSync(path.join(outputDir, "missing-core.dbf"), { force: true });
  const missingCoreResult = runCli(["gis", "inspect", "--file", missingCoreShapefile]);
  const missingCoreText = `${missingCoreResult.stdout}\n${missingCoreResult.stderr}`;
  assert.match(missingCoreText, /Shapefile sidecar missing: missing-core\.shx/);
  assert.match(missingCoreText, /Shapefile sidecar missing: missing-core\.dbf/);

  const incompleteTab = path.join(outputDir, "incomplete.tab");
  execFileSync(ogr2ogr, ["-f", "MapInfo File", incompleteTab, fixture], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  rmSync(path.join(outputDir, "incomplete.dat"), { force: true });
  const incompleteTabResult = runCli(["gis", "inspect", "--file", incompleteTab]);
  assert.match(`${incompleteTabResult.stdout}\n${incompleteTabResult.stderr}`, /MapInfo TAB sidecar missing: incomplete\.dat/);

  writeFileSync(mappingSourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "mapping_source",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
    features: [
      { type: "Feature", properties: { source_code: 101, 名称: "甲" }, geometry: { type: "Point", coordinates: [1, 2] } },
      { type: "Feature", properties: { source_code: 102, 名称: "乙" }, geometry: null },
    ],
  }), "utf8");
  execFileSync(ogr2ogr, ["-f", "GPKG", gpkgPath, mappingSourcePath, "-nln", "first_layer"], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  execFileSync(ogr2ogr, ["-f", "GPKG", "-update", gpkgPath, mappingSourcePath, "-where", "source_code = 101", "-nln", "second_layer"], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });

  const info = invokeDbStudio(["gis", "inspect", "--file", gpkgPath]);
  assert.deepEqual(info.layers.map((layer) => layer.name), ["first_layer", "second_layer"]);

  const omittedLayer = runCli(["gis", "import", "--file", gpkgPath, "--target", `public.${tableName}`]);
  assert.notEqual(omittedLayer.status, 0, "Multi-layer import must require an explicit layer.");
  assert.match(`${omittedLayer.stderr}\n${omittedLayer.stdout}`, /multiple layers.*--layer/i);

  const missingLayer = runCli(["gis", "import", "--file", gpkgPath, "--target", `public.${tableName}`, "--layer", "missing_layer"]);
  assert.notEqual(missingLayer.status, 0, "A nonexistent layer must be rejected.");
  assert.match(`${missingLayer.stderr}\n${missingLayer.stdout}`, /source layer was not found/i);

  const imported = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", gpkgPath, "--target", `public.${tableName}`, "--layer", "second_layer",
    "--field-map", "名称=label", "--field-type", "source_code=integer64",
  ]);
  assert.equal(imported.featureCount, 1);
  assert.equal(imported.successfulFeatures, 1);
  const count = query(`SELECT count(*) AS count, count(*) FILTER (WHERE label = '甲') AS selected_value, count(*) FILTER (WHERE label = '乙') AS omitted_value FROM public."${tableName}"`, connectionName);
  assert.equal(Number(count.rows[0].count), 1, "The selected source layer should write exactly its features.");
  assert.equal(Number(count.rows[0].selected_value), 1, "The selected layer's attributes should be imported.");
  assert.equal(Number(count.rows[0].omitted_value), 0, "Features absent from the selected layer must not be imported.");
  const columns = query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${tableName}'`, connectionName);
  assert.ok(columns.rows.some((column) => column.column_name === "label"), "The requested field alias should be present.");
  assert.ok(!columns.rows.some((column) => column.column_name === "名称"), "The source field name should be replaced by its alias.");
  assert.equal(columns.rows.find((column) => column.column_name === "source_code")?.data_type, "bigint", "The requested field type should be applied.");

  execFileSync(ogr2ogr, ["-f", "GPKG", geometryCoveragePath, geometryFixture, "-nlt", "GEOMETRY", "-nln", "coverage"], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  const geometryValidation = invokeDbStudio([
    "gis", "validate", "--file", geometryCoveragePath, "--layer", "coverage",
  ]);
  assert.equal(geometryValidation.featureCount, 9);
  assert.equal(geometryValidation.issueCount, 1);
  assert.equal(geometryValidation.issues[0]?.reason, "Self-intersection");
  assert.deepEqual(geometryValidation.issues[0]?.locations, [{ x: 1, y: 1 }]);
  const geometryImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", geometryCoveragePath, "--target", `public.${geometryCoverageTable}`,
  ]);
  assert.equal(geometryImport.featureCount, 9);
  const geometryColumn = query(`SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '${geometryCoverageTable}'`, connectionName).rows[0]?.f_geometry_column;
  assert.ok(geometryColumn, "PostGIS should expose the imported geometry column.");
  const geometryStats = query(`SELECT ST_GeometryType("${geometryColumn}") AS geometry_type, count(*) AS count FROM public."${geometryCoverageTable}" WHERE "${geometryColumn}" IS NOT NULL GROUP BY 1`, connectionName);
  const types = new Set(geometryStats.rows.map((row) => row.geometry_type));
  for (const type of ["ST_Point", "ST_MultiPoint", "ST_LineString", "ST_MultiLineString", "ST_Polygon", "ST_MultiPolygon", "ST_GeometryCollection"]) {
    assert.ok(types.has(type), `PostGIS should preserve ${type}.`);
  }
  const geometryChecks = query(`SELECT count(*) FILTER (WHERE "${geometryColumn}" IS NULL) AS null_count, count(*) FILTER (WHERE NOT ST_IsValid("${geometryColumn}") AND "${geometryColumn}" IS NOT NULL) AS invalid_count FROM public."${geometryCoverageTable}"`, connectionName);
  assert.equal(Number(geometryChecks.rows[0].null_count), 1, "The null geometry should be preserved.");
  assert.equal(Number(geometryChecks.rows[0].invalid_count), 1, "The invalid polygon should remain detectable after import.");

  const repairedGeometryImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", geometryCoveragePath,
    "--target", `public.${repairedGeometryTable}`, "--make-valid",
  ]);
  assert.equal(repairedGeometryImport.successfulFeatures, 9, "MakeValid should preserve the feature count, including null geometry.");
  assert.ok(repairedGeometryImport.warnings?.some((warning) => warning.includes("Lower-dimensional components may be removed")), "The operation report should disclose MakeValid's geometry changes.");
  const repairedGeometryChecks = query(
    `SELECT count(*) AS feature_count, count(*) FILTER (WHERE "${geometryColumn}" IS NULL) AS null_count, count(*) FILTER (WHERE NOT ST_IsValid("${geometryColumn}") AND "${geometryColumn}" IS NOT NULL) AS invalid_count FROM public."${repairedGeometryTable}"`,
    connectionName,
  );
  assert.equal(Number(repairedGeometryChecks.rows[0].feature_count), 9);
  assert.equal(Number(repairedGeometryChecks.rows[0].null_count), 1);
  assert.equal(Number(repairedGeometryChecks.rows[0].invalid_count), 0, "MakeValid should repair the self-intersecting polygon before it reaches PostGIS.");

  writeFileSync(makeValidZmCsvPath,
    'id,label,wkt\n1,自交ZM,"POLYGON ZM ((0 0 10 100,2 2 20 200,0 2 30 300,2 0 40 400,0 0 10 100))"\n2,有效ZM,"POLYGON ZM ((3 0 50 500,5 0 60 600,5 2 70 700,3 2 80 800,3 0 50 500))"\n',
    "utf8");
  execFileSync(ogr2ogr, [
    "-f", "GPKG", makeValidZmSourcePath, makeValidZmCsvPath,
    "-oo", "GEOM_POSSIBLE_NAMES=wkt", "-a_srs", "EPSG:4326", "-nlt", "PROMOTE_TO_MULTI",
  ], { cwd: root, env: environment, windowsHide: true, stdio: "pipe" });
  const makeValidZmSourceInfo = invokeDbStudio(["gis", "inspect", "--file", makeValidZmSourcePath]);
  assert.equal(makeValidZmSourceInfo.layers[0]?.featureCount, 2);
  const repairedZmImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", makeValidZmSourcePath,
    "--target", `public.${repairedZmTable}`, "--make-valid",
  ]);
  assert.equal(repairedZmImport.successfulFeatures, 2);
  const repairedZmColumn = query(`SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '${repairedZmTable}'`, connectionName).rows[0]?.f_geometry_column;
  assert.ok(repairedZmColumn, "The repaired ZM import should expose a PostGIS geometry column.");
  const repairedZmRows = query(
    `SELECT source.label, ST_NDims(source."${repairedZmColumn}") AS ndims, array_agg(DISTINCT ST_M(points.geom) ORDER BY ST_M(points.geom)) AS m_values FROM public."${repairedZmTable}" AS source CROSS JOIN LATERAL ST_DumpPoints(source."${repairedZmColumn}") AS points GROUP BY source.label, ST_NDims(source."${repairedZmColumn}") ORDER BY source.label`,
    connectionName,
  ).rows.map((row) => ({ label: row.label, ndims: Number(row.ndims), mValues: row.m_values?.map(Number) ?? [] }));
  assert.ok(repairedZmImport.warnings?.some((warning) => warning.includes("M (measure) values") && warning.includes("with 0")),
    "The MakeValid report must disclose that repaired measured ordinates may be zero-filled.");
  assert.deepEqual(Object.fromEntries(repairedZmRows.map((row) => [row.label, { ndims: row.ndims, mValues: row.mValues }])), {
    "有效ZM": { ndims: 4, mValues: [500, 600, 700, 800] },
    "自交ZM": { ndims: 4, mValues: [0] },
  }, "MakeValid should preserve M on valid features and report zero-filled M on repaired features.");

  const expectedPolygon = "POLYGON((0 0,4 0,4 4,0 4,0 0),(1 1,1 2,2 2,2 1,1 1))";
  const collapsedRingsFixture = path.join(root, "tests", "fixtures", "gis-repair-collapsed-rings.geojson");
  const repairInput = JSON.parse(readFileSync(collapsedRingsFixture, "utf8"));
  assert.equal(repairInput.features.length, 2);
  for (const feature of repairInput.features) {
    const geometry = JSON.stringify(feature.geometry).replaceAll("'", "''");
    const inputIsInvalid = query(`SELECT NOT ST_IsValid(ST_GeomFromGeoJSON('${geometry}')) AS invalid`, connectionName);
    assert.equal(inputIsInvalid.rows[0]?.invalid, true);
  }
  const repairedHoleImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", collapsedRingsFixture,
    "--target", `public.${repairedHoleTable}`, "--make-valid",
  ]);
  assert.equal(repairedHoleImport.successfulFeatures, 2);
  assert.ok(repairedHoleImport.warnings?.some((warning) => warning.includes("fully collapsed features may become lines or points")));
  const repairedHoleColumn = query(`SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '${repairedHoleTable}'`, connectionName).rows[0]?.f_geometry_column;
  assert.ok(repairedHoleColumn);
  const repairedHoleGeometry = `"${repairedHoleColumn}"`;
  const repairedHoleRows = query(
    `SELECT label, ST_IsValid(${repairedHoleGeometry}) AS valid,
      ST_Dimension(${repairedHoleGeometry}) AS dimension, ST_IsEmpty(${repairedHoleGeometry}) AS empty,
      CASE WHEN label = 'hole-and-spike' THEN ST_Equals(${repairedHoleGeometry}, ST_GeomFromText('${expectedPolygon}', 4326))
        ELSE ST_Equals(${repairedHoleGeometry}, ST_GeomFromText('LINESTRING(10 0,14 0)', 4326)) END AS matches,
      ST_NumInteriorRings(ST_GeometryN(${repairedHoleGeometry}, 1)) AS holes
      FROM public."${repairedHoleTable}" ORDER BY label`,
    connectionName,
  ).rows;
  assert.deepEqual(repairedHoleRows, [
    { label: "collapsed-shell", valid: true, dimension: 1, empty: false, matches: true, holes: null },
    { label: "hole-and-spike", valid: true, dimension: 2, empty: false, matches: true, holes: 1 },
  ]);

  writeFileSync(mixedGeometrySourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "mixed_line_geometries",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
    features: [
      { type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
      { type: "Feature", properties: { id: 2 }, geometry: { type: "MultiLineString", coordinates: [[[2, 2], [3, 3]], [[4, 4], [5, 5]]] } },
    ],
  }), "utf8");
  writeFileSync(mixedGeometryVrtPath,
    '<OGRVRTDataSource><OGRVRTLayer name="declared_lines"><SrcDataSource relativeToVRT="1">mixed-line-geometries.geojson</SrcDataSource><SrcLayer>mixed_line_geometries</SrcLayer><GeometryType>wkbLineString</GeometryType></OGRVRTLayer></OGRVRTDataSource>',
    "utf8");
  const mixedGeometryInfo = invokeDbStudio(["gis", "inspect", "--file", mixedGeometryVrtPath]);
  assert.equal(mixedGeometryInfo.layers[0]?.geometryType, "LineString", "The fixture should expose a single-type layer declaration with a multi-geometry feature.");
  const mixedGeometryPreview = await gis.previewAttributes(mixedGeometryVrtPath, { sourceLayer: "declared_lines" });
  assert.equal(mixedGeometryPreview.requiresUserChoice, false, "A layer without string fields should not require an encoding choice.");
  assert.equal(mixedGeometryPreview.rows.length, 2);
  const mixedGeometryImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", mixedGeometryVrtPath, "--target", `public.${mixedGeometryTable}`, "--layer", "declared_lines",
  ]);
  assert.equal(mixedGeometryImport.successfulFeatures, 2);
  assert.ok(mixedGeometryImport.warnings?.some((warning) => warning.includes("generic geometry column")), "The import report should explain the generic PostGIS geometry column.");
  const mixedGeometryAppend = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", mixedGeometryVrtPath, "--target", `public.${mixedGeometryTable}`, "--layer", "declared_lines", "--mode", "append",
  ]);
  assert.equal(mixedGeometryAppend.successfulFeatures, 2);
  assert.ok(mixedGeometryAppend.warnings?.some((warning) => warning.includes("Append preserves the destination geometry column type")), "Append reports that the destination geometry type remains in force.");
  const mixedGeometryColumn = query(`SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '${mixedGeometryTable}'`).rows[0]?.f_geometry_column;
  assert.ok(mixedGeometryColumn, "PostGIS should expose the imported mixed-type geometry column.");
  const mixedGeometryTypes = query(`SELECT ST_GeometryType("${mixedGeometryColumn}") AS geometry_type, count(*) AS count FROM public."${mixedGeometryTable}" GROUP BY 1`);
  assert.deepEqual(Object.fromEntries(mixedGeometryTypes.rows.map((row) => [row.geometry_type, Number(row.count)])), { ST_LineString: 2, ST_MultiLineString: 2 }, "Create and append should preserve both mixed single and multi geometry types.");

  const importModeSourcePath = path.join(outputDir, "import-modes.geojson");
  const overwriteModeSourcePath = path.join(outputDir, "overwrite-mode.geojson");
  writeFileSync(importModeSourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "import_modes",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
    features: [
      { type: "Feature", properties: { id: 1, label: "old-a" }, geometry: { type: "Point", coordinates: [1, 1] } },
      { type: "Feature", properties: { id: 2, label: "old-b" }, geometry: { type: "Point", coordinates: [2, 2] } },
    ],
  }), "utf8");
  writeFileSync(overwriteModeSourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "overwrite_mode",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
    features: [
      { type: "Feature", properties: { replacement_code: 99, replacement_label: "new-schema" }, geometry: { type: "Point", coordinates: [9, 9] } },
    ],
  }), "utf8");
  const createModeImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", importModeSourcePath, "--target", `public.${importModeTable}`,
  ]);
  assert.equal(createModeImport.successfulFeatures, 2, "Create mode should create a new destination layer.");
  assert.ok(createModeImport.warnings?.some((warning) => warning.includes('source attribute "id" also serves as the OGR feature ID')),
    "The import report should disclose when a GeoJSON id attribute overlaps the source feature ID.");
  const duplicateCreate = runCli([
    "gis", "import", "--connection", connectionName, "--file", importModeSourcePath, "--target", `public.${importModeTable}`,
  ]);
  const afterDuplicateCreateCount = Number(query(`SELECT count(*) AS count FROM public."${importModeTable}"`).rows[0].count);
  assert.equal(afterDuplicateCreateCount, 2,
    `Create mode must not append to or replace an existing destination (CLI status ${duplicateCreate.status}; output ${duplicateCreate.stdout || duplicateCreate.stderr}).`);
  const appendModeImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", importModeSourcePath,
    "--target", `public.${importModeTable}`, "--mode", "append",
  ]);
  assert.equal(appendModeImport.successfulFeatures, 2, "Append mode should add the source features.");
  assert.equal(Number(query(`SELECT count(*) AS count FROM public."${importModeTable}"`).rows[0].count), 4,
    "Append should preserve the original rows and add the new rows.");
  assert.deepEqual(query(`SELECT id, label FROM public."${importModeTable}" ORDER BY label`).rows,
    [
      { id: 1, label: "old-a" }, { id: 1, label: "old-a" },
      { id: 2, label: "old-b" }, { id: 2, label: "old-b" },
    ],
    "Appending GeoJSON with repeated property ids should retain those attributes while using independent PostGIS feature IDs.");
  const overwriteModeImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", overwriteModeSourcePath,
    "--target", `public.${importModeTable}`, "--mode", "overwrite",
  ]);
  assert.equal(overwriteModeImport.successfulFeatures, 1, "Overwrite mode should replace the destination layer.");
  const overwrittenRows = query(`SELECT replacement_code, replacement_label FROM public."${importModeTable}"`).rows;
  assert.deepEqual(overwrittenRows, [{ replacement_code: 99, replacement_label: "new-schema" }],
    "Overwrite should replace both the prior rows and prior column names.");

  writeFileSync(mixedDimensionSourcePath,
    'WKT,id\n"POINT (1 2)",1\n"POINT Z (3 4 5)",2\n"POINT M (6 7 8)",3\n"POINT ZM (9 10 11 12)",4\n"LINESTRING Z (0 0 1, 1 1 2)",5\n"POLYGON M ((0 0 7, 1 0 8, 1 1 9, 0 0 7))",6\n"GEOMETRYCOLLECTION ZM (POINT ZM (2 3 13 14), LINESTRING ZM (0 0 1 2, 1 1 3 4))",7\n',
    "utf8");
  writeFileSync(mixedDimensionVrtPath,
    '<OGRVRTDataSource><OGRVRTLayer name="mixed_dimensions"><SrcDataSource relativeToVRT="1">mixed-dimensions.csv</SrcDataSource><SrcLayer>mixed-dimensions</SrcLayer><GeometryType>wkbUnknown</GeometryType><LayerSRS>EPSG:4326</LayerSRS><GeometryField encoding="WKT" field="WKT"/><Field name="id" src="id" type="Integer"/></OGRVRTLayer></OGRVRTDataSource>',
    "utf8");
  const mixedDimensionInfo = invokeDbStudio(["gis", "inspect", "--file", mixedDimensionVrtPath]);
  assert.ok(
    mixedDimensionInfo.layers[0]?.geometryType === null || /^(geometry|unknown)/i.test(mixedDimensionInfo.layers[0]?.geometryType ?? ""),
    `The mixed-dimension VRT must retain an unspecified layer type; got ${mixedDimensionInfo.layers[0]?.geometryType}.`,
  );
  const mixedDimensionImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", mixedDimensionVrtPath,
    "--target", `public.${mixedDimensionTable}`, "--layer", "mixed_dimensions",
  ]);
  assert.equal(mixedDimensionImport.successfulFeatures, 7);
  const mixedDimensionColumn = query(`SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '${mixedDimensionTable}'`, connectionName).rows[0]?.f_geometry_column;
  assert.ok(mixedDimensionColumn, "PostGIS should expose the mixed-dimension geometry column.");
  const mixedDimensionRows = query(
    `SELECT id, ST_GeometryType("${mixedDimensionColumn}") AS geometry_type, ST_NDims("${mixedDimensionColumn}") AS ndims, CASE WHEN id = 5 THEN ST_Z(ST_StartPoint("${mixedDimensionColumn}")) WHEN id = 6 THEN ST_Z(ST_PointN(ST_ExteriorRing("${mixedDimensionColumn}"), 1)) WHEN id = 7 THEN ST_Z(ST_GeometryN("${mixedDimensionColumn}", 1)) ELSE ST_Z("${mixedDimensionColumn}") END AS z, CASE WHEN id = 5 THEN ST_M(ST_StartPoint("${mixedDimensionColumn}")) WHEN id = 6 THEN ST_M(ST_PointN(ST_ExteriorRing("${mixedDimensionColumn}"), 1)) WHEN id = 7 THEN ST_M(ST_GeometryN("${mixedDimensionColumn}", 1)) ELSE ST_M("${mixedDimensionColumn}") END AS m FROM public."${mixedDimensionTable}" ORDER BY id`,
    connectionName,
  ).rows.map((row) => ({ id: Number(row.id), geometryType: row.geometry_type, ndims: Number(row.ndims), z: row.z === null ? null : Number(row.z), m: row.m === null ? null : Number(row.m) }));
  assert.deepEqual(mixedDimensionRows, [
    { id: 1, geometryType: "ST_Point", ndims: 4, z: 0, m: 0 },
    { id: 2, geometryType: "ST_Point", ndims: 4, z: 5, m: 0 },
    { id: 3, geometryType: "ST_Point", ndims: 4, z: 0, m: 8 },
    { id: 4, geometryType: "ST_Point", ndims: 4, z: 11, m: 12 },
    { id: 5, geometryType: "ST_LineString", ndims: 4, z: 1, m: 0 },
    { id: 6, geometryType: "ST_Polygon", ndims: 4, z: 0, m: 7 },
    { id: 7, geometryType: "ST_GeometryCollection", ndims: 4, z: 13, m: 14 },
  ], "Mixed Point, LineString, Polygon, and GeometryCollection dimensions should be normalized to XYZM without dropping supplied Z/M ordinates.");
  assert.ok(mixedDimensionImport.warnings?.some((warning) =>
    warning.includes("Mixed feature dimensions XY/XYZ/XYM/XYZM were normalized to XYZM")
      && warning.includes("missing Z/M ordinates were padded with 0")),
  "The report must disclose normalization and zero padding for mixed dimensions.");
  const mixedDimensionExport = invokeDbStudio([
    "gis", "export", "--connection", connectionName, "--table", `public.${mixedDimensionTable}`,
    "--output", mixedDimensionExportGpkgPath,
  ]);
  assert.equal(mixedDimensionExport.operationReport.successfulFeatures, 7);
  const mixedDimensionRoundtripImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", mixedDimensionExportGpkgPath,
    "--target", `public.${mixedDimensionRoundtripTable}`,
  ]);
  assert.equal(mixedDimensionRoundtripImport.successfulFeatures, 7);
  const mixedDimensionRoundtripColumn = query(`SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = 'public' AND f_table_name = '${mixedDimensionRoundtripTable}'`, connectionName).rows[0]?.f_geometry_column;
  assert.ok(mixedDimensionRoundtripColumn, "The GeoPackage re-import should expose a geometry column.");
  const mixedDimensionRoundtripRows = query(
    `SELECT id, ST_GeometryType("${mixedDimensionRoundtripColumn}") AS geometry_type, ST_NDims("${mixedDimensionRoundtripColumn}") AS ndims, CASE WHEN id = 5 THEN ST_Z(ST_StartPoint("${mixedDimensionRoundtripColumn}")) WHEN id = 6 THEN ST_Z(ST_PointN(ST_ExteriorRing("${mixedDimensionRoundtripColumn}"), 1)) WHEN id = 7 THEN ST_Z(ST_GeometryN("${mixedDimensionRoundtripColumn}", 1)) ELSE ST_Z("${mixedDimensionRoundtripColumn}") END AS z, CASE WHEN id = 5 THEN ST_M(ST_StartPoint("${mixedDimensionRoundtripColumn}")) WHEN id = 6 THEN ST_M(ST_PointN(ST_ExteriorRing("${mixedDimensionRoundtripColumn}"), 1)) WHEN id = 7 THEN ST_M(ST_GeometryN("${mixedDimensionRoundtripColumn}", 1)) ELSE ST_M("${mixedDimensionRoundtripColumn}") END AS m FROM public."${mixedDimensionRoundtripTable}" ORDER BY id`,
    connectionName,
  ).rows.map((row) => ({ id: Number(row.id), geometryType: row.geometry_type, ndims: Number(row.ndims), z: row.z === null ? null : Number(row.z), m: row.m === null ? null : Number(row.m) }));
  assert.deepEqual(mixedDimensionRoundtripRows, mixedDimensionRows,
    "PostGIS → GeoPackage → PostGIS must preserve normalized dimensions and all supplied Z/M ordinates.");

  writeFileSync(extentFilterSourcePath, JSON.stringify({
    type: "FeatureCollection",
    name: "extent_filter_source",
    features: [
      { type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [0, 0] } },
      { type: "Feature", properties: { id: 2 }, geometry: { type: "Point", coordinates: [0.5, 0.5] } },
      { type: "Feature", properties: { id: 3 }, geometry: { type: "Point", coordinates: [5, 5] } },
      { type: "Feature", properties: { id: 4 }, geometry: { type: "Point", coordinates: [10, 10] } },
    ],
  }), "utf8");
  const extentPreview = await gis.previewAttributes(extentFilterSourcePath, { sourceLayer: "extent_filter_source", limit: 4 });
  assert.equal(extentPreview.features.length, 4, "GIS preview should return the bounded sample geometries for map rendering.");
  assert.equal(extentPreview.features[0]?.geometry?.type, "Point");
  const extentImport = await gis.importToPostgres(extentFilterSourcePath, `public.${extentFilterTable}`, {
    host: environment.PGHOST,
    port: Number(environment.PGPORT),
    database: environment.PGDATABASE,
    user: environment.PGUSER,
    password: environment.PGPASSWORD,
  }, {
    sourceLayer: "extent_filter_source",
    spatialFilter: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  });
  assert.equal(extentImport.status, "completed");
  assert.equal(extentImport.featureCount, 2, "A filtered import should count only the selected features.");
  assert.equal(extentImport.successfulFeatures, 2);
  assert.equal(extentImport.failedFeatures, 0);
  assert.ok(extentImport.warnings?.some((warning) => warning.includes("spatial filter")));
  const extentRows = query(`SELECT id FROM public."${extentFilterTable}" ORDER BY id`, connectionName);
  assert.deepEqual(extentRows.rows.map((row) => Number(row.id)), [1, 2], "OGR should apply the selected source-coordinate extent to PostGIS import.");
  const appendExtentArgs = [
    "gis", "import", "--connection", connectionName, "--file", extentFilterSourcePath,
    "--target", `public.${extentFilterTable}`, "--layer", "extent_filter_source", "--mode", "append",
  ];
  const appendedExtent = invokeDbStudio([...appendExtentArgs, "--bbox=-1,4,6,6"]);
  assert.equal(appendedExtent.status, "completed");
  assert.equal(appendedExtent.featureCount, 1);
  assert.equal(appendedExtent.successfulFeatures, 1);
  assert.equal(appendedExtent.failedFeatures, 0);
  const emptyExtent = invokeDbStudio([...appendExtentArgs, "--bbox", "70,70,71,71"]);
  assert.equal(emptyExtent.status, "completed");
  assert.equal(emptyExtent.featureCount, 0);
  assert.equal(emptyExtent.successfulFeatures, 0);
  assert.equal(emptyExtent.failedFeatures, 0);
  for (const value of ["1,,2,3", "NaN,0,1,1", "1,0,1,2"]) {
    const invalidExtent = runCli([...appendExtentArgs, `--bbox=${value}`]);
    assert.notEqual(invalidExtent.status, 0);
    assert.match(invalidExtent.stderr, /--bbox/);
  }
  const afterAppendIds = query(`SELECT id FROM public."${extentFilterTable}" ORDER BY id`, connectionName).rows.map((row) => Number(row.id));
  assert.deepEqual(afterAppendIds, [1, 2, 3]);
  await assert.rejects(() => gis.importToPostgres(extentFilterSourcePath, `public.${extentFilterTable}`, {
    host: environment.PGHOST,
    port: Number(environment.PGPORT),
    database: environment.PGDATABASE,
    user: environment.PGUSER,
    password: environment.PGPASSWORD,
  }, {
    sourceLayer: "extent_filter_source",
    spatialFilter: { minX: 1, minY: 1, maxX: 1, maxY: 2 },
  }), /minimum bounds must be smaller/i, "A zero-width extent should be rejected before OGR writes anything.");

  writeFileSync(encodingSourceGeoJsonPath, JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { label: "caf\u00e9" }, geometry: { type: "Point", coordinates: [12, 34] } }],
  }), "utf8");
  execFileSync(ogr2ogr, ["-f", "ESRI Shapefile", "-lco", "ENCODING=WINDOWS-1252", encodingSourceShapefilePath, encodingSourceGeoJsonPath], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  writeFileSync(encodingSourceShapefilePath.replace(/\.shp$/i, ".cpg"), "UTF-8\n", "ascii");
  const misdeclaredEncoding = await gis.inspect(encodingSourceShapefilePath);
  assert.equal(misdeclaredEncoding.encoding.declaredEncoding, "UTF-8", "The fixture should contain CP1252 bytes with a UTF-8 sidecar declaration.");
  const encodingImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", encodingSourceShapefilePath,
    "--target", `public.${encodingImportTable}`, "--source-encoding", "CP1252",
  ]);
  assert.equal(encodingImport.successfulFeatures, 1);
  assert.equal(Number(query(`SELECT count(*) AS count FROM public."${encodingImportTable}" WHERE label = 'caf\u00e9'`, connectionName).rows[0].count), 1,
    "The CP1252 override should decode text even when the sidecar declares UTF-8.");
  const encodingExport = invokeDbStudio([
    "gis", "export", "--connection", connectionName, "--table", `public.${encodingImportTable}`,
    "--output", encodingExportShapefilePath, "--target-encoding", "CP1252",
  ]);
  assert.equal(encodingExport.operationReport.successfulFeatures, 1);
  const encodingExportInfo = await gis.inspect(encodingExportShapefilePath);
  assert.equal(encodingExportInfo.encoding.declaredEncoding, "CP1252", "The exported Shapefile should advertise its output encoding.");
  const encodingReimport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", encodingExportShapefilePath,
    "--target", `public.${encodingRoundtripTable}`,
  ]);
  assert.equal(encodingReimport.successfulFeatures, 1);
  assert.equal(Number(query(`SELECT count(*) AS count FROM public."${encodingRoundtripTable}" WHERE label = 'caf\u00e9'`, connectionName).rows[0].count), 1,
    "The exported CP1252 Shapefile should roundtrip without a manual encoding override.");

  const geometryExport = invokeDbStudio([
    "gis", "export", "--connection", connectionName, "--table", `public.${geometryCoverageTable}`, "--output", geometryCoverageExportGpkgPath,
    "--field-map", "名称=label", "--field-type", "source_code=integer64",
  ]);
  assert.equal(geometryExport.operationReport.successfulFeatures, 9);
  const exportedGpkgInfo = invokeDbStudio(["gis", "inspect", "--file", geometryCoverageExportGpkgPath]);
  const exportedFieldTypes = new Map(exportedGpkgInfo.layers[0].fields.map((field) => [field.name, field.type]));
  assert.ok(exportedFieldTypes.has("label"), "The export field alias should be present.");
  assert.ok(!exportedFieldTypes.has("名称"), "The source Chinese field should be replaced by its alias.");
  assert.equal(exportedFieldTypes.get("source_code"), "Integer64", "The export field type should be applied.");
  execFileSync(ogr2ogr, ["-f", "GeoJSON", geometryCoverageGeoJsonPath, geometryCoverageExportGpkgPath], {
    cwd: root, env: environment, windowsHide: true, stdio: "pipe",
  });
  const exportedGeometry = JSON.parse(readFileSync(geometryCoverageGeoJsonPath, "utf8"));
  assert.equal(exportedGeometry.features.length, 9, "PostGIS export should retain every geometry fixture feature.");
  assert.ok(exportedGeometry.features.some((feature) => feature.geometry?.type === "GeometryCollection"));

  query(`CREATE TABLE public."${tabFieldSourceTable}" (record_no integer NOT NULL, "名称" text NOT NULL, label text, geom geometry(Point, 4326))`, connectionName);
  for (const row of [
    { id: 1, name: "中文甲", label: "O'Brien" },
    { id: 2, name: "乙", label: null },
  ]) {
    invokeDbStudio([
      "query", "run", "--connection", connectionName, "--sql",
      `INSERT INTO public."${tabFieldSourceTable}" (record_no, "名称", label, geom) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))`,
      "--params", JSON.stringify([row.id, row.name, row.label, 120 + row.id, 30 + row.id]), "--format", "json",
    ]);
  }
  const tabFieldExport = invokeDbStudio([
    "gis", "export", "--connection", connectionName, "--table", `public.${tabFieldSourceTable}`,
    "--output", tabFieldRoundtripPath, "--field-map", "名称=name_field",
  ]);
  assert.equal(tabFieldExport.operationReport.successfulFeatures, 2);
  assert.ok(tabFieldExport.operationReport.warnings?.some((warning) => warning.includes("do not represent SQL NULL values")),
    "The export report should disclose that MapInfo cannot preserve SQL NULL distinctions.");
  const tabFieldInfo = await gis.inspect(tabFieldRoundtripPath);
  const tabFieldNames = new Set(tabFieldInfo.layers[0]?.fields.map((field) => field.name));
  assert.ok(tabFieldNames.has("name_field"), "The TAB export should contain the compatible mapped field name.");
  assert.ok(!tabFieldNames.has("名称"), "The TAB export should replace the mapped source field name.");
  const tabFieldImport = invokeDbStudio([
    "gis", "import", "--connection", connectionName, "--file", tabFieldRoundtripPath,
    "--target", `public.${tabFieldRoundtripTable}`,
  ]);
  assert.equal(tabFieldImport.successfulFeatures, 2);
  const tabFieldRows = query(
    `SELECT record_no, name_field, label FROM public."${tabFieldRoundtripTable}" ORDER BY record_no`, connectionName,
  ).rows;
  assert.deepEqual(tabFieldRows, [
    { record_no: 1, name_field: "中文甲", label: "O'Brien" },
    { record_no: 2, name_field: "乙", label: "" },
  ], "PostGIS → MapInfo TAB → PostGIS preserves compatible schema and text but maps a NULL string to the format's empty value.");

  console.log(JSON.stringify({
    result: "passed",
    layers: info.layers.map((layer) => layer.name),
    importLayer: "second_layer",
    fieldMapping: { 名称: "label", source_code: "integer64" },
    importedFeatures: imported.successfulFeatures,
    geometryCoverage: { imported: geometryImport.successfulFeatures, types: [...types], nullGeometry: true, invalidGeometry: true, exported: exportedGeometry.features.length, exportFieldMapping: true },
    geometryValidation: { featureCount: geometryValidation.featureCount, issueCount: geometryValidation.issueCount, reason: geometryValidation.issues[0]?.reason, locations: geometryValidation.issues[0]?.locations },
    geometryRepair: { enabledExplicitly: true, imported: repairedGeometryImport.successfulFeatures, nullGeometryPreserved: Number(repairedGeometryChecks.rows[0].null_count) === 1, invalidGeometryCount: Number(repairedGeometryChecks.rows[0].invalid_count), warningReported: true },
    geometryRepairZMEvidence: { warnings: repairedZmImport.warnings ?? [], rows: repairedZmRows, measureLossDisclosed: true },
    geometryRepairHole: { sourceInvalid: true, equalsExpectedPolygon: true, interiorRings: 1, collapsedSpikeRemoved: true },
    geometryRepairCollapsedShell: { sourceInvalid: true, preservedFeature: true, repairedAsLine: true },
    mapInfoTabDatabaseRoundtrip: { exported: tabFieldExport.operationReport.successfulFeatures, imported: tabFieldImport.successfulFeatures, fieldAlias: "名称=name_field", unicodeAndQuotedTextPreserved: true, nullBecomesEmptyString: true, warningReported: true },
    mixedGeometryTypes: mixedGeometryTypes.rows.map((row) => row.geometry_type),
    importModes: { create: true, existingCreatePreservedRows: true, appendRows: 4, overwriteReplacedSchemaAndRows: true },
    mixedDimensions: { imported: mixedDimensionRows, roundtripPreserved: true },
    spatialFilter: { importedIds: extentRows.rows.map((row) => Number(row.id)), reportedCount: extentImport.successfulFeatures, appendedCount: appendedExtent.successfulFeatures, emptyCount: emptyExtent.successfulFeatures, afterAppendIds },
    shapefileEncodingOverride: { sourceSidecar: "UTF-8", selectedEncoding: "CP1252", exportedEncoding: encodingExportInfo.encoding.declaredEncoding, roundtripFeatures: encodingReimport.successfulFeatures },
    savedConnectionTest: true,
    crsValidation: { missingSourceRejected: true, explicitSourceAccepted: true, sourceOverrideTransformsCoordinates: true },
    omittedLayerRejected: true,
    missingLayerRejected: true,
  }, null, 2));
} finally {
  try { query(`DROP TABLE IF EXISTS public."${importModeTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${tableName}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${geometryCoverageTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${repairedGeometryTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${repairedZmTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${repairedHoleTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${mixedGeometryTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${mixedDimensionRoundtripTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${mixedDimensionTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${extentFilterTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${encodingImportTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${encodingRoundtripTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${tabFieldRoundtripTable}"`); } catch { /* Keep the primary integration failure. */ }
  try { query(`DROP TABLE IF EXISTS public."${tabFieldSourceTable}"`); } catch { /* Keep the primary integration failure. */ }
  rmSync(outputDir, { recursive: true, force: true });
}
