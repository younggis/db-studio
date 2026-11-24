import { type DatabaseAdapter, type ImportColumnType, MongoDocumentAdapter, type MongoIndexMetadata, type PostgresConnectionConfig, type MySqlConnectionConfig, type SqliteConnectionConfig, type SqlServerConnectionConfig, type OracleConnectionConfig, type MongoConnectionConfig, type MongoDocument, type MongoFindOptions } from "@db-studio/database";
import { type ColumnInfo, type DatabaseEngine, type QueryResult, type QueryResultBatch, type QueryStreamOptions, type TableForeignKeyInfo, type TableInfo, type TableRowChange, type TabularData } from "@db-studio/shared";
import { GdalService, type GdalOperationOptions, type GdalRuntimeStatus, type GisAttributePreview, type GisCrsOptions, type GisConversionOptions, type GisDatasetInfo, type GisExportOptions, type GisFieldMapping, type GisInputOptions, type GisLayerInfo, type GisOperationReport, type GisSpatialExtent } from "@db-studio/gis";
export { GisOperationError } from "@db-studio/gis";
export { summarizeLayerHealth, type LayerHealthReport } from "./layer-health.js";
export { diagnoseSpatialIndex, type SpatialIndexDiagnostic } from "./spatial-index-diagnostic.js";
export { OperationRegistry, type OperationHandle, type OperationType, type OperationRegistryOptions } from "./operation-handle.js";
export { parseGisDriverCreationOptions } from "@db-studio/gis";
export type { GdalOperationOptions, GisAttributePreview, GisCrsOptions, GisConversionOptions, GisDriverCreationOption, GisExportOptions, GisInputOptions, GisOperationReport, GisOutputFormatOptions, GisSpatialExtent } from "@db-studio/gis";
export interface GisSpatialDatabaseImportOptions extends GisCrsOptions, GisInputOptions {
    mode?: "create" | "append" | "overwrite";
    sourceLayer?: string;
    targetLayerName?: string;
    geometryColumn?: string;
    spatialColumnType?: "geometry" | "geography";
    fieldMappings?: GisFieldMapping[];
    spatialFilter?: GisSpatialExtent;
    makeValid?: boolean;
    replaceIncompleteUtf8Tails?: boolean;
    createSpatialIndex?: boolean;
}
export interface GisSpatialDatabaseImportReport extends GisOperationReport {
    engine: "mysql" | "mariadb" | "sqlserver" | "oracle";
    schema: string;
    table: string;
    geometryColumn: string;
    spatialColumnType?: "geometry" | "geography";
    srid: number | null;
}
export interface GisSqliteImportReport extends GisOperationReport {
    engine: "sqlite";
    storage: "spatialite" | "geopackage";
    table: string;
}
export { buildMongoGeoFilter, geoJsonToMongoDocuments, mongoDocumentsToGeoJson, parseMongoEjson, stringifyMongoJson } from "@db-studio/database";
export declare class CoreService {
    private readonly createDatabaseAdapter;
    private readonly environment;
    private readonly supportsPostgresGis;
    private readonly engine?;
    private readonly sqliteDatabasePath?;
    private readonly gis;
    constructor(createDatabaseAdapter: () => DatabaseAdapter, environment?: NodeJS.ProcessEnv, supportsPostgresGis?: boolean, engine?: DatabaseEngine | undefined, sqliteDatabasePath?: string | undefined);
    static fromEnvironment(env?: NodeJS.ProcessEnv): CoreService;
    static fromPostgresConfig(config: PostgresConnectionConfig): CoreService;
    static fromSqliteConfig(config: SqliteConnectionConfig): CoreService;
    static fromMySqlConfig(config: MySqlConnectionConfig): CoreService;
    static fromMariaDbConfig(config: MySqlConnectionConfig): CoreService;
    static fromSqlServerConfig(config: SqlServerConnectionConfig): CoreService;
    static fromOracleConfig(config: OracleConnectionConfig): CoreService;
    static gdalRuntimeStatus(env?: NodeJS.ProcessEnv): GdalRuntimeStatus;
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    testPostgresConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    query(sql: string, parameters?: unknown[]): Promise<QueryResult>;
    queryStream(sql: string, parameters?: unknown[], options?: QueryStreamOptions): AsyncGenerator<QueryResultBatch>;
    updateTableRows(engine: DatabaseEngine, schema: string, table: string, changes: TableRowChange[]): Promise<QueryResult[]>;
    queryPostgres(sql: string, parameters?: unknown[]): Promise<QueryResult>;
    listDatabases(): Promise<string[]>;
    listPostgresDatabases(): Promise<string[]>;
    listSchemas(): Promise<string[]>;
    listPostgresSchemas(): Promise<string[]>;
    listTables(schema?: string): Promise<TableInfo[]>;
    getTableColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    getTableForeignKeys(table: string, schema?: string): Promise<TableForeignKeyInfo[]>;
    exportTable(table: string, schema?: string): Promise<QueryResult>;
    exportTableWorkbook(table: string, schema?: string): Promise<Uint8Array>;
    importRows(table: string, data: TabularData, schema?: string): Promise<{
        insertedRows: number;
        columns: string[];
    }>;
    createTableFromRows(table: string, data: TabularData, schema?: string): Promise<{
        table: string;
        insertedRows: number;
        columns: string[];
        inferredTypes: Record<string, ImportColumnType>;
    }>;
    transferTableRows(destination: CoreService, options: {
        sourceTable: string;
        sourceSchema?: string;
        targetTable: string;
        targetSchema?: string;
        pageSize?: number;
        columnMappings?: Array<{
            sourceColumn: string;
            targetColumn: string;
        }>;
        /** Retag geometry as geography (or back). Requires a valid geographic SRID; the destination engine still enforces CRS rules. */
        allowSpatialTypeConversion?: boolean;
    }): Promise<{
        sourceRows: number;
        insertedRows: number;
        columns: string[];
    }>;
    importTableFile(table: string, content: string, format: "csv" | "json", schema?: string, options?: {
        nullValue?: string;
    }): Promise<{
        insertedRows: number;
        columns: string[];
    }>;
    importTableWorkbook(table: string, content: Uint8Array, schema?: string): Promise<{
        insertedRows: number;
        columns: string[];
    }>;
    importWorkbookToNewTable(table: string, content: Uint8Array, schema?: string): Promise<{
        table: string;
        insertedRows: number;
        columns: string[];
        inferredTypes: Record<string, ImportColumnType>;
    }>;
    listPostgresTables(schema?: string): Promise<TableInfo[]>;
    inspectGisFile(filePath: string, options?: GisInputOptions): Promise<GisDatasetInfo>;
    checkGisGeometry(filePath: string, options?: GisInputOptions & {
        sourceLayer?: string;
        sampleLimit?: number;
    }): ReturnType<GdalService["checkGeometry"]>;
    previewGisAttributes(filePath: string, options?: GisInputOptions & {
        sourceLayer?: string;
        limit?: number;
    }): Promise<GisAttributePreview>;
    convertGisFile(input: string, output: string, options?: GisConversionOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    importGisToMysqlFamily(input: string, table: string, schema: string, options?: GisSpatialDatabaseImportOptions, operationOptions?: GdalOperationOptions): Promise<GisSpatialDatabaseImportReport>;
    exportGisFromSqlServer(table: string, schema: string, output: string, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    exportGisFromOracle(table: string, schema: string, output: string, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    exportGisFromMysqlFamily(table: string, schema: string, output: string, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    inspectPostgresGisTable(table: string): Promise<GisLayerInfo>;
    inspectSqliteGisTable(table: string): Promise<GisLayerInfo>;
    importGisToSqlServer(input: string, table: string, schema: string, options?: GisSpatialDatabaseImportOptions, operationOptions?: GdalOperationOptions): Promise<GisSpatialDatabaseImportReport>;
    importGisToOracle(input: string, table: string, schema: string, options?: GisSpatialDatabaseImportOptions, operationOptions?: GdalOperationOptions): Promise<GisSpatialDatabaseImportReport>;
    importGisToPostgres(input: string, table: string, options?: {
        mode?: "create" | "append" | "overwrite";
        sourceLayer?: string;
        sourceCrs?: string;
        targetCrs?: string;
        coordinateOperation?: string;
        fieldMappings?: GisFieldMapping[];
        sourceEncoding?: string;
        zipFilenameEncoding?: string;
        replaceIncompleteUtf8Tails?: boolean;
        spatialFilter?: GisSpatialExtent;
        makeValid?: boolean;
    }, operationOptions?: GdalOperationOptions): Promise<GisOperationReport>;
    importGisToSqlite(input: string, table: string, options?: {
        mode?: "create" | "append" | "overwrite";
        sourceLayer?: string;
        sourceCrs?: string;
        targetCrs?: string;
        coordinateOperation?: string;
        fieldMappings?: GisFieldMapping[];
        sourceEncoding?: string;
        zipFilenameEncoding?: string;
        replaceIncompleteUtf8Tails?: boolean;
        spatialFilter?: GisSpatialExtent;
        makeValid?: boolean;
        createSpatialIndex?: boolean;
        initializeSpatialite?: boolean;
    }, operationOptions?: GdalOperationOptions): Promise<GisSqliteImportReport>;
    exportGisFromSqlite(table: string, output: string, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    exportGisFromPostgres(table: string, output: string, options?: GisExportOptions, operationOptions?: GdalOperationOptions): Promise<GisDatasetInfo>;
    getGdalRuntimeStatus(): GdalRuntimeStatus;
    private withDatabase;
    private requirePostgresGis;
}
export declare class MongoDocumentService {
    private readonly createAdapter;
    private readonly defaultDatabase?;
    constructor(createAdapter: () => MongoDocumentAdapter, defaultDatabase?: string | undefined);
    static fromEnvironment(env?: NodeJS.ProcessEnv): MongoDocumentService;
    static fromConfig(config: MongoConnectionConfig): MongoDocumentService;
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    listDatabases(): Promise<string[]>;
    listCollections(database?: string): Promise<string[]>;
    listIndexes(database: string | undefined, collection: string): Promise<MongoIndexMetadata[]>;
    createTwoDSphereIndex(database: string | undefined, collection: string, field?: string): Promise<string>;
    findDocuments(database: string | undefined, collection: string, options?: MongoFindOptions): Promise<MongoDocument[]>;
    aggregateDocuments(database: string | undefined, collection: string, pipeline: MongoDocument[], limit?: number): Promise<MongoDocument[]>;
    importDocuments(database: string | undefined, collection: string, documents: MongoDocument[]): Promise<number>;
    importJson(database: string | undefined, collection: string, content: string): Promise<number>;
    importGeoJson(database: string | undefined, collection: string, content: string, geometryField?: string): Promise<number>;
    exportDocuments(database: string | undefined, collection: string, options?: MongoFindOptions): Promise<MongoDocument[]>;
    exportGeoJson(database: string | undefined, collection: string, options?: MongoFindOptions, geometryField?: string): Promise<MongoDocument>;
    private requireDatabase;
    private withMongo;
}
//# sourceMappingURL=index.d.ts.map