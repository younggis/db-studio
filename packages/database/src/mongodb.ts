import { BSON, MongoClient, type Document, type FindOptions, type Sort } from "mongodb";

const { EJSON } = BSON;

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

export function buildMongoGeoFilter(
  field: string,
  geometry: unknown,
  relation: MongoGeoRelation = "within",
): MongoDocument {
  validateMongoFieldPath(field);
  const value = isDocument(geometry) && geometry.type === "Feature" ? geometry.geometry : geometry;
  if (!isGeoJsonGeometry(value)) throw new Error("Spatial query geometry must be a GeoJSON Geometry or Feature.");
  return { [field]: { [relation === "within" ? "$geoWithin" : "$geoIntersects"]: { $geometry: value } } };
}

export function geoJsonToMongoDocuments(value: unknown, geometryField = "geometry"): MongoDocument[] {
  validateMongoFieldPath(geometryField);
  const features = isDocument(value) && value.type === "FeatureCollection"
    ? value.features
    : [value];
  if (!Array.isArray(features)) throw new Error("GeoJSON FeatureCollection must contain a features array.");
  return features.map((feature) => {
    if (isDocument(feature) && feature.type === "Feature") {
      if (feature.geometry !== null && !isGeoJsonGeometry(feature.geometry)) {
        throw new Error("GeoJSON Feature geometry is invalid.");
      }
      const properties = feature.properties === null ? {} : feature.properties;
      if (!isDocument(properties)) throw new Error("GeoJSON Feature properties must be an object or null.");
      const document: MongoDocument = { ...properties };
      setFieldPath(document, geometryField, feature.geometry);
      if (feature.id !== undefined) document._id = feature.id;
      return document;
    }
    if (isGeoJsonGeometry(feature)) {
      const document: MongoDocument = {};
      setFieldPath(document, geometryField, feature);
      return document;
    }
    throw new Error("GeoJSON import must be a Geometry, Feature, or FeatureCollection.");
  });
}

export function mongoDocumentsToGeoJson(documents: MongoDocument[], geometryField = "geometry"): MongoDocument {
  validateMongoFieldPath(geometryField);
  return {
    type: "FeatureCollection",
    features: documents.map((document) => {
      const geometry = readFieldPath(document, geometryField);
      if (geometry !== null && geometry !== undefined && !isGeoJsonGeometry(geometry)) {
        throw new Error(`MongoDB field '${geometryField}' is not a GeoJSON Geometry.`);
      }
      const properties = { ...document };
      delete properties._id;
      deleteFieldPath(properties, geometryField);
      const feature: MongoDocument = { type: "Feature", geometry: geometry ?? null, properties };
      if (document._id !== undefined) feature.id = geoJsonId(document._id);
      return feature;
    }),
  };
}

export function mongoConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): MongoConnectionConfig {
  const uri = (env.DBSTUDIO_MONGODB_URL || env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("Configure MongoDB with DBSTUDIO_MONGODB_URL or MONGODB_URI.");
  validateMongoUri(uri);

  let uriDatabase: string | undefined;
  try {
    const pathname = new URL(uri).pathname.replace(/^\//, "");
    uriDatabase = pathname ? decodeURIComponent(pathname.split("/", 1)[0]!) : undefined;
  } catch {
    throw new Error("MongoDB connection URI is invalid.");
  }
  const database = env.DBSTUDIO_MONGODB_DATABASE?.trim()
    || env.MONGODB_DATABASE?.trim()
    || uriDatabase;
  const timeout = Number(env.MONGODB_CONNECT_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("MONGODB_CONNECT_TIMEOUT_MS must be between 1 and 120000.");
  }
  return { uri, database, connectTimeoutMS: timeout };
}

export class MongoDocumentAdapter {
  private readonly client: MongoClient;
  private connection?: Promise<MongoClient>;

  constructor(private readonly config: MongoConnectionConfig) {
    validateMongoUri(config.uri);
    this.client = new MongoClient(config.uri, {
      serverSelectionTimeoutMS: config.connectTimeoutMS ?? 10_000,
    });
  }

  async testConnection(): Promise<{ database: string; serverVersion: string }> {
    const client = await this.connect();
    const result = await client.db("admin").command({ buildInfo: 1 });
    return {
      database: this.config.database ?? "admin",
      serverVersion: String(result.version ?? "unknown"),
    };
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.connect();
    const result = await client.db("admin").admin().listDatabases({ nameOnly: true });
    return result.databases.map((database) => database.name).sort((left, right) => left.localeCompare(right));
  }

  async listCollections(database = this.requireDatabase()): Promise<string[]> {
    const client = await this.connect();
    const collections = await client.db(database).listCollections({}, { nameOnly: true }).toArray();
    return collections.map((collection) => collection.name).sort((left, right) => left.localeCompare(right));
  }

  async listIndexes(database: string, collection: string): Promise<MongoIndexMetadata[]> {
    const indexes = await (await this.connect()).db(database).collection<Document>(collection).listIndexes().toArray();
    return indexes.map((index) => {
      const key = (index.key ?? {}) as Record<string, unknown>;
      const metadata: MongoIndexMetadata = {
        name: String(index.name ?? ""),
        key,
        unique: index.unique === true,
        sparse: index.sparse === true,
        twoDSphere: Object.values(key).some((value) => value === "2dsphere"),
      };
      if (typeof index.expireAfterSeconds === "number") metadata.expireAfterSeconds = index.expireAfterSeconds;
      if (typeof index.hidden === "boolean") metadata.hidden = index.hidden;
      if (isDocument(index.partialFilterExpression)) metadata.partialFilterExpression = index.partialFilterExpression;
      return metadata;
    });
  }

  async createTwoDSphereIndex(database: string, collection: string, field = "geometry"): Promise<string> {
    validateMongoFieldPath(field);
    return (await this.connect()).db(database).collection<Document>(collection).createIndex({ [field]: "2dsphere" });
  }

  async findDocuments(
    database: string,
    collection: string,
    options: MongoFindOptions = {},
  ): Promise<MongoDocument[]> {
    const cursor = (await this.connect()).db(database).collection<Document>(collection).find(
      (options.filter ?? {}) as Document,
      { projection: options.projection as FindOptions["projection"] },
    );
    if (options.sort) cursor.sort(options.sort as Sort);
    if (options.skip !== undefined) cursor.skip(options.skip);
    if (options.limit !== undefined) cursor.limit(options.limit);
    return cursor.toArray() as Promise<MongoDocument[]>;
  }

  async aggregateDocuments(
    database: string,
    collection: string,
    pipeline: MongoDocument[],
    limit = 100,
  ): Promise<MongoDocument[]> {
    if (!Array.isArray(pipeline)) throw new Error("MongoDB aggregation pipeline must be an array.");
    const cursor = (await this.connect()).db(database).collection<Document>(collection).aggregate<Document>(pipeline as Document[]);
    if (limit > 0) cursor.limit(limit);
    return cursor.toArray() as Promise<MongoDocument[]>;
  }

  async importDocuments(
    database: string,
    collection: string,
    documents: MongoDocument[],
  ): Promise<number> {
    if (!Array.isArray(documents) || documents.some((document) => !isDocument(document))) {
      throw new Error("MongoDB import data must be a document or an array of documents.");
    }
    if (documents.length === 0) return 0;
    const target = (await this.connect()).db(database).collection<Document>(collection);
    let insertedCount = 0;
    for (let offset = 0; offset < documents.length; offset += 1_000) {
      const result = await target.insertMany(documents.slice(offset, offset + 1_000), { ordered: true });
      insertedCount += result.insertedCount;
    }
    return insertedCount;
  }

  async importGeoJson(database: string, collection: string, content: string, geometryField = "geometry"): Promise<number> {
    const value = parseMongoEjson(content, "GeoJSON data");
    return this.importDocuments(database, collection, geoJsonToMongoDocuments(value, geometryField));
  }

  async exportDocuments(
    database: string,
    collection: string,
    options: MongoFindOptions = {},
  ): Promise<MongoDocument[]> {
    return this.findDocuments(database, collection, options);
  }

  async exportGeoJson(
    database: string,
    collection: string,
    options: MongoFindOptions = {},
    geometryField = "geometry",
  ): Promise<MongoDocument> {
    return mongoDocumentsToGeoJson(await this.exportDocuments(database, collection, options), geometryField);
  }

  async close(): Promise<void> {
    await this.client.close();
    this.connection = undefined;
  }

  private async connect(): Promise<MongoClient> {
    this.connection ??= this.client.connect();
    return this.connection;
  }

  private requireDatabase(): string {
    if (!this.config.database) throw new Error("Set DBSTUDIO_MONGODB_DATABASE or provide a database in the MongoDB URI.");
    return this.config.database;
  }
}

export function parseMongoJson(content: string): MongoDocument[] {
  const value = parseMongoEjson(content, "MongoDB JSON data");
  const documents = Array.isArray(value) ? value : [value];
  if (!documents.every(isDocument)) throw new Error("MongoDB JSON data must contain document objects.");
  return documents;
}

export function parseMongoEjson(content: string, label = "MongoDB JSON"): unknown {
  try {
    return EJSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : "parse error"}`);
  }
}

export function stringifyMongoJson(value: unknown, pretty = true): string {
  return EJSON.stringify(value, null, pretty ? 2 : 0, { relaxed: true });
}

function validateMongoUri(uri: string): void {
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    throw new Error("MongoDB URI must use mongodb:// or mongodb+srv://.");
  }
  if (/\s/.test(uri)) throw new Error("MongoDB URI must not contain unescaped whitespace.");
}

function isDocument(value: unknown): value is MongoDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeoJsonGeometry(value: unknown): value is MongoDocument {
  if (!isDocument(value) || typeof value.type !== "string") return false;
  if (value.type === "GeometryCollection") {
    return Array.isArray(value.geometries) && value.geometries.every(isGeoJsonGeometry);
  }
  return ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(value.type)
    && Array.isArray(value.coordinates);
}

function validateMongoFieldPath(field: string): void {
  if (!field || field.length > 255 || field.split(".").some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error("MongoDB field path must contain only letters, digits, underscores, and dot-separated names.");
  }
}

function readFieldPath(document: MongoDocument, field: string): unknown {
  return field.split(".").reduce<unknown>((value, part) => isDocument(value) ? value[part] : undefined, document);
}

function setFieldPath(document: MongoDocument, field: string, value: unknown): void {
  const parts = field.split(".");
  let current = document;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (child === undefined) current[part] = {};
    else if (!isDocument(child)) throw new Error(`GeoJSON field path '${field}' conflicts with a non-object property.`);
    current = current[part] as MongoDocument;
  }
  current[parts.at(-1)!] = value;
}

function deleteFieldPath(document: MongoDocument, field: string): void {
  const parts = field.split(".");
  const parents: Array<{ document: MongoDocument; key: string }> = [];
  let current: MongoDocument = document;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!isDocument(child)) return;
    parents.push({ document: current, key: part });
    current = child;
  }
  const leaf = parts.at(-1);
  if (leaf) delete current[leaf];
  for (const parent of parents.reverse()) {
    if (Object.keys(parent.document[parent.key] as MongoDocument).length > 0) break;
    delete parent.document[parent.key];
  }
}

function geoJsonId(value: unknown): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  if (isDocument(value) && typeof value.toHexString === "function") return String(value.toHexString());
  return String(value);
}
