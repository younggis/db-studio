export type MongoDocument = Record<string, unknown>;
export interface MongoConnectionConfig {
    uri: string;
    database?: string;
    connectTimeoutMS?: number;
}
export interface MongoFindOptions {
    filter?: MongoDocument;
    projection?: MongoDocument;
    sort?: MongoDocument;
    skip?: number;
    limit?: number;
}
export interface MongoIndexMetadata {
    name: string;
    key: Record<string, unknown>;
    unique: boolean;
    sparse: boolean;
    twoDSphere: boolean;
    expireAfterSeconds?: number;
    hidden?: boolean;
    partialFilterExpression?: MongoDocument;
}
export type MongoGeoRelation = "within" | "intersects";
export declare function buildMongoGeoFilter(field: string, geometry: unknown, relation?: MongoGeoRelation): MongoDocument;
export declare function geoJsonToMongoDocuments(value: unknown, geometryField?: string): MongoDocument[];
export declare function mongoDocumentsToGeoJson(documents: MongoDocument[], geometryField?: string): MongoDocument;
export declare function mongoConfigFromEnvironment(env?: NodeJS.ProcessEnv): MongoConnectionConfig;
export declare class MongoDocumentAdapter {
    private readonly config;
    private readonly client;
    private connection?;
    constructor(config: MongoConnectionConfig);
    testConnection(): Promise<{
        database: string;
        serverVersion: string;
    }>;
    listDatabases(): Promise<string[]>;
    listCollections(database?: string): Promise<string[]>;
    listIndexes(database: string, collection: string): Promise<MongoIndexMetadata[]>;
    createTwoDSphereIndex(database: string, collection: string, field?: string): Promise<string>;
    findDocuments(database: string, collection: string, options?: MongoFindOptions): Promise<MongoDocument[]>;
    aggregateDocuments(database: string, collection: string, pipeline: MongoDocument[], limit?: number): Promise<MongoDocument[]>;
    importDocuments(database: string, collection: string, documents: MongoDocument[]): Promise<number>;
    importGeoJson(database: string, collection: string, content: string, geometryField?: string): Promise<number>;
    exportDocuments(database: string, collection: string, options?: MongoFindOptions): Promise<MongoDocument[]>;
    exportGeoJson(database: string, collection: string, options?: MongoFindOptions, geometryField?: string): Promise<MongoDocument>;
    close(): Promise<void>;
    private connect;
    private requireDatabase;
}
export declare function parseMongoJson(content: string): MongoDocument[];
export declare function parseMongoEjson(content: string, label?: string): unknown;
export declare function stringifyMongoJson(value: unknown, pretty?: boolean): string;
//# sourceMappingURL=mongodb.d.ts.map