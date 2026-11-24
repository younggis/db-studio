# CLI design

The `dbstudio` executable uses Commander and calls `@db-studio/core`. It does not import or launch Electron. Current commands are `doctor`, `connections list/add/update/remove/test`, `databases list`, `schemas list`, `tables list/columns/transfer`, `query run`, `data import/export`, `ai models list/test`, `ai sql generate/gis/repair/explain/explain-plan`, `mongo collections/find/aggregate/indexes/create-2dsphere-index/geo-find/import/export/geo-import/geo-export`, and `gis inspect/convert/import/export`.

`ai sql gis` creates a reviewable PostGIS-only spatial SQL draft. It requires `--include-schema` because selected table and spatial metadata can be sent to the configured model. The CLI reads PostGIS version, spatial column kind/type/SRID/dimension, and supported functions from the active database for the selected tables. If these facts are missing or incomplete, it returns a clarification instead of sending a GIS request to the model. Generated SQL is validated and printed for review; it is never executed by the assistant.

```powershell
dbstudio ai sql gis --connection local-pg --request "find roads within 500 meters of this point" --schema public --table public.roads --include-schema --format json
```

PostgreSQL configuration is read from `DATABASE_URL`/`DBSTUDIO_DATABASE_URL` or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE`. SQLite uses `DBSTUDIO_DATABASE_TYPE=sqlite` and `DBSTUDIO_SQLITE_PATH=<file>`. MySQL uses `DBSTUDIO_DATABASE_TYPE=mysql` and `DBSTUDIO_MYSQL_URL` or `MYSQL_*` variables. MariaDB uses `DBSTUDIO_DATABASE_TYPE=mariadb` and `DBSTUDIO_MARIADB_URL` or `MARIADB_*` variables. MongoDB uses `DBSTUDIO_DATABASE_TYPE=mongodb`, `DBSTUDIO_MONGODB_URL` or `MONGODB_URI`, and an optional `DBSTUDIO_MONGODB_DATABASE` / `MONGODB_DATABASE`. SQL Server uses `DBSTUDIO_DATABASE_TYPE=sqlserver` with `SQLSERVER_*` or `DBSTUDIO_SQLSERVER_URL`; Oracle uses `DBSTUDIO_DATABASE_TYPE=oracle` with `ORACLE_USER`, `ORACLE_PASSWORD`, and a service/connect string. Secrets are not printed. Query parameters use `--params` as a JSON array and are bound by the selected driver. Relational query output supports table, JSON, CSV, NDJSON and XLSX. MongoDB JSON/EJSON commands use the independent document service.

`tables columns --table <table> [--schema <schema>]` returns field order, type, nullability, default value and primary-key status as JSON. `data export` and `data import` accept `--format csv|json|xlsx`; imports append to existing tables. CSV/JSON/XLSX transfers are live verified on PostgreSQL, MySQL, MariaDB, SQLite, SQL Server and Oracle. The first worksheet is used for XLSX imports; header names must be unique and non-empty. XLSX transfers cap files at 50 MiB, actual ZIP-expanded size at 128 MiB, ZIP entries at 4,096, data rows at 100,000, columns at 2,048, and processing at 1,000,000 cell-work units. Before ExcelJS loads the workbook, the ZIP preflight inflates supported stored/deflate entries as a bounded stream and checks their actual output against the declared sizes and aggregate limit. Multi-disk, ZIP64, encrypted, and other compression-method archives are rejected. CSV uses `\\N` as its default SQL NULL marker; change it with `--null-value`. MongoDB supports Find, Aggregate, JSON/EJSON transfer, and GeoJSON Geometry/Feature/FeatureCollection conversion. `mongo indexes` lists index metadata; `mongo create-2dsphere-index` creates a spatial index; `mongo geo-find --geometry <json> --relation within|intersects` runs a native spatial query. Real MongoDB integration covers ObjectId/GeoJSON round trips, index metadata and `$geoWithin`.

`query run --stream --format ndjson` writes each row as one JSON line with bounded application memory. SQLite iterates rows, PostgreSQL fetches from a server cursor, MySQL/MariaDB and SQL Server use driver streams, and Oracle fetches bounded ResultSet batches. Oracle CLOB/NCLOB cells remain readable LOB streams until the CLI serializer writes them as JSON strings; BLOB cells stream as the existing `Buffer.toJSON()` shape. The serializer writes each LOB in chunks and preserves CLOB UTF-8 characters across Oracle piece boundaries. `--stream` requires `--format ndjson`; existing buffered output formats are unchanged. PostgreSQL statements that cannot be wrapped in a cursor (for example DML) retain normal query behavior and are buffered. Ctrl+C/SIGTERM aborts the active stream, including while stdout is applying backpressure; output errors or premature closure fail the command instead of leaving it waiting indefinitely. Already-written NDJSON lines remain on stdout. Oracle CLOB/NCLOB/BLOB table transfer into PostgreSQL text/bytea columns now streams LOB chunks into a per-row transaction; PostgreSQL-to-Oracle transfer and other destination engines still use materialized values.

```powershell
dbstudio query run --connection local-pg --sql "SELECT * FROM large_table" --format ndjson --stream
```

Named CLI profiles support all seven database engines. `connections add` and `connections update` save non-secret endpoint and database settings; `--password-env <variable>` and MongoDB's `--uri-env <variable>` save only an environment-variable name. The secret value is read when the command runs and is never written to the profile file or accepted as a password command-line option. On Windows, profiles live under `%APPDATA%\DB Studio\CLI\connections.json`; on macOS and Linux they use the standard per-user application configuration directory. POSIX files are created with mode `0600`. `connections test --connection <name>` and all other commands accepting `--connection` can use the saved profile. `connections update` replaces a full profile; `connections edit` is an alias.

Example (the referenced password variable must already be present in the process environment):

```powershell
dbstudio connections add --name local-pg --engine postgres --host 127.0.0.1 --port 5432 --database demo --user app --password-env DBSTUDIO_LOCAL_PG_PASSWORD
dbstudio connections test --connection local-pg
dbstudio query run --connection local-pg --sql "SELECT current_database()" --format json
```

`tables transfer` appends rows from an existing base table to an existing base table on any of the six relational engines. Source and destination can use different saved connection profiles or the process environment. `--source-database` and `--target-database` override PostgreSQL, MySQL, MariaDB, or SQL Server databases; SQLite uses the configured file path, while Oracle service selection belongs in its connection profile. The command uses bounded keyset pages and requires a source primary key. If no `--map` is given, source columns are matched to destination columns by exact name, then by an unambiguous case-insensitive name. Repeat `--map source=target` to choose columns or rename them; the target table's required unmapped columns must have defaults or allow `NULL`. Page size defaults to 250 and is limited to 1,000. A failure after earlier pages were committed reports how many rows were already inserted; there is no transaction across databases. MongoDB document transfer uses the `mongo` commands instead.

```powershell
dbstudio tables transfer `
  --source-connection local-pg --source-schema public --source-table source_places `
  --target-connection local-mysql --target-schema app --target-table imported_places `
  --page-size 500 --map place_id=id --map place_name=name
```

GIS convert/import/export stream through GDAL/OGR without loading features into Node.js memory. Progress is written to stderr so stdout remains machine-readable JSON. GIS success output includes feature counts; GIS failures include a bounded structured report with status and failure samples. Ctrl+C cancels the active OGR process; cancelled imports use a dataset transaction and exit with status 130. GIS test scripts discover bundled GDAL/PROJ data beside `DBSTUDIO_GDAL_BIN` when available.

GIS input commands (`inspect`, `preview`, `convert`, `validate`, and `import`) accept `--zip-filename-encoding <encoding>` for an explicit GDAL ZIP entry-name encoding, such as `UTF-8` or `CP936`. Use a GDAL virtual path to select a member directly; the option is applied to that operation as `CPL_ZIP_ENCODING` and does not set the TAB/DBF source text encoding. Keep using `--source-encoding` separately for attribute text. For example:

```powershell
dbstudio gis inspect --file '/vsizip/F:/temp/高铁线路车站图及工参.zip/高铁线路车站图及工参/成达高铁/成达高铁.TAB' --zip-filename-encoding UTF-8
dbstudio gis preview --file '/vsizip/F:/temp/高铁线路车站图及工参.zip/高铁线路车站图及工参/成达高铁/成达高铁.TAB' --zip-filename-encoding UTF-8 --source-encoding CP936 --limit 3
```

When importing into an existing ordinary SQLite database, `gis import --initialize-spatialite` explicitly adds SpatiaLite metadata before creating the first spatial layer. It is restricted to create mode, refuses a colliding table name, and leaves existing ordinary tables in place. If feature import later fails, the SpatiaLite metadata may remain. This option does not apply to `.gpkg` files; normal imports into an already spatially enabled SQLite database do not need it.

GIS import and export accept repeatable field mappings. `--field-map <source=target>` renames an attribute, and `--field-type <source=type>` casts it to `string`, `integer`, `integer64`, `real`, `date`, `time` or `datetime`. For example:

```powershell
dbstudio gis import --file parcels.gpkg --layer parcels --target public.parcels --field-map 名称=name --field-type area=real
dbstudio gis import --file parcels.gpkg --layer parcels --target public.parcels --bbox=-1,4,6,6
dbstudio gis export --table public.parcels --output parcels.shp --field-map name=parcel_name --field-type area=real
```

`--bbox` is `minX,minY,maxX,maxY` in the selected source layer's CRS; use `--layer` when the dataset contains multiple layers. The filter selects features intersecting that rectangle before import, so the reported feature count reflects the selected source features successfully written. It is not transformed by `--target-crs`. All four coordinates must be finite, and each minimum must be smaller than its maximum. Prefix the value with `=` when negative coordinates could otherwise be parsed as an option, as in the example above.

The GIS operation report includes known output-format constraints for Shapefile, MapInfo TAB, KML and GeoJSON. Field type conversion errors fail the operation; imports roll back and file exports remove their staged output.
