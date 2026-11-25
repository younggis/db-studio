import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { PostgresAdapter, MariaDbAdapter, MySqlAdapter, SqliteAdapter, SqlServerAdapter, OracleAdapter, mariaDbConfigFromEnvironment, mysqlConfigFromEnvironment, postgresConfigFromEnvironment, sqlServerConfigFromEnvironment, oracleConfigFromEnvironment, oracleTransferFetchTypeHandler, sqliteConfigFromEnvironment, MongoDocumentAdapter, buildMongoGeoFilter, mongoConfigFromEnvironment, parseMongoJson, buildTableUpdateStatements, buildBackupSql, splitSqlStatements, quoteIdentifier, } from "@db-studio/database";
import { isQueryStreamCell, parseExcelWorkbook, parseTabularData, queryResultToXlsx } from "@db-studio/shared";
import { convertTransferValue, spatialTypeOf, supportsSpatialTransfer } from "./table-transfer-conversion.js";
import { GisOperationError, GdalService, } from "@db-studio/gis";
import { decodeGeoPackageGeometry, encodeGeoPackageGeometry, importColumnTypeFromSqliteDeclaration } from "./geopackage.js";
import { oracleSdo2dWkbToDimensionalWkb } from "./oracle-gis-wkb.js";
export { GisOperationError } from "@db-studio/gis";
export { spatialIndexCapability, assertSpatialIndexSupported } from "./spatial-index-capability.js";
export { createDecisionLedger, needsUserDecision } from "./encoding-decision.js";
export { spatialFilterPredicate, validateExtent } from "./spatial-filter-sql.js";
export { summarizeLayerHealth } from "./layer-health.js";
export { diagnoseSpatialIndex } from "./spatial-index-diagnostic.js";
export { OperationRegistry } from "./operation-handle.js";
export { parseGisDriverCreationOptions } from "@db-studio/gis";
function quoteMysqlFamilyIdentifier(identifier) {
    return `\`${identifier.replaceAll("`", "``")}\``;
}
function quoteSqlServerIdentifier(identifier) {
    return "[" + identifier.replaceAll("]", "]]") + "]";
}
function quoteOracleIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function gisRuntimeEnvironment(source = process.env) {
    const result = {};
    for (const name of ["PATH", "DBSTUDIO_GDAL_BIN", "GDAL_DATA", "PROJ_DATA", "PROJ_LIB"]) {
        if (source[name] !== undefined)
            result[name] = source[name];
    }
    return result;
}
function isOracleSpatialColumn(column) {
    return column !== undefined && /^(?:MDSYS\.)?SDO_GEOMETRY$/i.test(column.dataType.trim());
}
function oracleColumnToGeoPackageType(dataType, targetType) {
    if (targetType === "integer" || targetType === "integer64")
        return "INTEGER";
    if (targetType === "real")
        return "REAL";
    if (targetType !== undefined)
        return "TEXT";
    const normalized = dataType.trim().toUpperCase();
    if (/^(?:BLOB|RAW|LONG RAW|BINARY_FLOAT|BINARY_DOUBLE)\b/.test(normalized)) {
        return /^(?:BINARY_FLOAT|BINARY_DOUBLE)\b/.test(normalized) ? "REAL" : "BLOB";
    }
    // Oracle NUMBER is staged as text by default to preserve arbitrary precision.
    return "TEXT";
}
function importTypeForGisFieldTarget(targetType) {
    if (targetType === undefined)
        return undefined;
    switch (targetType) {
        case "string": return "text";
        case "integer":
        case "integer64": return "integer";
        case "real": return "real";
        case "date": return "date";
        case "time": return "time";
        case "datetime": return "datetime";
        default: throw new Error(`GIS target field type '${String(targetType)}' is not supported for database import.`);
    }
}
function gisImportColumns(sourceColumns, fieldMappings = []) {
    const targetTypes = new Map(fieldMappings.map((mapping) => [mapping.target, mapping.targetType]));
    return sourceColumns.map((column) => ({
        name: column.name,
        type: importTypeForGisFieldTarget(targetTypes.get(column.name)) ?? importColumnTypeFromSqliteDeclaration(column.dataType),
    }));
}
function gisStagingFieldMappings(fieldMappings = []) {
    return fieldMappings.map((mapping) => ({
        ...mapping,
        ...(mapping.targetType === "date" || mapping.targetType === "time" || mapping.targetType === "datetime"
            ? { targetType: "string" }
            : {}),
    }));
}
function oracleWkbDimensionCount(wkb) {
    if (wkb.length < 5 || (wkb[0] !== 0 && wkb[0] !== 1))
        return undefined;
    const bytes = Buffer.from(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const type = wkb[0] === 1 ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
    const zFlag = (type & 0x8000_0000) !== 0;
    const mFlag = (type & 0x4000_0000) !== 0;
    if (zFlag || mFlag)
        return 2 + Number(zFlag) + Number(mFlag);
    const baseType = type & 0x1fff_ffff;
    if (baseType >= 3_000 && baseType < 4_000)
        return 4;
    if (baseType >= 1_000 && baseType < 3_000)
        return 3;
    if (baseType >= 1 && baseType <= 17)
        return 2;
    return undefined;
}
function oracleRowValue(row, name) {
    if (!row)
        return undefined;
    if (Object.hasOwn(row, name))
        return row[name];
    const key = Object.keys(row).find((candidate) => candidate.toLocaleUpperCase("en-US") === name.toLocaleUpperCase("en-US"));
    return key === undefined ? undefined : row[key];
}
function databaseRowValue(row, name) {
    if (!row)
        return undefined;
    if (Object.hasOwn(row, name))
        return row[name];
    const key = Object.keys(row).find((candidate) => candidate.toLocaleUpperCase("en-US") === name.toLocaleUpperCase("en-US"));
    return key === undefined ? undefined : row[key];
}
function gpkgSqliteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function isMySqlFamilySpatialColumn(column) {
    return column !== undefined && /^(?:GEOMETRY|POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i
        .test(column.dataType.trim());
}
function isSqlServerSpatialColumn(column, spatialColumnType) {
    return column !== undefined && column.dataType.trim().toLocaleLowerCase("en-US") === spatialColumnType;
}
function mysqlColumnToGeoPackageType(dataType, targetType) {
    if (targetType === "integer" || targetType === "integer64")
        return "INTEGER";
    if (targetType === "real")
        return "REAL";
    if (targetType !== undefined)
        return "TEXT";
    const normalized = dataType.trim().toUpperCase();
    if (/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|YEAR|BOOL|BOOLEAN)\b/.test(normalized))
        return "INTEGER";
    if (/^(?:FLOAT|DOUBLE|REAL)\b/.test(normalized))
        return "REAL";
    if (/^(?:BINARY|VARBINARY|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|BIT)\b/.test(normalized))
        return "BLOB";
    // Keep DECIMAL/NUMERIC values as text so the bridge does not round them through IEEE-754.
    return "TEXT";
}
function sqlServerColumnToGeoPackageType(dataType, targetType) {
    if (targetType === "integer" || targetType === "integer64")
        return "INTEGER";
    if (targetType === "real")
        return "REAL";
    if (targetType !== undefined)
        return "TEXT";
    const normalized = dataType.trim().toUpperCase();
    if (/^(?:TINYINT|SMALLINT|INT|INTEGER|BIGINT|BIT)\b/.test(normalized))
        return "INTEGER";
    if (/^(?:FLOAT|REAL)\b/.test(normalized))
        return "REAL";
    if (/^(?:BINARY|VARBINARY|IMAGE|TIMESTAMP|ROWVERSION)\b/.test(normalized))
        return "BLOB";
    // Preserve exact SQL Server decimal and money values as text in the staging GeoPackage.
    return "TEXT";
}
function normalizeMysqlExportCell(value, targetType) {
    if (value === undefined || value === null)
        return null;
    if (targetType === "string")
        return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value);
    if (targetType === "integer" || targetType === "integer64") {
        const stringValue = typeof value === "bigint" ? value.toString() : String(value);
        if (!/^[+-]?\d+$/.test(stringValue))
            throw new Error(`Value '${stringValue}' is not an integer.`);
        const integerValue = BigInt(stringValue);
        if (integerValue < -9223372036854775808n || integerValue > 9223372036854775807n) {
            throw new Error(`Integer value '${stringValue}' is outside GeoPackage's signed 64-bit range.`);
        }
        return stringValue;
    }
    if (targetType === "real") {
        const realValue = Number(value);
        if (!Number.isFinite(realValue))
            throw new Error(`Value '${String(value)}' is not a finite real number.`);
        return realValue;
    }
    if (typeof value === "boolean")
        return value ? 1 : 0;
    if (typeof value === "bigint")
        return value.toString();
    if (value instanceof Date)
        return value.toISOString();
    if (value instanceof Uint8Array)
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === "object")
        return JSON.stringify(value);
    return value;
}
function isolatedGdalEnvironment(environment) {
    const inherited = { ...process.env, ...environment };
    const allowedKeys = [
        "PATH", "PATHEXT", "SystemRoot", "WINDIR", "DBSTUDIO_GDAL_BIN", "GDAL_DATA", "GDAL_DRIVER_PATH",
        "PROJ_DATA", "PROJ_LIB", "PROJ_NETWORK", "CPL_DEBUG", "CPL_LOG", "CPL_LOG_ERRORS",
    ];
    return Object.fromEntries(allowedKeys.flatMap((key) => inherited[key] === undefined ? [] : [[key, inherited[key]]]));
}
export { buildMongoGeoFilter, geoJsonToMongoDocuments, mongoDocumentsToGeoJson, parseMongoEjson, stringifyMongoJson } from "@db-studio/database";
export * from "./schema-diff.js";
export * from "./table-designer.js";
export class CoreService {
    createDatabaseAdapter;
    environment;
    supportsPostgresGis;
    engine;
    sqliteDatabasePath;
    gis;
    constructor(createDatabaseAdapter, environment = process.env, supportsPostgresGis = true, engine, sqliteDatabasePath) {
        this.createDatabaseAdapter = createDatabaseAdapter;
        this.environment = environment;
        this.supportsPostgresGis = supportsPostgresGis;
        this.engine = engine;
        this.sqliteDatabasePath = sqliteDatabasePath;
        this.gis = new GdalService(environment);
    }
    static fromEnvironment(env = process.env) {
        const databaseType = env.DBSTUDIO_DATABASE_TYPE?.trim().toLowerCase();
        if (databaseType && !["postgres", "postgresql", "sqlite", "mysql", "mysql2", "mariadb", "sqlserver", "mssql", "oracle"].includes(databaseType)) {
            if (databaseType === "mongodb") {
                throw new Error("MongoDB is a document database; use MongoDocumentService and the mongo CLI commands.");
            }
            throw new Error(`Database type '${databaseType}' is not implemented yet.`);
        }
        if (databaseType === "sqlite") {
            const config = sqliteConfigFromEnvironment(env);
            return new CoreService(() => new SqliteAdapter(config), env, false, "sqlite", config.path);
        }
        if (databaseType === "mysql" || databaseType === "mysql2") {
            return new CoreService(() => new MySqlAdapter(mysqlConfigFromEnvironment(env)), env, false, "mysql");
        }
        if (databaseType === "mariadb") {
            return new CoreService(() => new MariaDbAdapter(mariaDbConfigFromEnvironment(env)), env, false, "mariadb");
        }
        if (databaseType === "sqlserver" || databaseType === "mssql") {
            return new CoreService(() => new SqlServerAdapter(sqlServerConfigFromEnvironment(env)), env, false, "sqlserver");
        }
        if (databaseType === "oracle") {
            return new CoreService(() => new OracleAdapter(oracleConfigFromEnvironment(env)), env, false, "oracle");
        }
        return new CoreService(() => new PostgresAdapter(postgresConfigFromEnvironment(env)), env, true, "postgres");
    }
    static fromPostgresConfig(config) {
        const environment = {
            ...process.env,
            PGHOST: String(config.host ?? "localhost"),
            PGPORT: String(config.port ?? 5432),
            PGDATABASE: String(config.database ?? "postgres"),
            PGUSER: String(config.user ?? "postgres"),
            PGPASSWORD: config.password ?? "",
            PGSSLMODE: config.ssl ? "require" : "",
        };
        return new CoreService(() => new PostgresAdapter(config), environment, true, "postgres");
    }
    static fromSqliteConfig(config) {
        return new CoreService(() => new SqliteAdapter(config), gisRuntimeEnvironment(), false, "sqlite", config.path);
    }
    static fromMySqlConfig(config) {
        return new CoreService(() => new MySqlAdapter(config), gisRuntimeEnvironment(), false, "mysql");
    }
    static fromMariaDbConfig(config) {
        return new CoreService(() => new MariaDbAdapter(config), gisRuntimeEnvironment(), false, "mariadb");
    }
    static fromSqlServerConfig(config) {
        return new CoreService(() => new SqlServerAdapter(config), gisRuntimeEnvironment(), false, "sqlserver");
    }
    static fromOracleConfig(config) {
        return new CoreService(() => new OracleAdapter(config), gisRuntimeEnvironment(), false, "oracle");
    }
    static gdalRuntimeStatus(env = process.env) {
        return new GdalService(env).runtimeStatus();
    }
    async testConnection() {
        return this.withDatabase((adapter) => adapter.testConnection());
    }
    async testPostgresConnection() {
        return this.testConnection();
    }
    async query(sql, parameters = []) {
        return this.withDatabase((adapter) => adapter.query(sql, parameters));
    }
    async *queryStream(sql, parameters = [], options = {}) {
        const adapter = this.createDatabaseAdapter();
        try {
            yield* adapter.queryStream(sql, parameters, options);
        }
        finally {
            await adapter.close();
        }
    }
    async updateTableRows(engine, schema, table, changes) {
        return this.withDatabase(async (adapter) => {
            const tableInfo = (await adapter.listTables(schema))
                .find((candidate) => candidate.schema === schema && candidate.name === table);
            if (!tableInfo || tableInfo.type !== "table") {
                throw new Error("Only an existing base table can be edited.");
            }
            const columns = await adapter.getTableColumns(table, schema);
            const statements = buildTableUpdateStatements(engine, schema, table, columns, changes);
            if (!statements.length)
                return [];
            return adapter.updateRows(statements);
        });
    }
    async queryPostgres(sql, parameters = []) {
        return this.query(sql, parameters);
    }
    async listDatabases() {
        return this.withDatabase((adapter) => adapter.listDatabases());
    }
    async listPostgresDatabases() {
        return this.listDatabases();
    }
    async listSchemas() {
        return this.withDatabase((adapter) => adapter.listSchemas());
    }
    async listPostgresSchemas() {
        return this.listSchemas();
    }
    async listTables(schema, options) {
        return this.withDatabase((adapter) => adapter.listTables(schema, options));
    }
    async getTableColumns(table, schema) {
        return this.withDatabase((adapter) => adapter.getTableColumns(table, schema));
    }
    async getTableForeignKeys(table, schema) {
        return this.withDatabase((adapter) => adapter.getTableForeignKeys(table, schema));
    }
    /** Precise column types for backup/DDL; catalog helpers often drop length/precision. */
    async preciseColumns(adapter, schema, table) {
        const base = await adapter.getTableColumns(table, schema);
        const engine = this.engine;
        try {
            if (engine === "postgres") {
                const result = await adapter.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY a.attnum`, [schema, table]);
                const types = new Map(result.rows.map((row) => [String(row.name), String(row.data_type)]));
                return base.map((column) => ({ ...column, dataType: types.get(column.name) ?? column.dataType }));
            }
            if (engine === "mysql" || engine === "mariadb") {
                const result = await adapter.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS data_type
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`, [schema, table]);
                const types = new Map(result.rows.map((row) => [String(row.name), String(row.data_type)]));
                return base.map((column) => ({ ...column, dataType: types.get(column.name) ?? column.dataType }));
            }
        }
        catch {
            return base;
        }
        return base;
    }
    async readIndexes(adapter, schema, table) {
        const engine = this.engine;
        try {
            if (engine === "postgres") {
                const result = await adapter.query(`SELECT i.relname AS name, ix.indisunique AS unique,
                  array_agg(a.attname ORDER BY k.ord) AS columns
           FROM pg_class t
           JOIN pg_index ix ON t.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) ON TRUE
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
           JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
           GROUP BY i.relname, ix.indisunique`, [schema, table]);
                return result.rows.map((row) => ({
                    name: String(row.name),
                    unique: row.unique === true,
                    columns: (Array.isArray(row.columns) ? row.columns : []).map(String),
                }));
            }
            if (engine === "mysql" || engine === "mariadb") {
                const result = await adapter.query(`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique,
                  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           GROUP BY INDEX_NAME, NON_UNIQUE`, [schema, table]);
                return result.rows
                    .filter((row) => String(row.name) !== "PRIMARY")
                    .map((row) => ({
                    name: String(row.name),
                    unique: row.non_unique === 0 || row.non_unique === "0",
                    columns: String(row.columns ?? "").split(",").filter(Boolean),
                }));
            }
        }
        catch {
            return [];
        }
        return [];
    }
    async createBackup(schema, options = {}) {
        if (!schema.trim())
            throw new Error("备份 Schema 不能为空。");
        const engine = this.engine;
        if (!engine || engine === "mongodb")
            throw new Error("MongoDB 请使用集合导出工具。");
        return this.withDatabase(async (adapter) => {
            const tables = (await adapter.listTables(schema, { limit: 5_000 })).filter((table) => table.type === "table");
            const backups = [];
            let rowCount = 0;
            for (const table of tables) {
                const [columns, foreignKeys] = await Promise.all([
                    this.preciseColumns(adapter, schema, table.name),
                    adapter.getTableForeignKeys(table.name, schema).catch(() => []),
                ]);
                let rows = [];
                if (options.includeData !== false) {
                    const result = await adapter.readTable(table.name, schema);
                    rows = result.rows;
                }
                rowCount += rows.length;
                backups.push({ name: table.name, columns, foreignKeys, rows });
            }
            return {
                sql: buildBackupSql(engine, schema, backups, { includeData: options.includeData !== false }),
                tableCount: backups.length,
                rowCount,
            };
        });
    }
    async restoreBackup(sql) {
        const statements = splitSqlStatements(sql).filter((statement) => !/^--/.test(statement));
        if (!statements.length)
            throw new Error("备份文件中没有可执行的 SQL 语句。");
        return this.withDatabase(async (adapter) => {
            let applied = 0;
            const failed = [];
            for (const statement of statements) {
                try {
                    await adapter.query(statement);
                    applied += 1;
                }
                catch (error) {
                    failed.push({ sql: statement.slice(0, 200), error: error instanceof Error ? error.message : String(error) });
                }
            }
            return { applied, failed };
        });
    }
    async readSchemaSnapshot(schema) {
        if (!schema.trim())
            throw new Error("Schema 不能为空。");
        const engine = this.engine;
        if (!engine || engine === "mongodb")
            throw new Error("MongoDB 不支持结构同步。");
        return this.withDatabase(async (adapter) => {
            const tables = (await adapter.listTables(schema, { limit: 5_000 })).filter((table) => table.type === "table");
            const snapshotTables = [];
            for (const table of tables) {
                const [columns, foreignKeys, indexes] = await Promise.all([
                    this.preciseColumns(adapter, schema, table.name),
                    adapter.getTableForeignKeys(table.name, schema).catch(() => []),
                    this.readIndexes(adapter, schema, table.name),
                ]);
                snapshotTables.push({
                    name: table.name,
                    columns: columns.map((column) => ({
                        name: column.name,
                        dataType: column.dataType,
                        nullable: column.nullable,
                        defaultValue: column.defaultValue,
                        primaryKey: column.primaryKey,
                        ordinalPosition: column.ordinalPosition,
                    })),
                    foreignKeys: foreignKeys.map((fk) => ({ ...fk })),
                    indexes,
                });
            }
            return { engine, schema, tables: snapshotTables };
        });
    }
    async tableSnapshot(schema, table) {
        if (!schema.trim() || !table.trim())
            throw new Error("Schema 与表名不能为空。");
        const engine = this.engine ?? "postgres";
        return this.withDatabase(async (adapter) => {
            const columns = await this.preciseColumns(adapter, schema, table);
            const qualified = schema ? `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}` : quoteIdentifier(engine, table);
            const result = await adapter.query(`SELECT COUNT(*) AS total FROM ${qualified}`);
            return {
                rowCount: Number(result.rows[0]?.total ?? 0),
                columns: columns.map((column) => ({ name: column.name, dataType: column.dataType, primaryKey: column.primaryKey })),
            };
        });
    }
    async applySchemaStatements(statements) {
        if (!statements.length)
            return { applied: 0, failed: [] };
        return this.withDatabase(async (adapter) => {
            let applied = 0;
            const failed = [];
            for (const statement of statements) {
                try {
                    await adapter.query(statement.sql);
                    applied += 1;
                }
                catch (error) {
                    failed.push({ sql: statement.sql.slice(0, 200), error: error instanceof Error ? error.message : String(error) });
                }
            }
            return { applied, failed };
        });
    }
    async exportTable(table, schema) {
        if (!table.trim())
            throw new Error("Table name cannot be empty.");
        return this.withDatabase((adapter) => adapter.readTable(table, schema));
    }
    async exportTableWorkbook(table, schema) {
        return queryResultToXlsx(await this.exportTable(table, schema));
    }
    async importRows(table, data, schema) {
        if (!table.trim())
            throw new Error("Table name cannot be empty.");
        if (data.columns.length === 0)
            throw new Error("Import data has no columns.");
        if (new Set(data.columns).size !== data.columns.length || data.columns.some((column) => !column.trim())) {
            throw new Error("Import data contains empty or duplicate column names.");
        }
        return this.withDatabase(async (adapter) => {
            const objects = await adapter.listTables(schema);
            const destination = objects.find((object) => object.name === table && object.type === "table");
            if (!destination)
                throw new Error(`Destination table '${table}' was not found or is not a base table.`);
            const availableColumns = await adapter.getTableColumns(table, schema);
            const availableNames = new Set(availableColumns.map((column) => column.name));
            const unknown = data.columns.filter((column) => !availableNames.has(column));
            if (unknown.length > 0) {
                throw new Error(`Destination table '${table}' has no column(s): ${unknown.join(", ")}.`);
            }
            const rows = data.rows.map((row, index) => {
                for (const column of data.columns) {
                    if (!Object.hasOwn(row, column))
                        throw new Error(`Import row ${index + 1} is missing column '${column}'.`);
                }
                const extraColumns = Object.keys(row).filter((column) => !data.columns.includes(column));
                if (extraColumns.length > 0) {
                    throw new Error(`Import row ${index + 1} contains unexpected column(s): ${extraColumns.join(", ")}.`);
                }
                return data.columns.map((column) => importValue(row[column]));
            });
            const insertedRows = await adapter.insertRows(table, data.columns, rows, schema);
            return { insertedRows, columns: data.columns };
        });
    }
    async createTableFromRows(table, data, schema) {
        if (!table.trim())
            throw new Error("Table name cannot be empty.");
        if (data.columns.length === 0)
            throw new Error("Import data has no columns.");
        if (new Set(data.columns).size !== data.columns.length || data.columns.some((column) => !column.trim())) {
            throw new Error("Import data contains empty or duplicate column names.");
        }
        const rows = data.rows.map((row, index) => {
            for (const column of data.columns) {
                if (!Object.hasOwn(row, column))
                    throw new Error(`Import row ${index + 1} is missing column '${column}'.`);
            }
            const extraColumns = Object.keys(row).filter((column) => !data.columns.includes(column));
            if (extraColumns.length > 0)
                throw new Error(`Import row ${index + 1} contains unexpected column(s): ${extraColumns.join(", ")}.`);
            return data.columns.map((column) => importValue(row[column]));
        });
        const columns = data.columns.map((name, index) => ({
            name,
            type: inferImportColumnType(data.rows.map((row) => row[name])),
        }));
        const inferredTypes = Object.fromEntries(columns.map((column) => [column.name, column.type]));
        return this.withDatabase(async (adapter) => {
            await adapter.createTable(table, columns, schema);
            try {
                const insertedRows = await adapter.insertRows(table, data.columns, rows, schema);
                return { table, insertedRows, columns: data.columns, inferredTypes };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Table '${table}' was created, but importing rows failed: ${message}`, { cause: error });
            }
        });
    }
    async transferTableRows(destination, options) {
        const { sourceTable, sourceSchema, targetTable, targetSchema } = options;
        if (!sourceTable.trim() || !targetTable.trim())
            throw new Error("Source and destination table names are required.");
        const pageSize = options.pageSize ?? 250;
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
            throw new Error("Table transfer page size must be an integer from 1 to 1,000.");
        }
        const sourceAdapter = this.createDatabaseAdapter();
        let targetAdapter;
        let insertedRows = 0;
        let sourceRows = 0;
        try {
            targetAdapter = destination.createDatabaseAdapter();
            const sourceObject = (await sourceAdapter.listTables(sourceSchema))
                .find((item) => item.name === sourceTable && item.type === "table");
            if (!sourceObject)
                throw new Error(`Source '${sourceTable}' was not found or is not a base table.`);
            const targetObject = (await targetAdapter.listTables(targetSchema))
                .find((item) => item.name === targetTable && item.type === "table");
            if (!targetObject)
                throw new Error(`Destination '${targetTable}' was not found or is not a base table.`);
            if (options.mode === "replace") {
                const quote = (name) => quoteIdentifier(destination.engine ?? "postgres", name);
                const qualified = targetSchema ? `${quote(targetSchema)}.${quote(targetTable)}` : quote(targetTable);
                await targetAdapter.query(`DELETE FROM ${qualified}`);
            }
            const sourceColumns = (await sourceAdapter.getTableColumns(sourceTable, sourceSchema))
                .sort((left, right) => left.ordinalPosition - right.ordinalPosition);
            if (!sourceColumns.length)
                throw new Error(`Source '${sourceTable}' has no transferable columns.`);
            const primaryKeys = sourceColumns.filter((column) => column.primaryKey).map((column) => column.name);
            if (!primaryKeys.length)
                throw new Error(`Source '${sourceTable}' needs a primary key for bounded keyset transfer.`);
            const targetColumns = await targetAdapter.getTableColumns(targetTable, targetSchema);
            const hasOracleLobColumn = [...sourceColumns, ...targetColumns].some((column) => /^(?:BLOB|CLOB|NCLOB)$/i.test(column.dataType.trim()));
            const sourceNames = sourceColumns.map((column) => column.name);
            const sourceColumnsByName = new Map(sourceColumns.map((column) => [column.name, column]));
            const targetColumnsByExactName = new Map(targetColumns.map((column) => [column.name, column]));
            const targetColumnsByFoldedName = new Map();
            for (const column of targetColumns) {
                const folded = column.name.toLocaleLowerCase("en-US");
                const matches = targetColumnsByFoldedName.get(folded) ?? [];
                matches.push(column);
                targetColumnsByFoldedName.set(folded, matches);
            }
            const columnMappings = options.columnMappings ?? sourceColumns.map((column) => {
                const exact = targetColumnsByExactName.get(column.name);
                if (exact)
                    return { sourceColumn: column.name, targetColumn: exact.name };
                const matches = targetColumnsByFoldedName.get(column.name.toLocaleLowerCase("en-US")) ?? [];
                if (matches.length > 1) {
                    throw new Error(`Destination '${targetTable}' has ambiguous case-insensitive matches for source column '${column.name}'.`);
                }
                if (!matches[0])
                    throw new Error(`Destination '${targetTable}' is missing source column(s): ${column.name}.`);
                return { sourceColumn: column.name, targetColumn: matches[0].name };
            });
            if (!columnMappings.length)
                throw new Error("At least one source-to-destination column mapping is required.");
            const seenSources = new Set();
            const mappedColumns = columnMappings.map(({ sourceColumn, targetColumn }) => {
                if (!sourceColumn || !targetColumn)
                    throw new Error("Column mappings require both source and destination column names.");
                if (seenSources.has(sourceColumn))
                    throw new Error(`Source column '${sourceColumn}' is mapped more than once.`);
                seenSources.add(sourceColumn);
                if (!sourceColumnsByName.has(sourceColumn))
                    throw new Error(`Source '${sourceTable}' has no column '${sourceColumn}'.`);
                const target = targetColumnsByExactName.get(targetColumn);
                if (!target)
                    throw new Error(`Destination '${targetTable}' has no column '${targetColumn}'.`);
                return { sourceColumn, targetColumn: target.name };
            });
            const targetNames = mappedColumns.map((mapping) => mapping.targetColumn);
            if (new Set(targetNames).size !== targetNames.length) {
                throw new Error(`Destination '${targetTable}' maps multiple source columns to the same destination column.`);
            }
            const mappedTargetNames = new Set(targetNames);
            const missingRequiredColumns = targetColumns.filter((column) => !mappedTargetNames.has(column.name) && !column.nullable && column.defaultValue === null && !column.primaryKey);
            if (missingRequiredColumns.length) {
                throw new Error(`Destination '${targetTable}' requires unmapped column(s): ${missingRequiredColumns.map((column) => column.name).join(", ")}.`);
            }
            const spatialWkbColumns = [];
            for (const key of primaryKeys) {
                if (spatialTypeOf(sourceColumnsByName.get(key).dataType, this.engine)) {
                    throw new Error(`Spatial primary-key column '${key}' cannot be used for bounded keyset transfer.`);
                }
            }
            for (const { sourceColumn, targetColumn } of mappedColumns) {
                const sourceSpatialType = spatialTypeOf(sourceColumnsByName.get(sourceColumn).dataType, this.engine);
                const targetSpatialType = spatialTypeOf(targetColumnsByExactName.get(targetColumn).dataType, destination.engine);
                if (!sourceSpatialType && !targetSpatialType)
                    continue;
                if (!sourceSpatialType || !targetSpatialType) {
                    throw new Error(`Spatial column '${sourceColumn}' must map to a matching geometry or geography destination column.`);
                }
                if (sourceSpatialType !== targetSpatialType && !options.allowSpatialTypeConversion) {
                    throw new Error(`Spatial column '${sourceColumn}' is ${sourceSpatialType} but destination '${targetColumn}' is ${targetSpatialType}.`);
                }
                if (!supportsSpatialTransfer(this.engine, sourceSpatialType)
                    || !supportsSpatialTransfer(destination.engine, targetSpatialType)) {
                    throw new Error(sourceSpatialType === "geometry"
                        ? "Geometry row transfer supports PostgreSQL/PostGIS, SQL Server, MySQL, MariaDB, Oracle SDO_GEOMETRY, and SQLite/GeoPackage."
                        : "Geography row transfer supports PostgreSQL/PostGIS and SQL Server only.");
                }
                spatialWkbColumns.push(sourceColumn);
            }
            const mappedLobColumns = mappedColumns.filter(({ sourceColumn, targetColumn }) => {
                const sourceColumnInfo = sourceColumnsByName.get(sourceColumn);
                const targetColumnInfo = targetColumnsByExactName.get(targetColumn);
                const sourceType = sourceColumnInfo.dataType.trim().toUpperCase();
                const targetType = targetColumnInfo.dataType.trim().toUpperCase();
                return isOracleLobDataType(sourceType) || isOracleLobDataType(targetType)
                    || this.engine === "sqlserver" && isSqlServerLargeObjectColumn(sourceColumnInfo);
            });
            const streamableLobMappings = mappedLobColumns.flatMap(({ sourceColumn, targetColumn }) => {
                const sourceColumnInfo = sourceColumnsByName.get(sourceColumn);
                const targetColumnInfo = targetColumnsByExactName.get(targetColumn);
                const encoding = lobTransferEncoding(this.engine ?? "", sourceColumnInfo, destination.engine ?? "", targetColumnInfo);
                return encoding ? [{ sourceColumn, encoding }] : [];
            });
            if (this.engine === "oracle" && destination.engine === "sqlserver"
                && streamableLobMappings.length !== mappedLobColumns.length) {
                throw new Error("Oracle LOB transfer to SQL Server requires CLOB/NCLOB → NVARCHAR(MAX) and BLOB → VARBINARY(MAX) columns.");
            }
            if (this.engine === "oracle" && ["mysql", "mariadb"].includes(destination.engine ?? "")
                && streamableLobMappings.length !== mappedLobColumns.length) {
                throw new Error("Oracle LOB transfer to MySQL/MariaDB requires CLOB/NCLOB → LONGTEXT CHARACTER SET utf8mb4 and BLOB → LONGBLOB columns.");
            }
            const streamLobs = typeof targetAdapter.insertRowWithStreamedLobs === "function"
                && streamableLobMappings.length > 0
                && streamableLobMappings.length === mappedLobColumns.length;
            const transferPageSize = hasOracleLobColumn || streamLobs ? 1 : pageSize;
            const streamLobColumns = Object.fromEntries(streamableLobMappings.map(({ sourceColumn, encoding }) => [sourceColumn, encoding]));
            const pageSourceNames = [...new Set([...mappedColumns.map((mapping) => mapping.sourceColumn), ...primaryKeys])];
            const jsonTextColumns = ["postgres", "mysql", "mariadb"].includes(this.engine ?? "")
                ? pageSourceNames.filter((name) => /^(?:JSON|JSONB)(?:\b|\s*\()/i.test(sourceColumnsByName.get(name).dataType.trim()))
                : [];
            const exactNumericColumns = this.engine === "sqlserver"
                ? pageSourceNames.filter((name) => /^(?:DECIMAL|NUMERIC|MONEY|SMALLMONEY|BIGINT|INT|INTEGER|SMALLINT|TINYINT)\b/i
                    .test(sourceColumnsByName.get(name).dataType.trim()))
                : [];
            const pageReadOptions = streamLobs || exactNumericColumns.length || jsonTextColumns.length || spatialWkbColumns.length
                ? {
                    ...(streamLobs ? { streamLobs: true, streamLobColumns } : {}),
                    ...(exactNumericColumns.length ? { exactNumericColumns } : {}),
                    ...(jsonTextColumns.length ? { jsonTextColumns } : {}),
                    ...(spatialWkbColumns.length ? { spatialWkbColumns } : {}),
                }
                : undefined;
            const insertTransferRows = async (rows) => {
                try {
                    return await targetAdapter.insertRows(targetTable, targetNames, rows, targetSchema);
                }
                catch (error) {
                    const valueKinds = mappedColumns.map((mapping, index) => `${mapping.sourceColumn}->${mapping.targetColumn}:${transferValueKind(rows[0]?.[index])}`).join(", ");
                    const reason = error instanceof Error ? error.message : String(error);
                    throw new Error(`Destination insert failed for mapped columns [${valueKinds}]: ${reason}`, { cause: error });
                }
            };
            let cursor;
            while (true) {
                const page = await sourceAdapter.readTablePage(sourceTable, pageSourceNames, primaryKeys, cursor, transferPageSize, sourceSchema, pageReadOptions);
                if (!page.rows.length)
                    break;
                let rows = [];
                try {
                    rows = page.rows.map((row, rowIndex) => mappedColumns.map(({ sourceColumn, targetColumn }) => {
                        if (!Object.hasOwn(row, sourceColumn)) {
                            throw new Error(`Source page row ${sourceRows + rowIndex + 1} is missing column '${sourceColumn}'.`);
                        }
                        const value = row[sourceColumn];
                        if (isQueryStreamCell(value))
                            return value;
                        return convertTransferValue(value, sourceColumnsByName.get(sourceColumn), targetColumnsByExactName.get(targetColumn), this.engine, destination.engine, { allowSpatialTypeConversion: options.allowSpatialTypeConversion });
                    }));
                    if (streamLobs && rows.some((row) => row.some(isQueryStreamCell))) {
                        for (const row of rows) {
                            const inserted = row.some(isQueryStreamCell)
                                ? await targetAdapter.insertRowWithStreamedLobs(targetTable, targetNames, row, targetSchema)
                                : await insertTransferRows([row]);
                            if (inserted !== 1)
                                throw new Error(`Destination inserted ${inserted} of 1 streamed transfer row.`);
                            insertedRows += inserted;
                        }
                        sourceRows += rows.length;
                    }
                    else {
                        const inserted = await insertTransferRows(rows);
                        if (inserted !== rows.length)
                            throw new Error(`Destination inserted ${inserted} of ${rows.length} rows in one transfer page.`);
                        sourceRows += rows.length;
                        insertedRows += inserted;
                    }
                }
                catch (error) {
                    for (const row of page.rows) {
                        for (const value of Object.values(row)) {
                            if (isQueryStreamCell(value))
                                value.destroy();
                        }
                    }
                    throw error;
                }
                const lastRow = page.rows.at(-1);
                cursor = primaryKeys.map((key) => {
                    if (!Object.hasOwn(lastRow, key) || lastRow[key] === null || lastRow[key] === undefined) {
                        throw new Error(`Source page ended without a value for primary-key column '${key}'.`);
                    }
                    return lastRow[key];
                });
                if (page.rows.length < transferPageSize)
                    break;
            }
            return { sourceRows, insertedRows, columns: mappedColumns.map((mapping) => mapping.sourceColumn) };
        }
        catch (error) {
            if (insertedRows === 0)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Table transfer stopped after ${insertedRows} rows were committed: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                sourceAdapter.close(),
                ...(targetAdapter ? [targetAdapter.close()] : []),
            ]);
        }
    }
    async importTableFile(table, content, format, schema, options = {}) {
        return this.importRows(table, parseTabularData(content, format, options), schema);
    }
    async importTableWorkbook(table, content, schema) {
        return this.importRows(table, await parseExcelWorkbook(content), schema);
    }
    async importWorkbookToNewTable(table, content, schema) {
        return this.createTableFromRows(table, await parseExcelWorkbook(content), schema);
    }
    async listPostgresTables(schema = "public") {
        return this.listTables(schema);
    }
    inspectGisFile(filePath, options = {}) {
        return this.gis.inspect(filePath, options);
    }
    checkGisGeometry(filePath, options = {}) {
        return this.gis.checkGeometry(filePath, options);
    }
    previewGisAttributes(filePath, options = {}) {
        return this.gis.previewAttributes(filePath, options);
    }
    convertGisFile(input, output, options = {}, operationOptions = {}) {
        return this.gis.convert(input, output, options, operationOptions);
    }
    async importGisToMysqlFamily(input, table, schema, options = {}, operationOptions = {}) {
        if (this.engine !== "mysql" && this.engine !== "mariadb") {
            throw new Error("Direct GIS file import is currently available for MySQL and MariaDB connections.");
        }
        if (options.spatialColumnType !== undefined) {
            throw new Error("SQL Server spatial column type selection cannot be used with MySQL or MariaDB GIS import.");
        }
        if (!input.trim() || !table.trim() || !schema.trim()) {
            throw new Error("A GIS input path, destination schema, and table name are required.");
        }
        const mode = options.mode ?? "create";
        if (mode !== "create" && mode !== "append" && mode !== "overwrite") {
            throw new Error("GIS destination mode must be create, append, or overwrite.");
        }
        const gis = new GdalService(isolatedGdalEnvironment(this.environment));
        const source = await gis.inspect(input, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const sourceLayer = options.sourceLayer === undefined
            ? source.layers.length === 1 ? source.layers[0] : undefined
            : source.layers.find((layer) => layer.name === options.sourceLayer);
        if (!sourceLayer) {
            throw new Error(source.layers.length > 1
                ? "Choose a source layer before importing a multi-layer GIS dataset."
                : `GIS source layer '${options.sourceLayer ?? ""}' was not found.`);
        }
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "db-studio-gis-import-"));
        const stagedPath = join(temporaryDirectory, "staged.gpkg");
        let stagedDatabase;
        let database;
        let createdTable;
        let importedRows = 0;
        let completed = false;
        let existingTable = false;
        let writeTable = table;
        let backupTable;
        let geometryColumn = options.geometryColumn?.trim() || "geom";
        let layerSrsId = null;
        let sawUnknownSrs = false;
        let spatialIndexName;
        const warnings = [];
        try {
            if (operationOptions.signal?.aborted)
                throw new Error("GIS import was cancelled before staging started.");
            const stagedLayerName = options.targetLayerName ?? sourceLayer.name;
            const staged = await gis.convert(input, stagedPath, {
                sourceLayer: sourceLayer.name,
                targetLayerName: stagedLayerName,
                sourceCrs: options.sourceCrs,
                targetCrs: options.targetCrs,
                coordinateOperation: options.coordinateOperation,
                fieldMappings: gisStagingFieldMappings(options.fieldMappings),
                spatialFilter: options.spatialFilter,
                makeValid: options.makeValid,
                sourceEncoding: options.sourceEncoding,
                zipFilenameEncoding: options.zipFilenameEncoding,
                replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
            }, operationOptions);
            warnings.push(...(staged.operationReport?.warnings ?? []));
            stagedDatabase = new SqliteAdapter({ path: stagedPath, readOnly: true });
            const geometryMetadata = await stagedDatabase.query("SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ?", [stagedLayerName]);
            const geometryInfo = geometryMetadata.rows[0];
            if (!geometryInfo || typeof geometryInfo.column_name !== "string") {
                throw new Error(`Staged GeoPackage layer '${stagedLayerName}' has no geometry column.`);
            }
            const sourceGeometryColumn = geometryInfo.column_name;
            const rawSrsId = Number(geometryInfo.srs_id);
            layerSrsId = Number.isSafeInteger(rawSrsId) && rawSrsId >= 0 ? rawSrsId : null;
            if (options.createSpatialIndex) {
                if (layerSrsId === null || layerSrsId <= 0) {
                    throw new Error("MySQL/MariaDB spatial-index creation requires a known positive SRID shared by the imported geometries.");
                }
                const stagedGeometryCounts = await stagedDatabase.query(`SELECT COUNT(*) AS total_count, `
                    + `SUM(CASE WHEN ${gpkgSqliteIdentifier(sourceGeometryColumn)} IS NULL THEN 1 ELSE 0 END) AS null_count `
                    + `FROM ${gpkgSqliteIdentifier(stagedLayerName)}`);
                const stagedTotalCount = Number(stagedGeometryCounts.rows[0]?.total_count ?? stagedGeometryCounts.rows[0]?.TOTAL_COUNT ?? 0);
                const stagedNullCount = Number(stagedGeometryCounts.rows[0]?.null_count ?? stagedGeometryCounts.rows[0]?.NULL_COUNT ?? 0);
                if (stagedTotalCount === 0) {
                    throw new Error("MySQL/MariaDB spatial-index creation requires at least one non-NULL geometry.");
                }
                if (stagedNullCount > 0) {
                    throw new Error("MySQL/MariaDB spatial-index creation requires every feature to have a non-NULL geometry.");
                }
            }
            const sourceColumns = (await stagedDatabase.getTableColumns(stagedLayerName))
                .filter((column) => column.name !== sourceGeometryColumn);
            if (sourceColumns.length === 0)
                throw new Error("Staged GIS layer has no importable attribute columns.");
            const importColumns = gisImportColumns(sourceColumns, options.fieldMappings);
            if (new Set(importColumns.map((column) => column.name)).size !== importColumns.length
                || importColumns.some((column) => column.name === geometryColumn)) {
                throw new Error("GIS attributes contain duplicate names or collide with the destination geometry column.");
            }
            database = this.createDatabaseAdapter();
            existingTable = (await database.listTables(schema)).some((item) => item.name === table && item.type === "table");
            if (mode === "create" && existingTable)
                throw new Error(`Destination table '${schema}.${table}' already exists.`);
            if (mode === "append" && !existingTable)
                throw new Error(`Destination table '${schema}.${table}' does not exist for append mode.`);
            if (mode === "overwrite" && existingTable) {
                const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
                writeTable = `__dbstudio_gis_${suffix}`;
                backupTable = `__dbstudio_old_${suffix}`;
            }
            if (mode === "append" && existingTable) {
                const targetColumns = await database.getTableColumns(table, schema);
                const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
                const missing = [...sourceColumns.map((column) => column.name), geometryColumn]
                    .filter((name) => !targetByName.has(name));
                if (missing.length > 0)
                    throw new Error(`Destination table is missing GIS column(s): ${missing.join(", ")}.`);
                if (!isMySqlFamilySpatialColumn(targetByName.get(geometryColumn))) {
                    throw new Error(`Destination column '${geometryColumn}' is not a MySQL/MariaDB spatial column.`);
                }
                if (options.createSpatialIndex) {
                    if (layerSrsId === null || layerSrsId <= 0) {
                        throw new Error("MySQL/MariaDB indexed append requires a known positive SRID shared by the imported geometries.");
                    }
                    const targetGeometry = targetByName.get(geometryColumn);
                    if (!targetGeometry || targetGeometry.nullable) {
                        throw new Error(`MySQL/MariaDB indexed append requires destination geometry column '${geometryColumn}' to be NOT NULL.`);
                    }
                    if (this.engine === "mysql") {
                        const spatialReference = await database.query("SELECT SRS_ID AS srs_id FROM information_schema.COLUMNS "
                            + "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [schema, table, geometryColumn]);
                        const destinationSrsId = Number(databaseRowValue(spatialReference.rows[0], "srs_id"));
                        if (spatialReference.rows.length !== 1 || destinationSrsId !== layerSrsId) {
                            throw new Error(`MySQL indexed append requires destination SRID ${layerSrsId}; column '${geometryColumn}' has SRID ${Number.isFinite(destinationSrsId) ? destinationSrsId : "unknown"}.`);
                        }
                    }
                    else {
                        const constraints = await database.query("SELECT cc.CHECK_CLAUSE AS check_clause "
                            + "FROM information_schema.TABLE_CONSTRAINTS AS tc "
                            + "INNER JOIN information_schema.CHECK_CONSTRAINTS AS cc "
                            + "ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME "
                            + "WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'", [schema, table]);
                        const checkSettings = await database.query("SELECT @@GLOBAL.check_constraint_checks AS global_checks, "
                            + "@@SESSION.check_constraint_checks AS session_checks");
                        const checkSettingsRow = checkSettings.rows[0];
                        const checksEnabled = ["global_checks", "session_checks"].every((name) => {
                            const setting = String(databaseRowValue(checkSettingsRow, name) ?? "").toLocaleUpperCase("en-US");
                            return ["ON", "1", "YES", "TRUE"].includes(setting);
                        });
                        const normalizedGeometryColumn = geometryColumn.replace(/[\s`"\[\]]/g, "").toLocaleLowerCase("en-US");
                        const escapedGeometryColumn = normalizedGeometryColumn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        const sridCheck = new RegExp(`(?:st_srid|srid)\\(${escapedGeometryColumn}\\)=${layerSrsId}(?![0-9])`, "i");
                        const hasEnforcedSridCheck = constraints.rows.some((row) => {
                            const clause = String(databaseRowValue(row, "check_clause") ?? "")
                                .replace(/[\s`"\[\]]/g, "").toLocaleLowerCase("en-US");
                            return sridCheck.test(clause);
                        });
                        if (!checksEnabled || !hasEnforcedSridCheck) {
                            throw new Error(`MariaDB indexed append requires an enforced CHECK constraint limiting '${geometryColumn}' to SRID ${layerSrsId}.`);
                        }
                    }
                    const indexMetadata = await database.query("SELECT INDEX_NAME AS index_name, INDEX_TYPE AS index_type, NON_UNIQUE AS non_unique, "
                        + "COLUMN_NAME AS column_name, COUNT(*) AS column_count "
                        + "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? "
                        + "AND INDEX_TYPE IN ('RTREE', 'SPATIAL') AND COLUMN_NAME = ? "
                        + "GROUP BY INDEX_NAME, INDEX_TYPE, NON_UNIQUE, COLUMN_NAME", [schema, table, geometryColumn]);
                    const indexRow = indexMetadata.rows[0];
                    const indexType = String(databaseRowValue(indexRow, "index_type") ?? "").toLocaleUpperCase("en-US");
                    const indexColumn = String(databaseRowValue(indexRow, "column_name") ?? "");
                    const columnCount = Number(databaseRowValue(indexRow, "column_count") ?? 0);
                    const nonUnique = Number(databaseRowValue(indexRow, "non_unique") ?? 0);
                    if (indexMetadata.rows.length !== 1 || columnCount !== 1 || indexColumn !== geometryColumn
                        || nonUnique !== 1 || !["RTREE", "SPATIAL"].includes(indexType)) {
                        throw new Error(`MySQL/MariaDB indexed append requires exactly one existing single-column SPATIAL index on '${geometryColumn}'.`);
                    }
                    spatialIndexName = String(databaseRowValue(indexRow, "index_name") ?? "");
                }
            }
            else {
                await database.createTable(writeTable, importColumns, schema);
                createdTable = writeTable;
                const spatialColumnDefinition = options.createSpatialIndex
                    ? this.engine === "mysql"
                        ? `GEOMETRY NOT NULL SRID ${layerSrsId}`
                        : `GEOMETRY REF_SYSTEM_ID=${layerSrsId} NOT NULL`
                    : "GEOMETRY NULL";
                await database.query(`ALTER TABLE ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(writeTable)} `
                    + `ADD COLUMN ${quoteMysqlFamilyIdentifier(geometryColumn)} ${spatialColumnDefinition}`);
                if (options.createSpatialIndex && this.engine === "mariadb") {
                    const sridConstraintName = `DBSC${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
                    await database.query(`ALTER TABLE ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(writeTable)} `
                        + `ADD CONSTRAINT ${quoteMysqlFamilyIdentifier(sridConstraintName)} `
                        + `CHECK (ST_SRID(${quoteMysqlFamilyIdentifier(geometryColumn)}) = ${layerSrsId})`);
                }
            }
            const queryColumns = [...sourceColumns.map((column) => column.name), sourceGeometryColumn];
            const selectSql = `SELECT ${queryColumns.map(gpkgSqliteIdentifier).join(", ")} `
                + `FROM ${gpkgSqliteIdentifier(stagedLayerName)}`;
            const insertColumns = [...sourceColumns.map((column) => column.name), geometryColumn];
            for await (const batch of stagedDatabase.queryStream(selectSql, [], {
                signal: operationOptions.signal,
                batchSize: 200,
            })) {
                if (operationOptions.signal?.aborted)
                    throw new Error("GIS import was cancelled.");
                if (batch.rows.length === 0)
                    continue;
                const rows = batch.rows.map((row, rowIndex) => {
                    const geometry = decodeGeoPackageGeometry(row[sourceGeometryColumn]);
                    if (options.createSpatialIndex && geometry && geometry.srid !== layerSrsId) {
                        throw new Error(`Feature ${importedRows + rowIndex + 1} has SRID ${geometry.srid ?? "unknown"}, expected ${layerSrsId} for spatial-index creation.`);
                    }
                    if (geometry && geometry.srid === null) {
                        sawUnknownSrs = true;
                        geometry.srid = 0;
                    }
                    else if (geometry && layerSrsId !== null && geometry.srid !== layerSrsId) {
                        throw new Error(`Feature ${importedRows + rowIndex + 1} has SRID ${geometry.srid}, expected ${layerSrsId}.`);
                    }
                    return [...sourceColumns.map((column) => row[column.name] ?? null), geometry];
                });
                const inserted = await database.insertRows(writeTable, insertColumns, rows, schema);
                if (inserted !== rows.length)
                    throw new Error(`Destination inserted ${inserted} of ${rows.length} rows in one GIS batch.`);
                importedRows += inserted;
            }
            const stagedLayer = staged.layers.find((layer) => layer.name === stagedLayerName);
            const featureCount = stagedLayer?.featureCount ?? null;
            if (featureCount !== null && featureCount !== importedRows) {
                throw new Error(`GIS import count mismatch: staged ${featureCount}, inserted ${importedRows}.`);
            }
            if (options.createSpatialIndex) {
                if (mode === "append") {
                    const indexMetadata = await database.query("SELECT INDEX_NAME AS index_name, INDEX_TYPE AS index_type, NON_UNIQUE AS non_unique, "
                        + "COLUMN_NAME AS column_name, COUNT(*) AS column_count "
                        + "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? "
                        + "AND INDEX_NAME = ? GROUP BY INDEX_NAME, INDEX_TYPE, NON_UNIQUE, COLUMN_NAME", [schema, table, spatialIndexName]);
                    const indexRow = indexMetadata.rows[0];
                    const indexType = String(databaseRowValue(indexRow, "index_type") ?? "").toLocaleUpperCase("en-US");
                    const indexColumn = String(databaseRowValue(indexRow, "column_name") ?? "");
                    const columnCount = Number(databaseRowValue(indexRow, "column_count") ?? 0);
                    const nonUnique = Number(databaseRowValue(indexRow, "non_unique") ?? 0);
                    if (indexMetadata.rows.length !== 1 || columnCount !== 1 || indexColumn !== geometryColumn
                        || nonUnique !== 1 || !["RTREE", "SPATIAL"].includes(indexType)) {
                        throw new Error(`MySQL/MariaDB spatial index '${spatialIndexName}' did not remain valid after indexed append.`);
                    }
                    warnings.push(`${this.engine} spatial index '${spatialIndexName}' was retained and maintained during append.`);
                }
                else {
                    spatialIndexName = `DBSI${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
                    await database.query(`CREATE SPATIAL INDEX ${quoteMysqlFamilyIdentifier(spatialIndexName)} `
                        + `ON ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(writeTable)} `
                        + `(${quoteMysqlFamilyIdentifier(geometryColumn)})`);
                    const indexMetadata = await database.query("SELECT INDEX_TYPE AS index_type, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, COUNT(*) AS column_count "
                        + "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? "
                        + "GROUP BY INDEX_TYPE, NON_UNIQUE, COLUMN_NAME", [schema, writeTable, spatialIndexName]);
                    const indexRow = indexMetadata.rows[0];
                    const indexType = String(indexRow?.index_type ?? indexRow?.INDEX_TYPE ?? "").toUpperCase();
                    const indexColumn = String(indexRow?.column_name ?? indexRow?.COLUMN_NAME ?? "");
                    const columnCount = Number(indexRow?.column_count ?? indexRow?.COLUMN_COUNT ?? 0);
                    const nonUnique = Number(indexRow?.non_unique ?? indexRow?.NON_UNIQUE ?? 0);
                    if (indexMetadata.rows.length !== 1 || columnCount !== 1 || indexColumn !== geometryColumn
                        || nonUnique !== 1 || !["RTREE", "SPATIAL"].includes(indexType)) {
                        throw new Error(`MySQL/MariaDB spatial index '${spatialIndexName}' did not verify as a single-column R-tree index on '${geometryColumn}'.`);
                    }
                    warnings.push(`${this.engine} spatial index '${spatialIndexName}' was created on '${geometryColumn}'.`);
                }
            }
            if (backupTable) {
                await database.query(`RENAME TABLE ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(table)} `
                    + `TO ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(backupTable)}, `
                    + `${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(writeTable)} `
                    + `TO ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(table)}`);
                createdTable = undefined;
                if (options.createSpatialIndex && spatialIndexName) {
                    try {
                        const renamedIndex = await database.query("SELECT INDEX_TYPE AS index_type, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, COUNT(*) AS column_count "
                            + "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? "
                            + "GROUP BY INDEX_TYPE, NON_UNIQUE, COLUMN_NAME", [schema, table, spatialIndexName]);
                        const indexRow = renamedIndex.rows[0];
                        const indexType = String(indexRow?.index_type ?? indexRow?.INDEX_TYPE ?? "").toUpperCase();
                        const indexColumn = String(indexRow?.column_name ?? indexRow?.COLUMN_NAME ?? "");
                        const columnCount = Number(indexRow?.column_count ?? indexRow?.COLUMN_COUNT ?? 0);
                        const nonUnique = Number(indexRow?.non_unique ?? indexRow?.NON_UNIQUE ?? 0);
                        if (renamedIndex.rows.length !== 1 || columnCount !== 1 || indexColumn !== geometryColumn
                            || nonUnique !== 1 || !["RTREE", "SPATIAL"].includes(indexType)) {
                            throw new Error(`MySQL/MariaDB spatial index '${spatialIndexName}' did not remain valid on replacement table '${table}'.`);
                        }
                    }
                    catch (error) {
                        try {
                            await database.query(`RENAME TABLE ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(table)} `
                                + `TO ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(writeTable)}, `
                                + `${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(backupTable)} `
                                + `TO ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(table)}`);
                            createdTable = writeTable;
                        }
                        catch (rollbackError) {
                            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                            throw new Error(`Spatial-index verification failed after table swap; the previous table remains at '${schema}.${backupTable}', and automatic rollback failed: ${message}`, { cause: error });
                        }
                        throw error;
                    }
                }
                try {
                    await database.query(`DROP TABLE ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(backupTable)}`);
                }
                catch {
                    warnings.push(`Previous table contents remain in '${backupTable}' because the backup table could not be removed.`);
                }
            }
            completed = true;
            if (sawUnknownSrs)
                warnings.push("Source GeoPackage has an undefined SRS id; imported geometry uses SRID 0.");
            return {
                operation: "import",
                status: "completed",
                engine: this.engine,
                input,
                output: `${schema}.${table}`,
                schema,
                table,
                geometryColumn,
                srid: layerSrsId,
                featureCount,
                successfulFeatures: importedRows,
                failedFeatures: featureCount === null ? null : featureCount - importedRows,
                failedSamples: [],
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }
        catch (error) {
            if (createdTable && !completed && database) {
                await database.query(`DROP TABLE IF EXISTS ${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(createdTable)}`).catch(() => undefined);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(importedRows > 0 && mode === "append"
                ? `GIS append stopped after ${importedRows} committed rows: ${message}`
                : `GIS import to '${schema}.${table}' failed: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                ...(stagedDatabase ? [stagedDatabase.close()] : []),
                ...(database ? [database.close()] : []),
            ]);
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    async exportGisFromSqlServer(table, schema, output, options = {}, operationOptions = {}) {
        if (this.engine !== "sqlserver") {
            throw new Error("GIS file export from a database is currently available for SQL Server connections through this method.");
        }
        if (!table.trim() || !schema.trim() || !output.trim()) {
            throw new Error("A source database, table, and output path are required for GIS export.");
        }
        let database;
        let stagedDatabase;
        let temporaryDirectory;
        let processedRows = 0;
        const sourceName = `${schema}.${table}`;
        try {
            if (operationOptions.signal?.aborted)
                throw new Error("GIS export was cancelled before staging started.");
            database = this.createDatabaseAdapter();
            const sourceTable = (await database.listTables(schema))
                .find((candidate) => candidate.name === table && candidate.type === "table");
            if (!sourceTable)
                throw new Error(`Source table '${sourceName}' was not found or is not a base table.`);
            const columns = (await database.getTableColumns(table, schema))
                .sort((left, right) => left.ordinalPosition - right.ordinalPosition);
            const geometryColumns = columns.filter((column) => /^(?:GEOMETRY|GEOGRAPHY)$/i.test(column.dataType.trim()));
            if (geometryColumns.length !== 1) {
                throw new Error(geometryColumns.length === 0
                    ? `Source table '${sourceName}' has no SQL Server geometry or geography column.`
                    : `Source table '${sourceName}' has ${geometryColumns.length} spatial columns; export currently requires exactly one.`);
            }
            const geometryColumn = geometryColumns[0];
            const attributeColumns = columns.filter((column) => column.name !== geometryColumn.name);
            const sourceColumnsByName = new Map(attributeColumns.map((column) => [column.name, column]));
            const mappingsBySource = new Map();
            for (const mapping of options.fieldMappings ?? []) {
                if (mappingsBySource.has(mapping.source))
                    throw new Error(`Source field '${mapping.source}' is mapped more than once.`);
                if (!sourceColumnsByName.has(mapping.source))
                    throw new Error(`Source table '${sourceName}' has no attribute field '${mapping.source}'.`);
                if (!mapping.target.trim())
                    throw new Error(`Output field name for '${mapping.source}' cannot be empty.`);
                mappingsBySource.set(mapping.source, mapping);
            }
            const outputAttributes = attributeColumns.map((column) => {
                const mapping = mappingsBySource.get(column.name);
                return { column, target: mapping?.target ?? column.name, targetType: mapping?.targetType };
            });
            const outputAttributeNames = outputAttributes.map((attribute) => attribute.target.toLocaleLowerCase("en-US"));
            if (new Set(outputAttributeNames).size !== outputAttributeNames.length
                || outputAttributeNames.includes(geometryColumn.name.toLocaleLowerCase("en-US"))) {
                throw new Error("Output attribute names are duplicated or collide with the geometry column.");
            }
            const exportWarnings = [];
            if (outputAttributes.some(({ column, targetType }) => targetType === undefined && /^(?:DECIMAL|NUMERIC|MONEY|SMALLMONEY)\b/i.test(column.dataType))) {
                exportWarnings.push("DECIMAL/NUMERIC/MONEY attributes are staged as text to preserve their exact values.");
            }
            const qualifiedTable = `${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(table)}`;
            const quotedGeometry = quoteSqlServerIdentifier(geometryColumn.name);
            const srsGroups = await database.query(`SELECT ${quotedGeometry}.STSrid AS srs_id, COUNT_BIG(*) AS feature_count `
                + `FROM ${qualifiedTable} WHERE ${quotedGeometry} IS NOT NULL GROUP BY ${quotedGeometry}.STSrid`);
            if (srsGroups.rows.length > 1) {
                throw new Error(`Source table '${sourceName}' contains multiple geometry SRIDs; export requires one SRS per layer.`);
            }
            const rawSrsId = srsGroups.rows.length > 0
                ? Number(srsGroups.rows[0].srs_id)
                : 0;
            if (!Number.isSafeInteger(rawSrsId) || rawSrsId < 0) {
                throw new Error(`Source table '${sourceName}' has an invalid geometry SRID.`);
            }
            const srid = rawSrsId;
            let stagedSrsId = srid;
            const sourceCrsOverride = options.sourceCrs?.trim() || undefined;
            const totalResult = await database.query(`SELECT COUNT_BIG(*) AS total FROM ${qualifiedTable}`);
            const totalRows = Number(totalResult.rows[0]?.total ?? 0);
            if (!Number.isSafeInteger(totalRows) || totalRows < 0)
                throw new Error("The source table returned an invalid row count.");
            let spatialReference = {
                name: srid === 0 ? "Undefined geographic SRS" : "",
                organization: "NONE",
                organizationCoordsysId: srid,
                definition: "undefined",
                description: "undefined",
            };
            if (srid !== 0) {
                let row;
                try {
                    const srsResult = await database.query(`SELECT CONCAT(authority_name, ':', authorized_spatial_reference_id) AS name, `
                        + `authority_name AS organization, authorized_spatial_reference_id AS organization_coordsys_id, `
                        + `well_known_text AS definition, unit_of_measure AS description `
                        + `FROM sys.spatial_reference_systems WHERE spatial_reference_id = @p1`, [srid]);
                    row = srsResult.rows[0];
                }
                catch (error) {
                    if (!sourceCrsOverride) {
                        const message = error instanceof Error ? error.message : String(error);
                        throw new Error(`SQL Server could not expose the CRS definition for SRID ${srid}; specify --source-crs to assign one explicitly. (${message})`);
                    }
                }
                if (!row || typeof row.definition !== "string" || !row.definition.trim()) {
                    if (!sourceCrsOverride) {
                        throw new Error(`SQL Server does not expose a CRS definition for SRID ${srid}; specify --source-crs to assign one explicitly.`);
                    }
                    stagedSrsId = 0;
                    exportWarnings.push(`SQL Server has no CRS definition for SRID ${srid}; source CRS '${sourceCrsOverride}' was explicitly assigned for export.`);
                }
                else {
                    const organizationCoordsysId = Number(row.organization_coordsys_id ?? srid);
                    if (!Number.isSafeInteger(organizationCoordsysId)) {
                        throw new Error(`SQL Server returned an invalid authority CRS id for SRID ${srid}.`);
                    }
                    spatialReference = {
                        name: String(row.name ?? `SRID ${srid}`),
                        organization: String(row.organization ?? "NONE"),
                        organizationCoordsysId,
                        definition: row.definition,
                        description: String(row.description ?? ""),
                    };
                }
            }
            if (sourceCrsOverride && srid === 0) {
                exportWarnings.push(`Source CRS '${sourceCrsOverride}' was explicitly assigned to geometries with SRID 0.`);
            }
            else if (sourceCrsOverride && stagedSrsId !== 0) {
                exportWarnings.push(`Source CRS '${sourceCrsOverride}' overrides the spatial reference definition stored by SQL Server.`);
            }
            const attributeNames = new Set(outputAttributes.map((attribute) => attribute.target.toLocaleLowerCase("en-US")));
            const featureIdColumn = ["fid", "_dbstudio_fid", "dbstudio_fid"]
                .find((candidate) => !attributeNames.has(candidate) && candidate !== geometryColumn.name.toLocaleLowerCase("en-US"))
                ?? `dbstudio_fid_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
            const attributeAliases = attributeColumns.map((_, index) => `__dbstudio_attr_${index}`);
            const wkbAlias = "__dbstudio_geometry_wkb";
            const sridAlias = "__dbstudio_geometry_srid";
            const emptyAlias = "__dbstudio_geometry_empty";
            const selectAttributes = attributeColumns.map((column, index) => {
                const source = quoteSqlServerIdentifier(column.name);
                const normalizedType = column.dataType.trim().toUpperCase();
                const expression = /^(?:DECIMAL|NUMERIC|MONEY|SMALLMONEY)\b/.test(normalizedType)
                    ? `CONVERT(nvarchar(max), ${source})`
                    : source;
                return `${expression} AS ${quoteSqlServerIdentifier(attributeAliases[index])}`;
            });
            const selectColumns = [
                ...selectAttributes,
                `${quotedGeometry}.AsBinaryZM() AS ${quoteSqlServerIdentifier(wkbAlias)}`,
                `${quotedGeometry}.STSrid AS ${quoteSqlServerIdentifier(sridAlias)}`,
                `${quotedGeometry}.STIsEmpty() AS ${quoteSqlServerIdentifier(emptyAlias)}`,
            ];
            temporaryDirectory = await mkdtemp(join(tmpdir(), "db-studio-gis-export-"));
            const stagedPath = join(temporaryDirectory, "staged.gpkg");
            stagedDatabase = new SqliteAdapter({ path: stagedPath });
            await stagedDatabase.query("PRAGMA application_id = 1196444487");
            await stagedDatabase.query("PRAGMA user_version = 10300");
            await stagedDatabase.query(`CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL PRIMARY KEY,
        organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL,
        description TEXT
      )`);
            await stagedDatabase.query(`CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY,
        data_type TEXT NOT NULL,
        identifier TEXT UNIQUE,
        description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
        srs_id INTEGER,
        FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      )`);
            await stagedDatabase.query(`CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL,
        m TINYINT NOT NULL,
        PRIMARY KEY (table_name, column_name),
        FOREIGN KEY (table_name) REFERENCES gpkg_contents (table_name),
        FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      )`);
            for (const row of [
                ["Undefined Cartesian SRS", -1, "NONE", -1, "undefined", "undefined"],
                ["Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined"],
            ]) {
                await stagedDatabase.query("INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)", row);
            }
            if (stagedSrsId !== 0) {
                await stagedDatabase.query("INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)", [spatialReference.name, stagedSrsId, spatialReference.organization, spatialReference.organizationCoordsysId, spatialReference.definition, spatialReference.description]);
            }
            await stagedDatabase.query("INSERT INTO gpkg_contents (table_name, data_type, identifier, description, srs_id) VALUES (?, 'features', ?, ?, ?)", ["features", "features", `Exported from ${sourceName}`, stagedSrsId]);
            await stagedDatabase.query("INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, ?, 'GEOMETRY', ?, 2, 2)", ["features", geometryColumn.name, stagedSrsId]);
            const featureColumns = [
                `${gpkgSqliteIdentifier(featureIdColumn)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`,
                `${gpkgSqliteIdentifier(geometryColumn.name)} BLOB`,
                ...outputAttributes.map(({ column, target, targetType }) => `${gpkgSqliteIdentifier(target)} ${sqlServerColumnToGeoPackageType(column.dataType, targetType)}`),
            ];
            await stagedDatabase.query(`CREATE TABLE ${gpkgSqliteIdentifier("features")} (${featureColumns.join(", ")})`);
            const querySql = `SELECT ${selectColumns.join(", ")} FROM ${qualifiedTable}`;
            for await (const batch of database.queryStream(querySql, [], { batchSize: 200, signal: operationOptions.signal })) {
                if (operationOptions.signal?.aborted)
                    throw new Error("GIS export was cancelled while reading database rows.");
                if (batch.rows.length === 0)
                    continue;
                const rows = batch.rows.map((row, rowIndex) => {
                    const rawWkb = row[wkbAlias];
                    if (rawWkb === null || rawWkb === undefined) {
                        return [null, ...attributeAliases.map((alias, index) => normalizeMysqlExportCell(row[alias], outputAttributes[index]?.targetType))];
                    }
                    const rowSrid = Number(row[sridAlias]);
                    if (rowSrid !== srid)
                        throw new Error(`Feature ${processedRows + rowIndex + 1} has SRID ${rowSrid}, expected ${srid}.`);
                    const geometry = encodeGeoPackageGeometry(rawWkb, stagedSrsId, Number(row[emptyAlias]) === 1 || row[emptyAlias] === true);
                    return [geometry, ...attributeAliases.map((alias, index) => normalizeMysqlExportCell(row[alias], outputAttributes[index]?.targetType))];
                });
                const written = await stagedDatabase.insertRows("features", [geometryColumn.name, ...outputAttributes.map((attribute) => attribute.target)], rows);
                if (written !== rows.length)
                    throw new Error(`GeoPackage staging inserted ${written} of ${rows.length} rows in one batch.`);
                processedRows += written;
                operationOptions.onProgress?.(totalRows > 0 ? Math.min(35, Math.floor((processedRows / totalRows) * 35)) : 35);
            }
            if (processedRows !== totalRows) {
                throw new Error(`Database row count changed during export: counted ${totalRows}, streamed ${processedRows}.`);
            }
            if (srsGroups.rows.length === 0 && totalRows > 0)
                operationOptions.onProgress?.(35);
            await stagedDatabase.close();
            stagedDatabase = undefined;
            await database.close();
            database = undefined;
            const gis = new GdalService(isolatedGdalEnvironment(this.environment));
            const converted = await gis.convert(stagedPath, output, {
                sourceLayer: "features",
                sourceCrs: sourceCrsOverride,
                targetLayerName: options.targetLayerName,
                targetCrs: options.targetCrs,
                coordinateOperation: options.coordinateOperation,
                targetEncoding: options.targetEncoding,
                spatialFilter: options.spatialFilter,
                datasetCreationOptions: options.datasetCreationOptions,
                layerCreationOptions: options.layerCreationOptions,
            }, {
                signal: operationOptions.signal,
                onProgress: (percent) => operationOptions.onProgress?.(35 + Math.floor(percent * 0.65)),
            });
            const report = {
                operation: "export",
                status: "completed",
                input: sourceName,
                output: converted.path,
                featureCount: converted.operationReport?.featureCount ?? totalRows,
                successfulFeatures: converted.operationReport?.successfulFeatures ?? processedRows,
                failedFeatures: converted.operationReport?.failedFeatures ?? 0,
                failedSamples: converted.operationReport?.failedSamples ?? [],
                ...((converted.operationReport?.warnings?.length || exportWarnings.length)
                    ? { warnings: [...exportWarnings, ...(converted.operationReport?.warnings ?? [])] }
                    : {}),
            };
            if (srsGroups.rows.length === 0 && totalRows > 0 && !sourceCrsOverride) {
                report.warnings = [...(report.warnings ?? []), "The spatial column contains only NULL values; the exported layer uses undefined SRS (SRID 0)."];
            }
            return { ...converted, operationReport: report };
        }
        catch (error) {
            if (error instanceof GisOperationError) {
                throw new GisOperationError(error.message, {
                    ...error.report,
                    operation: "export",
                    input: sourceName,
                    output,
                });
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`GIS export from '${sourceName}' failed after staging ${processedRows} rows: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                ...(stagedDatabase ? [stagedDatabase.close()] : []),
                ...(database ? [database.close()] : []),
            ]);
            if (temporaryDirectory)
                await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    async exportGisFromOracle(table, schema, output, options = {}, operationOptions = {}) {
        if (this.engine !== "oracle") {
            throw new Error("GIS file export from a database is currently available for Oracle connections through this method.");
        }
        if (!table.trim() || !schema.trim() || !output.trim()) {
            throw new Error("A source database, table, and output path are required for GIS export.");
        }
        let database;
        let stagedDatabase;
        let temporaryDirectory;
        let processedRows = 0;
        const sourceName = `${schema}.${table}`;
        try {
            if (operationOptions.signal?.aborted)
                throw new Error("GIS export was cancelled before staging started.");
            database = this.createDatabaseAdapter();
            const oracleAdapter = database;
            const sourceTable = (await database.listTables(schema))
                .find((candidate) => candidate.name === table && candidate.type === "table");
            if (!sourceTable)
                throw new Error(`Source table '${sourceName}' was not found or is not a base table.`);
            const columns = (await database.getTableColumns(table, schema))
                .sort((left, right) => left.ordinalPosition - right.ordinalPosition);
            const geometryColumns = columns.filter(isOracleSpatialColumn);
            if (geometryColumns.length !== 1) {
                throw new Error(geometryColumns.length === 0
                    ? `Source table '${sourceName}' has no Oracle SDO_GEOMETRY column.`
                    : `Source table '${sourceName}' has ${geometryColumns.length} SDO_GEOMETRY columns; export currently requires exactly one.`);
            }
            const geometryColumn = geometryColumns[0];
            const attributeColumns = columns.filter((column) => column.name !== geometryColumn.name);
            const sourceColumnsByName = new Map(attributeColumns.map((column) => [column.name, column]));
            const mappingsBySource = new Map();
            for (const mapping of options.fieldMappings ?? []) {
                if (mappingsBySource.has(mapping.source))
                    throw new Error(`Source field '${mapping.source}' is mapped more than once.`);
                if (!sourceColumnsByName.has(mapping.source))
                    throw new Error(`Source table '${sourceName}' has no attribute field '${mapping.source}'.`);
                if (!mapping.target.trim())
                    throw new Error(`Output field name for '${mapping.source}' cannot be empty.`);
                mappingsBySource.set(mapping.source, mapping);
            }
            const outputAttributes = attributeColumns.map((column) => {
                const mapping = mappingsBySource.get(column.name);
                return { column, target: mapping?.target ?? column.name, targetType: mapping?.targetType };
            });
            const outputAttributeNames = outputAttributes.map((attribute) => attribute.target.toLocaleLowerCase("en-US"));
            if (new Set(outputAttributeNames).size !== outputAttributeNames.length
                || outputAttributeNames.includes(geometryColumn.name.toLocaleLowerCase("en-US"))) {
                throw new Error("Output attribute names are duplicated or collide with the geometry column.");
            }
            const exportWarnings = [];
            if (outputAttributes.some(({ column, targetType }) => targetType === undefined && /^(?:NUMBER|DECIMAL|NUMERIC)\b/i.test(column.dataType))) {
                exportWarnings.push("NUMBER attributes are staged as text by default to preserve Oracle numeric precision.");
            }
            const qualifiedTable = `${quoteOracleIdentifier(schema)}.${quoteOracleIdentifier(table)}`;
            const quotedGeometry = quoteOracleIdentifier(geometryColumn.name);
            const oracleSourceAlias = "dbstudio_source";
            const spatialObject = `${oracleSourceAlias}.${quotedGeometry}`;
            const srsGroups = await database.query(`SELECT ${spatialObject}.SDO_SRID AS srs_id, COUNT(*) AS feature_count `
                + `FROM ${qualifiedTable} ${oracleSourceAlias} WHERE ${spatialObject} IS NOT NULL GROUP BY ${spatialObject}.SDO_SRID`);
            const sridValues = [...new Set(srsGroups.rows.map((row) => {
                    const raw = oracleRowValue(row, "srs_id");
                    if (raw === null || raw === undefined)
                        return 0;
                    const value = Number(raw);
                    if (!Number.isSafeInteger(value) || value < 0)
                        throw new Error(`Source table '${sourceName}' has an invalid geometry SRID.`);
                    return value;
                }))];
            if (sridValues.length > 1) {
                throw new Error(`Source table '${sourceName}' contains multiple geometry SRIDs; export requires one SRS per layer.`);
            }
            const srid = sridValues[0] ?? 0;
            let stagedSrsId = srid;
            const sourceCrsOverride = options.sourceCrs?.trim() || undefined;
            const totalResult = await database.query(`SELECT COUNT(*) AS total FROM ${qualifiedTable}`);
            const totalRows = Number(oracleRowValue(totalResult.rows[0], "total") ?? 0);
            if (!Number.isSafeInteger(totalRows) || totalRows < 0)
                throw new Error("The source table returned an invalid row count.");
            let spatialReference = {
                name: srid === 0 ? "Undefined geographic SRS" : "",
                organization: "NONE",
                organizationCoordsysId: srid,
                definition: "undefined",
                description: "undefined",
            };
            if (srid !== 0) {
                let row;
                try {
                    const srsResult = await oracleAdapter.query("SELECT CS_NAME AS name, NVL(AUTH_NAME, 'NONE') AS organization, "
                        + "NVL(AUTH_SRID, SRID) AS organization_coordsys_id, WKTEXT AS definition "
                        + "FROM MDSYS.CS_SRS WHERE SRID = :1", [srid], { fetchTypeHandler: oracleTransferFetchTypeHandler });
                    const sourceRow = srsResult.rows[0];
                    row = sourceRow ? {
                        name: oracleRowValue(sourceRow, "name"),
                        organization: oracleRowValue(sourceRow, "organization"),
                        organization_coordsys_id: oracleRowValue(sourceRow, "organization_coordsys_id"),
                        definition: oracleRowValue(sourceRow, "definition"),
                    } : undefined;
                }
                catch (error) {
                    if (!sourceCrsOverride) {
                        const message = error instanceof Error ? error.message : String(error);
                        throw new Error(`Oracle could not expose the CRS definition for SRID ${srid}; specify --source-crs to assign one explicitly. (${message})`);
                    }
                }
                if (!row || typeof row.definition !== "string" || !row.definition.trim()) {
                    if (!sourceCrsOverride) {
                        throw new Error(`Oracle does not expose a CRS definition for SRID ${srid}; specify --source-crs to assign one explicitly.`);
                    }
                    stagedSrsId = 0;
                    exportWarnings.push(`Oracle has no CRS definition for SRID ${srid}; source CRS '${sourceCrsOverride}' was explicitly assigned for export.`);
                }
                else {
                    const organizationCoordsysId = Number(row.organization_coordsys_id ?? srid);
                    if (!Number.isSafeInteger(organizationCoordsysId))
                        throw new Error(`Oracle returned an invalid authority CRS id for SRID ${srid}.`);
                    spatialReference = {
                        name: String(row.name ?? `SRID ${srid}`),
                        organization: String(row.organization ?? "NONE"),
                        organizationCoordsysId,
                        definition: row.definition,
                        description: "Oracle coordinate reference system",
                    };
                }
            }
            if (sourceCrsOverride && srid === 0) {
                exportWarnings.push(`Source CRS '${sourceCrsOverride}' was explicitly assigned to geometries with a NULL or zero SRID.`);
            }
            else if (sourceCrsOverride && stagedSrsId !== 0) {
                exportWarnings.push(`Source CRS '${sourceCrsOverride}' overrides the coordinate reference system stored by Oracle.`);
            }
            const invalidDimensions = await database.query(`SELECT COUNT(*) AS invalid_count FROM ${qualifiedTable} ${oracleSourceAlias} `
                + `WHERE ${spatialObject} IS NOT NULL AND (`
                + `${spatialObject}.SDO_GTYPE IS NULL `
                + `OR TRUNC(${spatialObject}.SDO_GTYPE / 1000) NOT IN (2, 3, 4) `
                + `OR MOD(${spatialObject}.SDO_GTYPE, 100) NOT BETWEEN 1 AND 7 `
                + `OR (TRUNC(${spatialObject}.SDO_GTYPE / 1000) = 2 AND MOD(TRUNC(${spatialObject}.SDO_GTYPE / 100), 10) <> 0) `
                + `OR (TRUNC(${spatialObject}.SDO_GTYPE / 1000) = 3 AND MOD(TRUNC(${spatialObject}.SDO_GTYPE / 100), 10) NOT IN (0, 3)) `
                + `OR (TRUNC(${spatialObject}.SDO_GTYPE / 1000) = 4 AND MOD(TRUNC(${spatialObject}.SDO_GTYPE / 100), 10) <> 4))`);
            const invalidDimensionCount = Number(oracleRowValue(invalidDimensions.rows[0], "invalid_count") ?? 0);
            if (!Number.isSafeInteger(invalidDimensionCount) || invalidDimensionCount < 0) {
                throw new Error("Oracle returned an invalid SDO_GTYPE validation count.");
            }
            if (invalidDimensionCount > 0) {
                throw new Error(`Source table '${sourceName}' contains ${invalidDimensionCount} geometry value(s) with unsupported SDO_GTYPE, geometry type, or Z/M layout; export stops before writing output.`);
            }
            const dimensionGroups = await database.query(`SELECT TRUNC(${spatialObject}.SDO_GTYPE / 1000) AS coordinate_dimension, `
                + `MOD(TRUNC(${spatialObject}.SDO_GTYPE / 100), 10) AS lrs_dimension, COUNT(*) AS feature_count `
                + `FROM ${qualifiedTable} ${oracleSourceAlias} WHERE ${spatialObject} IS NOT NULL `
                + `GROUP BY TRUNC(${spatialObject}.SDO_GTYPE / 1000), MOD(TRUNC(${spatialObject}.SDO_GTYPE / 100), 10)`);
            const dimensionLayouts = dimensionGroups.rows.map((row) => ({
                coordinateDimension: Number(oracleRowValue(row, "coordinate_dimension")),
                lrsDimension: Number(oracleRowValue(row, "lrs_dimension")),
                featureCount: Number(oracleRowValue(row, "feature_count")),
            }));
            if (dimensionLayouts.some((layout) => !Number.isSafeInteger(layout.featureCount) || layout.featureCount < 0)) {
                throw new Error("Oracle returned an invalid geometry dimension group count.");
            }
            const hasZ = (layout) => layout.coordinateDimension === 3 && layout.lrsDimension === 0
                || layout.coordinateDimension === 4;
            const hasM = (layout) => layout.coordinateDimension === 3 && layout.lrsDimension === 3
                || layout.coordinateDimension === 4;
            const hasAnyZ = dimensionLayouts.some(hasZ);
            const hasAnyM = dimensionLayouts.some(hasM);
            const geometryZFlag = !hasAnyZ ? 0 : dimensionLayouts.every(hasZ) ? 1 : 2;
            const geometryMFlag = !hasAnyM ? 0 : dimensionLayouts.every(hasM) ? 1 : 2;
            if ((geometryZFlag === 2 || geometryMFlag === 2) && dimensionLayouts.length > 1) {
                exportWarnings.push("The source mixes XY, Z, or M dimension layouts; GeoPackage metadata marks the corresponding Z/M ordinates as optional.");
            }
            const attributeNames = new Set(outputAttributes.map((attribute) => attribute.target.toLocaleLowerCase("en-US")));
            const featureIdColumn = ["fid", "_dbstudio_fid", "dbstudio_fid"]
                .find((candidate) => !attributeNames.has(candidate) && candidate !== geometryColumn.name.toLocaleLowerCase("en-US"))
                ?? `dbstudio_fid_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
            const attributeAliases = attributeColumns.map((_, index) => `__dbstudio_attr_${index}`);
            const wkbAlias = "__dbstudio_geometry_wkb";
            const sridAlias = "__dbstudio_geometry_srid";
            const gtypeAlias = "__dbstudio_geometry_gtype";
            const verticesAlias = "__dbstudio_geometry_vertices";
            const selectAttributes = attributeColumns.map((column, index) => {
                const source = quoteOracleIdentifier(column.name);
                const normalizedType = column.dataType.trim().toUpperCase();
                const expression = /^(?:NUMBER|DECIMAL|NUMERIC)\b/.test(normalizedType)
                    ? `TO_CHAR(${source}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')`
                    : source;
                return `${expression} AS ${quoteOracleIdentifier(attributeAliases[index])}`;
            });
            const selectColumns = [
                ...selectAttributes,
                `CASE WHEN ${spatialObject} IS NULL THEN NULL `
                    + `WHEN TRUNC(${spatialObject}.SDO_GTYPE / 1000) = 2 THEN MDSYS.SDO_UTIL.TO_WKBGEOMETRY(${spatialObject}) `
                    + `ELSE MDSYS.SDO_UTIL.TO_WKBGEOMETRY(MDSYS.SDO_CS.MAKE_2D(${spatialObject})) END AS ${quoteOracleIdentifier(wkbAlias)}`,
                `CASE WHEN ${spatialObject} IS NULL THEN NULL ELSE ${spatialObject}.SDO_SRID END AS ${quoteOracleIdentifier(sridAlias)}`,
                `CASE WHEN ${spatialObject} IS NULL THEN NULL ELSE ${spatialObject}.SDO_GTYPE END AS ${quoteOracleIdentifier(gtypeAlias)}`,
                `CASE WHEN ${spatialObject} IS NULL OR TRUNC(${spatialObject}.SDO_GTYPE / 1000) = 2 THEN NULL ELSE `
                    + `(SELECT JSON_ARRAYAGG(JSON_OBJECT('x' VALUE vertex.x, 'y' VALUE vertex.y, 'z' VALUE vertex.z, 'w' VALUE vertex.w) `
                    + `ORDER BY vertex.id RETURNING CLOB) FROM TABLE(MDSYS.SDO_UTIL.GETVERTICES(${spatialObject})) vertex) `
                    + `END AS ${quoteOracleIdentifier(verticesAlias)}`,
            ];
            temporaryDirectory = await mkdtemp(join(tmpdir(), "db-studio-oracle-gis-export-"));
            const stagedPath = join(temporaryDirectory, "staged.gpkg");
            stagedDatabase = new SqliteAdapter({ path: stagedPath });
            await stagedDatabase.query("PRAGMA application_id = 1196444487");
            await stagedDatabase.query("PRAGMA user_version = 10300");
            await stagedDatabase.query(`CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL PRIMARY KEY,
        organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL,
        description TEXT
      )`);
            await stagedDatabase.query(`CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY,
        data_type TEXT NOT NULL,
        identifier TEXT UNIQUE,
        description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
        srs_id INTEGER,
        FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      )`);
            await stagedDatabase.query(`CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL,
        m TINYINT NOT NULL,
        PRIMARY KEY (table_name, column_name),
        FOREIGN KEY (table_name) REFERENCES gpkg_contents (table_name),
        FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      )`);
            for (const row of [
                ["Undefined Cartesian SRS", -1, "NONE", -1, "undefined", "undefined"],
                ["Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined"],
            ]) {
                await stagedDatabase.query("INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)", row);
            }
            if (stagedSrsId !== 0) {
                await stagedDatabase.query("INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)", [spatialReference.name, stagedSrsId, spatialReference.organization, spatialReference.organizationCoordsysId, spatialReference.definition, spatialReference.description]);
            }
            await stagedDatabase.query("INSERT INTO gpkg_contents (table_name, data_type, identifier, description, srs_id) VALUES (?, 'features', ?, ?, ?)", ["features", "features", `Exported from ${sourceName}`, stagedSrsId]);
            await stagedDatabase.query("INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, ?, 'GEOMETRY', ?, ?, ?)", ["features", geometryColumn.name, stagedSrsId, geometryZFlag, geometryMFlag]);
            const featureColumns = [
                `${gpkgSqliteIdentifier(featureIdColumn)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`,
                `${gpkgSqliteIdentifier(geometryColumn.name)} BLOB`,
                ...outputAttributes.map(({ column, target, targetType }) => `${gpkgSqliteIdentifier(target)} ${oracleColumnToGeoPackageType(column.dataType, targetType)}`),
            ];
            await stagedDatabase.query(`CREATE TABLE ${gpkgSqliteIdentifier("features")} (${featureColumns.join(", ")})`);
            const querySql = `SELECT ${selectColumns.join(", ")} FROM ${qualifiedTable} ${oracleSourceAlias}`;
            for await (const batch of oracleAdapter.queryStream(querySql, [], {
                batchSize: 100,
                signal: operationOptions.signal,
                fetchTypeHandler: oracleTransferFetchTypeHandler,
            })) {
                if (operationOptions.signal?.aborted)
                    throw new Error("GIS export was cancelled while reading Oracle rows.");
                if (batch.rows.length === 0)
                    continue;
                const rows = batch.rows.map((row, rowIndex) => {
                    const rawWkb = oracleRowValue(row, wkbAlias);
                    const attrs = attributeAliases.map((alias, index) => normalizeMysqlExportCell(oracleRowValue(row, alias), outputAttributes[index]?.targetType));
                    if (rawWkb === null || rawWkb === undefined) {
                        return [null, ...attrs];
                    }
                    if (!(rawWkb instanceof Uint8Array)) {
                        throw new Error(`Feature ${processedRows + rowIndex + 1} returned an Oracle WKB value that is not binary.`);
                    }
                    const rawGtype = oracleRowValue(row, gtypeAlias);
                    const gtype = rawGtype === null || rawGtype === undefined ? Number.NaN : Number(rawGtype);
                    const coordinateDimension = Math.trunc(gtype / 1_000);
                    let outputWkb = rawWkb;
                    if (coordinateDimension === 2) {
                        if (oracleWkbDimensionCount(rawWkb) !== 2) {
                            throw new Error(`Feature ${processedRows + rowIndex + 1} returned non-XY or unknown WKB from Oracle.`);
                        }
                    }
                    else {
                        const vertexJson = oracleRowValue(row, verticesAlias);
                        if (typeof vertexJson !== "string") {
                            throw new Error(`Feature ${processedRows + rowIndex + 1} did not return SDO Z/M vertex ordinates as text.`);
                        }
                        outputWkb = oracleSdo2dWkbToDimensionalWkb(rawWkb, gtype, vertexJson);
                        if (oracleWkbDimensionCount(outputWkb) !== coordinateDimension) {
                            throw new Error(`Feature ${processedRows + rowIndex + 1} returned inconsistent SDO_GTYPE and reconstructed WKB dimensions.`);
                        }
                    }
                    const rawRowSrid = oracleRowValue(row, sridAlias);
                    const rowSrid = rawRowSrid === null || rawRowSrid === undefined ? 0 : Number(rawRowSrid);
                    if (!Number.isSafeInteger(rowSrid) || rowSrid !== srid) {
                        throw new Error(`Feature ${processedRows + rowIndex + 1} has SRID ${String(rawRowSrid)}, expected ${srid === 0 ? "NULL" : srid}.`);
                    }
                    return [encodeGeoPackageGeometry(outputWkb, stagedSrsId), ...attrs];
                });
                const written = await stagedDatabase.insertRows("features", [geometryColumn.name, ...outputAttributes.map((attribute) => attribute.target)], rows);
                if (written !== rows.length)
                    throw new Error(`GeoPackage staging inserted ${written} of ${rows.length} rows in one batch.`);
                processedRows += written;
                operationOptions.onProgress?.(totalRows > 0 ? Math.min(35, Math.floor((processedRows / totalRows) * 35)) : 35);
            }
            if (processedRows !== totalRows) {
                throw new Error(`Database row count changed during export: counted ${totalRows}, streamed ${processedRows}.`);
            }
            if (sridValues.length === 0 && totalRows > 0)
                operationOptions.onProgress?.(35);
            await stagedDatabase.close();
            stagedDatabase = undefined;
            await database.close();
            database = undefined;
            const gis = new GdalService(isolatedGdalEnvironment(this.environment));
            const converted = await gis.convert(stagedPath, output, {
                sourceLayer: "features",
                sourceCrs: sourceCrsOverride,
                targetLayerName: options.targetLayerName,
                targetCrs: options.targetCrs,
                coordinateOperation: options.coordinateOperation,
                targetEncoding: options.targetEncoding,
                spatialFilter: options.spatialFilter,
                datasetCreationOptions: options.datasetCreationOptions,
                layerCreationOptions: options.layerCreationOptions,
            }, {
                signal: operationOptions.signal,
                onProgress: (percent) => operationOptions.onProgress?.(35 + Math.floor(percent * 0.65)),
            });
            const report = {
                operation: "export",
                status: "completed",
                input: sourceName,
                output: converted.path,
                featureCount: converted.operationReport?.featureCount ?? totalRows,
                successfulFeatures: converted.operationReport?.successfulFeatures ?? processedRows,
                failedFeatures: converted.operationReport?.failedFeatures ?? 0,
                failedSamples: converted.operationReport?.failedSamples ?? [],
                ...(converted.operationReport?.warnings?.length || exportWarnings.length
                    ? { warnings: [...exportWarnings, ...(converted.operationReport?.warnings ?? [])] }
                    : {}),
            };
            if (sridValues.length === 0 && totalRows > 0 && !sourceCrsOverride) {
                report.warnings = [...(report.warnings ?? []), "The spatial column contains only NULL values; the exported layer uses undefined SRS (SRID 0)."];
            }
            return { ...converted, operationReport: report };
        }
        catch (error) {
            if (error instanceof GisOperationError) {
                throw new GisOperationError(error.message, {
                    ...error.report,
                    operation: "export",
                    input: sourceName,
                    output,
                });
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`GIS export from '${sourceName}' failed after staging ${processedRows} rows: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                ...(stagedDatabase ? [stagedDatabase.close()] : []),
                ...(database ? [database.close()] : []),
            ]);
            if (temporaryDirectory)
                await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    async exportGisFromMysqlFamily(table, schema, output, options = {}, operationOptions = {}) {
        if (this.engine !== "mysql" && this.engine !== "mariadb") {
            throw new Error("GIS file export from a database is currently available for MySQL and MariaDB connections.");
        }
        if (!table.trim() || !schema.trim() || !output.trim()) {
            throw new Error("A source database, table, and output path are required for GIS export.");
        }
        let database;
        let stagedDatabase;
        let temporaryDirectory;
        let processedRows = 0;
        const sourceName = `${schema}.${table}`;
        try {
            if (operationOptions.signal?.aborted)
                throw new Error("GIS export was cancelled before staging started.");
            database = this.createDatabaseAdapter();
            const sourceTable = (await database.listTables(schema))
                .find((candidate) => candidate.name === table && candidate.type === "table");
            if (!sourceTable)
                throw new Error(`Source table '${sourceName}' was not found or is not a base table.`);
            const columns = (await database.getTableColumns(table, schema))
                .sort((left, right) => left.ordinalPosition - right.ordinalPosition);
            const geometryColumns = columns.filter(isMySqlFamilySpatialColumn);
            if (geometryColumns.length !== 1) {
                throw new Error(geometryColumns.length === 0
                    ? `Source table '${sourceName}' has no MySQL/MariaDB geometry column.`
                    : `Source table '${sourceName}' has ${geometryColumns.length} geometry columns; export currently requires exactly one.`);
            }
            const geometryColumn = geometryColumns[0];
            const attributeColumns = columns.filter((column) => column.name !== geometryColumn.name);
            const sourceColumnsByName = new Map(attributeColumns.map((column) => [column.name, column]));
            const mappingsBySource = new Map();
            for (const mapping of options.fieldMappings ?? []) {
                if (mappingsBySource.has(mapping.source))
                    throw new Error(`Source field '${mapping.source}' is mapped more than once.`);
                if (!sourceColumnsByName.has(mapping.source))
                    throw new Error(`Source table '${sourceName}' has no attribute field '${mapping.source}'.`);
                if (!mapping.target.trim())
                    throw new Error(`Output field name for '${mapping.source}' cannot be empty.`);
                mappingsBySource.set(mapping.source, mapping);
            }
            const outputAttributes = attributeColumns.map((column) => {
                const mapping = mappingsBySource.get(column.name);
                return { column, target: mapping?.target ?? column.name, targetType: mapping?.targetType };
            });
            const outputAttributeNames = outputAttributes.map((attribute) => attribute.target.toLocaleLowerCase("en-US"));
            if (new Set(outputAttributeNames).size !== outputAttributeNames.length
                || outputAttributeNames.includes(geometryColumn.name.toLocaleLowerCase("en-US"))) {
                throw new Error("Output attribute names are duplicated or collide with the geometry column.");
            }
            const exportWarnings = [];
            if (outputAttributes.some(({ column, targetType }) => targetType === undefined && /^(?:DECIMAL|NUMERIC)\b/i.test(column.dataType))) {
                exportWarnings.push("DECIMAL/NUMERIC attributes are staged as text to preserve their exact decimal values.");
            }
            const qualifiedTable = `${quoteMysqlFamilyIdentifier(schema)}.${quoteMysqlFamilyIdentifier(table)}`;
            const quotedGeometry = quoteMysqlFamilyIdentifier(geometryColumn.name);
            const srsGroups = await database.query(`SELECT ST_SRID(${quotedGeometry}) AS srs_id, COUNT(*) AS feature_count `
                + `FROM ${qualifiedTable} WHERE ${quotedGeometry} IS NOT NULL GROUP BY ST_SRID(${quotedGeometry})`);
            if (srsGroups.rows.length > 1) {
                throw new Error(`Source table '${sourceName}' contains multiple geometry SRIDs; export requires one SRS per layer.`);
            }
            const rawSrsId = srsGroups.rows.length > 0
                ? Number(srsGroups.rows[0].srs_id)
                : 0;
            if (!Number.isSafeInteger(rawSrsId) || rawSrsId < 0) {
                throw new Error(`Source table '${sourceName}' has an invalid geometry SRID.`);
            }
            const srid = rawSrsId;
            let stagedSrsId = srid;
            const sourceCrsOverride = options.sourceCrs?.trim() || undefined;
            const totalResult = await database.query(`SELECT COUNT(*) AS total FROM ${qualifiedTable}`);
            const totalRows = Number(totalResult.rows[0]?.total ?? 0);
            if (!Number.isSafeInteger(totalRows) || totalRows < 0)
                throw new Error("The source table returned an invalid row count.");
            let spatialReference = {
                name: srid === 0 ? "Undefined geographic SRS" : "",
                organization: "NONE",
                organizationCoordsysId: srid,
                definition: "undefined",
                description: "undefined",
            };
            if (srid !== 0) {
                const srsResult = this.engine === "mariadb"
                    ? await database.query(`SELECT CONCAT(AUTH_NAME, ':', AUTH_SRID) AS name, AUTH_NAME AS organization, `
                        + `AUTH_SRID AS organization_coordsys_id, SRTEXT AS definition, '' AS description `
                        + `FROM information_schema.SPATIAL_REF_SYS WHERE SRID = ?`, [srid])
                    : await database.query(`SELECT SRS_NAME AS name, ORGANIZATION AS organization, `
                        + `ORGANIZATION_COORDSYS_ID AS organization_coordsys_id, DEFINITION AS definition, `
                        + `DESCRIPTION AS description FROM information_schema.ST_SPATIAL_REFERENCE_SYSTEMS WHERE SRS_ID = ?`, [srid]);
                const row = srsResult.rows[0];
                if (!row || typeof row.definition !== "string" || !row.definition.trim()) {
                    if (!sourceCrsOverride) {
                        throw new Error(`The database does not expose a CRS definition for SRID ${srid}; specify --source-crs to assign one explicitly.`);
                    }
                    stagedSrsId = 0;
                    exportWarnings.push(`The database has no CRS definition for SRID ${srid}; source CRS '${sourceCrsOverride}' was explicitly assigned for export.`);
                }
                else {
                    const organizationCoordsysId = Number(row.organization_coordsys_id);
                    if (!Number.isSafeInteger(organizationCoordsysId)) {
                        throw new Error(`The database returned an invalid organization CRS id for SRID ${srid}.`);
                    }
                    spatialReference = {
                        name: String(row.name ?? `SRS ${srid}`),
                        organization: String(row.organization ?? "NONE"),
                        organizationCoordsysId,
                        definition: row.definition,
                        description: String(row.description ?? ""),
                    };
                }
            }
            if (sourceCrsOverride && srid === 0) {
                exportWarnings.push(`Source CRS '${sourceCrsOverride}' was explicitly assigned to geometries with SRID 0.`);
            }
            else if (sourceCrsOverride && stagedSrsId !== 0) {
                exportWarnings.push(`Source CRS '${sourceCrsOverride}' overrides the spatial reference definition stored by the database.`);
            }
            const attributeNames = new Set(outputAttributes.map((attribute) => attribute.target.toLocaleLowerCase("en-US")));
            const featureIdColumn = ["fid", "_dbstudio_fid", "dbstudio_fid"]
                .find((candidate) => !attributeNames.has(candidate) && candidate !== geometryColumn.name.toLocaleLowerCase("en-US"))
                ?? `dbstudio_fid_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
            const attributeAliases = attributeColumns.map((_, index) => `__dbstudio_attr_${index}`);
            const wkbAlias = "__dbstudio_geometry_wkb";
            const sridAlias = "__dbstudio_geometry_srid";
            const emptyAlias = "__dbstudio_geometry_empty";
            // MySQL geographic SRS definitions such as EPSG:4326 use latitude/longitude axis order.
            // GDAL and GeoPackage use traditional XY (longitude/latitude); request that order explicitly
            // before staging the WKB so bbox filtering and exported coordinates remain in source XY.
            const geometryWkbExpression = this.engine === "mysql"
                ? `ST_AsWKB(${quotedGeometry}, 'axis-order=long-lat')`
                : `ST_AsWKB(${quotedGeometry})`;
            const selectAttributes = attributeColumns.map((column, index) => `${quoteMysqlFamilyIdentifier(column.name)} AS ${quoteMysqlFamilyIdentifier(attributeAliases[index])}`);
            const selectColumns = [
                ...selectAttributes,
                `${geometryWkbExpression} AS ${quoteMysqlFamilyIdentifier(wkbAlias)}`,
                `ST_SRID(${quotedGeometry}) AS ${quoteMysqlFamilyIdentifier(sridAlias)}`,
                `ST_IsEmpty(${quotedGeometry}) AS ${quoteMysqlFamilyIdentifier(emptyAlias)}`,
            ];
            temporaryDirectory = await mkdtemp(join(tmpdir(), "db-studio-gis-export-"));
            const stagedPath = join(temporaryDirectory, "staged.gpkg");
            stagedDatabase = new SqliteAdapter({ path: stagedPath });
            await stagedDatabase.query("PRAGMA application_id = 1196444487");
            await stagedDatabase.query("PRAGMA user_version = 10300");
            await stagedDatabase.query(`CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL PRIMARY KEY,
        organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL,
        description TEXT
      )`);
            await stagedDatabase.query(`CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY,
        data_type TEXT NOT NULL,
        identifier TEXT UNIQUE,
        description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
        srs_id INTEGER,
        FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      )`);
            await stagedDatabase.query(`CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL,
        m TINYINT NOT NULL,
        PRIMARY KEY (table_name, column_name),
        FOREIGN KEY (table_name) REFERENCES gpkg_contents (table_name),
        FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id)
      )`);
            for (const row of [
                ["Undefined Cartesian SRS", -1, "NONE", -1, "undefined", "undefined"],
                ["Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined"],
            ]) {
                await stagedDatabase.query("INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)", row);
            }
            if (stagedSrsId !== 0) {
                await stagedDatabase.query("INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)", [spatialReference.name, stagedSrsId, spatialReference.organization, spatialReference.organizationCoordsysId, spatialReference.definition, spatialReference.description]);
            }
            await stagedDatabase.query("INSERT INTO gpkg_contents (table_name, data_type, identifier, description, srs_id) VALUES (?, 'features', ?, ?, ?)", ["features", "features", `Exported from ${sourceName}`, stagedSrsId]);
            await stagedDatabase.query("INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, ?, 'GEOMETRY', ?, 2, 2)", ["features", geometryColumn.name, stagedSrsId]);
            const featureColumns = [
                `${gpkgSqliteIdentifier(featureIdColumn)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`,
                `${gpkgSqliteIdentifier(geometryColumn.name)} BLOB`,
                ...outputAttributes.map(({ column, target, targetType }) => `${gpkgSqliteIdentifier(target)} ${mysqlColumnToGeoPackageType(column.dataType, targetType)}`),
            ];
            await stagedDatabase.query(`CREATE TABLE ${gpkgSqliteIdentifier("features")} (${featureColumns.join(", ")})`);
            const querySql = `SELECT ${selectColumns.join(", ")} FROM ${qualifiedTable}`;
            for await (const batch of database.queryStream(querySql, [], { batchSize: 200, signal: operationOptions.signal })) {
                if (operationOptions.signal?.aborted)
                    throw new Error("GIS export was cancelled while reading database rows.");
                if (batch.rows.length === 0)
                    continue;
                const rows = batch.rows.map((row, rowIndex) => {
                    const rawWkb = row[wkbAlias];
                    if (rawWkb === null || rawWkb === undefined) {
                        return [null, ...attributeAliases.map((alias, index) => normalizeMysqlExportCell(row[alias], outputAttributes[index]?.targetType))];
                    }
                    const rowSrid = Number(row[sridAlias]);
                    if (rowSrid !== srid)
                        throw new Error(`Feature ${processedRows + rowIndex + 1} has SRID ${rowSrid}, expected ${srid}.`);
                    const geometry = encodeGeoPackageGeometry(rawWkb, stagedSrsId, Number(row[emptyAlias]) === 1);
                    return [geometry, ...attributeAliases.map((alias, index) => normalizeMysqlExportCell(row[alias], outputAttributes[index]?.targetType))];
                });
                const written = await stagedDatabase.insertRows("features", [geometryColumn.name, ...outputAttributes.map((attribute) => attribute.target)], rows);
                if (written !== rows.length)
                    throw new Error(`GeoPackage staging inserted ${written} of ${rows.length} rows in one batch.`);
                processedRows += written;
                operationOptions.onProgress?.(totalRows > 0 ? Math.min(35, Math.floor((processedRows / totalRows) * 35)) : 35);
            }
            if (processedRows !== totalRows) {
                throw new Error(`Database row count changed during export: counted ${totalRows}, streamed ${processedRows}.`);
            }
            if (srsGroups.rows.length === 0 && totalRows > 0) {
                operationOptions.onProgress?.(35);
            }
            await stagedDatabase.close();
            stagedDatabase = undefined;
            await database.close();
            database = undefined;
            const gis = new GdalService(isolatedGdalEnvironment(this.environment));
            const converted = await gis.convert(stagedPath, output, {
                sourceLayer: "features",
                sourceCrs: sourceCrsOverride,
                targetLayerName: options.targetLayerName,
                targetCrs: options.targetCrs,
                coordinateOperation: options.coordinateOperation,
                targetEncoding: options.targetEncoding,
                spatialFilter: options.spatialFilter,
                datasetCreationOptions: options.datasetCreationOptions,
                layerCreationOptions: options.layerCreationOptions,
            }, {
                signal: operationOptions.signal,
                onProgress: (percent) => operationOptions.onProgress?.(35 + Math.floor(percent * 0.65)),
            });
            const report = {
                operation: "export",
                status: "completed",
                input: sourceName,
                output: converted.path,
                featureCount: converted.operationReport?.featureCount ?? totalRows,
                successfulFeatures: converted.operationReport?.successfulFeatures ?? processedRows,
                failedFeatures: converted.operationReport?.failedFeatures ?? 0,
                failedSamples: converted.operationReport?.failedSamples ?? [],
                ...((converted.operationReport?.warnings?.length || exportWarnings.length)
                    ? { warnings: [...exportWarnings, ...(converted.operationReport?.warnings ?? [])] }
                    : {}),
            };
            if (srsGroups.rows.length === 0 && totalRows > 0 && !sourceCrsOverride) {
                report.warnings = [...(report.warnings ?? []), "The spatial column contains only NULL values; the exported layer uses undefined SRS (SRID 0)."];
            }
            return { ...converted, operationReport: report };
        }
        catch (error) {
            if (error instanceof GisOperationError) {
                throw new GisOperationError(error.message, {
                    ...error.report,
                    operation: "export",
                    input: sourceName,
                    output,
                });
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`GIS export from '${sourceName}' failed after staging ${processedRows} rows: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                ...(stagedDatabase ? [stagedDatabase.close()] : []),
                ...(database ? [database.close()] : []),
            ]);
            if (temporaryDirectory)
                await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    inspectPostgresGisTable(table) {
        this.requirePostgresGis();
        return this.gis.inspectPostgresTable(table, postgresConfigFromEnvironment(this.environment));
    }
    async inspectSqliteGisTable(table) {
        if (this.engine !== "sqlite" || !this.sqliteDatabasePath) {
            throw new Error("SQLite GIS inspection requires an SQLite connection with a database file path.");
        }
        if (!existsSync(this.sqliteDatabasePath))
            throw new Error("SQLite GIS database file does not exist.");
        const dataset = await this.gis.inspect(this.sqliteDatabasePath);
        const layer = dataset.layers.find((candidate) => candidate.name.toLocaleLowerCase("en-US") === table.toLocaleLowerCase("en-US"));
        if (!layer)
            throw new Error(`SQLite GIS table '${table}' was not found.`);
        if ((layer.geometryFields?.length ?? 0) === 0 && !layer.geometryType) {
            throw new Error(`SQLite table '${table}' has no recognized spatial column.`);
        }
        return layer;
    }
    async importGisToSqlServer(input, table, schema, options = {}, operationOptions = {}) {
        if (this.engine !== "sqlserver") {
            throw new Error("Direct GIS file import to a database is currently available for SQL Server connections through this method.");
        }
        if (!input.trim() || !table.trim() || !schema.trim()) {
            throw new Error("A GIS input path, destination schema, and table name are required.");
        }
        const spatialColumnType = options.spatialColumnType ?? "geometry";
        if (spatialColumnType !== "geometry" && spatialColumnType !== "geography") {
            throw new Error("SQL Server spatial column type must be geometry or geography.");
        }
        const mode = options.mode ?? "create";
        if (mode !== "create" && mode !== "append" && mode !== "overwrite") {
            throw new Error("GIS destination mode must be create, append, or overwrite.");
        }
        const geometryColumn = options.geometryColumn?.trim() || "geom";
        const gis = new GdalService(isolatedGdalEnvironment(this.environment));
        const source = await gis.inspect(input, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const sourceLayer = options.sourceLayer === undefined
            ? source.layers.length === 1 ? source.layers[0] : undefined
            : source.layers.find((layer) => layer.name === options.sourceLayer);
        if (!sourceLayer) {
            throw new Error(source.layers.length > 1
                ? "Choose a source layer before importing a multi-layer GIS dataset."
                : `GIS source layer '${options.sourceLayer ?? ""}' was not found.`);
        }
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "db-studio-gis-import-"));
        const stagedPath = join(temporaryDirectory, "staged.gpkg");
        let stagedDatabase;
        let database;
        let createdTable;
        let importedRows = 0;
        let completed = false;
        let existingTable = false;
        let writeTable = table;
        let backupTable;
        let layerSrsId = null;
        let sawUnknownSrs = false;
        let clusteredPrimaryKeyColumn;
        let spatialIndexName;
        const warnings = [];
        try {
            if (operationOptions.signal?.aborted)
                throw new Error("GIS import was cancelled before staging started.");
            const stagedLayerName = options.targetLayerName ?? sourceLayer.name;
            const staged = await gis.convert(input, stagedPath, {
                sourceLayer: sourceLayer.name,
                targetLayerName: stagedLayerName,
                sourceCrs: options.sourceCrs,
                targetCrs: options.targetCrs,
                coordinateOperation: options.coordinateOperation,
                fieldMappings: gisStagingFieldMappings(options.fieldMappings),
                spatialFilter: options.spatialFilter,
                makeValid: options.makeValid,
                sourceEncoding: options.sourceEncoding,
                zipFilenameEncoding: options.zipFilenameEncoding,
                replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
            }, {
                signal: operationOptions.signal,
                onProgress: (percent) => operationOptions.onProgress?.(Math.floor(percent * 0.5)),
            });
            warnings.push(...(staged.operationReport?.warnings ?? []));
            stagedDatabase = new SqliteAdapter({ path: stagedPath, readOnly: true });
            const geometryMetadata = await stagedDatabase.query("SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ?", [stagedLayerName]);
            const geometryInfo = geometryMetadata.rows[0];
            if (!geometryInfo || typeof geometryInfo.column_name !== "string") {
                throw new Error(`Staged GeoPackage layer '${stagedLayerName}' has no geometry column.`);
            }
            const sourceGeometryColumn = geometryInfo.column_name;
            const rawSrsId = Number(geometryInfo.srs_id);
            layerSrsId = Number.isSafeInteger(rawSrsId) && rawSrsId >= 0 ? rawSrsId : null;
            const sourceColumns = (await stagedDatabase.getTableColumns(stagedLayerName))
                .filter((column) => column.name !== sourceGeometryColumn);
            if (sourceColumns.length === 0)
                throw new Error("Staged GIS layer has no importable attribute columns.");
            const importColumns = gisImportColumns(sourceColumns, options.fieldMappings);
            if (new Set(importColumns.map((column) => column.name)).size !== importColumns.length
                || importColumns.some((column) => column.name === geometryColumn)) {
                throw new Error("GIS attributes contain duplicate names or collide with the destination geometry column.");
            }
            if (options.createSpatialIndex) {
                if (layerSrsId === null) {
                    throw new Error("SQL Server spatial-index creation requires a defined GeoPackage SRID (SRID 0 is allowed for geometry columns).");
                }
                const stagedGeometryCounts = await stagedDatabase.query(`SELECT COUNT(*) AS total_count, `
                    + `SUM(CASE WHEN ${gpkgSqliteIdentifier(sourceGeometryColumn)} IS NOT NULL THEN 1 ELSE 0 END) AS non_null_count `
                    + `FROM ${gpkgSqliteIdentifier(stagedLayerName)}`);
                const totalCount = Number(stagedGeometryCounts.rows[0]?.total_count ?? stagedGeometryCounts.rows[0]?.TOTAL_COUNT ?? 0);
                const nonNullCount = Number(stagedGeometryCounts.rows[0]?.non_null_count ?? stagedGeometryCounts.rows[0]?.NON_NULL_COUNT ?? 0);
                if (totalCount === 0 || nonNullCount === 0) {
                    throw new Error("SQL Server spatial-index creation requires at least one non-NULL geometry.");
                }
                const stagedPrimaryKey = sourceColumns.find((column) => column.primaryKey);
                const importedPrimaryKey = stagedPrimaryKey && importColumns.find((column) => column.name === stagedPrimaryKey.name);
                if (!stagedPrimaryKey || importedPrimaryKey?.type !== "integer") {
                    throw new Error("SQL Server spatial-index creation requires the staged GeoPackage integer feature ID as a clustered primary key.");
                }
                clusteredPrimaryKeyColumn = stagedPrimaryKey.name;
            }
            database = this.createDatabaseAdapter();
            existingTable = (await database.listTables(schema)).some((item) => item.name === table && item.type === "table");
            if (mode === "create" && existingTable)
                throw new Error(`Destination table '${schema}.${table}' already exists.`);
            if (mode === "append" && !existingTable)
                throw new Error(`Destination table '${schema}.${table}' does not exist for append mode.`);
            if (mode === "overwrite" && existingTable) {
                const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
                writeTable = `__dbstudio_gis_${suffix}`;
                backupTable = `__dbstudio_old_${suffix}`;
            }
            if (mode === "append" && existingTable) {
                const targetColumns = await database.getTableColumns(table, schema);
                const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
                const missing = [...sourceColumns.map((column) => column.name), geometryColumn]
                    .filter((name) => !targetByName.has(name));
                if (missing.length > 0)
                    throw new Error(`Destination table is missing GIS column(s): ${missing.join(", ")}.`);
                if (!isSqlServerSpatialColumn(targetByName.get(geometryColumn), spatialColumnType)) {
                    throw new Error(`Destination column '${geometryColumn}' must have SQL Server ${spatialColumnType} type.`);
                }
                if (options.createSpatialIndex) {
                    if (!clusteredPrimaryKeyColumn) {
                        throw new Error("SQL Server indexed append requires the staged GeoPackage integer feature ID as a clustered primary key.");
                    }
                    const objectNameSql = "OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2))";
                    const primaryKeys = await database.query("SELECT i.type_desc AS type_desc, c.name AS column_name FROM sys.indexes AS i "
                        + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                        + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                        + `WHERE i.object_id = ${objectNameSql} AND i.is_primary_key = 1 AND i.type = 1`, [schema, table]);
                    const primaryKeyRow = primaryKeys.rows[0];
                    const primaryKeyType = String(databaseRowValue(primaryKeyRow, "type_desc") ?? "").toLocaleUpperCase("en-US");
                    const primaryKeyColumn = String(databaseRowValue(primaryKeyRow, "column_name") ?? "");
                    if (primaryKeys.rows.length !== 1 || primaryKeyType !== "CLUSTERED" || primaryKeyColumn !== clusteredPrimaryKeyColumn) {
                        throw new Error(`SQL Server indexed append requires a single clustered primary key on staged feature ID '${clusteredPrimaryKeyColumn}'.`);
                    }
                    const spatialIndexes = await database.query("SELECT i.name AS index_name, i.type_desc AS type_desc, i.is_disabled AS is_disabled, c.name AS column_name "
                        + "FROM sys.indexes AS i "
                        + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                        + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                        + `WHERE i.object_id = ${objectNameSql} AND i.type = 4 AND i.is_disabled = 0 AND c.name = @p3`, [schema, table, geometryColumn]);
                    const spatialIndexRow = spatialIndexes.rows[0];
                    const spatialIndexType = String(databaseRowValue(spatialIndexRow, "type_desc") ?? "").toLocaleUpperCase("en-US");
                    const spatialIndexColumn = String(databaseRowValue(spatialIndexRow, "column_name") ?? "");
                    if (spatialIndexes.rows.length !== 1 || spatialIndexType !== "SPATIAL" || spatialIndexColumn !== geometryColumn) {
                        throw new Error(`SQL Server indexed append requires exactly one enabled SPATIAL index on '${geometryColumn}'.`);
                    }
                    spatialIndexName = String(databaseRowValue(spatialIndexRow, "index_name") ?? "");
                    if (spatialColumnType === "geometry") {
                        const tessellation = await database.query("SELECT t.bounding_box_xmin AS min_x, t.bounding_box_ymin AS min_y, "
                            + "t.bounding_box_xmax AS max_x, t.bounding_box_ymax AS max_y "
                            + "FROM sys.spatial_index_tessellations AS t "
                            + "INNER JOIN sys.indexes AS i ON i.object_id = t.object_id AND i.index_id = t.index_id "
                            + `WHERE t.object_id = ${objectNameSql} AND i.name = @p3`, [schema, table, spatialIndexName]);
                        if (tessellation.rows.length !== 1) {
                            throw new Error(`SQL Server geometry index '${spatialIndexName}' has no verifiable tessellation metadata.`);
                        }
                        const bounds = tessellation.rows[0];
                        const minX = databaseRowValue(bounds, "min_x");
                        const minY = databaseRowValue(bounds, "min_y");
                        const maxX = databaseRowValue(bounds, "max_x");
                        const maxY = databaseRowValue(bounds, "max_y");
                        const hasBounds = [minX, minY, maxX, maxY].every((value) => value !== null && value !== undefined);
                        if (hasBounds) {
                            const bbox = [minX, minY, maxX, maxY].map(Number);
                            if (!bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
                                throw new Error(`SQL Server geometry index '${spatialIndexName}' has invalid bounding-box metadata.`);
                            }
                            const extent = staged.layers.find((layer) => layer.name === stagedLayerName)?.extent;
                            if (extent && (extent.minX < bbox[0] || extent.minY < bbox[1] || extent.maxX > bbox[2] || extent.maxY > bbox[3])) {
                                throw new Error(`SQL Server indexed append extent is outside the existing geometry index '${spatialIndexName}' bounding box; no rows were written.`);
                            }
                        }
                        else if ([minX, minY, maxX, maxY].some((value) => value !== null && value !== undefined)) {
                            throw new Error(`SQL Server geometry index '${spatialIndexName}' has incomplete bounding-box metadata.`);
                        }
                    }
                }
            }
            else {
                await database.createTable(writeTable, importColumns, schema);
                createdTable = writeTable;
                await database.query(`ALTER TABLE ${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(writeTable)} `
                    + `ADD ${quoteSqlServerIdentifier(geometryColumn)} ${spatialColumnType} NULL`);
            }
            if (spatialColumnType === "geography") {
                if (layerSrsId === null || layerSrsId === 0) {
                    throw new Error("SQL Server geography import requires a known geographic CRS and non-zero SRID. Set the source CRS or transform the input to a supported geographic CRS.");
                }
                const spatialReference = await database.query("SELECT well_known_text AS definition FROM sys.spatial_reference_systems WHERE spatial_reference_id = @p1", [layerSrsId]);
                const definition = spatialReference.rows[0]?.definition;
                if (typeof definition !== "string" || !/\b(?:GEOGCS|GEOGCRS|GEODCRS)\s*\[/i.test(definition)) {
                    throw new Error(`SQL Server geography import requires a geographic CRS supported by sys.spatial_reference_systems; SRID ${layerSrsId} is not available as a geographic CRS. Set or transform to a supported geographic CRS first.`);
                }
            }
            const queryColumns = [...sourceColumns.map((column) => column.name), sourceGeometryColumn];
            const selectSql = `SELECT ${queryColumns.map(gpkgSqliteIdentifier).join(", ")} `
                + `FROM ${gpkgSqliteIdentifier(stagedLayerName)}`;
            for await (const batch of stagedDatabase.queryStream(selectSql, [], {
                signal: operationOptions.signal,
                batchSize: 200,
            })) {
                if (operationOptions.signal?.aborted)
                    throw new Error("GIS import was cancelled.");
                if (batch.rows.length === 0)
                    continue;
                const rows = batch.rows.map((row, rowIndex) => {
                    const geometry = decodeGeoPackageGeometry(row[sourceGeometryColumn]);
                    if (options.createSpatialIndex && geometry && (geometry.srid ?? 0) !== layerSrsId) {
                        throw new Error(`Feature ${importedRows + rowIndex + 1} has SRID ${geometry.srid ?? "unknown"}, expected ${layerSrsId} for spatial-index creation.`);
                    }
                    if (geometry && geometry.srid === null) {
                        sawUnknownSrs = true;
                        geometry.srid = 0;
                    }
                    else if (geometry && layerSrsId !== null && geometry.srid !== layerSrsId) {
                        throw new Error(`Feature ${importedRows + rowIndex + 1} has SRID ${geometry.srid}, expected ${layerSrsId}.`);
                    }
                    if (geometry)
                        geometry.spatialType = spatialColumnType;
                    return [...sourceColumns.map((column) => row[column.name] ?? null), geometry];
                });
                const inserted = await database.insertRows(writeTable, [...sourceColumns.map((column) => column.name), geometryColumn], rows, schema);
                if (inserted !== rows.length)
                    throw new Error(`Destination inserted ${inserted} of ${rows.length} rows in one GIS batch.`);
                importedRows += inserted;
                const stagedFeatureCount = staged.layers.find((layer) => layer.name === stagedLayerName)?.featureCount ?? null;
                operationOptions.onProgress?.(stagedFeatureCount && stagedFeatureCount > 0
                    ? Math.min(100, 50 + Math.floor((importedRows / stagedFeatureCount) * 50))
                    : 100);
            }
            const featureCount = staged.layers.find((layer) => layer.name === stagedLayerName)?.featureCount ?? null;
            if (featureCount !== null && featureCount !== importedRows) {
                throw new Error(`GIS import count mismatch: staged ${featureCount}, inserted ${importedRows}.`);
            }
            if (options.createSpatialIndex && mode === "append") {
                const objectNameSql = "OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2))";
                const spatialIndexStatus = await database.query("SELECT i.type_desc AS type_desc, i.is_disabled AS is_disabled, c.name AS column_name FROM sys.indexes AS i "
                    + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                    + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                    + `WHERE i.object_id = ${objectNameSql} AND i.name = @p3 AND i.type = 4`, [schema, table, spatialIndexName]);
                const spatialIndexRow = spatialIndexStatus.rows[0];
                const spatialIndexType = String(databaseRowValue(spatialIndexRow, "type_desc") ?? "").toLocaleUpperCase("en-US");
                const spatialColumn = String(databaseRowValue(spatialIndexRow, "column_name") ?? "");
                const disabled = Number(databaseRowValue(spatialIndexRow, "is_disabled") ?? 1);
                const primaryKeys = await database.query("SELECT i.type_desc AS type_desc, c.name AS column_name FROM sys.indexes AS i "
                    + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                    + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                    + `WHERE i.object_id = ${objectNameSql} AND i.is_primary_key = 1 AND i.type = 1`, [schema, table]);
                const primaryKeyRow = primaryKeys.rows[0];
                const primaryKeyType = String(databaseRowValue(primaryKeyRow, "type_desc") ?? "").toLocaleUpperCase("en-US");
                const primaryKeyColumn = String(databaseRowValue(primaryKeyRow, "column_name") ?? "");
                if (spatialIndexStatus.rows.length !== 1 || spatialIndexType !== "SPATIAL" || spatialColumn !== geometryColumn
                    || disabled !== 0 || primaryKeys.rows.length !== 1 || primaryKeyType !== "CLUSTERED"
                    || primaryKeyColumn !== clusteredPrimaryKeyColumn) {
                    throw new Error(`SQL Server spatial index '${spatialIndexName}' or its clustered primary key did not remain valid after append.`);
                }
                warnings.push(`SQL Server spatial index '${spatialIndexName}' and clustered primary key '${clusteredPrimaryKeyColumn}' were retained during append.`);
            }
            if (options.createSpatialIndex && mode !== "append") {
                if (!clusteredPrimaryKeyColumn)
                    throw new Error("SQL Server spatial-index creation has no staged feature ID to use as a clustered primary key.");
                const qualifiedSchema = quoteSqlServerIdentifier(schema);
                const qualifiedTable = quoteSqlServerIdentifier(writeTable);
                const objectNameSql = "OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2))";
                const primaryKeyName = `DBSIPK${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
                await database.query(`ALTER TABLE ${qualifiedSchema}.${qualifiedTable} ALTER COLUMN `
                    + `${quoteSqlServerIdentifier(clusteredPrimaryKeyColumn)} BIGINT NOT NULL`);
                await database.query(`ALTER TABLE ${qualifiedSchema}.${qualifiedTable} ADD CONSTRAINT ${quoteSqlServerIdentifier(primaryKeyName)} `
                    + `PRIMARY KEY CLUSTERED (${quoteSqlServerIdentifier(clusteredPrimaryKeyColumn)})`);
                const primaryKeyStatus = await database.query(`SELECT i.type_desc AS type_desc, c.name AS column_name FROM sys.indexes AS i `
                    + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                    + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                    + `WHERE i.object_id = ${objectNameSql} AND i.is_primary_key = 1 AND i.type = 1 AND c.name = @p3`, [schema, writeTable, clusteredPrimaryKeyColumn]);
                if (primaryKeyStatus.rows.length !== 1) {
                    throw new Error(`SQL Server clustered primary key on '${clusteredPrimaryKeyColumn}' did not verify.`);
                }
                spatialIndexName = `DBSI${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
                if (spatialColumnType === "geometry") {
                    const extent = staged.layers.find((layer) => layer.name === stagedLayerName)?.extent;
                    if (!extent || ![extent.minX, extent.minY, extent.maxX, extent.maxY].every(Number.isFinite)
                        || extent.minX > extent.maxX || extent.minY > extent.maxY) {
                        throw new Error("SQL Server geometry spatial-index creation requires a finite XY extent for the staged layer.");
                    }
                    const pad = (minimum, maximum) => Math.max((maximum - minimum) * 0.05, Math.abs((maximum + minimum) / 2) * 1e-12, 1e-7);
                    const minX = extent.minX - pad(extent.minX, extent.maxX);
                    const maxX = extent.maxX + pad(extent.minX, extent.maxX);
                    const minY = extent.minY - pad(extent.minY, extent.maxY);
                    const maxY = extent.maxY + pad(extent.minY, extent.maxY);
                    if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX >= maxX || minY >= maxY) {
                        throw new Error("SQL Server geometry spatial-index bounding box is invalid after applying its margin.");
                    }
                    await database.query(`CREATE SPATIAL INDEX ${quoteSqlServerIdentifier(spatialIndexName)} `
                        + `ON ${qualifiedSchema}.${qualifiedTable} (${quoteSqlServerIdentifier(geometryColumn)}) `
                        + `USING GEOMETRY_GRID WITH (BOUNDING_BOX = (${minX}, ${minY}, ${maxX}, ${maxY}), CELLS_PER_OBJECT = 16)`);
                }
                else {
                    await database.query(`CREATE SPATIAL INDEX ${quoteSqlServerIdentifier(spatialIndexName)} `
                        + `ON ${qualifiedSchema}.${qualifiedTable} (${quoteSqlServerIdentifier(geometryColumn)}) USING GEOGRAPHY_AUTO_GRID`);
                }
                const spatialIndexStatus = await database.query(`SELECT i.type_desc AS type_desc, c.name AS column_name FROM sys.indexes AS i `
                    + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                    + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                    + `WHERE i.object_id = ${objectNameSql} AND i.name = @p3 AND i.type = 4 AND i.is_disabled = 0`, [schema, writeTable, spatialIndexName]);
                const indexRow = spatialIndexStatus.rows[0];
                const indexType = String(indexRow?.type_desc ?? indexRow?.TYPE_DESC ?? "").toUpperCase();
                const indexColumn = String(indexRow?.column_name ?? indexRow?.COLUMN_NAME ?? "");
                if (spatialIndexStatus.rows.length !== 1 || indexType !== "SPATIAL" || indexColumn !== geometryColumn) {
                    throw new Error(`SQL Server spatial index '${spatialIndexName}' did not verify on '${geometryColumn}'.`);
                }
                warnings.push(`SQL Server spatial index '${spatialIndexName}' was created. A clustered primary key was added on staged feature ID '${clusteredPrimaryKeyColumn}'.`);
                if (spatialColumnType === "geometry") {
                    warnings.push("SQL Server geometry spatial-index bounding box uses the staged XY extent with a 5% margin (minimum max(1e-7, 1e-12 times coordinate magnitude)); review it against the data's coordinate system and expected future extent.");
                }
            }
            if (backupTable) {
                const qualifiedExisting = `${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(table)}`;
                const qualifiedStaging = `${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(writeTable)}`;
                await database.query("SET XACT_ABORT ON; BEGIN TRANSACTION; "
                    + "EXEC sys.sp_rename @objname = @p1, @newname = @p2, @objtype = N'OBJECT'; "
                    + "EXEC sys.sp_rename @objname = @p3, @newname = @p4, @objtype = N'OBJECT'; "
                    + "COMMIT TRANSACTION", [qualifiedExisting, backupTable, qualifiedStaging, table]);
                createdTable = undefined;
                if (options.createSpatialIndex && spatialIndexName && clusteredPrimaryKeyColumn) {
                    try {
                        const objectNameSql = "OBJECT_ID(QUOTENAME(@p1) + N'.' + QUOTENAME(@p2))";
                        const renamedSpatialIndex = await database.query("SELECT i.type_desc AS type_desc, i.is_disabled AS is_disabled, c.name AS column_name FROM sys.indexes AS i "
                            + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                            + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                            + `WHERE i.object_id = ${objectNameSql} AND i.name = @p3 AND i.type = 4`, [schema, table, spatialIndexName]);
                        const spatialRow = renamedSpatialIndex.rows[0];
                        const spatialType = String(spatialRow?.type_desc ?? spatialRow?.TYPE_DESC ?? "").toUpperCase();
                        const spatialColumn = String(spatialRow?.column_name ?? spatialRow?.COLUMN_NAME ?? "");
                        const spatialDisabled = Number(spatialRow?.is_disabled ?? spatialRow?.IS_DISABLED ?? 1);
                        const renamedPrimaryKey = await database.query("SELECT i.type_desc AS type_desc, c.name AS column_name FROM sys.indexes AS i "
                            + "INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                            + "INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                            + `WHERE i.object_id = ${objectNameSql} AND i.is_primary_key = 1 AND i.type = 1 AND c.name = @p3`, [schema, table, clusteredPrimaryKeyColumn]);
                        const primaryKeyRow = renamedPrimaryKey.rows[0];
                        const primaryKeyType = String(primaryKeyRow?.type_desc ?? primaryKeyRow?.TYPE_DESC ?? "").toUpperCase();
                        const primaryKeyColumn = String(primaryKeyRow?.column_name ?? primaryKeyRow?.COLUMN_NAME ?? "");
                        if (renamedSpatialIndex.rows.length !== 1 || spatialType !== "SPATIAL"
                            || spatialColumn !== geometryColumn || spatialDisabled !== 0
                            || renamedPrimaryKey.rows.length !== 1 || primaryKeyType !== "CLUSTERED"
                            || primaryKeyColumn !== clusteredPrimaryKeyColumn) {
                            throw new Error(`SQL Server spatial index '${spatialIndexName}' or its clustered primary key did not remain valid on replacement table '${table}'.`);
                        }
                    }
                    catch (error) {
                        try {
                            await database.query("SET XACT_ABORT ON; BEGIN TRANSACTION; "
                                + "EXEC sys.sp_rename @objname = @p1, @newname = @p2, @objtype = N'OBJECT'; "
                                + "EXEC sys.sp_rename @objname = @p3, @newname = @p4, @objtype = N'OBJECT'; "
                                + "COMMIT TRANSACTION", [`${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(table)}`, writeTable,
                                `${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(backupTable)}`, table]);
                            createdTable = writeTable;
                        }
                        catch (rollbackError) {
                            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                            throw new Error(`Spatial-index verification failed after table swap; the previous table remains at '${schema}.${backupTable}', and automatic rollback failed: ${message}`, { cause: error });
                        }
                        throw error;
                    }
                }
                try {
                    await database.query(`DROP TABLE ${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(backupTable)}`);
                }
                catch {
                    warnings.push(`Previous table contents remain in '${schema}.${backupTable}' because the backup table could not be removed.`);
                }
            }
            completed = true;
            if (sawUnknownSrs)
                warnings.push("Source GeoPackage has an undefined SRS id; imported geometry uses SRID 0.");
            return {
                operation: "import",
                status: "completed",
                engine: "sqlserver",
                input,
                output: `${schema}.${table}`,
                schema,
                table,
                geometryColumn,
                spatialColumnType,
                srid: layerSrsId,
                featureCount,
                successfulFeatures: importedRows,
                failedFeatures: featureCount === null ? null : featureCount - importedRows,
                failedSamples: [],
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }
        catch (error) {
            if (createdTable && !completed && database) {
                await database.query(`DROP TABLE IF EXISTS ${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(createdTable)}`).catch(() => undefined);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(importedRows > 0 && mode === "append"
                ? `GIS append stopped after ${importedRows} committed rows: ${message}`
                : `GIS import to '${schema}.${table}' failed: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                ...(stagedDatabase ? [stagedDatabase.close()] : []),
                ...(database ? [database.close()] : []),
            ]);
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    async importGisToOracle(input, table, schema, options = {}, operationOptions = {}) {
        if (this.engine !== "oracle") {
            throw new Error("Direct GIS file import to a database is currently available for Oracle connections through this method.");
        }
        if (options.spatialColumnType !== undefined && options.spatialColumnType !== "geometry") {
            throw new Error("Oracle GIS file import supports SDO_GEOMETRY only.");
        }
        if (!input.trim() || !table.trim() || !schema.trim()) {
            throw new Error("A GIS input path, destination schema, and table name are required.");
        }
        const mode = options.mode ?? "create";
        if (mode !== "create" && mode !== "append" && mode !== "overwrite") {
            throw new Error("GIS destination mode must be create, append, or overwrite.");
        }
        const destinationSchema = options.createSpatialIndex ? schema.toUpperCase() : schema;
        const destinationTable = options.createSpatialIndex ? table.toUpperCase() : table;
        const geometryColumn = options.createSpatialIndex
            ? (options.geometryColumn?.trim() || "geom").toUpperCase()
            : options.geometryColumn?.trim() || "geom";
        if (options.createSpatialIndex) {
            const simpleIdentifier = /^[A-Z][A-Z0-9_]{0,29}$/;
            if (!simpleIdentifier.test(destinationTable)) {
                throw new Error("Oracle spatial-index imports require a simple table name of up to 30 letters, digits, or underscores; the name is stored in uppercase.");
            }
            if (!simpleIdentifier.test(geometryColumn)) {
                throw new Error("Oracle spatial-index imports require a simple geometry-column name of up to 30 letters, digits, or underscores; the name is stored in uppercase.");
            }
        }
        const gis = new GdalService(isolatedGdalEnvironment(this.environment));
        const source = await gis.inspect(input, {
            sourceEncoding: options.sourceEncoding,
            zipFilenameEncoding: options.zipFilenameEncoding,
        });
        const sourceLayer = options.sourceLayer === undefined
            ? source.layers.length === 1 ? source.layers[0] : undefined
            : source.layers.find((layer) => layer.name === options.sourceLayer);
        if (!sourceLayer) {
            throw new Error(source.layers.length > 1
                ? "Choose a source layer before importing a multi-layer GIS dataset."
                : `GIS source layer '${options.sourceLayer ?? ""}' was not found.`);
        }
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "db-studio-oracle-gis-import-"));
        const stagedPath = join(temporaryDirectory, "staged.gpkg");
        let stagedDatabase;
        let database;
        let createdTable;
        let importedRows = 0;
        let completed = false;
        let existingTable = false;
        let writeTable = destinationTable;
        let backupTable;
        let layerSrsId = null;
        let sawUnknownSrs = false;
        let nonNullSpatialRows = 0;
        let spatialMetadataRegistered = false;
        let spatialIndexName;
        let spatialIndexCreatedByImport = false;
        let spatialMetadataTable = destinationTable;
        let existingSpatialIndexVerified = false;
        const warnings = [];
        try {
            if (operationOptions.signal?.aborted)
                throw new Error("GIS import was cancelled before staging started.");
            const stagedLayerName = options.targetLayerName ?? sourceLayer.name;
            const staged = await gis.convert(input, stagedPath, {
                sourceLayer: sourceLayer.name,
                targetLayerName: stagedLayerName,
                sourceCrs: options.sourceCrs,
                targetCrs: options.targetCrs,
                coordinateOperation: options.coordinateOperation,
                fieldMappings: gisStagingFieldMappings(options.fieldMappings),
                spatialFilter: options.spatialFilter,
                makeValid: options.makeValid,
                sourceEncoding: options.sourceEncoding,
                zipFilenameEncoding: options.zipFilenameEncoding,
                replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
            }, {
                signal: operationOptions.signal,
                onProgress: (percent) => operationOptions.onProgress?.(Math.floor(percent * 0.5)),
            });
            warnings.push(...(staged.operationReport?.warnings ?? []));
            stagedDatabase = new SqliteAdapter({ path: stagedPath, readOnly: true });
            const geometryMetadata = await stagedDatabase.query("SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ?", [stagedLayerName]);
            const geometryInfo = geometryMetadata.rows[0];
            if (!geometryInfo || typeof geometryInfo.column_name !== "string") {
                throw new Error(`Staged GeoPackage layer '${stagedLayerName}' has no geometry column.`);
            }
            const sourceGeometryColumn = geometryInfo.column_name;
            const rawSrsId = Number(geometryInfo.srs_id);
            layerSrsId = Number.isSafeInteger(rawSrsId) && rawSrsId >= 0 ? rawSrsId : null;
            if (options.createSpatialIndex) {
                const spatialIndexSource = `SELECT ${gpkgSqliteIdentifier(sourceGeometryColumn)} `
                    + `FROM ${gpkgSqliteIdentifier(stagedLayerName)}`;
                for await (const batch of stagedDatabase.queryStream(spatialIndexSource, [], {
                    signal: operationOptions.signal,
                    batchSize: 500,
                })) {
                    if (operationOptions.signal?.aborted)
                        throw new Error("Oracle spatial-index import was cancelled during geometry preflight.");
                    for (const row of batch.rows) {
                        const geometry = decodeGeoPackageGeometry(row[sourceGeometryColumn]);
                        if (geometry && oracleWkbDimensionCount(geometry.wkb) !== 2) {
                            throw new Error("Oracle spatial-index import currently supports XY geometries only; no destination rows were written.");
                        }
                    }
                }
            }
            const sourceColumns = (await stagedDatabase.getTableColumns(stagedLayerName))
                .filter((column) => column.name !== sourceGeometryColumn);
            if (sourceColumns.length === 0)
                throw new Error("Staged GIS layer has no importable attribute columns.");
            const importColumns = gisImportColumns(sourceColumns, options.fieldMappings);
            if (new Set(importColumns.map((column) => column.name)).size !== importColumns.length
                || importColumns.some((column) => column.name === geometryColumn)) {
                throw new Error("GIS attributes contain duplicate names or collide with the destination geometry column.");
            }
            database = this.createDatabaseAdapter();
            if (options.createSpatialIndex) {
                const sessionUserResult = await database.query("SELECT USER AS \"user_name\" FROM dual");
                const sessionUserRow = sessionUserResult.rows[0];
                const sessionUser = String(sessionUserRow?.user_name ?? sessionUserRow?.USER_NAME ?? "").toUpperCase();
                if (!sessionUser || destinationSchema !== sessionUser) {
                    throw new Error(`Oracle spatial-index creation requires the destination schema to match the connected Oracle user '${sessionUser || "unknown"}'.`);
                }
            }
            existingTable = (await database.listTables(destinationSchema)).some((item) => item.name === destinationTable && item.type === "table");
            if (mode === "create" && existingTable)
                throw new Error(`Destination table '${destinationSchema}.${destinationTable}' already exists.`);
            if (mode === "append" && !existingTable)
                throw new Error(`Destination table '${destinationSchema}.${destinationTable}' does not exist for append mode.`);
            if (mode === "overwrite" && existingTable) {
                const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
                writeTable = `DBSG${suffix}`;
                backupTable = `DBSO${suffix}`;
            }
            const insertColumns = [...sourceColumns.map((column) => column.name), geometryColumn];
            if (mode === "append" && existingTable) {
                const targetColumns = await database.getTableColumns(destinationTable, destinationSchema);
                const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
                const missing = insertColumns.filter((name) => !targetByName.has(name));
                if (missing.length > 0)
                    throw new Error(`Destination table is missing GIS column(s): ${missing.join(", ")}.`);
                if (!isOracleSpatialColumn(targetByName.get(geometryColumn))) {
                    throw new Error(`Destination column '${geometryColumn}' must have Oracle SDO_GEOMETRY type.`);
                }
                if (options.createSpatialIndex) {
                    if (layerSrsId === null || layerSrsId <= 0) {
                        throw new Error("Oracle spatial-index append requires a known positive source SRID.");
                    }
                    const extent = staged.layers.find((layer) => layer.name === stagedLayerName)?.extent;
                    if (!extent || ![extent.minX, extent.minY, extent.maxX, extent.maxY].every(Number.isFinite)
                        || extent.minX > extent.maxX || extent.minY > extent.maxY) {
                        throw new Error("Oracle spatial-index append requires a finite XY extent for the staged layer.");
                    }
                    const metadataResult = await database.query("SELECT m.SRID AS srid, d.SDO_DIMNAME AS dimension_name, d.SDO_LB AS lower_bound, d.SDO_UB AS upper_bound "
                        + "FROM USER_SDO_GEOM_METADATA m, TABLE(m.DIMINFO) d "
                        + "WHERE m.TABLE_NAME = :1 AND m.COLUMN_NAME = :2", [destinationTable, geometryColumn]);
                    if (metadataResult.rows.length !== 2) {
                        throw new Error("Oracle spatial-index append requires an existing valid spatial index with X/Y metadata for the target geometry column.");
                    }
                    const dimensions = new Map(metadataResult.rows.map((row) => {
                        const value = row;
                        return [
                            String(value.dimension_name ?? value.DIMENSION_NAME ?? "").toUpperCase(),
                            {
                                srid: Number(value.srid ?? value.SRID),
                                lower: Number(value.lower_bound ?? value.LOWER_BOUND),
                                upper: Number(value.upper_bound ?? value.UPPER_BOUND),
                            },
                        ];
                    }));
                    const x = dimensions.get("X");
                    const y = dimensions.get("Y");
                    if (dimensions.size !== 2 || !x || !y
                        || x.srid !== layerSrsId || y.srid !== layerSrsId
                        || ![x.lower, x.upper, y.lower, y.upper].every(Number.isFinite)) {
                        throw new Error("Oracle spatial-index append requires matching SRID and finite X/Y bounds in target metadata.");
                    }
                    if (extent.minX < x.lower || extent.maxX > x.upper || extent.minY < y.lower || extent.maxY > y.upper) {
                        throw new Error("Oracle spatial-index append source extent falls outside the existing metadata bounds; no rows were appended.");
                    }
                    const indexResult = await database.query("SELECT s.INDEX_NAME AS index_name, i.DOMIDX_OPSTATUS AS operation_status, i.STATUS AS status "
                        + "FROM USER_SDO_INDEX_INFO s JOIN USER_INDEXES i ON i.INDEX_NAME = s.INDEX_NAME "
                        + "WHERE s.TABLE_NAME = :1 AND s.COLUMN_NAME = :2 AND i.INDEX_TYPE = 'DOMAIN'", [destinationTable, geometryColumn]);
                    if (indexResult.rows.length !== 1) {
                        throw new Error("Oracle spatial-index append requires exactly one existing domain index on the target geometry column.");
                    }
                    const indexRow = indexResult.rows[0];
                    const operationStatus = String(indexRow.operation_status ?? indexRow.OPERATION_STATUS ?? "").toUpperCase();
                    const status = String(indexRow.status ?? indexRow.STATUS ?? "").toUpperCase();
                    if (operationStatus !== "VALID" || status !== "VALID") {
                        throw new Error(`Oracle spatial-index append requires a VALID target index; current status is ${operationStatus || "unknown"}/${status || "unknown"}.`);
                    }
                    spatialIndexName = String(indexRow.index_name ?? indexRow.INDEX_NAME ?? "");
                    existingSpatialIndexVerified = true;
                }
            }
            else {
                await database.createTable(writeTable, importColumns, destinationSchema);
                createdTable = writeTable;
                await database.query(`ALTER TABLE ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(writeTable)} `
                    + `ADD (${quoteOracleIdentifier(geometryColumn)} MDSYS.SDO_GEOMETRY)`);
            }
            const queryColumns = [...sourceColumns.map((column) => column.name), sourceGeometryColumn];
            const selectSql = `SELECT ${queryColumns.map(gpkgSqliteIdentifier).join(", ")} `
                + `FROM ${gpkgSqliteIdentifier(stagedLayerName)}`;
            for await (const batch of stagedDatabase.queryStream(selectSql, [], {
                signal: operationOptions.signal,
                batchSize: 200,
            })) {
                if (operationOptions.signal?.aborted)
                    throw new Error("GIS import was cancelled.");
                if (batch.rows.length === 0)
                    continue;
                const rows = batch.rows.map((row, rowIndex) => {
                    const geometry = decodeGeoPackageGeometry(row[sourceGeometryColumn]);
                    if (geometry) {
                        nonNullSpatialRows += 1;
                        const dimensions = oracleWkbDimensionCount(geometry.wkb);
                        if (dimensions !== 2 && dimensions !== 3 && dimensions !== 4) {
                            throw new Error(`Feature ${importedRows + rowIndex + 1} has invalid or unsupported Oracle SDO WKB dimensions.`);
                        }
                        if (geometry.srid === null || geometry.srid === 0) {
                            sawUnknownSrs = true;
                            geometry.srid = null;
                        }
                        else if (layerSrsId !== null && geometry.srid !== layerSrsId) {
                            throw new Error(`Feature ${importedRows + rowIndex + 1} has SRID ${geometry.srid}, expected ${layerSrsId}.`);
                        }
                    }
                    return [...sourceColumns.map((column) => row[column.name] ?? null), geometry];
                });
                const inserted = await database.insertRows(writeTable, insertColumns, rows, destinationSchema);
                if (inserted !== rows.length)
                    throw new Error(`Destination inserted ${inserted} of ${rows.length} rows in one GIS batch.`);
                importedRows += inserted;
                const stagedFeatureCount = staged.layers.find((layer) => layer.name === stagedLayerName)?.featureCount ?? null;
                operationOptions.onProgress?.(stagedFeatureCount && stagedFeatureCount > 0
                    ? Math.min(100, 50 + Math.floor((importedRows / stagedFeatureCount) * 50))
                    : 100);
            }
            const featureCount = staged.layers.find((layer) => layer.name === stagedLayerName)?.featureCount ?? null;
            if (featureCount !== null && featureCount !== importedRows) {
                throw new Error(`GIS import count mismatch: staged ${featureCount}, inserted ${importedRows}.`);
            }
            if (options.createSpatialIndex && mode !== "append") {
                if (layerSrsId === null || layerSrsId <= 0 || sawUnknownSrs) {
                    throw new Error("Oracle spatial-index creation requires a known positive SRID shared by every non-null geometry.");
                }
                if (nonNullSpatialRows === 0) {
                    throw new Error("Oracle spatial-index creation requires at least one non-null geometry.");
                }
                const extent = staged.layers.find((layer) => layer.name === stagedLayerName)?.extent;
                if (!extent || ![extent.minX, extent.minY, extent.maxX, extent.maxY].every(Number.isFinite)
                    || extent.minX > extent.maxX || extent.minY > extent.maxY) {
                    throw new Error("Oracle spatial-index creation requires a finite XY extent for the staged layer.");
                }
                const pad = (minimum, maximum) => Math.max((maximum - minimum) * 0.05, Math.abs((maximum + minimum) / 2) * 1e-12, 1e-7);
                const minX = extent.minX - pad(extent.minX, extent.maxX);
                const maxX = extent.maxX + pad(extent.minX, extent.maxX);
                const minY = extent.minY - pad(extent.minY, extent.maxY);
                const maxY = extent.maxY + pad(extent.minY, extent.maxY);
                const metadata = await database.query("SELECT COUNT(*) AS total FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME = :1", [writeTable]);
                if (Number(metadata.rows[0]?.TOTAL ?? metadata.rows[0]?.total ?? 0) > 0) {
                    throw new Error(`Oracle spatial metadata for '${writeTable}' already exists; refusing to replace it.`);
                }
                await database.query("INSERT INTO USER_SDO_GEOM_METADATA (TABLE_NAME, COLUMN_NAME, DIMINFO, SRID) "
                    + "VALUES (:1, :2, MDSYS.SDO_DIM_ARRAY(MDSYS.SDO_DIM_ELEMENT('X', :3, :4, 0.05), "
                    + "MDSYS.SDO_DIM_ELEMENT('Y', :5, :6, 0.05)), :7)", [writeTable, geometryColumn, minX, maxX, minY, maxY, layerSrsId]);
                spatialMetadataRegistered = true;
                spatialMetadataTable = writeTable;
                spatialIndexName = `DBSI${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
                spatialIndexCreatedByImport = true;
                await database.query(`CREATE INDEX ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(spatialIndexName)} `
                    + `ON ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(writeTable)} `
                    + `(${quoteOracleIdentifier(geometryColumn)}) INDEXTYPE IS MDSYS.SPATIAL_INDEX`);
                const indexStatus = await database.query("SELECT DOMIDX_OPSTATUS AS \"operation_status\", STATUS AS \"status\" FROM USER_INDEXES WHERE INDEX_NAME = :1 AND TABLE_NAME = :2", [spatialIndexName, writeTable]);
                const indexRow = indexStatus.rows[0];
                const operationStatus = String(indexRow?.operation_status ?? indexRow?.OPERATION_STATUS ?? "").toUpperCase();
                const status = String(indexRow?.status ?? indexRow?.STATUS ?? "").toUpperCase();
                if (operationStatus !== "VALID" || status !== "VALID") {
                    throw new Error(`Oracle spatial index '${spatialIndexName}' is not valid (status ${operationStatus || "unknown"}/${status || "unknown"}).`);
                }
                warnings.push("Oracle SDO metadata uses the staged XY extent with a 5% margin (minimum max(1e-7, 1e-12 times coordinate magnitude)) and a 0.05 tolerance; review tolerance against the source coordinate system and data precision.");
            }
            if (backupTable) {
                const qualifiedExisting = `${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(destinationTable)}`;
                const qualifiedStaging = `${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(writeTable)}`;
                let oldTableRenamed = false;
                let stagingTableRenamed = false;
                try {
                    await database.query(`ALTER TABLE ${qualifiedExisting} RENAME TO ${quoteOracleIdentifier(backupTable)}`);
                    oldTableRenamed = true;
                    await database.query(`ALTER TABLE ${qualifiedStaging} RENAME TO ${quoteOracleIdentifier(destinationTable)}`);
                    stagingTableRenamed = true;
                    spatialMetadataTable = destinationTable;
                    if (options.createSpatialIndex && spatialIndexName) {
                        const movedIndex = await database.query("SELECT DOMIDX_OPSTATUS AS \"operation_status\", STATUS AS \"status\" FROM USER_INDEXES WHERE INDEX_NAME = :1 AND TABLE_NAME = :2", [spatialIndexName, destinationTable]);
                        const movedRow = movedIndex.rows[0];
                        const operationStatus = String(movedRow?.operation_status ?? movedRow?.OPERATION_STATUS ?? "").toUpperCase();
                        const status = String(movedRow?.status ?? movedRow?.STATUS ?? "").toUpperCase();
                        if (operationStatus !== "VALID" || status !== "VALID") {
                            throw new Error(`Oracle spatial index '${spatialIndexName}' did not remain VALID after staging-table rename (status ${operationStatus || "unknown"}/${status || "unknown"}).`);
                        }
                    }
                }
                catch (error) {
                    if (stagingTableRenamed) {
                        await database.query(`ALTER TABLE ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(destinationTable)} RENAME TO ${quoteOracleIdentifier(writeTable)}`).catch(() => undefined);
                        spatialMetadataTable = writeTable;
                        createdTable = writeTable;
                    }
                    if (oldTableRenamed) {
                        await database.query(`ALTER TABLE ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(backupTable)} RENAME TO ${quoteOracleIdentifier(destinationTable)}`).catch(() => undefined);
                    }
                    throw error;
                }
                createdTable = undefined;
                try {
                    await database.query(`DROP TABLE ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(backupTable)} PURGE`);
                }
                catch {
                    warnings.push(`Previous table contents remain in '${destinationSchema}.${backupTable}' because the backup table could not be removed.`);
                }
            }
            completed = true;
            if (sawUnknownSrs)
                warnings.push("Source GeoPackage has an undefined SRS id; Oracle SDO_GEOMETRY uses a NULL SRID.");
            warnings.push(options.createSpatialIndex
                ? existingSpatialIndexVerified
                    ? `Oracle spatial-index append requires XY geometry. Existing spatial metadata and VALID index '${spatialIndexName}' were retained and the index was maintained for this append.`
                    : `Oracle spatial-index import requires XY geometry. Spatial metadata was registered and spatial index '${spatialIndexName}' is VALID.`
                : "Oracle file import accepts XY, XYZ, XYM, and XYZM geometry. Spatial metadata and indexes are not created automatically; export and spatial row transfer remain XY-only.");
            return {
                operation: "import",
                status: "completed",
                engine: "oracle",
                input,
                output: `${destinationSchema}.${destinationTable}`,
                schema: destinationSchema,
                table: destinationTable,
                geometryColumn,
                spatialColumnType: "geometry",
                srid: layerSrsId,
                featureCount,
                successfulFeatures: importedRows,
                failedFeatures: featureCount === null ? null : featureCount - importedRows,
                failedSamples: [],
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }
        catch (error) {
            if (database && !completed && options.createSpatialIndex) {
                if (spatialIndexName && spatialIndexCreatedByImport) {
                    await database.query(`DROP INDEX ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(spatialIndexName)} FORCE`).catch(() => undefined);
                }
                if (spatialMetadataRegistered) {
                    await database.query("DELETE FROM USER_SDO_GEOM_METADATA WHERE TABLE_NAME = :1 AND COLUMN_NAME = :2", [spatialMetadataTable, geometryColumn]).catch(() => undefined);
                }
            }
            if (createdTable && !completed && database) {
                await database.query(`DROP TABLE ${quoteOracleIdentifier(destinationSchema)}.${quoteOracleIdentifier(createdTable)} PURGE`).catch(() => undefined);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(importedRows > 0 && mode === "append"
                ? `GIS append stopped after ${importedRows} committed rows: ${message}`
                : `GIS import to '${destinationSchema}.${destinationTable}' failed: ${message}`, { cause: error });
        }
        finally {
            await Promise.all([
                ...(stagedDatabase ? [stagedDatabase.close()] : []),
                ...(database ? [database.close()] : []),
            ]);
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    importGisToPostgres(input, table, options = {}, operationOptions = {}) {
        this.requirePostgresGis();
        return this.gis.importToPostgres(input, table, postgresConfigFromEnvironment(this.environment), options, operationOptions);
    }
    async importGisToSqlite(input, table, options = {}, operationOptions = {}) {
        if (this.engine !== "sqlite" || !this.sqliteDatabasePath) {
            throw new Error("SQLite GIS import requires an SQLite connection with a database file path.");
        }
        if (!table.trim() || table.includes("."))
            throw new Error("SQLite GIS target must be one table name in the main database.");
        const databaseExists = existsSync(this.sqliteDatabasePath);
        let storage;
        if (databaseExists) {
            const metadata = await this.withDatabase(async (adapter) => adapter.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('geometry_columns', 'gpkg_geometry_columns')"));
            const names = new Set(metadata.rows.map((row) => String(row.name).toLocaleLowerCase("en-US")));
            if (names.has("gpkg_geometry_columns")) {
                if (options.initializeSpatialite)
                    throw new Error("--initialize-spatialite only applies to ordinary SQLite files without spatial metadata.");
                storage = "geopackage";
            }
            else if (names.has("geometry_columns")) {
                if (options.initializeSpatialite)
                    throw new Error("--initialize-spatialite only applies to ordinary SQLite files without spatial metadata.");
                storage = "spatialite";
            }
            else {
                if (!options.initializeSpatialite) {
                    throw new Error("This SQLite file has no SpatiaLite or GeoPackage geometry metadata. Use a new .sqlite/.gpkg file, or explicitly enable SpatiaLite initialization for this ordinary SQLite database.");
                }
                if (path.extname(this.sqliteDatabasePath).toLocaleLowerCase("en-US") === ".gpkg") {
                    throw new Error("--initialize-spatialite cannot convert an ordinary SQLite file with a .gpkg extension.");
                }
                if ((options.mode ?? "create") !== "create") {
                    throw new Error("--initialize-spatialite can only create the first spatial layer; use create mode.");
                }
                const target = await this.withDatabase((adapter) => adapter.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", [table]));
                if (target.rows.length > 0) {
                    throw new Error(`SQLite object '${table}' already exists. SpatiaLite initialization only creates a new spatial table.`);
                }
                storage = "spatialite";
            }
        }
        else {
            if (options.initializeSpatialite)
                throw new Error("--initialize-spatialite applies only to an existing ordinary SQLite database.");
            if ((options.mode ?? "create") === "append")
                throw new Error("Cannot append GIS features because the SQLite database file does not exist.");
            storage = path.extname(this.sqliteDatabasePath).toLocaleLowerCase("en-US") === ".gpkg" ? "geopackage" : "spatialite";
        }
        const report = await this.gis.importToSqlite(input, this.sqliteDatabasePath, table, storage, options, operationOptions);
        return { ...report, engine: "sqlite", storage, table };
    }
    async exportGisFromSqlite(table, output, options = {}, operationOptions = {}) {
        if (this.engine !== "sqlite" || !this.sqliteDatabasePath) {
            throw new Error("SQLite GIS export requires an SQLite connection with a database file path.");
        }
        if (!existsSync(this.sqliteDatabasePath))
            throw new Error("SQLite GIS database file does not exist.");
        const metadata = await this.withDatabase(async (adapter) => adapter.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('geometry_columns', 'gpkg_geometry_columns')"));
        if (metadata.rows.length === 0) {
            throw new Error("This SQLite file has no SpatiaLite or GeoPackage geometry metadata; GIS export requires a spatially enabled SQLite database.");
        }
        return this.gis.exportFromSqlite(this.sqliteDatabasePath, table, output, options, operationOptions);
    }
    exportGisFromPostgres(table, output, options = {}, operationOptions = {}) {
        this.requirePostgresGis();
        return this.gis.exportFromPostgres(table, output, postgresConfigFromEnvironment(this.environment), options, operationOptions);
    }
    getGdalRuntimeStatus() {
        return this.gis.runtimeStatus();
    }
    async withDatabase(action) {
        const adapter = this.createDatabaseAdapter();
        try {
            return await action(adapter);
        }
        finally {
            await adapter.close();
        }
    }
    requirePostgresGis() {
        if (!this.supportsPostgresGis) {
            throw new Error("GIS database import/export currently requires PostgreSQL with PostGIS.");
        }
    }
}
export class MongoDocumentService {
    createAdapter;
    defaultDatabase;
    constructor(createAdapter, defaultDatabase) {
        this.createAdapter = createAdapter;
        this.defaultDatabase = defaultDatabase;
    }
    static fromEnvironment(env = process.env) {
        const config = mongoConfigFromEnvironment(env);
        return MongoDocumentService.fromConfig(config);
    }
    static fromConfig(config) {
        return new MongoDocumentService(() => new MongoDocumentAdapter(config), config.database);
    }
    async testConnection() {
        return this.withMongo((adapter) => adapter.testConnection());
    }
    async listDatabases() {
        return this.withMongo((adapter) => adapter.listDatabases());
    }
    async listCollections(database) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.listCollections(target));
    }
    async listIndexes(database, collection) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.listIndexes(target, collection));
    }
    async createTwoDSphereIndex(database, collection, field = "geometry") {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.createTwoDSphereIndex(target, collection, field));
    }
    async findDocuments(database, collection, options = {}) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.findDocuments(target, collection, options));
    }
    async deleteDocument(database, collection, filterJson) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.deleteDocument(target, collection, filterJson));
    }
    async replaceDocument(database, collection, filterJson, replacementJson) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.replaceDocument(target, collection, filterJson, replacementJson));
    }
    async aggregateDocuments(database, collection, pipeline, limit = 100) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.aggregateDocuments(target, collection, pipeline, limit));
    }
    async importDocuments(database, collection, documents) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.importDocuments(target, collection, documents));
    }
    async importJson(database, collection, content) {
        return this.importDocuments(database, collection, parseMongoJson(content));
    }
    async importGeoJson(database, collection, content, geometryField = "geometry") {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.importGeoJson(target, collection, content, geometryField));
    }
    async exportDocuments(database, collection, options = {}) {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.exportDocuments(target, collection, options));
    }
    async exportGeoJson(database, collection, options = {}, geometryField = "geometry") {
        const target = this.requireDatabase(database);
        return this.withMongo((adapter) => adapter.exportGeoJson(target, collection, options, geometryField));
    }
    requireDatabase(database) {
        const target = database?.trim() || this.defaultDatabase;
        if (!target)
            throw new Error("Set a MongoDB database in the command or connection URI.");
        return target;
    }
    async withMongo(action) {
        const adapter = this.createAdapter();
        try {
            return await action(adapter);
        }
        finally {
            await adapter.close();
        }
    }
}
function importValue(value) {
    if (value === undefined)
        throw new Error("Import data cannot contain undefined values.");
    if (typeof value === "object" && value !== null && !(value instanceof Date) && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
        return JSON.stringify(value);
    }
    return value;
}
function inferImportColumnType(values) {
    const present = values.filter((value) => value !== null && value !== undefined);
    if (present.length === 0)
        return "text";
    if (present.every((value) => value instanceof Uint8Array || value instanceof ArrayBuffer))
        return "binary";
    if (present.every((value) => value instanceof Date && !Number.isNaN(value.getTime()))) {
        return present.every((value) => value.getUTCHours() === 0
            && value.getUTCMinutes() === 0
            && value.getUTCSeconds() === 0
            && value.getUTCMilliseconds() === 0) ? "date" : "datetime";
    }
    if (present.every((value) => typeof value === "boolean"))
        return "boolean";
    if (present.every((value) => typeof value === "number" && Number.isFinite(value))) {
        return present.every((value) => Number.isSafeInteger(value)) ? "integer" : "real";
    }
    if (present.every((value) => typeof value === "object"))
        return "json";
    return "text";
}
function isPostgresTextDataType(dataType) {
    return /^(?:TEXT|CHARACTER VARYING|VARCHAR|CHARACTER|CHAR|BPCHAR)(?:\s*\(\s*\d+\s*\))?$/.test(dataType);
}
function isOracleLobDataType(dataType) {
    return /^(?:BLOB|CLOB|NCLOB)$/.test(dataType);
}
function isSqlServerLargeObjectColumn(column) {
    const dataType = column.dataType.trim().toUpperCase();
    return /^(?:TEXT|NTEXT|IMAGE)$/.test(dataType)
        || column.maximumLength === -1 && /^(?:VARCHAR|NVARCHAR|VARBINARY)$/.test(dataType);
}
function lobTransferEncoding(sourceEngine, sourceColumn, targetEngine, targetColumn) {
    const sourceType = sourceColumn.dataType.trim().toUpperCase();
    const targetType = targetColumn.dataType.trim().toUpperCase();
    if (sourceEngine === "sqlserver" && isSqlServerLargeObjectColumn(sourceColumn)) {
        const binarySource = /^(?:BINARY|VARBINARY|IMAGE)$/.test(sourceType);
        const textSource = /^(?:CHAR|NCHAR|VARCHAR|NVARCHAR|TEXT|NTEXT)$/.test(sourceType);
        if (binarySource && targetEngine === "oracle" && targetType === "BLOB")
            return "buffer";
        if (binarySource && targetEngine === "postgres" && targetType === "BYTEA")
            return "buffer";
        if (binarySource && targetEngine === "sqlserver" && targetType === "VARBINARY" && targetColumn.maximumLength === -1)
            return "buffer";
        if (binarySource && ["mysql", "mariadb"].includes(targetEngine) && targetType === "LONGBLOB")
            return "buffer";
        if (textSource && targetEngine === "oracle" && ["CLOB", "NCLOB"].includes(targetType))
            return "utf8";
        if (textSource && targetEngine === "postgres" && isPostgresTextDataType(targetType))
            return "utf8";
        if (textSource && targetEngine === "sqlserver" && targetType === "NVARCHAR" && targetColumn.maximumLength === -1)
            return "utf8";
        if (textSource && ["mysql", "mariadb"].includes(targetEngine) && targetType === "LONGTEXT")
            return "utf8";
    }
    if (sourceEngine === "oracle")
        return oracleLobTransferEncoding(sourceType, targetType, targetEngine, targetColumn.maximumLength);
    if (sourceEngine === "postgres") {
        if (sourceType === "BYTEA" && targetType === "BLOB")
            return "buffer";
        if (isPostgresTextDataType(sourceType) && ["CLOB", "NCLOB"].includes(targetType))
            return "utf8";
    }
    return undefined;
}
function oracleLobTransferEncoding(sourceType, targetType, targetEngine, targetMaximumLength) {
    if (sourceType === "BLOB" && (targetType === "BLOB" || targetType === "BYTEA"
        || targetEngine === "sqlserver" && targetType === "VARBINARY" && targetMaximumLength === -1))
        return "buffer";
    if (sourceType === "BLOB" && ["mysql", "mariadb"].includes(targetEngine) && targetType === "LONGBLOB")
        return "buffer";
    if (sourceType === "BYTEA" && targetType === "BLOB")
        return "buffer";
    if ((sourceType === "CLOB" || sourceType === "NCLOB")
        && (targetType === "CLOB" || targetType === "NCLOB" || isPostgresTextDataType(targetType)
            || targetEngine === "sqlserver" && targetType === "NVARCHAR" && targetMaximumLength === -1))
        return "utf8";
    if ((sourceType === "CLOB" || sourceType === "NCLOB")
        && ["mysql", "mariadb"].includes(targetEngine) && targetType === "LONGTEXT")
        return "utf8";
    return undefined;
}
function transferValueKind(value) {
    if (value === null)
        return "null";
    if (value === undefined)
        return "undefined";
    if (value instanceof Date)
        return "date";
    if (value instanceof Uint8Array || value instanceof ArrayBuffer)
        return "binary";
    if (Array.isArray(value))
        return "array";
    return typeof value;
}
//# sourceMappingURL=index.js.map