import type { GisAttributePreview, GisDatasetInfo, GisFieldMapping, GisGeometryValidationReport, GisInputOptions, GisLayerInfo, GisOperationReport, GisSpatialExtent } from "@db-studio/gis";
import type { ColumnInfo, DatabaseEngine, QueryResult, TableInfo, TableRowChange } from "@db-studio/shared";
import type { QueryExecutionRecord, QueryFavorite, QueryHistorySnapshot } from "@db-studio/shared";
import type { MongoAssistantContext, MongoAssistantResult, MongoAssistantTask, MongoQueryMode, PublicAiModelSettings, SqlAssistantRequest, SqlAssistantResponse } from "@db-studio/ai";

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password: string;
  uri?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  path?: string;
  ssh?: SshConnectionDraft;
}

export interface SshConnectionDraft {
  enabled: boolean;
  host?: string;
  port?: number;
  username?: string;
  authentication?: "password" | "privateKey";
  hostFingerprint?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshConnectionMetadata {
  host: string;
  port: number;
  username: string;
  authentication: "password" | "privateKey";
  hostFingerprint: string;
  hasCredentials: boolean;
  hasPassphrase: boolean;
}

export interface DbStudioApi {
  queryHistory: {
    list(): Promise<QueryHistorySnapshot>;
    record(entry: QueryExecutionRecord): Promise<QueryHistorySnapshot>;
    clear(connectionId?: string): Promise<QueryHistorySnapshot>;
    saveFavorite(favorite: QueryFavorite): Promise<QueryHistorySnapshot>;
    removeFavorite(id: string): Promise<QueryHistorySnapshot>;
  };
  ai: {
    settings(): Promise<PublicAiModelSettings>;
    saveSettings(settings: unknown): Promise<PublicAiModelSettings>;
    testModel(kind: "chat" | "embedding" | "rerank", profile: Record<string, unknown>): Promise<{ ok: true; message: string; dimensions?: number }>;
    buildSchemaIndex(connectionId: string, schema: string, selectedTables: string[], requestId: string): Promise<{ tableCount: number; dimensions: number; schema: string }>;
    clearSchemaIndex(connectionId: string, schema: string): Promise<{ removedCount: number }>;
    run(request: {
      requestId: string;
      connectionId: string;
      modelId?: string;
      task: SqlAssistantRequest["task"];
      request: string;
      schema?: string;
      schemas?: string[];
      selectedTables?: string[];
      includeSchema: boolean;
      refreshSchema?: boolean;
      selectedSql?: string;
      executionPlan?: string;
      error?: { code?: string; message: string; position?: number };
    }): Promise<SqlAssistantResponse>;
    runMongo(request: {
      requestId: string;
      connectionId: string;
      database: string;
      collection: string;
      modelId?: string;
      task: MongoAssistantTask;
      mode: MongoQueryMode;
      request: string;
      includeContext: boolean;
      schemaHint?: string;
      query?: MongoAssistantContext["query"];
      error?: MongoAssistantContext["error"];
    }): Promise<MongoAssistantResult>;
    cancel(requestId: string): void;
    onDelta(listener: (event: { requestId: string; delta: string }) => void): () => void;
  };
  connections: {
    list(): Promise<Array<Omit<ConnectionProfile, "password" | "uri" | "ssh"> & { hasPassword: boolean; hasUri: boolean; endpoint?: string; ssh?: SshConnectionMetadata }>>;
    backupAndResetUnreadable(): Promise<{ backupPath: string }>;
    save(connection: ConnectionProfile): Promise<void>;
    remove(id: string): Promise<void>;
    test(id: string): Promise<{ database: string; serverVersion: string }>;
  };
  database: {
    databases(id: string): Promise<string[]>;
    schemas(id: string): Promise<string[]>;
    tables(id: string, schema?: string): Promise<TableInfo[]>;
    columns(id: string, table: string, schema?: string): Promise<ColumnInfo[]>;
    query(id: string, sql: string, parameters?: unknown[]): Promise<QueryResult>;
    updateRows(id: string, input: { schema: string; table: string; changes: TableRowChange[] }): Promise<QueryResult[]>;
    exportTable(id: string, table: string, schema?: string): Promise<{ path: string; format: "csv" | "json" | "xlsx"; rowCount: number; columnCount: number } | null>;
    importTable(id: string, table: string, schema?: string): Promise<{ path: string; insertedRows: number; columns: string[] } | null>;
    importTableToNewTable(id: string, table: string, schema?: string): Promise<{ path: string; table: string; insertedRows: number; columns: string[]; inferredTypes: Record<string, string> } | null>;
    transferTable(id: string, input: {
      targetConnectionId: string;
      sourceTable: string;
      sourceSchema?: string;
      targetTable: string;
      targetSchema?: string;
      pageSize?: number;
      columnMappings?: Array<{ sourceColumn: string; targetColumn: string }>;
    }): Promise<{ sourceRows: number; insertedRows: number; columns: string[] }>;
  };
  mongo: {
    databases(id: string): Promise<string[]>;
    collections(id: string, database: string): Promise<string[]>;
    indexes(id: string, database: string, collection: string): Promise<Array<{
      name: string;
      key: Record<string, unknown>;
      unique: boolean;
      sparse: boolean;
      twoDSphere: boolean;
      expireAfterSeconds?: number;
      hidden?: boolean;
      partialFilterExpression?: Record<string, unknown>;
    }>>;
    createTwoDSphereIndex(id: string, database: string, collection: string, field: string): Promise<string>;
    deleteDocument(id: string, database: string, collection: string, filterJson: string): Promise<number>;
    replaceDocument(id: string, database: string, collection: string, filterJson: string, replacementJson: string): Promise<number>;
    find(id: string, database: string, collection: string, options: {
      filter?: Record<string, unknown>;
      projection?: Record<string, unknown>;
      sort?: Record<string, unknown>;
      skip?: number;
      limit?: number;
    }): Promise<string>;
    aggregate(id: string, database: string, collection: string, pipeline: Array<Record<string, unknown>>, limit: number): Promise<string>;
    import(id: string, database: string, collection: string): Promise<{ path: string; insertedCount: number } | null>;
    export(id: string, database: string, collection: string, filter?: Record<string, unknown>): Promise<{ path: string; documentCount: number } | null>;
    importGeoJson(id: string, database: string, collection: string, geometryField: string): Promise<{ path: string; insertedCount: number } | null>;
    exportGeoJson(id: string, database: string, collection: string, geometryField: string, filter?: Record<string, unknown>): Promise<{ path: string; featureCount: number } | null>;
  };
  gis: {
    inspect(file: string, options?: GisInputOptions): Promise<GisDatasetInfo>;
    preview(file: string, options?: GisInputOptions & { sourceLayer?: string; limit?: number }): Promise<GisAttributePreview>;
    validate(file: string, options?: GisInputOptions & { sourceLayer?: string; sampleLimit?: number }): Promise<GisGeometryValidationReport>;
    inspectTable(id: string, table: string): Promise<GisLayerInfo>;
    import(id: string, file: string, table: string, options: GisInputOptions & { mode?: "create" | "append" | "overwrite"; sourceLayer?: string; sourceCrs?: string; targetCrs?: string; coordinateOperation?: string; fieldMappings?: GisFieldMapping[]; spatialFilter?: GisSpatialExtent; makeValid?: boolean; replaceIncompleteUtf8Tails?: boolean; createSpatialIndex?: boolean; initializeSpatialite?: boolean; spatialColumnType?: "geometry" | "geography" }, operationId: string): Promise<{ ok: true; report: GisOperationReport } | { ok: false; error: string; report: GisOperationReport }>;
    export(id: string, table: string, output: string, options: { targetLayerName?: string; targetCrs?: string; coordinateOperation?: string; targetEncoding?: string; fieldMappings?: GisFieldMapping[]; datasetCreationOptions?: string[]; layerCreationOptions?: string[] }, operationId: string): Promise<{ ok: true; dataset: GisDatasetInfo } | { ok: false; error: string; report: GisOperationReport }>;
    cancel(operationId: string): void;
    onProgress(listener: (event: { operationId: string; percent: number }) => void): () => void;
  };
  files: {
    openSql(): Promise<{ path: string; content: string } | null>;
    saveSql(initial: string | null, content: string): Promise<string | null>;
    saveResult(format: "csv" | "json", content: string): Promise<string | null>;
    openVector(): Promise<string | null>;
    saveVector(): Promise<string | null>;
  };
}

declare global {
  interface Window { dbStudio: DbStudioApi }
}

export {};