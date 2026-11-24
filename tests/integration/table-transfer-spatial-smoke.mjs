import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreService } from "../../packages/core/dist/index.js";
import { SqliteAdapter } from "../../packages/database/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerEnvPath = path.join(root, "docker", ".env");

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim().replace(/^(\"|')(.*)\1$/, "$2")]));
}

const dockerEnv = parseEnvFile(dockerEnvPath);

function required(name, fallback) {
  const value = process.env[name] || fallback;
  assert.ok(value, `Set ${name} before running this integration.`);
  return value;
}

function port(name, fallback) {
  const value = Number(required(name, fallback));
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 65_535, `${name} must be a valid TCP port.`);
  return value;
}

function identifier(engine, value) {
  if (engine === "sqlserver") return `[${value.replaceAll("]", "]]" )}]`;
  if (engine === "mysql" || engine === "mariadb") return `\`${value.replaceAll("`", "``")}\``;
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(engine, schema, table) {
  return `${identifier(engine, schema)}.${identifier(engine, table)}`;
}

function coordinates(value) {
  if (value === null || value === undefined) return null;
  return String(value).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
}

function readField(row, name) {
  if (Object.hasOwn(row, name)) return row[name];
  return row[name.toUpperCase()];
}

const postgresConfig = {
  host: required("DBSTUDIO_TRANSFER_PG_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_PG_PORT", dockerEnv.DBSTUDIO_POSTGIS_PORT || "25432"),
  database: required("DBSTUDIO_TRANSFER_PG_DATABASE", dockerEnv.DBSTUDIO_PG_DATABASE),
  user: required("DBSTUDIO_TRANSFER_PG_USER", dockerEnv.DBSTUDIO_PG_USER),
  password: required("DBSTUDIO_TRANSFER_PG_PASSWORD", dockerEnv.DBSTUDIO_PG_PASSWORD),
};
const sqlServerConfig = {
  server: required("DBSTUDIO_TRANSFER_SQLSERVER_HOST", "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_SQLSERVER_PORT", "21433"),
  database: required("DBSTUDIO_TRANSFER_SQLSERVER_DATABASE", "dbstudio_test"),
  user: required("DBSTUDIO_TRANSFER_SQLSERVER_USER", "sa"),
  password: required("DBSTUDIO_TRANSFER_SQLSERVER_PASSWORD", dockerEnv.SQLSERVER_SA_PASSWORD),
  encrypt: true,
  trustServerCertificate: true,
  connectionTimeout: 15_000,
  requestTimeout: 30_000,
};
const mysqlConfig = {
  host: required("DBSTUDIO_TRANSFER_MYSQL_HOST", dockerEnv.MYSQL_HOST || "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_MYSQL_PORT", dockerEnv.MYSQL_PORT || "23306"),
  database: required("DBSTUDIO_TRANSFER_MYSQL_DATABASE", dockerEnv.MYSQL_DATABASE || "dbstudio_test"),
  user: required("DBSTUDIO_TRANSFER_MYSQL_USER", dockerEnv.MYSQL_USER),
  password: required("DBSTUDIO_TRANSFER_MYSQL_PASSWORD", dockerEnv.MYSQL_PASSWORD),
  connectTimeout: 8_000,
};
const mariaDbConfig = {
  host: required("DBSTUDIO_TRANSFER_MARIADB_HOST", dockerEnv.MARIADB_HOST || "127.0.0.1"),
  port: port("DBSTUDIO_TRANSFER_MARIADB_PORT", dockerEnv.MARIADB_PORT || "23307"),
  database: required("DBSTUDIO_TRANSFER_MARIADB_DATABASE", dockerEnv.MARIADB_DATABASE || "dbstudio_test"),
  user: required("DBSTUDIO_TRANSFER_MARIADB_USER", dockerEnv.MARIADB_USER),
  password: required("DBSTUDIO_TRANSFER_MARIADB_PASSWORD", dockerEnv.MARIADB_PASSWORD),
  connectTimeout: 8_000,
};
const oracleConfig = {
  user: required("DBSTUDIO_TRANSFER_ORACLE_USER", "SYSTEM").toUpperCase(),
  password: required("DBSTUDIO_TRANSFER_ORACLE_PASSWORD", dockerEnv.ORACLE_PASSWORD),
  connectString: required("DBSTUDIO_TRANSFER_ORACLE_CONNECT_STRING",
    `//${required("DBSTUDIO_TRANSFER_ORACLE_HOST", "127.0.0.1")}:${port("DBSTUDIO_TRANSFER_ORACLE_PORT", "21521")}/${required("DBSTUDIO_TRANSFER_ORACLE_SERVICE", "FREEPDB1")}`),
  connectTimeout: 15,
  callTimeout: 30_000,
};

const postgres = CoreService.fromPostgresConfig({ ...postgresConfig, ssl: false, connectionTimeoutMillis: 8_000 });
const sqlServer = CoreService.fromSqlServerConfig(sqlServerConfig);
const mysql = CoreService.fromMySqlConfig(mysqlConfig);
const mariaDb = CoreService.fromMariaDbConfig(mariaDbConfig);
const oracle = CoreService.fromOracleConfig(oracleConfig);
const sqliteDirectory = mkdtempSync(path.join(tmpdir(), "db-studio-spatial-transfer-"));
const sqlitePath = path.join(sqliteDirectory, "spatial.sqlite");
const sqlite = CoreService.fromSqliteConfig({ path: sqlitePath });
const spatialiteDirectory = mkdtempSync(path.join(tmpdir(), "db-studio-spatialite-transfer-"));
const gdalBin = path.join(root, "apps/desktop/resources/gdal/bin");
const runId = randomBytes(5).toString("hex");
const tables = {
  sqlServerSource: `spatial_src_${runId}`,
  postgresTarget: `spatial_dst_${runId}`,
  postgresSource: `spatial_src_${runId}`,
  sqlServerTarget: `spatial_dst_${runId}`,
};
const created = { postgres: [], sqlserver: [], mysql: [], mariadb: [], oracle: [], sqlite: [] };

async function createTables(direction) {
  if (direction === "sqlserver-to-postgis") {
    const source = qualified("sqlserver", "dbo", tables.sqlServerSource);
    const target = qualified("postgres", "public", tables.postgresTarget);
    await sqlServer.query(`CREATE TABLE ${source} (id INT NOT NULL PRIMARY KEY, shape geometry NULL, location geography NULL, label NVARCHAR(40) NOT NULL)`);
    created.sqlserver.push(tables.sqlServerSource);
    await sqlServer.query(`INSERT INTO ${source} (id, shape, location, label) VALUES
      (1, geometry::STGeomFromText('POINT(10 20)', 3857), geography::STGeomFromText('POINT(-122.36 47.656)', 4326), N'first'),
      (2, geometry::STGeomFromText('POINT(31 41 51)', 3857), geography::STGeomFromText('POINT(-70 40)', 4326), N'second'),
      (3, NULL, NULL, N'null geometry')`);
    await postgres.query(`CREATE TABLE ${target} (id INTEGER PRIMARY KEY, shape geometry NULL, location geography NULL, label TEXT NOT NULL)`);
    created.postgres.push(tables.postgresTarget);
  } else {
    const source = qualified("postgres", "public", tables.postgresSource);
    const target = qualified("sqlserver", "dbo", tables.sqlServerTarget);
    await postgres.query(`CREATE TABLE ${source} (id INTEGER PRIMARY KEY, shape geometry NULL, location geography NULL, label TEXT NOT NULL)`);
    created.postgres.push(tables.postgresSource);
    await postgres.query(`INSERT INTO ${source} (id, shape, location, label) VALUES
      (1, ST_GeomFromEWKT('SRID=3857;POINT(12 22)'), ST_GeogFromText('SRID=4326;POINT(-71 41)'), 'first'),
      (2, ST_GeomFromEWKT('SRID=3857;POINT Z (32 42 52)'), ST_GeogFromText('SRID=4326;POINT(-72 42)'), 'second'),
      (3, NULL, NULL, 'null geometry')`);
    await sqlServer.query(`CREATE TABLE ${target} (id INT NOT NULL PRIMARY KEY, shape geometry NULL, location geography NULL, label NVARCHAR(40) NOT NULL)`);
    created.sqlserver.push(tables.sqlServerTarget);
  }
}

async function readPostgres(table) {
  const result = await postgres.query(`SELECT id, ST_SRID(shape) AS shape_srid, ST_AsText(shape) AS shape_wkt, ST_Z(shape) AS shape_z,
    ST_SRID(location) AS location_srid, ST_AsText(location::geometry) AS location_wkt, label
    FROM ${qualified("postgres", "public", table)} ORDER BY id`);
  return result.rows.map((row) => ({
    id: Number(readField(row, "id")),
    shapeSrid: readField(row, "shape_srid") === null ? null : Number(readField(row, "shape_srid")),
    shapeCoordinates: coordinates(readField(row, "shape_wkt")),
    shapeZ: readField(row, "shape_z") === null ? null : Number(readField(row, "shape_z")),
    locationSrid: readField(row, "location_srid") === null ? null : Number(readField(row, "location_srid")),
    locationCoordinates: coordinates(readField(row, "location_wkt")),
    label: readField(row, "label"),
  }));
}

async function readSqlServer(table) {
  const result = await sqlServer.query(`SELECT id, shape.STSrid AS shape_srid, shape.AsTextZM() AS shape_wkt, shape.Z AS shape_z,
    location.STSrid AS location_srid, location.ToString() AS location_wkt, label
    FROM ${qualified("sqlserver", "dbo", table)} ORDER BY id`);
  return result.rows.map((row) => ({
    id: Number(readField(row, "id")),
    shapeSrid: readField(row, "shape_srid") === null ? null : Number(readField(row, "shape_srid")),
    shapeCoordinates: coordinates(readField(row, "shape_wkt")),
    shapeZ: readField(row, "shape_z") === null ? null : Number(readField(row, "shape_z")),
    locationSrid: readField(row, "location_srid") === null ? null : Number(readField(row, "location_srid")),
    locationCoordinates: coordinates(readField(row, "location_wkt")),
    label: readField(row, "label"),
  }));
}

async function createMysqlSpatialTables(engine) {
  const service = engine === "mysql" ? mysql : mariaDb;
  const sourceTable = `spatial_${engine}_src_${runId}`;
  const targetTable = `spatial_${engine}_dst_${runId}`;
  const mysqlSource = qualified(engine, engine === "mysql" ? mysqlConfig.database : mariaDbConfig.database, sourceTable);
  const mysqlTarget = qualified(engine, engine === "mysql" ? mysqlConfig.database : mariaDbConfig.database, targetTable);
  const postgisSource = qualified("postgres", "public", sourceTable);
  const postgisTarget = qualified("postgres", "public", targetTable);
  const database = engine === "mysql" ? mysqlConfig.database : mariaDbConfig.database;

  await service.query(`CREATE TABLE ${mysqlSource} (id INT NOT NULL PRIMARY KEY, shape GEOMETRY NULL, label VARCHAR(40) NOT NULL)`);
  created[engine].push(sourceTable);
  const geographicPoint = engine === "mysql"
    ? "ST_GeomFromText('POINT(121.5 31.2)', 4326, 'axis-order=long-lat')"
    : "ST_GeomFromText('POINT(121.5 31.2)', 4326)";
  await service.query(`INSERT INTO ${mysqlSource} (id, shape, label) VALUES
    (1, ST_GeomFromText('POINT(10 20)', 3857), 'first'),
    (2, ${geographicPoint}, 'geographic'),
    (3, NULL, 'null geometry')`);
  await postgres.query(`CREATE TABLE ${postgisTarget} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(targetTable);

  await postgres.query(`CREATE TABLE ${postgisSource} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(sourceTable);
  await postgres.query(`INSERT INTO ${postgisSource} (id, shape, label) VALUES
    (1, ST_GeomFromEWKT('SRID=3857;POINT(10 20)'), 'first'),
    (2, ST_GeomFromEWKT('SRID=4326;POINT(121.5 31.2)'), 'geographic'),
    (3, NULL, 'null geometry')`);
  await service.query(`CREATE TABLE ${mysqlTarget} (id INT NOT NULL PRIMARY KEY, shape GEOMETRY NULL, label VARCHAR(40) NOT NULL)`);
  created[engine].push(targetTable);

  const fromMysql = await service.transferTableRows(postgres, {
    sourceTable,
    sourceSchema: database,
    targetTable,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(fromMysql.sourceRows, 3, `${engine} source row count`);
  assert.equal(fromMysql.insertedRows, 3, `${engine} to PostGIS inserted row count`);
  assertSpatialGeometryRows(await readPostgisGeometry(targetTable), engine);

  const toMysql = await postgres.transferTableRows(service, {
    sourceTable,
    sourceSchema: "public",
    targetTable,
    targetSchema: database,
    pageSize: 2,
  });
  assert.equal(toMysql.sourceRows, 3, `PostGIS ${engine} source row count`);
  assert.equal(toMysql.insertedRows, 3, `PostGIS to ${engine} inserted row count`);
  assertSpatialGeometryRows(await readMysqlGeometry(service, engine, targetTable, database), engine);
  return { service, directions: [`${engine} geometry to PostGIS`, `PostGIS geometry to ${engine}`] };
}

async function assertMysqlFamilyDimensionalRejection(engine) {
  const service = engine === "mysql" ? mysql : mariaDb;
  const database = engine === "mysql" ? mysqlConfig.database : mariaDbConfig.database;
  const sourceTable = `spatial_${engine}_z_src_${runId}`;
  const targetTable = `spatial_${engine}_z_dst_${runId}`;
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", sourceTable)} (id INTEGER PRIMARY KEY, shape geometry NULL)`);
  created.postgres.push(sourceTable);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", sourceTable)} (id, shape) VALUES
    (1, ST_GeomFromEWKT('SRID=4326;POINT Z (101.5 21.2 32)'))`);
  await service.query(`CREATE TABLE ${qualified(engine, database, targetTable)} (id INT NOT NULL PRIMARY KEY, shape GEOMETRY NULL)`);
  created[engine].push(targetTable);
  await assert.rejects(postgres.transferTableRows(service, {
    sourceTable,
    sourceSchema: "public",
    targetTable,
    targetSchema: database,
    pageSize: 2,
  }), /MySQL\/MariaDB geometry row transfer supports XY geometries only/);
  const remaining = Number(readField((await service.query(
    `SELECT COUNT(*) AS count FROM ${qualified(engine, database, targetTable)}`,
  )).rows[0] ?? {}, "count"));
  assert.equal(remaining, 0, `${engine} dimensional WKB rejection must happen before destination inserts`);
  return `${engine} dimensional WKB rejected before insert`;
}

function geopackageBlob(hexWkb, srid) {
  const wkb = Buffer.from(hexWkb, "hex");
  const header = Buffer.alloc(8);
  header.write("GP", 0, "ascii");
  header[3] = 0x01;
  header.writeInt32LE(srid, 4);
  return Buffer.concat([header, wkb]);
}

async function readSqliteGeometry(table) {
  const rows = (await sqlite.query(`SELECT id, shape, label FROM main.${table} ORDER BY id`)).rows;
  return rows.map((row) => {
    const raw = readField(row, "shape");
    if (raw === null || raw === undefined) {
      return { id: Number(readField(row, "id")), label: readField(row, "label"), srid: null, wkb: null };
    }
    const blob = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    return {
      id: Number(readField(row, "id")),
      label: readField(row, "label"),
      srid: blob.readInt32LE(4),
      wkb: blob.subarray(8).toString("hex"),
    };
  });
}

async function createSpatialTypeConversionTables() {
  const postgresSource = `spatial_conv_pg_src_${runId}`;
  const sqlServerTarget = `spatial_conv_ss_dst_${runId}`;
  const sqlServerSource = `spatial_conv_ss_src_${runId}`;
  const postgresTarget = `spatial_conv_pg_dst_${runId}`;
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresSource)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresSource);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", postgresSource)} (id, shape, label) VALUES
    (1, ST_GeomFromText('POINT(121.5 31.2)', 4326), 'geometry to geography')`);
  await sqlServer.query(`CREATE TABLE ${qualified("sqlserver", "dbo", sqlServerTarget)} (id INT NOT NULL PRIMARY KEY, shape geography NULL, label NVARCHAR(40) NOT NULL)`);
  created.sqlserver.push(sqlServerTarget);
  await assert.rejects(postgres.transferTableRows(sqlServer, {
    sourceTable: postgresSource,
    sourceSchema: "public",
    targetTable: sqlServerTarget,
    targetSchema: "dbo",
    pageSize: 2,
  }), /Spatial column 'shape' is geometry but destination 'shape' is geography/);
  const rejectedCount = Number(readField((await sqlServer.query(
    `SELECT COUNT(*) AS count FROM ${qualified("sqlserver", "dbo", sqlServerTarget)}`,
  )).rows[0] ?? {}, "count"));
  assert.equal(rejectedCount, 0, "Cross-type conversion must be rejected before inserts without opt-in");

  const forward = await postgres.transferTableRows(sqlServer, {
    sourceTable: postgresSource,
    sourceSchema: "public",
    targetTable: sqlServerTarget,
    targetSchema: "dbo",
    pageSize: 2,
    allowSpatialTypeConversion: true,
  });
  assert.equal(forward.insertedRows, 1, "Geometry to geography inserted row count");
  const forwardRows = (await sqlServer.query(`SELECT id, shape.STSrid AS srid, shape.AsTextZM() AS wkt, label
    FROM ${qualified("sqlserver", "dbo", sqlServerTarget)} ORDER BY id`)).rows.map((row) => ({
    srid: Number(readField(row, "srid")),
    wkt: String(readField(row, "wkt")),
    label: readField(row, "label"),
  }));
  assert.deepEqual(forwardRows, [{ srid: 4326, wkt: "POINT (121.5 31.2)", label: "geometry to geography" }]);

  await sqlServer.query(`CREATE TABLE ${qualified("sqlserver", "dbo", sqlServerSource)} (id INT NOT NULL PRIMARY KEY, shape geography NULL, label NVARCHAR(40) NOT NULL)`);
  created.sqlserver.push(sqlServerSource);
  await sqlServer.query(`INSERT INTO ${qualified("sqlserver", "dbo", sqlServerSource)} (id, shape, label) VALUES
    (1, geography::STGeomFromText('POINT(31.5 41.2)', 4326), N'geography to geometry')`);
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresTarget)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresTarget);
  const reverse = await sqlServer.transferTableRows(postgres, {
    sourceTable: sqlServerSource,
    sourceSchema: "dbo",
    targetTable: postgresTarget,
    targetSchema: "public",
    pageSize: 2,
    allowSpatialTypeConversion: true,
  });
  assert.equal(reverse.insertedRows, 1, "Geography to geometry inserted row count");
  const reverseRows = (await postgres.query(`SELECT id, ST_SRID(shape) AS srid, ST_AsText(shape::geometry) AS wkt, label
    FROM ${qualified("postgres", "public", postgresTarget)} ORDER BY id`)).rows.map((row) => ({
    srid: Number(readField(row, "srid")),
    wkt: String(readField(row, "wkt")),
    label: readField(row, "label"),
  }));
  assert.deepEqual(reverseRows, [{ srid: 4326, wkt: "POINT(31.5 41.2)", label: "geography to geometry" }]);
  return {
    directions: ["PostGIS geometry to SQL Server geography (opt-in)", "SQL Server geography to PostGIS geometry (opt-in)"],
    rejectedWithoutOptIn: true,
  };
}

async function assertSpatialPrimaryKeyRejection() {
  const sourceTable = `spatial_pk_src_${runId}`;
  const targetTable = `spatial_pk_dst_${runId}`;
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", sourceTable)} (shape geometry PRIMARY KEY, label TEXT NOT NULL)`);
  created.postgres.push(sourceTable);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", sourceTable)} (shape, label) VALUES (ST_GeomFromText('POINT(1 2)', 4326), 'point')`);
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", targetTable)} (shape geometry PRIMARY KEY, label TEXT NOT NULL)`);
  created.postgres.push(targetTable);
  await assert.rejects(postgres.transferTableRows(postgres, {
    sourceTable,
    targetTable,
    sourceSchema: "public",
    targetSchema: "public",
    pageSize: 2,
  }), /Spatial primary-key column 'shape' cannot be used for bounded keyset transfer/);
  const remaining = Number(readField((await postgres.query(
    `SELECT COUNT(*)::int AS count FROM ${qualified("postgres", "public", targetTable)}`,
  )).rows[0] ?? {}, "count"));
  assert.equal(remaining, 0, "Spatial primary-key rejection must happen before destination inserts");
  return "PostGIS geometry primary key rejected before insert";
}

async function createSpatialiteTransferTables() {
  const sourceFile = path.join(spatialiteDirectory, "source.geojson");
  writeFileSync(sourceFile, JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: 1, label: "甲" }, geometry: { type: "Point", coordinates: [104, 30] } },
    { type: "Feature", properties: { id: 2, label: "乙" }, geometry: { type: "Point", coordinates: [106, 32] } },
    { type: "Feature", properties: { id: 3, label: "null" }, geometry: null },
  ] }));
  const sourcePath = path.join(spatialiteDirectory, "source.sqlite");
  const targetPath = path.join(spatialiteDirectory, "target.sqlite");
  const environment = { ...process.env, PATH: `${gdalBin}${path.delimiter}${process.env.PATH}`, PROJ_LIB: path.join(root, "apps/desktop/resources/gdal/proj") };
  execFileSync(path.join(gdalBin, "ogr2ogr.exe"), [
    "-f", "SQLite", sourcePath, sourceFile,
    "-lco", "FORMAT=SPATIALITE", "-lco", "LAUNDER=NO",
    "-dsco", "SPATIALITE=YES", "-dsco", "INIT_WITH_EPSG=NO",
    "-a_srs", "EPSG:4326", "-nln", "points",
  ], { env: environment, stdio: "pipe" });
  const sqliteSource = CoreService.fromSqliteConfig({ path: sourcePath });
  const sqliteTarget = CoreService.fromSqliteConfig({ path: targetPath });
  // GDAL's SpatiaLite DDL adds a GeometryConstraints CHECK that requires the
  // extension at insert time. Register an equivalent SpatiaLite geometry
  // column without that CHECK so the native BLOB path is exercised directly.
  await sqliteTarget.query('CREATE TABLE points (id INTEGER PRIMARY KEY, "GEOMETRY" GEOMETRY, label TEXT)');
  await sqliteTarget.query("CREATE TABLE geometry_columns (f_table_name TEXT, f_geometry_column TEXT, geometry_type INTEGER, coord_dimension INTEGER, srid INTEGER, spatial_index_enabled INTEGER)");
  await sqliteTarget.query("INSERT INTO geometry_columns VALUES ('points', 'GEOMETRY', 1, 2, 4326, 0)");
  const postgresTarget = `spatial_pg_slite_dst_${runId}`;
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresTarget)} (id INTEGER PRIMARY KEY, "GEOMETRY" geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresTarget);

  const forward = await sqliteSource.transferTableRows(postgres, {
    sourceTable: "points",
    sourceSchema: "main",
    targetTable: postgresTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(forward.sourceRows, 3, "SpatiaLite source row count");
  assert.equal(forward.insertedRows, 3, "SpatiaLite to PostGIS inserted row count");
  const forwardRows = (await postgres.query(`SELECT id, ST_SRID("GEOMETRY") AS srid, ST_AsText("GEOMETRY") AS wkt, label
    FROM ${qualified("postgres", "public", postgresTarget)} ORDER BY id`)).rows.map((row) => ({
    srid: readField(row, "srid") === null ? null : Number(readField(row, "srid")),
    wkt: readField(row, "wkt") === null ? null : String(readField(row, "wkt")),
    label: readField(row, "label"),
  }));
  assert.deepEqual(forwardRows.map((row) => row.srid), [4326, 4326, null], "SpatiaLite to PostGIS SRIDs");
  assert.deepEqual(forwardRows.map((row) => row.wkt), ["POINT(104 30)", "POINT(106 32)", null], "SpatiaLite to PostGIS geometries");

  const reverse = await postgres.transferTableRows(sqliteTarget, {
    sourceTable: postgresTarget,
    sourceSchema: "public",
    targetTable: "points",
    targetSchema: "main",
    pageSize: 2,
  });
  assert.equal(reverse.sourceRows, 3, "PostGIS SpatiaLite source row count");
  assert.equal(reverse.insertedRows, 3, "PostGIS to SpatiaLite inserted row count");
  const targetAdapter = new SqliteAdapter({ path: targetPath });
  const backPage = await targetAdapter.readTablePage("points", ["id", "GEOMETRY", "label"], ["id"], undefined, 10, "main", { spatialWkbColumns: ["GEOMETRY"] });
  const backRows = backPage.rows.map((row) => ({
    srid: row.GEOMETRY?.srid ?? null,
    wkt: row.GEOMETRY ? `POINT(${Buffer.from(row.GEOMETRY.wkb).readDoubleLE(5)} ${Buffer.from(row.GEOMETRY.wkb).readDoubleLE(13)})` : null,
    label: row.label,
  }));
  await targetAdapter.close();
  assert.deepEqual(backRows.map((row) => row.srid), [4326, 4326, null], "PostGIS to SpatiaLite SRIDs");
  assert.deepEqual(backRows.map((row) => row.wkt), ["POINT(104 30)", "POINT(106 32)", null], "PostGIS to SpatiaLite geometries");
  return { directions: ["SpatiaLite native BLOB to PostGIS", "PostGIS to SpatiaLite native BLOB"] };
}

async function createSqliteSpatialTables() {
  const postgresSource = `spatial_pg_sqlite_src_${runId}`;
  const sqliteTarget = `spatial_sqlite_dst_${runId}`;
  const sqliteSource = `spatial_sqlite_src_${runId}`;
  const postgresTarget = `spatial_pg_sqlite_dst_${runId}`;
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresSource)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresSource);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", postgresSource)} (id, shape, label) VALUES
    (1, ST_GeomFromText('POINT(10 20)', 3857), 'first'),
    (2, ST_GeomFromText('POINT(121.5 31.2)', 4326), 'geographic'),
    (3, NULL, 'null geometry')`);
  const sourceRows = (await postgres.query(`SELECT id, encode(ST_AsBinary(shape), 'hex') AS wkb, ST_SRID(shape) AS srid, label
    FROM ${qualified("postgres", "public", postgresSource)} ORDER BY id`)).rows.map((row) => ({
    id: Number(readField(row, "id")),
    wkb: readField(row, "wkb") === null ? null : String(readField(row, "wkb")),
    srid: readField(row, "srid") === null ? null : Number(readField(row, "srid")),
    label: readField(row, "label"),
  }));

  await sqlite.query(`CREATE TABLE main.${sqliteSource} (id INTEGER PRIMARY KEY, shape GEOMETRY, label TEXT NOT NULL)`);
  created.sqlite.push(sqliteSource);
  for (const row of sourceRows) {
    await sqlite.query(`INSERT INTO main.${sqliteSource} (id, shape, label) VALUES (?, ?, ?)`, [
      row.id,
      row.wkb === null ? null : geopackageBlob(row.wkb, row.srid ?? 0),
      row.label,
    ]);
  }
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresTarget)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresTarget);
  const fromSqlite = await sqlite.transferTableRows(postgres, {
    sourceTable: sqliteSource,
    sourceSchema: "main",
    targetTable: postgresTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(fromSqlite.sourceRows, 3, "SQLite source row count");
  assert.equal(fromSqlite.insertedRows, 3, "SQLite to PostGIS inserted row count");
  assert.deepEqual((await readPostgisGeometry(postgresTarget)).map((row) => row.coordinates),
    [[10, 20], [121.5, 31.2], null], "SQLite to PostGIS coordinates");

  await sqlite.query(`CREATE TABLE main.${sqliteTarget} (id INTEGER PRIMARY KEY, shape GEOMETRY, label TEXT NOT NULL)`);
  created.sqlite.push(sqliteTarget);
  const toSqlite = await postgres.transferTableRows(sqlite, {
    sourceTable: postgresSource,
    sourceSchema: "public",
    targetTable: sqliteTarget,
    targetSchema: "main",
    pageSize: 2,
  });
  assert.equal(toSqlite.sourceRows, 3, "PostGIS SQLite source row count");
  assert.equal(toSqlite.insertedRows, 3, "PostGIS to SQLite inserted row count");
  const sqliteRows = await readSqliteGeometry(sqliteTarget);
  assert.deepEqual(sqliteRows.map((row) => row.id), [1, 2, 3], "PostGIS to SQLite IDs");
  assert.deepEqual(sqliteRows.map((row) => row.wkb), sourceRows.map((row) => row.wkb), "PostGIS to SQLite WKB blobs");
  assert.deepEqual(sqliteRows.map((row) => row.srid), [3857, 4326, null], "PostGIS to SQLite SRS ids");
  assert.deepEqual(sqliteRows.map((row) => row.label), ["first", "geographic", "null geometry"]);
  return { directions: ["SQLite/GeoPackage to PostGIS", "PostGIS to SQLite/GeoPackage"] };
}

async function createOracleSpatialTables() {
  const oracleSource = `spatial_oracle_src_${runId}`;
  const oracleTarget = `spatial_oracle_dst_${runId}`;
  const postgresTarget = oracleSource;
  const postgresSource = oracleTarget;
  const oracleSourceName = qualified("oracle", oracleConfig.user, oracleSource);
  const oracleTargetName = qualified("oracle", oracleConfig.user, oracleTarget);

  await oracle.query(`CREATE TABLE ${oracleSourceName} (id NUMBER(10) NOT NULL PRIMARY KEY, shape MDSYS.SDO_GEOMETRY NULL, label NVARCHAR2(40) NOT NULL)`);
  created.oracle.push(oracleSource);
  await oracle.query(`INSERT ALL
    INTO ${oracleSourceName} (id, shape, label) VALUES (1, MDSYS.SDO_GEOMETRY(2001, 3857, MDSYS.SDO_POINT_TYPE(10, 20, NULL), NULL, NULL), N'first')
    INTO ${oracleSourceName} (id, shape, label) VALUES (2, MDSYS.SDO_GEOMETRY(2001, 4326, MDSYS.SDO_POINT_TYPE(121.5, 31.2, NULL), NULL, NULL), N'geographic')
    INTO ${oracleSourceName} (id, shape, label) VALUES (3, MDSYS.SDO_GEOMETRY(2001, NULL, MDSYS.SDO_POINT_TYPE(7, 8, NULL), NULL, NULL), N'unknown srid')
    INTO ${oracleSourceName} (id, shape, label) VALUES (4, NULL, N'null geometry')
    SELECT 1 FROM dual`);
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresTarget)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresTarget);

  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresSource)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresSource);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", postgresSource)} (id, shape, label) VALUES
    (1, ST_GeomFromEWKT('SRID=3857;POINT(10 20)'), 'first'),
    (2, ST_GeomFromEWKT('SRID=4326;POINT(121.5 31.2)'), 'geographic'),
    (3, ST_GeomFromText('POINT(7 8)', 0), 'unknown srid'),
    (4, NULL, 'null geometry')`);
  await oracle.query(`CREATE TABLE ${oracleTargetName} (id NUMBER(10) NOT NULL PRIMARY KEY, shape MDSYS.SDO_GEOMETRY NULL, label NVARCHAR2(40) NOT NULL)`);
  created.oracle.push(oracleTarget);

  const fromOracle = await oracle.transferTableRows(postgres, {
    sourceTable: oracleSource,
    sourceSchema: oracleConfig.user,
    targetTable: postgresTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(fromOracle.sourceRows, 4, "Oracle source row count");
  assert.equal(fromOracle.insertedRows, 4, "Oracle to PostGIS inserted row count");
  const fromOracleRows = await readPostgisGeometry(postgresTarget);
  assert.deepEqual(fromOracleRows.map((row) => row.id), [1, 2, 3, 4], "Oracle to PostGIS IDs");
  assert.deepEqual(fromOracleRows.map((row) => row.srid), [3857, 4326, 0, null], "Oracle to PostGIS SRIDs");
  assert.deepEqual(fromOracleRows.map((row) => row.coordinates), [[10, 20], [121.5, 31.2], [7, 8], null], "Oracle to PostGIS coordinates");
  assert.deepEqual(fromOracleRows.map((row) => row.label), ["first", "geographic", "unknown srid", "null geometry"]);

  const toOracle = await postgres.transferTableRows(oracle, {
    sourceTable: postgresSource,
    sourceSchema: "public",
    targetTable: oracleTarget,
    targetSchema: oracleConfig.user,
    pageSize: 2,
  });
  assert.equal(toOracle.sourceRows, 4, "PostGIS Oracle source row count");
  assert.equal(toOracle.insertedRows, 4, "PostGIS to Oracle inserted row count");
  const toOracleRows = await readOracleGeometry(oracleTarget);
  assert.deepEqual(toOracleRows.map((row) => row.id), [1, 2, 3, 4], "PostGIS to Oracle IDs");
  assert.deepEqual(toOracleRows.map((row) => row.srid), [3857, 4326, null, null], "PostGIS to Oracle SRIDs");
  assert.deepEqual(toOracleRows.map((row) => row.coordinates), [[10, 20], [121.5, 31.2], [7, 8], null], "PostGIS to Oracle coordinates");
  assert.deepEqual(toOracleRows.map((row) => row.label), ["first", "geographic", "unknown srid", "null geometry"]);

  // Dimensional (Z/M) row transfer in both directions. Oracle TO_WKBGEOMETRY
  // drops Z and rejects 4D, so dimensional rows use a 2D structural WKB plus
  // SDO_UTIL.GETVERTICES ordinates and are rebuilt by the adapter.
  const oracleZmSource = `spatial_oracle_zm_src_${runId}`;
  const postgresZmTarget = oracleZmSource;
  const oracleZmSourceName = qualified("oracle", oracleConfig.user, oracleZmSource);
  await oracle.query(`CREATE TABLE ${oracleZmSourceName} (id NUMBER(10) NOT NULL PRIMARY KEY, shape MDSYS.SDO_GEOMETRY NULL, label NVARCHAR2(40) NOT NULL)`);
  created.oracle.push(oracleZmSource);
  await oracle.query(`INSERT ALL
    INTO ${oracleZmSourceName} (id, shape, label) VALUES (1, MDSYS.SDO_GEOMETRY(3001, 4326, MDSYS.SDO_POINT_TYPE(121.5, 31.2, 52), NULL, NULL), N'xyz')
    INTO ${oracleZmSourceName} (id, shape, label) VALUES (2, MDSYS.SDO_GEOMETRY(3301, 4326, MDSYS.SDO_POINT_TYPE(121.6, 31.3, 7), NULL, NULL), N'xym')
    INTO ${oracleZmSourceName} (id, shape, label) VALUES (3, MDSYS.SDO_GEOMETRY(4401, 4326, NULL, MDSYS.SDO_ELEM_INFO_ARRAY(1,1,1), MDSYS.SDO_ORDINATE_ARRAY(121.7, 31.4, 53, 8)), N'xyzm')
    INTO ${oracleZmSourceName} (id, shape, label) VALUES (4, MDSYS.SDO_GEOMETRY(3002, 4326, NULL, MDSYS.SDO_ELEM_INFO_ARRAY(1,2,1), MDSYS.SDO_ORDINATE_ARRAY(10, 20, 5, 11, 21, 6)), N'xyz line')
    SELECT 1 FROM dual`);
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresZmTarget)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresZmTarget);
  const fromOracleZm = await oracle.transferTableRows(postgres, {
    sourceTable: oracleZmSource,
    sourceSchema: oracleConfig.user,
    targetTable: postgresZmTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(fromOracleZm.sourceRows, 4, "Oracle dimensional source row count");
  assert.equal(fromOracleZm.insertedRows, 4, "Oracle dimensional to PostGIS inserted row count");
  const fromOracleZmRows = (await postgres.query(`SELECT id, ST_SRID(shape) AS shape_srid, ST_AsEWKT(shape) AS shape_ewkt,
    ST_NDims(shape) AS ndims, label
    FROM ${qualified("postgres", "public", postgresZmTarget)} ORDER BY id`)).rows.map((row) => ({
    id: Number(readField(row, "id")),
    srid: Number(readField(row, "shape_srid")),
    ewkt: String(readField(row, "shape_ewkt")),
    ndims: Number(readField(row, "ndims")),
    label: readField(row, "label"),
  }));
  assert.deepEqual(fromOracleZmRows.map((row) => row.srid), [4326, 4326, 4326, 4326], "Oracle dimensional SRIDs");
  assert.deepEqual(fromOracleZmRows.map((row) => row.ndims), [3, 3, 4, 3], "Oracle dimensional coordinate counts");
  assert.deepEqual(fromOracleZmRows.map((row) => row.ewkt), [
    "SRID=4326;POINT(121.5 31.2 52)",
    "SRID=4326;POINTM(121.6 31.3 7)",
    "SRID=4326;POINT(121.7 31.4 53 8)",
    "SRID=4326;LINESTRING(10 20 5,11 21 6)",
  ], "Oracle dimensional EWKT readback");
  assert.deepEqual(fromOracleZmRows.map((row) => row.label), ["xyz", "xym", "xyzm", "xyz line"]);

  const postgresZmSource = `spatial_pg_oracle_zm_src_${runId}`;
  const oracleZmTarget = `spatial_oracle_zm_dst_${runId}`;
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresZmSource)} (id INTEGER PRIMARY KEY, shape geometry NULL, label TEXT NOT NULL)`);
  created.postgres.push(postgresZmSource);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", postgresZmSource)} (id, shape, label) VALUES
    (1, ST_GeomFromEWKT('SRID=4326;POINT Z (11.5 21.2 32)'), 'xyz'),
    (2, ST_GeomFromEWKT('SRID=4326;POINT M (11.6 21.3 7)'), 'xym'),
    (3, ST_GeomFromEWKT('SRID=4326;POINT ZM (11.7 21.4 42 8)'), 'xyzm')`);
  await oracle.query(`CREATE TABLE ${qualified("oracle", oracleConfig.user, oracleZmTarget)} (id NUMBER(10) NOT NULL PRIMARY KEY, shape MDSYS.SDO_GEOMETRY NULL, label NVARCHAR2(40) NOT NULL)`);
  created.oracle.push(oracleZmTarget);
  const toOracleZm = await postgres.transferTableRows(oracle, {
    sourceTable: postgresZmSource,
    sourceSchema: "public",
    targetTable: oracleZmTarget,
    targetSchema: oracleConfig.user,
    pageSize: 2,
  });
  assert.equal(toOracleZm.sourceRows, 3, "PostGIS dimensional source row count");
  assert.equal(toOracleZm.insertedRows, 3, "PostGIS dimensional to Oracle inserted row count");
  const toOracleZmRows = (await oracle.query(`SELECT src.id, src.shape.SDO_GTYPE AS gtype, src.shape.SDO_SRID AS srid,
    vertex.x AS x, vertex.y AS y, vertex.z AS z, vertex.w AS w, src.label
    FROM ${qualified("oracle", oracleConfig.user, oracleZmTarget)} src
    CROSS JOIN TABLE(MDSYS.SDO_UTIL.GETVERTICES(src.shape)) vertex ORDER BY src.id`)).rows.map((row) => ({
    id: Number(readField(row, "id")),
    gtype: Number(readField(row, "gtype")),
    srid: readField(row, "srid") === null ? null : Number(readField(row, "srid")),
    ordinates: ["X", "Y", "Z", "W"].map((axis) => {
      const value = readField(row, axis.toLowerCase()) ?? readField(row, axis);
      return value === null || value === undefined ? null : Number(value);
    }),
    label: readField(row, "label"),
  }));
  assert.deepEqual(toOracleZmRows.map((row) => row.gtype), [3001, 3301, 4401], "PostGIS dimensional SDO_GTYPE values");
  assert.deepEqual(toOracleZmRows.map((row) => row.srid), [4326, 4326, 4326], "PostGIS dimensional Oracle SRIDs");
  assert.deepEqual(toOracleZmRows.map((row) => row.ordinates), [
    [11.5, 21.2, 32, null],
    [11.6, 21.3, 7, null],
    [11.7, 21.4, 42, 8],
  ], "PostGIS dimensional ordinates in Oracle");
  assert.deepEqual(toOracleZmRows.map((row) => row.label), ["xyz", "xym", "xyzm"]);

  return {
    service: oracle,
    directions: ["Oracle SDO_GEOMETRY to PostGIS", "PostGIS to Oracle SDO_GEOMETRY", "Oracle Z/M to PostGIS", "PostGIS Z/M to Oracle"],
    dimensionalRoundTrip: true,
  };
}

async function readPostgisGeometry(table) {
  const result = await postgres.query(`SELECT id, ST_SRID(shape) AS shape_srid, ST_AsText(shape) AS shape_wkt, label
    FROM ${qualified("postgres", "public", table)} ORDER BY id`);
  return result.rows.map((row) => ({
    id: Number(readField(row, "id")),
    srid: readField(row, "shape_srid") === null ? null : Number(readField(row, "shape_srid")),
    coordinates: coordinates(readField(row, "shape_wkt")),
    label: readField(row, "label"),
  }));
}

async function readMysqlGeometry(service, engine, table, schema) {
  const axisOptions = engine === "mysql" ? ", 'axis-order=long-lat'" : "";
  const result = await service.query(`SELECT id, ST_SRID(shape) AS shape_srid,
    ST_AsText(shape${axisOptions}) AS shape_wkt, label
    FROM ${qualified(engine, schema, table)} ORDER BY id`);
  return result.rows.map((row) => ({
    id: Number(readField(row, "id")),
    srid: readField(row, "shape_srid") === null ? null : Number(readField(row, "shape_srid")),
    coordinates: coordinates(readField(row, "shape_wkt")),
    label: readField(row, "label"),
  }));
}

async function readOracleGeometry(table) {
  const result = await oracle.query(`SELECT dbstudio_source.id, dbstudio_source.shape.SDO_SRID AS shape_srid,
    DBMS_LOB.SUBSTR(MDSYS.SDO_UTIL.TO_WKTGEOMETRY(dbstudio_source.shape), 4000, 1) AS shape_wkt, dbstudio_source.label
    FROM ${qualified("oracle", oracleConfig.user, table)} dbstudio_source ORDER BY dbstudio_source.id`);
  return result.rows.map((row) => ({
    id: Number(readField(row, "id")),
    srid: readField(row, "shape_srid") === null || readField(row, "shape_srid") === undefined ? null : Number(readField(row, "shape_srid")),
    coordinates: coordinates(readField(row, "shape_wkt")),
    label: readField(row, "label"),
  }));
}

function assertSpatialGeometryRows(rows, engine) {
  assert.equal(rows.length, 3, `${engine} geometry row count`);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3], `${engine} geometry IDs`);
  assert.deepEqual(rows.map((row) => row.srid), [3857, 4326, null], `${engine} geometry SRIDs`);
  assert.deepEqual(rows.map((row) => row.coordinates), [[10, 20], [121.5, 31.2], null], `${engine} XY coordinates`);
  assert.deepEqual(rows.map((row) => row.label), ["first", "geographic", "null geometry"], `${engine} labels`);
}

function assertRows(rows, points) {
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.shapeSrid), [3857, 3857, null]);
  assert.deepEqual(rows.map((row) => row.shapeCoordinates), [points.shape[0], points.shape[1], null]);
  assert.deepEqual(rows.map((row) => row.shapeZ), points.shapeZ);
  assert.deepEqual(rows.map((row) => row.locationSrid), [4326, 4326, null]);
  assert.deepEqual(rows.map((row) => row.locationCoordinates), [points.location[0], points.location[1], null]);
  assert.deepEqual(rows.map((row) => row.label), ["first", "second", "null geometry"]);
}

async function createSqlServerZmTables() {
  const sqlServerSource = `spatial_ss_zm_src_${runId}`;
  const postgresTarget = sqlServerSource;
  const postgresSource = `spatial_pg_zm_src_${runId}`;
  const sqlServerTarget = `spatial_ss_zm_dst_${runId}`;
  await sqlServer.query(`CREATE TABLE ${qualified("sqlserver", "dbo", sqlServerSource)} (id INT NOT NULL PRIMARY KEY, shape geometry NULL)`);
  created.sqlserver.push(sqlServerSource);
  await sqlServer.query(`INSERT INTO ${qualified("sqlserver", "dbo", sqlServerSource)} (id, shape) VALUES
    (1, geometry::STGeomFromText('POINT (31.6 41.3 NULL 17)', 4326)),
    (2, geometry::STGeomFromText('POINT (31.7 41.4 52 18)', 4326))`);
  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresTarget)} (id INTEGER PRIMARY KEY, shape geometry NULL)`);
  created.postgres.push(postgresTarget);
  const forward = await sqlServer.transferTableRows(postgres, {
    sourceTable: sqlServerSource,
    sourceSchema: "dbo",
    targetTable: postgresTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(forward.sourceRows, 2, "SQL Server dimensional source row count");
  assert.equal(forward.insertedRows, 2, "SQL Server dimensional to PostGIS inserted row count");
  const forwardRows = (await postgres.query(`SELECT id, ST_AsEWKT(shape) AS ewkt, ST_NDims(shape) AS ndims
    FROM ${qualified("postgres", "public", postgresTarget)} ORDER BY id`)).rows.map((row) => ({
    ewkt: String(readField(row, "ewkt")),
    ndims: Number(readField(row, "ndims")),
  }));
  assert.deepEqual(forwardRows.map((row) => row.ndims), [3, 4], "SQL Server dimensional coordinate counts");
  assert.deepEqual(forwardRows.map((row) => row.ewkt), [
    "SRID=4326;POINTM(31.6 41.3 17)",
    "SRID=4326;POINT(31.7 41.4 52 18)",
  ], "SQL Server dimensional EWKT readback");

  await postgres.query(`CREATE TABLE ${qualified("postgres", "public", postgresSource)} (id INTEGER PRIMARY KEY, shape geometry NULL)`);
  created.postgres.push(postgresSource);
  await postgres.query(`INSERT INTO ${qualified("postgres", "public", postgresSource)} (id, shape) VALUES
    (1, ST_GeomFromEWKT('SRID=4326;POINT M (11.6 21.3 7)')),
    (2, ST_GeomFromEWKT('SRID=4326;POINT ZM (11.7 21.4 42 8)'))`);
  await sqlServer.query(`CREATE TABLE ${qualified("sqlserver", "dbo", sqlServerTarget)} (id INT NOT NULL PRIMARY KEY, shape geometry NULL)`);
  created.sqlserver.push(sqlServerTarget);
  const reverse = await postgres.transferTableRows(sqlServer, {
    sourceTable: postgresSource,
    sourceSchema: "public",
    targetTable: sqlServerTarget,
    targetSchema: "dbo",
    pageSize: 2,
  });
  assert.equal(reverse.sourceRows, 2, "PostGIS dimensional source row count");
  assert.equal(reverse.insertedRows, 2, "PostGIS dimensional to SQL Server inserted row count");
  const reverseRows = (await sqlServer.query(`SELECT id, shape.AsTextZM() AS wkt
    FROM ${qualified("sqlserver", "dbo", sqlServerTarget)} ORDER BY id`)).rows.map((row) => String(readField(row, "wkt")));
  assert.deepEqual(reverseRows, ["POINT (11.6 21.3 NULL 7)", "POINT (11.7 21.4 42 8)"], "PostGIS dimensional readback in SQL Server");
  return { directions: ["SQL Server Z/M to PostGIS", "PostGIS Z/M to SQL Server"] };
}

try {
  const postgis = await postgres.query("SELECT PostGIS_Version() AS version");
  assert.equal(postgis.rows.length, 1, "PostGIS must be enabled in the isolated test database.");

  await createTables("sqlserver-to-postgis");
  const forward = await sqlServer.transferTableRows(postgres, {
    sourceTable: tables.sqlServerSource,
    sourceSchema: "dbo",
    targetTable: tables.postgresTarget,
    targetSchema: "public",
    pageSize: 2,
  });
  assert.equal(forward.sourceRows, 3);
  assert.equal(forward.insertedRows, 3);
  const forwardRows = await readPostgres(tables.postgresTarget);
  assertRows(forwardRows, {
    shape: [[10, 20], [31, 41, 51]],
    shapeZ: [null, 51, null],
    location: [[-122.36, 47.656], [-70, 40]],
  });

  await createTables("postgis-to-sqlserver");
  const reverse = await postgres.transferTableRows(sqlServer, {
    sourceTable: tables.postgresSource,
    sourceSchema: "public",
    targetTable: tables.sqlServerTarget,
    targetSchema: "dbo",
    pageSize: 2,
  });
  assert.equal(reverse.sourceRows, 3);
  assert.equal(reverse.insertedRows, 3);
  const reverseRows = await readSqlServer(tables.sqlServerTarget);
  assertRows(reverseRows, {
    shape: [[12, 22], [32, 42, 52]],
    shapeZ: [null, 52, null],
    location: [[-71, 41], [-72, 42]],
  });

  const sqlServerZm = await createSqlServerZmTables();
  const mysqlSpatial = await createMysqlSpatialTables("mysql");
  const mariaDbSpatial = await createMysqlSpatialTables("mariadb");
  const mysqlDimensionalRejected = await assertMysqlFamilyDimensionalRejection("mysql");
  const mariaDbDimensionalRejected = await assertMysqlFamilyDimensionalRejection("mariadb");
  const spatialPkRejected = await assertSpatialPrimaryKeyRejection();
  const spatialConversion = await createSpatialTypeConversionTables();
  const spatialiteSpatial = await createSpatialiteTransferTables();
  const sqliteSpatial = await createSqliteSpatialTables();
  const oracleSpatial = await createOracleSpatialTables();

  while (created.postgres.length) {
    const table = created.postgres.at(-1);
    await postgres.query(`DROP TABLE IF EXISTS ${qualified("postgres", "public", table)}`);
    created.postgres.pop();
  }
  while (created.sqlserver.length) {
    const table = created.sqlserver.at(-1);
    await sqlServer.query(`DROP TABLE IF EXISTS ${qualified("sqlserver", "dbo", table)}`);
    created.sqlserver.pop();
  }
  for (const engine of ["mysql", "mariadb"]) {
    const service = engine === "mysql" ? mysql : mariaDb;
    const database = engine === "mysql" ? mysqlConfig.database : mariaDbConfig.database;
    while (created[engine].length) {
      const table = created[engine].at(-1);
      await service.query(`DROP TABLE IF EXISTS ${qualified(engine, database, table)}`);
      created[engine].pop();
    }
  }
  while (created.oracle.length) {
    const table = created.oracle.at(-1);
    await oracle.query(`DROP TABLE ${qualified("oracle", oracleConfig.user, table)} PURGE`);
    created.oracle.pop();
  }
  while (created.sqlite.length) {
    const table = created.sqlite.at(-1);
    await sqlite.query(`DROP TABLE IF EXISTS main.${table}`);
    created.sqlite.pop();
  }

  const remainingTables = {
    postgres: Number(readField((await postgres.query(
      "SELECT COUNT(*)::int AS remaining FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE $2",
      ["public", `%${runId}`],
    )).rows[0] ?? {}, "remaining")),
    sqlserver: Number(readField((await sqlServer.query(
      "SELECT COUNT(*) AS remaining FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME LIKE @p1",
      [`%${runId}`],
    )).rows[0] ?? {}, "remaining")),
    mysql: Number(readField((await mysql.query(
      "SELECT COUNT(*) AS remaining FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?",
      [mysqlConfig.database, `%${runId}`],
    )).rows[0] ?? {}, "remaining")),
    mariadb: Number(readField((await mariaDb.query(
      "SELECT COUNT(*) AS remaining FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?",
      [mariaDbConfig.database, `%${runId}`],
    )).rows[0] ?? {}, "remaining")),
    oracle: Number(readField((await oracle.query(
      "SELECT COUNT(*) AS remaining FROM user_tables WHERE table_name LIKE :1",
      [`%${runId}`],
    )).rows[0] ?? {}, "remaining")),
    sqlite: Number(readField((await sqlite.query(
      "SELECT COUNT(*) AS remaining FROM sqlite_master WHERE type = 'table' AND name LIKE ?",
      [`%${runId}`],
    )).rows[0] ?? {}, "remaining")),
  };
  for (const [engine, remaining] of Object.entries(remainingTables)) {
    assert.equal(remaining, 0, `${engine} retained spatial transfer smoke tables after cleanup`);
  }

  const evidence = {
    date: new Date().toISOString(),
    status: "passed",
    source: "synthetic-only",
    directions: [
      "SQL Server to PostGIS",
      "PostGIS to SQL Server",
      ...sqlServerZm.directions,
      ...spatialConversion.directions,
      ...mysqlSpatial.directions,
      ...spatialiteSpatial.directions,
      ...sqliteSpatial.directions,
      ...mariaDbSpatial.directions,
      ...oracleSpatial.directions,
    ],
    rowsPerDirection: 3,
    geometryTypes: ["geometry", "geography"],
    srids: { geometry: 3857, geography: 4326 },
    dimensions: ["XY", "XYZ"],
    nullGeometryRowsPerDirection: 1,
    pageSize: 2,
    sourceAndTargetCountsMatched: true,
    coordinateAndSridReadbackMatched: true,
    mysqlFamilyGeometry: {
      engines: ["mysql", "mariadb"],
      srids: [3857, 4326],
      dimensions: ["XY"],
      rowsPerDirection: 3,
      nullGeometryRowsPerDirection: 1,
      nonSymmetricGeographicCoordinatesPreserved: true,
      testTablesRemaining: { mysql: remainingTables.mysql, mariadb: remainingTables.mariadb },
    },
    oracleSdoGeometry: {
      srids: [3857, 4326, null],
      dimensions: ["XY"],
      rowsPerDirection: 4,
      nullGeometryRowsPerDirection: 1,
      unknownSridMappedBetweenOracleNullAndPostGisZero: true,
    },
    oracleSdoDimensionalTransfer: {
      ...oracleSpatial.dimensionalRoundTrip && { roundTripPassed: true },
      dimensions: ["XYZ", "XYM", "XYZM"],
      geometryTypes: ["POINT", "LINESTRING"],
      oracleToPostGisRows: 4,
      postGisToOracleRows: 3,
    },
    sqlServerDimensionalTransfer: {
      roundTripPassed: true,
      dimensions: ["XYM", "XYZM"],
      rowsPerDirection: 2,
    },
    spatialiteNativeTransfer: {
      ...spatialiteSpatial.directions.length === 2 && { roundTripPassed: true },
      storage: "SpatiaLite native geometry BLOB",
      dimensions: ["XY"],
      srids: [4326],
      rowsPerDirection: 3,
      nullGeometryRowsPerDirection: 1,
    },
    sqliteGeoPackageTransfer: {
      ...sqliteSpatial.directions.length === 2 && { roundTripPassed: true },
      storage: "GeoPackage geometry BLOB",
      srids: [3857, 4326],
      rowsPerDirection: 3,
      nullGeometryRowsPerDirection: 1,
    },
    mysqlFamilyDimensionalTransfer: {
      supported: false,
      reason: "MySQL/MariaDB ST_GeomFromWKB rejects dimensional WKB; rejected explicitly to avoid ordinate loss.",
      liveRejections: [mysqlDimensionalRejected, mariaDbDimensionalRejected],
    },
    spatialPrimaryKeyTransfer: {
      supported: false,
      reason: "Keyset paging requires an orderable non-spatial primary key; spatial PKs are rejected before any page is read.",
      liveRejection: spatialPkRejected,
    },
    spatialTypeConversion: {
      ...spatialConversion,
      note: "Opt-in only; caller must supply a valid geographic SRID. Destination engines still enforce their own CRS rules.",
    },
    testTablesRemaining: remainingTables,
    testTablesCleaned: true,
    externalDataSent: false,
  };
  const evidencePath = path.resolve(".cache", "gis-roundtrip", `spatial-table-transfer-${runId}.json`);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "passed", evidence: evidencePath, rowsPerDirection: 3, directions: evidence.directions }));
} finally {
  for (const table of created.postgres.reverse()) {
    await postgres.query(`DROP TABLE IF EXISTS ${qualified("postgres", "public", table)}`).catch(() => undefined);
  }
  for (const table of created.sqlserver.reverse()) {
    await sqlServer.query(`DROP TABLE IF EXISTS ${qualified("sqlserver", "dbo", table)}`).catch(() => undefined);
  }
  for (const table of created.mysql.reverse()) {
    await mysql.query(`DROP TABLE IF EXISTS ${qualified("mysql", mysqlConfig.database, table)}`).catch(() => undefined);
  }
  for (const table of created.mariadb.reverse()) {
    await mariaDb.query(`DROP TABLE IF EXISTS ${qualified("mariadb", mariaDbConfig.database, table)}`).catch(() => undefined);
  }
  for (const table of created.oracle.reverse()) {
    await oracle.query(`DROP TABLE ${qualified("oracle", oracleConfig.user, table)} PURGE`).catch(() => undefined);
  }
  rmSync(sqliteDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  rmSync(spatialiteDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
