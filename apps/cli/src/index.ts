#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { loadPostgisSchemaMetadata, loadSchemaCandidateMetadata, runSqlAssistant, selectRelevantTables, testChatModel, testEmbeddingModel, testRerankModel } from "@db-studio/ai";
import type { ChatModelConfig, EmbeddingModelConfig, RerankModelConfig, SchemaTable, SqlAssistantContext } from "@db-studio/ai";
import { databaseEngines } from "@db-studio/shared";
import type { DatabaseEngine } from "@db-studio/shared";
import {
  CoreService,
  GisOperationError,
  MongoDocumentService,
  buildMongoGeoFilter,
  parseMongoEjson,
  stringifyMongoJson,
  type GdalOperationOptions,
} from "@db-studio/core";
import { parseTabularData, queryResultToCsv, queryResultToXlsx } from "@db-studio/shared";
import {
  addConnectionProfile,
  applyConnectionEnvironment,
  connectionSummary,
  environmentForConnection,
  readConnectionProfiles,
  removeConnectionProfile,
  updateConnectionProfile,
  type CliConnectionOptions,
} from "./connections.js";
import type { OutputFormat } from "./format.js";
import { formatQueryResult, writeQueryResultNdjsonStream } from "./format.js";
import { readDesktopAiModelSettings } from "./model-settings.js";

const VERSION = "0.1.0";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("dbstudio")
    .description("Lightweight database and GIS tools")
    .version(VERSION);

  program.command("doctor").description("Check runtime prerequisites")
    .option("--connection <name>", "Connection source", "environment")
    .action(() => {
    const environmentConfigured = hasConfiguredDatabase(process.env);
    const gdal = CoreService.gdalRuntimeStatus();
    writeJson({
      node: process.versions.node,
      databaseType: configuredDatabaseType(process.env),
      databaseEnvironmentConfigured: environmentConfigured,
      gdal,
    });
  });

  const connections = program.command("connections").description("Inspect configured connections");
  connections.command("list").description("List saved and environment connection sources").action(async () => {
    const saved = (await readConnectionProfiles()).map(connectionSummary);
    if (hasConfiguredDatabase(process.env)) {
      saved.unshift({
        name: "environment",
        engine: configuredDatabaseType(process.env),
        source: "environment",
        configured: true,
        credentials: "provided by environment; not displayed",
      });
    }
    writeJson(saved);
  });
  addConnectionProfileOptions(connections.command("add").description("Save a named connection without storing its secret"))
    .action(async (options: CliConnectionOptions) => writeJson(connectionSummary(await addConnectionProfile(options))));
  addConnectionProfileOptions(connections.command("update").alias("edit").description("Replace a saved connection profile"))
    .action(async (options: CliConnectionOptions) => writeJson(connectionSummary(await updateConnectionProfile(options))));
  connections.command("remove").description("Remove a saved connection profile")
    .requiredOption("--name <name>", "Saved connection name")
    .action(async (options: { name: string }) => {
      await removeConnectionProfile(options.name);
      writeJson({ removed: true, name: options.name });
    });
  connections
    .command("test")
    .description("Test an environment or saved database connection")
    .addOption(new Option("--connection <name>", "Connection source").default("environment"))
    .action(async (options: { connection: string }) => {
      assertEnvironmentConnection(options.connection);
      const result = configuredDatabaseType(process.env) === "mongodb"
        ? await MongoDocumentService.fromEnvironment().testConnection()
        : await CoreService.fromEnvironment().testConnection();
      writeJson({ ok: true, ...result });
    });

  const databases = program.command("databases").description("Browse databases");
  databases
    .command("list")
    .description("List database names or SQLite schemas")
    .option("--connection <name>", "Connection source", "environment")
    .action(async (options: { connection: string }) => {
      assertEnvironmentConnection(options.connection);
      const result = configuredDatabaseType(process.env) === "mongodb"
        ? await MongoDocumentService.fromEnvironment().listDatabases()
        : await CoreService.fromEnvironment().listDatabases();
      writeJson(result);
    });

  const schemas = program.command("schemas").description("Browse schemas");
  schemas
    .command("list")
    .description("List schemas or users visible to the connection")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .action(async (options: { connection: string; database?: string }) => {
      assertEnvironmentConnection(options.connection);
      if (configuredDatabaseType(process.env) === "mongodb") {
        throw new Error("MongoDB does not use SQL schemas; use `mongo collections`.");
      }
      writeJson(await coreForDatabase(options.database).listSchemas());
    });

  const mongo = program.command("mongo").description("Browse and query MongoDB documents");
  mongo
    .command("collections")
    .description("List collections in a MongoDB database")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .action(async (options: { connection: string; database?: string }) => {
      assertMongoConnection(options.connection);
      writeJson(await MongoDocumentService.fromEnvironment().listCollections(options.database));
    });
  mongo
    .command("find")
    .description("Find MongoDB documents with filter, projection, sort and paging")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Collection name")
    .option("--filter <json>", "MongoDB filter document")
    .option("--projection <json>", "MongoDB projection document")
    .option("--sort <json>", "MongoDB sort document")
    .option("--skip <count>", "Documents to skip", parseNonNegativeInteger, 0)
    .option("--limit <count>", "Maximum documents to return", parsePositiveInteger, 100)
    .addOption(new Option("--format <format>", "Output format").choices(["json", "ndjson"]).default("json"))
    .action(async (options: {
      connection: string;
      database?: string;
      collection: string;
      filter?: string;
      projection?: string;
      sort?: string;
      skip: number;
      limit: number;
      format: "json" | "ndjson";
    }) => {
      assertMongoConnection(options.connection);
      const documents = await MongoDocumentService.fromEnvironment().findDocuments(
        options.database,
        options.collection,
        {
          filter: options.filter ? parseMongoDocument(options.filter, "filter") : undefined,
          projection: options.projection ? parseMongoDocument(options.projection, "projection") : undefined,
          sort: options.sort ? parseMongoDocument(options.sort, "sort") : undefined,
          skip: options.skip,
          limit: options.limit,
        },
      );
      const output = options.format === "json"
        ? stringifyMongoJson(documents)
        : documents.map((document) => stringifyMongoJson(document, false)).join("\n");
      process.stdout.write(`${output}\n`);
    });
  mongo
    .command("aggregate")
    .description("Run a MongoDB aggregation pipeline")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Collection name")
    .requiredOption("--pipeline <json>", "MongoDB aggregation pipeline array")
    .option("--limit <count>", "Maximum documents to return", parsePositiveInteger, 100)
    .action(async (options: { connection: string; database?: string; collection: string; pipeline: string; limit: number }) => {
      assertMongoConnection(options.connection);
      const pipeline = parseMongoEjson(options.pipeline, "aggregation pipeline");
      if (!Array.isArray(pipeline)) throw new Error("MongoDB aggregation pipeline must be a JSON array.");
      const documents = await MongoDocumentService.fromEnvironment().aggregateDocuments(
        options.database, options.collection, pipeline, options.limit,
      );
      process.stdout.write(`${stringifyMongoJson(documents)}\n`);
    });
  mongo
    .command("indexes")
    .description("List MongoDB index metadata, including 2dsphere indexes")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Collection name")
    .action(async (options: { connection: string; database?: string; collection: string }) => {
      assertMongoConnection(options.connection);
      writeJson(await MongoDocumentService.fromEnvironment().listIndexes(options.database, options.collection));
    });
  mongo
    .command("create-2dsphere-index")
    .description("Create a MongoDB 2dsphere index on a GeoJSON field")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Collection name")
    .option("--field <field>", "GeoJSON Geometry field path", "geometry")
    .action(async (options: { connection: string; database?: string; collection: string; field: string }) => {
      assertMongoConnection(options.connection);
      const name = await MongoDocumentService.fromEnvironment().createTwoDSphereIndex(options.database, options.collection, options.field);
      writeJson({ created: true, name, field: options.field, type: "2dsphere" });
    });
  mongo
    .command("geo-find")
    .description("Find documents by GeoJSON Geometry using $geoWithin or $geoIntersects")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Collection name")
    .requiredOption("--geometry <json>", "GeoJSON Geometry or Feature")
    .option("--field <field>", "GeoJSON Geometry field path", "geometry")
    .addOption(new Option("--relation <relation>", "Spatial relation").choices(["within", "intersects"]).default("within"))
    .option("--limit <count>", "Maximum documents to return", parsePositiveInteger, 100)
    .action(async (options: { connection: string; database?: string; collection: string; geometry: string; field: string; relation: "within" | "intersects"; limit: number }) => {
      assertMongoConnection(options.connection);
      const geometry = parseMongoEjson(options.geometry, "GeoJSON query geometry");
      const documents = await MongoDocumentService.fromEnvironment().findDocuments(
        options.database,
        options.collection,
        { filter: buildMongoGeoFilter(options.field, geometry, options.relation), limit: options.limit },
      );
      process.stdout.write(`${stringifyMongoJson(documents)}\n`);
    });
  mongo
    .command("geo-import")
    .description("Import a GeoJSON Geometry, Feature, or FeatureCollection into a MongoDB collection")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Destination collection")
    .requiredOption("--file <path>", "GeoJSON input file")
    .option("--field <field>", "MongoDB Geometry field path", "geometry")
    .action(async (options: { connection: string; database?: string; collection: string; file: string; field: string }) => {
      assertMongoConnection(options.connection);
      const insertedCount = await MongoDocumentService.fromEnvironment().importGeoJson(
        options.database, options.collection, await readFile(options.file, "utf8"), options.field,
      );
      writeJson({ imported: true, collection: options.collection, insertedCount, geometryField: options.field });
    });
  mongo
    .command("geo-export")
    .description("Export MongoDB documents as a GeoJSON FeatureCollection")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Source collection")
    .option("--field <field>", "MongoDB Geometry field path", "geometry")
    .option("--filter <json>", "MongoDB filter document")
    .option("--limit <count>", "Maximum features to export", parsePositiveInteger, 1000)
    .option("--output <path>", "Write FeatureCollection to this file; otherwise write to stdout")
    .action(async (options: { connection: string; database?: string; collection: string; field: string; filter?: string; limit: number; output?: string }) => {
      assertMongoConnection(options.connection);
      const geoJson = await MongoDocumentService.fromEnvironment().exportGeoJson(
        options.database,
        options.collection,
        { filter: options.filter ? parseMongoDocument(options.filter, "filter") : undefined, limit: options.limit },
        options.field,
      );
      const content = `${stringifyMongoJson(geoJson)}\n`;
      if (options.output) {
        await writeFile(options.output, content, "utf8");
        writeJson({ exported: true, output: options.output, featureCount: (geoJson.features as unknown[]).length });
      } else {
        process.stdout.write(content);
      }
    });
  mongo
    .command("import")
    .description("Import one MongoDB JSON/EJSON document or an array of documents")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Destination collection")
    .requiredOption("--file <path>", "JSON/EJSON input file")
    .action(async (options: { connection: string; database?: string; collection: string; file: string }) => {
      assertMongoConnection(options.connection);
      const content = await readFile(options.file, "utf8");
      const insertedCount = await MongoDocumentService.fromEnvironment().importJson(
        options.database, options.collection, content,
      );
      writeJson({ imported: true, database: options.database ?? "connection default", collection: options.collection, insertedCount });
    });
  mongo
    .command("export")
    .description("Export MongoDB documents as JSON/EJSON or NDJSON")
    .option("--connection <name>", "Connection source", "environment")
    .option("--database <database>", "Database override")
    .requiredOption("--collection <collection>", "Source collection")
    .option("--filter <json>", "MongoDB filter document")
    .option("--output <path>", "Write documents to this file; otherwise write to stdout")
    .addOption(new Option("--format <format>", "Output format").choices(["json", "ndjson"]).default("json"))
    .option("--limit <count>", "Maximum documents to export", parsePositiveInteger, 1000)
    .action(async (options: {
      connection: string; database?: string; collection: string; filter?: string; output?: string;
      format: "json" | "ndjson"; limit: number;
    }) => {
      assertMongoConnection(options.connection);
      const documents = await MongoDocumentService.fromEnvironment().exportDocuments(
        options.database,
        options.collection,
        { filter: options.filter ? parseMongoDocument(options.filter, "filter") : undefined, limit: options.limit },
      );
      const content = options.format === "json"
        ? `${stringifyMongoJson(documents)}\n`
        : `${documents.map((document) => stringifyMongoJson(document, false)).join("\n")}\n`;
      if (options.output) {
        await writeFile(options.output, content, "utf8");
        writeJson({ exported: true, output: options.output, documentCount: documents.length });
      } else {
        process.stdout.write(content);
      }
    });

  const tables = program.command("tables").description("Browse relational objects");
  tables
    .command("list")
    .description("List tables and views in a database schema")
    .option("--connection <name>", "Connection source", "environment")
    .option("--schema <schema>", "Schema name")
    .option("--database <database>", "Database override")
    .action(async (options: { connection: string; schema?: string; database?: string }) => {
      assertEnvironmentConnection(options.connection);
      const core = coreForDatabase(options.database);
      writeJson(await core.listTables(options.schema));
    });
  tables
    .command("transfer")
    .description("Append rows from a source table to an existing destination table")
    .option("--source-connection <name>", "Source saved connection or environment", "environment")
    .option("--target-connection <name>", "Destination saved connection or environment", "environment")
    .requiredOption("--source-table <table>", "Source base table")
    .requiredOption("--target-table <table>", "Existing destination base table")
    .option("--source-schema <schema>", "Source schema")
    .option("--target-schema <schema>", "Destination schema")
    .option("--source-database <database>", "Source PostgreSQL/MySQL/MariaDB/SQL Server database override")
    .option("--target-database <database>", "Destination PostgreSQL/MySQL/MariaDB/SQL Server database override")
    .option("--page-size <count>", "Rows per transfer page (maximum 1000)", parsePositiveInteger, 250)
    .option("--map <source=target>", "Map a source column to a destination column; repeat to select columns", (value: string, previous: string[]) => [...previous, value], [])
    .option("--allow-spatial-type-conversion", "Retag geometry as geography (or back); requires a valid geographic SRID")
    .action(async (options: {
      sourceConnection: string;
      targetConnection: string;
      sourceTable: string;
      targetTable: string;
      sourceSchema?: string;
      targetSchema?: string;
      sourceDatabase?: string;
      targetDatabase?: string;
      pageSize: number;
      map: string[];
      allowSpatialTypeConversion?: boolean;
    }) => {
      const sourceEnvironment = await environmentForConnection(options.sourceConnection);
      const targetEnvironment = await environmentForConnection(options.targetConnection);
      const columnMappings = parseTableTransferMappings(options.map);
      const source = coreForDatabase(options.sourceDatabase, sourceEnvironment);
      const target = coreForDatabase(options.targetDatabase, targetEnvironment);
      const result = await source.transferTableRows(target, {
        sourceTable: options.sourceTable,
        sourceSchema: options.sourceSchema,
        targetTable: options.targetTable,
        targetSchema: options.targetSchema,
        pageSize: options.pageSize,
        ...(columnMappings.length ? { columnMappings } : {}),
        ...(options.allowSpatialTypeConversion ? { allowSpatialTypeConversion: true } : {}),
      });
      writeJson({
        transferred: true,
        sourceConnection: options.sourceConnection,
        sourceTable: options.sourceTable,
        targetConnection: options.targetConnection,
        targetTable: options.targetTable,
        ...result,
      });
    });
  tables
    .command("columns")
    .description("Describe columns for a table or view")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--table <table>", "Table or view name")
    .option("--schema <schema>", "Schema or SQLite database name")
    .option("--database <database>", "Database override")
    .action(async (options: { connection: string; table: string; schema?: string; database?: string }) => {
      assertEnvironmentConnection(options.connection);
      const core = coreForDatabase(options.database);
      writeJson(await core.getTableColumns(options.table, options.schema));
    });

  const query = program.command("query").description("Run SQL");
  query
    .command("run")
    .description("Execute a SQL statement")
    .option("--connection <name>", "Connection source", "environment")
    .option("--sql <sql>", "SQL text")
    .option("--file <path>", "Read SQL from a file")
    .option("--params <json>", "JSON array of positional parameters")
    .addOption(
      new Option("--format <format>", "Result format")
        .choices(["table", "json", "csv", "ndjson"])
        .default("table"),
    )
    .option("--stream", "Stream rows as NDJSON with bounded memory use")
    .action(
      async (options: {
        connection: string;
        sql?: string;
        file?: string;
        params?: string;
        format: OutputFormat;
        stream?: boolean;
      }) => {
        assertEnvironmentConnection(options.connection);
        if (Boolean(options.sql) === Boolean(options.file)) {
          throw new Error("Provide exactly one of --sql or --file.");
        }
        const sql = options.file ? await readFile(options.file, "utf8") : options.sql!;
        let parameters: unknown[] = [];
        if (options.params) {
          const value: unknown = JSON.parse(options.params);
          if (!Array.isArray(value)) throw new Error("--params must be a JSON array.");
          parameters = value;
        }
        if (options.stream && options.format !== "ndjson") {
          throw new Error("--stream requires --format ndjson.");
        }
        const core = CoreService.fromEnvironment();
        if (options.stream) {
          const controller = new AbortController();
          const onInterrupt = () => controller.abort();
          process.once("SIGINT", onInterrupt);
          process.once("SIGTERM", onInterrupt);
          try {
            await writeQueryResultNdjsonStream(
              core.queryStream(sql, parameters, { signal: controller.signal }),
              process.stdout,
              controller.signal,
            );
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          } finally {
            process.removeListener("SIGINT", onInterrupt);
            process.removeListener("SIGTERM", onInterrupt);
          }
          return;
        }
        const result = await core.query(sql, parameters);
        process.stdout.write(formatQueryResult(result, options.format) + "\n");
      },
    );

  const ai = program.command("ai").description("Generate, repair, and explain SQL with a configured AI model");
  const aiModels = ai.command("models").description("Inspect and test the configured AI model");
  aiModels.command("list").description("Show non-secret AI model configuration").action(async () => {
    const settings = await readDesktopAiModelSettings();
    const stored = settings?.enabled ? settings : undefined;
    const storedChat = stored?.chatModels.find((candidate) => candidate.id === stored.defaultChatModelId && candidate.enabled)
      ?? stored?.chatModels.find((candidate) => candidate.enabled);
    const baseURL = process.env.MODEL_OPENAI_BASE_URL || process.env.DBSTUDIO_AI_BASE_URL || storedChat?.baseURL;
    const model = process.env.MODEL_OPENAI_MODEL || process.env.DBSTUDIO_AI_MODEL || storedChat?.model;
    const storedEmbedding = stored?.embedding?.enabled ? stored.embedding : undefined;
    const embeddingBaseURL = process.env.MODEL_EMBEDDING_BASE_URL || process.env.MODEL_OPENAI_BASE_URL || process.env.DBSTUDIO_AI_BASE_URL || storedEmbedding?.baseURL || baseURL;
    const embeddingModel = process.env.MODEL_EMBEDDING_MODEL || storedEmbedding?.model;
    const storedRerank = stored?.rerank?.enabled ? stored.rerank : undefined;
    const rerankBaseURL = process.env.MODEL_RERANK_BASE_URL || process.env.MODEL_OPENAI_BASE_URL || process.env.DBSTUDIO_AI_BASE_URL || storedRerank?.baseURL || baseURL;
    const rerankModel = process.env.MODEL_RERANK_MODEL || storedRerank?.model;
    writeJson({
      chat: {
        provider: storedChat?.provider ?? "openai-compatible",
        configured: Boolean(baseURL && model),
        baseURL: baseURL ? redactModelBaseURL(baseURL) : null,
        model: model || null,
        apiKeyConfigured: Boolean(process.env.MODEL_OPENAI_API_KEY || process.env.DBSTUDIO_AI_API_KEY || storedChat?.apiKey),
      },
      embedding: {
        provider: storedEmbedding?.provider ?? "openai-compatible",
        configured: Boolean(embeddingModel && embeddingBaseURL),
        baseURL: redactModelBaseURL(embeddingBaseURL || ""),
        model: embeddingModel || null,
        apiKeyConfigured: Boolean(process.env.MODEL_EMBEDDING_API_KEY || process.env.MODEL_OPENAI_API_KEY || process.env.DBSTUDIO_AI_API_KEY || storedEmbedding?.apiKey || storedChat?.apiKey),
      },
      rerank: {
        provider: storedRerank?.provider ?? "dashscope",
        configured: Boolean(rerankModel && rerankBaseURL),
        baseURL: redactModelBaseURL(rerankBaseURL || ""),
        model: rerankModel || null,
        apiKeyConfigured: Boolean(process.env.MODEL_RERANK_API_KEY || process.env.MODEL_OPENAI_API_KEY || process.env.DBSTUDIO_AI_API_KEY || storedRerank?.apiKey || storedChat?.apiKey),
      },
      credentials: "read from process environment or encrypted desktop settings; never displayed",
    });
  });
  aiModels.command("test").description("Send a minimal request to verify a configured model")
    .addOption(new Option("--kind <kind>", "Model type").choices(["chat", "embedding", "rerank"]).default("chat"))
    .option("--model <model>", "Override the model ID for this test")
    .action(async (options: { kind: "chat" | "embedding" | "rerank"; model?: string }) => {
      if (options.kind === "chat") {
        const config = await cliChatModelConfig(options.model);
        await testChatModel(config);
        writeJson({ ok: true, kind: options.kind, model: config.model, message: "Model returned a valid minimal text response." });
      } else if (options.kind === "embedding") {
        const config = await cliEmbeddingModelConfig(options.model);
        const dimensions = await testEmbeddingModel(config);
        writeJson({ ok: true, kind: options.kind, model: config.model, dimensions });
      } else {
        const config = await cliRerankModelConfig(options.model);
        await testRerankModel(config);
        writeJson({ ok: true, kind: options.kind, model: config.model, message: "Rerank response passed structural checks." });
      }
  });

  const aiSql = ai.command("sql").description("Create reviewable SQL drafts");
  aiSql.command("generate")
    .description("Generate SQL from a natural-language request")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--request <text>", "Natural-language query request")
    .option("--schema <schema>", "Schema to inspect")
    .option("--table <schema.table>", "Limit context to a table (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--include-schema", "Explicitly allow selected table metadata in the model request")
    .option("--format <format>", "Output format", "sql")
    .action(async (options: { connection: string; request: string; schema?: string; table: string[]; includeSchema?: boolean; format: string }) => {
      assertEnvironmentConnection(options.connection);
      if (!options.includeSchema) throw new Error("Pass --include-schema to explicitly allow table metadata to be sent to the model.");
      if (!["sql", "json"].includes(options.format)) throw new Error("--format must be sql or json.");
      const context = await cliSqlContext(options.connection, options.schema, options.request, options.table);
      const response = await runSqlAssistant(await cliChatModelConfig(), { task: "generate", request: options.request, context });
      outputAiSql(response, options.format as "sql" | "json");
    });
  aiSql.command("gis")
    .description("Generate a reviewable PostGIS spatial query")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--request <text>", "Natural-language spatial query request")
    .option("--schema <schema>", "Schema to inspect")
    .option("--table <schema.table>", "Limit context to a table (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--include-schema", "Explicitly allow selected spatial schema metadata in the model request")
    .option("--format <format>", "Output format", "sql")
    .action(async (options: { connection: string; request: string; schema?: string; table: string[]; includeSchema?: boolean; format: string }) => {
      assertEnvironmentConnection(options.connection);
      if (!options.includeSchema) throw new Error("Pass --include-schema to explicitly allow spatial schema metadata to be sent to the model.");
      if (!["sql", "json"].includes(options.format)) throw new Error("--format must be sql or json.");
      const context = await cliSqlContext(options.connection, options.schema, options.request, options.table);
      const response = await runSqlAssistant(await cliChatModelConfig(), { task: "gis", request: options.request, context });
      outputAiSql(response, options.format as "sql" | "json");
    });
  aiSql.command("repair")
    .description("Suggest a repair for a failed SQL statement")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--file <path>", "SQL file")
    .requiredOption("--error-file <path>", "File containing the database error")
    .option("--request <text>", "Optional repair intent")
    .option("--schema <schema>", "Schema to inspect")
    .option("--table <schema.table>", "Limit context to a table (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--include-schema", "Explicitly allow selected table metadata in the model request")
    .option("--format <format>", "Output format", "json")
    .action(async (options: { connection: string; file: string; errorFile: string; request?: string; schema?: string; table: string[]; includeSchema?: boolean; format: string }) => {
      assertEnvironmentConnection(options.connection);
      if (!options.includeSchema) throw new Error("Pass --include-schema to explicitly allow table metadata to be sent to the model.");
      if (!["sql", "json"].includes(options.format)) throw new Error("--format must be sql or json.");
      const selectedSql = await readFile(options.file, "utf8");
      const errorMessage = (await readFile(options.errorFile, "utf8")).slice(0, 4_000);
      const context = await cliSqlContext(options.connection, options.schema, options.request ?? "", options.table);
      context.selectedSql = selectedSql;
      context.error = { message: errorMessage };
      const response = await runSqlAssistant(await cliChatModelConfig(), {
        task: "repair", request: options.request ?? "", context,
      });
      outputAiSql(response, options.format as "sql" | "json");
    });
  aiSql.command("explain")
    .description("Explain SQL without executing it")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--file <path>", "SQL file")
    .option("--request <text>", "Optional focus for the explanation", "")
    .option("--schema <schema>", "Schema to inspect")
    .option("--table <schema.table>", "Limit context to a table (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--include-schema", "Explicitly allow selected table metadata in the model request")
    .option("--format <format>", "Output format", "json")
    .action(async (options: { connection: string; file: string; request: string; schema?: string; table: string[]; includeSchema?: boolean; format: string }) => {
      assertEnvironmentConnection(options.connection);
      if (!["sql", "json"].includes(options.format)) throw new Error("--format must be sql or json.");
      const selectedSql = await readFile(options.file, "utf8");
      const context = options.includeSchema
        ? await cliSqlContext(options.connection, options.schema, options.request, options.table)
        : await cliEmptySqlContext(options.connection, options.schema);
      context.selectedSql = selectedSql;
      const response = await runSqlAssistant(await cliChatModelConfig(), { task: "explain", request: options.request, context });
      outputAiSql(response, options.format as "sql" | "json");
    });
  aiSql.command("explain-plan")
    .description("Interpret a manually supplied execution plan without executing SQL")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--file <path>", "SQL file")
    .requiredOption("--plan-file <path>", "Text file containing database EXPLAIN output")
    .option("--request <text>", "Optional focus for the plan explanation", "")
    .option("--schema <schema>", "Schema to inspect")
    .option("--table <schema.table>", "Limit context to a table (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--include-schema", "Explicitly allow selected table metadata in the model request")
    .option("--format <format>", "Output format", "json")
    .action(async (options: { connection: string; file: string; planFile: string; request: string; schema?: string; table: string[]; includeSchema?: boolean; format: string }) => {
      assertEnvironmentConnection(options.connection);
      if (!["sql", "json"].includes(options.format)) throw new Error("--format must be sql or json.");
      if ((await stat(options.planFile)).size > 48_000) throw new Error("执行计划文件不能超过 48,000 字节或 12,000 个字符。");
      const [selectedSql, executionPlan] = await Promise.all([
        readFile(options.file, "utf8"), readFile(options.planFile, "utf8"),
      ]);
      if (!executionPlan.trim() || executionPlan.length > 12_000) throw new Error("执行计划不能为空或超过 12,000 个字符。");
      const context = options.includeSchema
        ? await cliSqlContext(options.connection, options.schema, options.request, options.table)
        : await cliEmptySqlContext(options.connection, options.schema);
      context.selectedSql = selectedSql;
      context.executionPlan = executionPlan;
      const response = await runSqlAssistant(await cliChatModelConfig(), {
        task: "explain-plan", request: options.request, context,
      });
      outputAiSql(response, options.format as "sql" | "json");
    });

  const data = program.command("data").description("Import and export ordinary table data");
  data
    .command("export")
    .description("Export a table to CSV, JSON, or Excel")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--table <table>", "Source table name")
    .option("--schema <schema>", "Schema or SQLite database name")
    .option("--database <database>", "Database override")
    .requiredOption("--output <path>", "Destination file")
    .addOption(new Option("--format <format>", "Output format").choices(["csv", "json", "xlsx"]).default("csv"))
    .action(async (options: {
      connection: string;
      table: string;
      schema?: string;
      database?: string;
      output: string;
      format: "csv" | "json" | "xlsx";
    }) => {
      assertEnvironmentConnection(options.connection);
      const core = coreForDatabase(options.database);
      const result = await core.exportTable(options.table, options.schema);
      if (options.format === "xlsx") {
        await writeFile(options.output, await queryResultToXlsx(result));
      } else {
        const content = options.format === "csv"
          ? `${queryResultToCsv(result, { nullValue: "\\N" })}\n`
          : `${JSON.stringify({ columns: result.columns, rows: result.rows, rowCount: result.rowCount }, null, 2)}\n`;
        await writeFile(options.output, content, "utf8");
      }
      writeJson({ exported: true, output: options.output, rowCount: result.rowCount, columnCount: result.columns.length });
    });
  data
    .command("import")
    .description("Import CSV, JSON, or Excel rows into a table")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--table <table>", "Destination table name")
    .option("--schema <schema>", "Schema or SQLite database name")
    .option("--database <database>", "Database override")
    .requiredOption("--input <path>", "CSV, JSON, or XLSX file")
    .addOption(new Option("--format <format>", "Input format").choices(["csv", "json", "xlsx"]).makeOptionMandatory())
    .option("--create-table", "Create a new table using inferred input column types; refuses to overwrite an existing table")
    .option("--null-value <token>", "CSV token that represents SQL NULL", "\\N")
    .action(async (options: {
      connection: string;
      table: string;
      schema?: string;
      database?: string;
      input: string;
      format: "csv" | "json" | "xlsx";
      createTable?: boolean;
      nullValue: string;
    }) => {
      assertEnvironmentConnection(options.connection);
      const core = coreForDatabase(options.database);
      const result = options.createTable
        ? options.format === "xlsx"
          ? await core.importWorkbookToNewTable(options.table, await readFile(options.input), options.schema)
          : await core.createTableFromRows(
              options.table,
              parseTabularData(await readFile(options.input, "utf8"), options.format, { nullValue: options.nullValue }),
              options.schema,
            )
        : options.format === "xlsx"
          ? await core.importTableWorkbook(options.table, await readFile(options.input), options.schema)
          : await core.importRows(
              options.table,
              parseTabularData(await readFile(options.input, "utf8"), options.format, { nullValue: options.nullValue }),
              options.schema,
            );
      writeJson({
        imported: true,
        createdTable: Boolean(options.createTable),
        input: options.input,
        table: "table" in result ? result.table : options.table,
        insertedRows: result.insertedRows,
        columns: result.columns,
        ...("inferredTypes" in result ? { inferredTypes: result.inferredTypes } : {}),
      });
    });

  const gis = program.command("gis").description("Inspect, convert and transfer GIS vector data");
  gis
    .command("inspect")
    .description("Read vector file metadata without loading features into memory")
    .requiredOption("--file <path>", "GIS file path")
    .option("--source-encoding <encoding>", "Override the source text encoding")
    .option("--zip-filename-encoding <encoding>", "Encoding of names stored inside a ZIP archive, such as UTF-8 or CP936")
    .action(async (options: { file: string; sourceEncoding?: string; zipFilenameEncoding?: string }) => {
      writeJson(await CoreService.fromEnvironment().inspectGisFile(options.file, {
        sourceEncoding: options.sourceEncoding,
        zipFilenameEncoding: options.zipFilenameEncoding,
      }));
    });
  gis
    .command("preview")
    .description("Preview a small sample of vector attributes and their detected encoding")
    .requiredOption("--file <path>", "GIS file path")
    .option("--layer <name>", "Select a source layer in a multi-layer dataset")
    .option("--source-encoding <encoding>", "Override the source text encoding")
    .option("--zip-filename-encoding <encoding>", "Encoding of names stored inside a ZIP archive, such as UTF-8 or CP936")
    .option("--limit <count>", "Maximum preview feature count", "20")
    .action(async (options: { file: string; layer?: string; sourceEncoding?: string; zipFilenameEncoding?: string; limit: string }) => {
      writeJson(await CoreService.fromEnvironment().previewGisAttributes(options.file, {
        sourceLayer: options.layer,
        sourceEncoding: options.sourceEncoding,
        zipFilenameEncoding: options.zipFilenameEncoding,
        limit: Number(options.limit),
      }));
    });
  gis
    .command("convert")
    .description("Convert a vector file with OGR")
    .requiredOption("--input <path>", "Input vector file")
    .requiredOption("--output <path>", "Output vector file")
    .option("--layer <name>", "Select one source layer from a multi-layer dataset")
    .option("--target-layer <name>", "Name the output layer; requires a single selected source layer")
    .option("--source-crs <crs>", "Override or supply the source CRS")
    .option("--target-crs <crs>", "Transform coordinates to this CRS")
    .option("--coordinate-operation <pipeline>", "Apply an explicit PROJ pipeline (requires --target-crs)")
    .option("--source-encoding <encoding>", "Override the source text encoding")
    .option("--zip-filename-encoding <encoding>", "Encoding of names stored inside a ZIP archive, such as UTF-8 or CP936")
    .option("--target-encoding <encoding>", "Encoding for Shapefile or MapInfo output (default UTF-8)")
    .option("--dataset-option <name=value>", "GDAL dataset creation option (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--layer-option <name=value>", "GDAL layer creation option (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .action(async (options: { input: string; output: string; layer?: string; targetLayer?: string; sourceCrs?: string; targetCrs?: string; coordinateOperation?: string; sourceEncoding?: string; zipFilenameEncoding?: string; targetEncoding?: string; datasetOption: string[]; layerOption: string[] }) => {
      const result = await withGisProgress((operationOptions) => CoreService.fromEnvironment().convertGisFile(
        options.input,
        options.output,
        {
          sourceLayer: options.layer,
          targetLayerName: options.targetLayer,
          sourceCrs: options.sourceCrs,
          targetCrs: options.targetCrs,
          coordinateOperation: options.coordinateOperation,
          sourceEncoding: options.sourceEncoding,
          zipFilenameEncoding: options.zipFilenameEncoding,
          targetEncoding: options.targetEncoding,
          datasetCreationOptions: options.datasetOption,
          layerCreationOptions: options.layerOption,
        },
        operationOptions,
      ));
      writeJson(result);
    });
  gis
    .command("validate")
    .description("Check vector geometry validity and simplicity with GDAL/GEOS")
    .requiredOption("--file <path>", "Input vector file")
    .option("--layer <name>", "Select a source layer in a multi-layer dataset")
    .option("--source-encoding <encoding>", "Override the source text encoding")
    .option("--zip-filename-encoding <encoding>", "Encoding of names stored inside a ZIP archive, such as UTF-8 or CP936")
    .option("--sample-limit <count>", "Maximum error locations to include", parsePositiveInteger, 20)
    .action(async (options: { file: string; layer?: string; sourceEncoding?: string; zipFilenameEncoding?: string; sampleLimit: number }) => {
      const report = await CoreService.fromEnvironment().checkGisGeometry(options.file, {
        sourceLayer: options.layer,
        sourceEncoding: options.sourceEncoding,
        zipFilenameEncoding: options.zipFilenameEncoding,
        sampleLimit: options.sampleLimit,
      });
      writeJson(report);
    });
  gis
    .command("import")
    .description("Import a vector file into SQLite/SpatiaLite, PostGIS, MySQL, MariaDB, SQL Server, or Oracle SDO_GEOMETRY")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--file <path>", "Input vector file")
    .requiredOption("--target <table|schema.table>", "Destination table; SQLite uses a single table name")
    .option("--layer <name>", "Select a source layer in a multi-layer dataset")
    .option("--field-map <source=target>", "Rename a source attribute field (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--field-type <source=type>", "Cast an attribute field to string, integer, integer64, real, date, time, or datetime (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--source-crs <crs>", "Supply or override the source CRS")
    .option("--target-crs <crs>", "Transform coordinates to this CRS")
    .option("--coordinate-operation <pipeline>", "Apply an explicit PROJ pipeline (requires --target-crs)")
    .option("--source-encoding <encoding>", "Override the source text encoding")
    .option("--zip-filename-encoding <encoding>", "Encoding of names stored inside a ZIP archive, such as UTF-8 or CP936")
    .option("--replace-incomplete-utf8-tails", "Replace only incomplete terminal UTF-8 code points in Shapefile text fields with '?' in a temporary copy")
    .option("--make-valid", "Repair invalid geometries before importing (may change geometry type)")
    .option("--create-spatial-index", "Create a SpatiaLite/GeoPackage RTree index or an engine-specific index; append requires a compatible existing index where supported")
    .option("--initialize-spatialite", "Explicitly initialize SpatiaLite metadata in an existing ordinary SQLite file (create mode only; existing tables are preserved)")
    .option("--bbox <minX,minY,maxX,maxY>", "Select features intersecting a rectangle in the source CRS")
    .addOption(new Option("--spatial-column-type <type>", "SQL Server spatial column type")
      .choices(["geometry", "geography"]))
    .addOption(
      new Option("--mode <mode>", "Destination table mode")
        .choices(["create", "append", "overwrite"])
        .default("create"),
    )
    .action(
      async (options: {
        connection: string;
        file: string;
        target: string;
        layer?: string;
        fieldMap: string[];
        fieldType: string[];
        sourceCrs?: string;
        targetCrs?: string;
        coordinateOperation?: string;
        sourceEncoding?: string;
        zipFilenameEncoding?: string;
        replaceIncompleteUtf8Tails?: boolean;
        makeValid?: boolean;
        createSpatialIndex?: boolean;
        initializeSpatialite?: boolean;
        bbox?: string;
        spatialColumnType?: "geometry" | "geography";
        mode: "create" | "append" | "overwrite";
      }) => {
        assertEnvironmentConnection(options.connection);
        const core = CoreService.fromEnvironment();
        const engine = configuredDatabaseType(process.env);
        if (options.spatialColumnType !== undefined && engine !== "sqlserver") {
          throw new Error("--spatial-column-type is only supported for SQL Server GIS import.");
        }
        if (options.createSpatialIndex && !["sqlite", "oracle", "mysql", "mariadb", "sqlserver"].includes(engine)) {
          throw new Error("--create-spatial-index is supported for SQLite/SpatiaLite, Oracle, MySQL, MariaDB, and SQL Server GIS imports.");
        }
        if (options.initializeSpatialite && engine !== "sqlite") {
          throw new Error("--initialize-spatialite is only supported for SQLite GIS imports.");
        }
        let report: unknown;
        const spatialFilter = options.bbox === undefined ? undefined : parseGisBoundingBox(options.bbox);
        if (engine === "sqlite") {
          report = await withGisProgress((operationOptions) => core.importGisToSqlite(
            options.file,
            options.target,
            {
              mode: options.mode,
              sourceLayer: options.layer,
              sourceCrs: options.sourceCrs,
              targetCrs: options.targetCrs,
              coordinateOperation: options.coordinateOperation,
              fieldMappings: parseGisFieldMappings(options.fieldMap, options.fieldType),
              spatialFilter,
              makeValid: options.makeValid,
              sourceEncoding: options.sourceEncoding,
              zipFilenameEncoding: options.zipFilenameEncoding,
              replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
              createSpatialIndex: options.createSpatialIndex,
              initializeSpatialite: options.initializeSpatialite,
            },
            operationOptions,
          ));
        } else if (engine === "mysql" || engine === "mariadb") {
          const targetParts = options.target.split(".");
          if (targetParts.length !== 2 || targetParts.some((part) => !part.trim())) {
            throw new Error("MySQL/MariaDB GIS target must use the form database.table.");
          }
          report = await withGisProgress((operationOptions) => core.importGisToMysqlFamily(
            options.file,
            targetParts[1]!,
            targetParts[0]!,
            {
              mode: options.mode,
              sourceLayer: options.layer,
              sourceCrs: options.sourceCrs,
              targetCrs: options.targetCrs,
              coordinateOperation: options.coordinateOperation,
              fieldMappings: parseGisFieldMappings(options.fieldMap, options.fieldType),
              spatialFilter,
              makeValid: options.makeValid,
              sourceEncoding: options.sourceEncoding,
              zipFilenameEncoding: options.zipFilenameEncoding,
              replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
              createSpatialIndex: options.createSpatialIndex,
            },
            operationOptions,
          ));
        } else if (engine === "sqlserver") {
          const targetParts = options.target.split(".");
          if (targetParts.length > 2 || targetParts.some((part) => !part.trim())) {
            throw new Error("SQL Server GIS target must use the form table or schema.table.");
          }
          const targetSchema = targetParts.length === 2 ? targetParts[0]! : "dbo";
          const targetTable = targetParts.length === 2 ? targetParts[1]! : targetParts[0]!;
          report = await withGisProgress((operationOptions) => core.importGisToSqlServer(
            options.file,
            targetTable,
            targetSchema,
            {
              mode: options.mode,
              sourceLayer: options.layer,
              sourceCrs: options.sourceCrs,
              targetCrs: options.targetCrs,
              coordinateOperation: options.coordinateOperation,
              fieldMappings: parseGisFieldMappings(options.fieldMap, options.fieldType),
              spatialFilter,
              makeValid: options.makeValid,
              sourceEncoding: options.sourceEncoding,
              zipFilenameEncoding: options.zipFilenameEncoding,
              replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
              spatialColumnType: options.spatialColumnType,
              createSpatialIndex: options.createSpatialIndex,
            },
            operationOptions,
          ));
        } else if (engine === "oracle") {
          const targetParts = options.target.split(".");
          if (targetParts.length !== 2 || targetParts.some((part) => !part.trim())) {
            throw new Error("Oracle GIS target must use the form schema.table.");
          }
          report = await withGisProgress((operationOptions) => core.importGisToOracle(
            options.file,
            targetParts[1]!,
            targetParts[0]!,
            {
              mode: options.mode,
              sourceLayer: options.layer,
              sourceCrs: options.sourceCrs,
              targetCrs: options.targetCrs,
              coordinateOperation: options.coordinateOperation,
              fieldMappings: parseGisFieldMappings(options.fieldMap, options.fieldType),
              spatialFilter,
              makeValid: options.makeValid,
              sourceEncoding: options.sourceEncoding,
              zipFilenameEncoding: options.zipFilenameEncoding,
              replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
              createSpatialIndex: options.createSpatialIndex,
            },
            operationOptions,
          ));
        } else {
          report = await withGisProgress((operationOptions) => core.importGisToPostgres(
            options.file,
            options.target,
            {
              mode: options.mode,
              sourceLayer: options.layer,
              sourceCrs: options.sourceCrs,
              targetCrs: options.targetCrs,
              coordinateOperation: options.coordinateOperation,
              sourceEncoding: options.sourceEncoding,
              zipFilenameEncoding: options.zipFilenameEncoding,
              replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
              makeValid: options.makeValid,
              spatialFilter,
              fieldMappings: parseGisFieldMappings(options.fieldMap, options.fieldType),
            },
            operationOptions,
          ));
        }
        writeJson(report);
      },
    );
  gis
    .command("export")
    .description("Export a SQLite/SpatiaLite, PostgreSQL/PostGIS, MySQL, MariaDB, SQL Server, or Oracle spatial table to a vector file")
    .option("--connection <name>", "Connection source", "environment")
    .requiredOption("--table <table|schema.table>", "Source spatial table; SQLite uses a single table name")
    .requiredOption("--output <path>", "Output vector file")
    .option("--target-layer <name>", "Name the output layer (defaults to the output file name)")
    .option("--source-crs <crs>", "Override or supply the source CRS when the database has no SRS definition")
    .option("--target-crs <crs>", "Transform coordinates to this CRS")
    .option("--bbox <minX,minY,maxX,maxY>", "Export features intersecting a rectangle in the source CRS")
    .option("--coordinate-operation <pipeline>", "Apply an explicit PROJ pipeline (requires --target-crs)")
    .option("--target-encoding <encoding>", "Encoding for Shapefile or MapInfo output (default UTF-8)")
    .option("--dataset-option <name=value>", "GDAL dataset creation option (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--layer-option <name=value>", "GDAL layer creation option (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--field-map <source=target>", "Rename a source attribute field (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--field-type <source=type>", "Cast an attribute field to string, integer, integer64, real, date, time, or datetime (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .action(async (options: { connection: string; table: string; output: string; targetLayer?: string; sourceCrs?: string; targetCrs?: string; bbox?: string; coordinateOperation?: string; targetEncoding?: string; datasetOption: string[]; layerOption: string[]; fieldMap: string[]; fieldType: string[] }) => {
      assertEnvironmentConnection(options.connection);
      const core = CoreService.fromEnvironment();
      const engine = configuredDatabaseType(process.env);
      const exportOptions = {
        targetLayerName: options.targetLayer,
        sourceCrs: options.sourceCrs,
        targetCrs: options.targetCrs,
        spatialFilter: options.bbox === undefined ? undefined : parseGisBoundingBox(options.bbox),
        coordinateOperation: options.coordinateOperation,
        targetEncoding: options.targetEncoding,
        datasetCreationOptions: options.datasetOption,
        layerCreationOptions: options.layerOption,
        fieldMappings: parseGisFieldMappings(options.fieldMap, options.fieldType),
      };
      const result = await withGisProgress((operationOptions) => {
        if (engine === "sqlite") {
          return core.exportGisFromSqlite(options.table, options.output, exportOptions, operationOptions);
        }
        if (engine === "mysql" || engine === "mariadb") {
          const parts = options.table.split(".");
          if (parts.length !== 2 || parts.some((part) => !part.trim())) {
            throw new Error("MySQL/MariaDB GIS source must use the form database.table.");
          }
          return core.exportGisFromMysqlFamily(parts[1]!, parts[0]!, options.output, exportOptions, operationOptions);
        }
        if (engine === "sqlserver") {
          const parts = options.table.split(".");
          if (parts.length !== 2 || parts.some((part) => !part.trim())) {
            throw new Error("SQL Server GIS source must use the form schema.table.");
          }
          return core.exportGisFromSqlServer(parts[1]!, parts[0]!, options.output, exportOptions, operationOptions);
        }
        if (engine === "oracle") {
          const parts = options.table.split(".");
          if (parts.length !== 2 || parts.some((part) => !part.trim())) {
            throw new Error("Oracle GIS source must use the form schema.table.");
          }
          return core.exportGisFromOracle(parts[1]!, parts[0]!, options.output, exportOptions, operationOptions);
        }
        return core.exportGisFromPostgres(options.table, options.output, exportOptions, operationOptions);
      });
      writeJson(result);
    });

  program.hook("preAction", async (_command, actionCommand) => {
    const connection = actionCommand.opts().connection;
    if (typeof connection === "string") await applyConnectionEnvironment(connection);
  });
  return program;
}

function addConnectionProfileOptions(command: Command): Command {
  return command
    .requiredOption("--name <name>", "Saved connection name")
    .addOption(new Option("--engine <engine>", "Database engine").choices(databaseEngines).makeOptionMandatory())
    .option("--host <host>", "Database host")
    .option("--port <port>", "Database port", parsePort)
    .option("--database <database>", "Default database")
    .option("--user <user>", "Database username")
    .option("--password-env <variable>", "Environment variable containing the password; its value is never saved")
    .option("--uri-env <variable>", "Environment variable containing a MongoDB URI; its value is never saved")
    .option("--path <path>", "SQLite database file path")
    .option("--service-name <name>", "Oracle service name")
    .option("--ssl", "Require TLS for PostgreSQL")
    .option("--no-encrypt", "Disable SQL Server TLS encryption")
    .option("--no-trust-server-certificate", "Validate the SQL Server certificate");
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be an integer between 1 and 65535.");
  return port;
}

function coreForDatabase(database?: string, environment: NodeJS.ProcessEnv = process.env): CoreService {
  if (!database) return CoreService.fromEnvironment(environment);
  const env = { ...environment };
  const databaseType = configuredDatabaseType(env);
  if (databaseType === "oracle") {
    throw new Error("Oracle --database selects a database service; configure ORACLE_SERVICE_NAME or ORACLE_CONNECT_STRING instead.");
  }
  if (databaseType === "sqlserver") {
    env.SQLSERVER_DATABASE = database;
    return CoreService.fromEnvironment(env);
  }
  if (databaseType === "sqlite") {
    return CoreService.fromEnvironment(env);
  }
  if (databaseType === "mysql" || databaseType === "mariadb") {
    const connectionUrl =
      databaseType === "mariadb"
        ? env.DBSTUDIO_MARIADB_URL || env.DBSTUDIO_MYSQL_URL || env.DBSTUDIO_DATABASE_URL || env.DATABASE_URL
        : env.DBSTUDIO_MYSQL_URL || env.DBSTUDIO_DATABASE_URL || env.DATABASE_URL;
    if (connectionUrl) {
      const url = new URL(connectionUrl);
      url.pathname = "/" + database;
      if (databaseType === "mariadb") env.DBSTUDIO_MARIADB_URL = url.toString();
      else env.DBSTUDIO_MYSQL_URL = url.toString();
      delete env.DBSTUDIO_DATABASE_URL;
      delete env.DATABASE_URL;
    } else {
      if (databaseType === "mariadb") env.MARIADB_DATABASE = database;
      else env.MYSQL_DATABASE = database;
    }
    return CoreService.fromEnvironment(env);
  }
  const connectionString = env.DBSTUDIO_DATABASE_URL || env.DATABASE_URL;
  if (connectionString) {
    const url = new URL(connectionString);
    url.pathname = "/" + database;
    env.DBSTUDIO_DATABASE_URL = url.toString();
    delete env.DATABASE_URL;
  } else {
    env.PGDATABASE = database;
  }
  return CoreService.fromEnvironment(env);
}

function redactModelBaseURL(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol + "//" + url.host + url.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

async function cliChatModelConfig(modelOverride?: string): Promise<ChatModelConfig> {
  const settings = await readDesktopAiModelSettings();
  const storedChat = settings?.enabled
    ? settings.chatModels.find((candidate) => candidate.id === settings.defaultChatModelId && candidate.enabled)
      ?? settings.chatModels.find((candidate) => candidate.enabled)
    : undefined;
  const baseURL = process.env.MODEL_OPENAI_BASE_URL || process.env.DBSTUDIO_AI_BASE_URL || storedChat?.baseURL;
  const model = modelOverride || process.env.MODEL_OPENAI_MODEL || process.env.DBSTUDIO_AI_MODEL || storedChat?.model;
  if (!baseURL || !model) throw new Error("Configure MODEL_OPENAI_BASE_URL and MODEL_OPENAI_MODEL or enable a chat model in DB Studio AI settings.");
  const temperature = Number(process.env.MODEL_OPENAI_TEMPERATURE ?? storedChat?.temperature ?? "0.2");
  const maxOutputTokens = Number(process.env.MODEL_OPENAI_MAX_OUTPUT_TOKENS ?? storedChat?.maxOutputTokens ?? "2048");
  const timeoutMs = Number(process.env.MODEL_OPENAI_TIMEOUT_MS ?? storedChat?.timeoutMs ?? "60000");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("MODEL_OPENAI_TEMPERATURE must be between 0 and 2.");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 16_384) throw new Error("MODEL_OPENAI_MAX_OUTPUT_TOKENS must be from 64 to 16384.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error("MODEL_OPENAI_TIMEOUT_MS must be from 1000 to 300000.");
  return {
    id: storedChat?.id ?? "environment",
    name: storedChat?.name ?? "Environment model",
    provider: storedChat?.provider ?? "openai-compatible",
    baseURL,
    model,
    apiKey: process.env.MODEL_OPENAI_API_KEY || process.env.DBSTUDIO_AI_API_KEY || storedChat?.apiKey || "",
    temperature,
    maxOutputTokens,
    timeoutMs,
    streaming: process.env.MODEL_OPENAI_STREAMING === "true" || storedChat?.streaming === true,
    enabled: true,
  };
}

function parseModelTimeout(value: string | undefined, variable: string): number {
  const timeout = Number(value ?? "60000");
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error(`${variable} must be from 1000 to 300000.`);
  }
  return timeout;
}

async function cliEmbeddingModelConfig(modelOverride?: string): Promise<EmbeddingModelConfig> {
  const settings = await readDesktopAiModelSettings();
  const storedEmbedding = settings?.enabled && settings.embedding?.enabled ? settings.embedding : undefined;
  const storedChat = settings?.enabled
    ? settings.chatModels.find((candidate) => candidate.id === settings.defaultChatModelId && candidate.enabled)
      ?? settings.chatModels.find((candidate) => candidate.enabled)
    : undefined;
  const baseURL = process.env.MODEL_EMBEDDING_BASE_URL || process.env.MODEL_OPENAI_BASE_URL || process.env.DBSTUDIO_AI_BASE_URL
    || storedEmbedding?.baseURL || storedChat?.baseURL;
  const model = modelOverride || process.env.MODEL_EMBEDDING_MODEL || storedEmbedding?.model;
  if (!baseURL || !model) throw new Error("Configure MODEL_EMBEDDING_BASE_URL and MODEL_EMBEDDING_MODEL or enable Embedding in DB Studio AI settings.");
  const dimensions = process.env.MODEL_EMBEDDING_DIMENSIONS
    ? Number(process.env.MODEL_EMBEDDING_DIMENSIONS) : storedEmbedding?.dimensions;
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8_192)) throw new Error("MODEL_EMBEDDING_DIMENSIONS must be from 1 to 8192.");
  return {
    provider: storedEmbedding?.provider ?? "openai-compatible",
    baseURL,
    model,
    apiKey: process.env.MODEL_EMBEDDING_API_KEY || process.env.MODEL_OPENAI_API_KEY || process.env.DBSTUDIO_AI_API_KEY
      || storedEmbedding?.apiKey || storedChat?.apiKey || "",
    dimensions,
    batchSize: storedEmbedding?.batchSize ?? 10,
    timeoutMs: parseModelTimeout(process.env.MODEL_EMBEDDING_TIMEOUT_MS ?? (storedEmbedding?.timeoutMs ? String(storedEmbedding.timeoutMs) : undefined), "MODEL_EMBEDDING_TIMEOUT_MS"),
    enabled: true,
  };
}

async function cliRerankModelConfig(modelOverride?: string): Promise<RerankModelConfig> {
  const settings = await readDesktopAiModelSettings();
  const storedRerank = settings?.enabled && settings.rerank?.enabled ? settings.rerank : undefined;
  const storedChat = settings?.enabled
    ? settings.chatModels.find((candidate) => candidate.id === settings.defaultChatModelId && candidate.enabled)
      ?? settings.chatModels.find((candidate) => candidate.enabled)
    : undefined;
  const baseURL = process.env.MODEL_RERANK_BASE_URL || process.env.MODEL_OPENAI_BASE_URL || process.env.DBSTUDIO_AI_BASE_URL
    || storedRerank?.baseURL || storedChat?.baseURL;
  const model = modelOverride || process.env.MODEL_RERANK_MODEL || storedRerank?.model;
  if (!baseURL || !model) throw new Error("Configure MODEL_RERANK_BASE_URL and MODEL_RERANK_MODEL or enable Rerank in DB Studio AI settings.");
  return {
    provider: storedRerank?.provider ?? "dashscope",
    baseURL,
    model,
    apiKey: process.env.MODEL_RERANK_API_KEY || process.env.MODEL_OPENAI_API_KEY || process.env.DBSTUDIO_AI_API_KEY
      || storedRerank?.apiKey || storedChat?.apiKey || "",
    timeoutMs: parseModelTimeout(process.env.MODEL_RERANK_TIMEOUT_MS ?? (storedRerank?.timeoutMs ? String(storedRerank.timeoutMs) : undefined), "MODEL_RERANK_TIMEOUT_MS"),
    enabled: true,
  };
}

async function cliSqlContext(
  connectionName: string,
  requestedSchema: string | undefined,
  request: string,
  requestedTables: string[],
): Promise<SqlAssistantContext> {
  const context = await cliEmptySqlContext(connectionName, requestedSchema);
  const core = CoreService.fromEnvironment();
  const available = await core.listTables(context.schema);
  const requestedKeys = requestedTables.map((name) => name.includes(".") ? name : context.schema + "." + name);
  const unknown = requestedKeys.filter((key) => !available.some((table) => context.schema + "." + table.name === key));
  if (unknown.length) throw new Error("Unknown table(s) in the selected schema: " + unknown.join(", "));
  const candidates = available.map((table) => ({
    schema: table.schema, name: table.name, type: table.type, comment: table.comment ?? undefined, columns: [],
  })) as SchemaTable[];
  const loadColumns = async (table: SchemaTable): Promise<SchemaTable> => {
    const columns = await core.getTableColumns(table.name, table.schema);
    return {
      ...table,
      columns: columns.slice(0, 160).map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        comment: column.comment ?? undefined,
      })),
    };
  };
  let relevant = selectRelevantTables(request, candidates, requestedKeys, 8);
  if (!relevant.length && !requestedKeys.length) {
    const loaded = await loadSchemaCandidateMetadata(candidates, loadColumns, { concurrency: 8 });
    if (loaded.failedCount) {
      context.metadataWarnings ??= [];
      context.metadataWarnings.push(`Could not read column metadata for ${loaded.failedCount} schema table(s); those tables were excluded from relevance search.`);
    }
    relevant = selectRelevantTables(request, loaded.tables, [], 8);
    if (!relevant.length) {
      throw new Error("No relevant table was identified after searching table names, comments, column names, and column comments. Pass --table to select schema context explicitly.");
    }
  } else if (!relevant.length) {
    throw new Error("No relevant table was identified. Pass --table to select schema context explicitly.");
  }
  const loadedByKey = new Map(relevant.map((table) => [`${table.schema}.${table.name}`, table]));
  context.tables = await Promise.all(relevant.map(async (candidate) => {
    const table = loadedByKey.get(`${candidate.schema}.${candidate.name}`)!;
    const withColumns = table.columns.length ? table : await loadColumns(table);
    const foreignKeys = await core.getTableForeignKeys(table.name, table.schema).catch(() => undefined);
    if (foreignKeys === undefined) {
      context.metadataWarnings ??= [];
      context.metadataWarnings.push(`Could not read foreign key metadata for ${table.schema}.${table.name}; do not assume a relationship.`);
    }
    return {
      ...withColumns,
      foreignKeys: (foreignKeys ?? []).slice(0, 40).map((foreignKey) => ({
        name: foreignKey.name,
        columns: foreignKey.columns,
        referencedSchema: foreignKey.referencedSchema,
        referencedTable: foreignKey.referencedTable,
        referencedColumns: foreignKey.referencedColumns,
      })),
    };
  }));
  if (context.engine === "postgres") {
    const { metadata, warnings } = await loadPostgisSchemaMetadata(
      (sql, parameters) => core.query(sql, parameters),
      context.schema ?? "public",
      context.tables,
    );
    context.postgis = metadata;
    if (warnings.length) context.metadataWarnings = [...(context.metadataWarnings ?? []), ...warnings];
  }
  return context;
}

async function cliEmptySqlContext(connectionName: string, requestedSchema?: string): Promise<SqlAssistantContext> {
  assertEnvironmentConnection(connectionName);
  const engine = configuredDatabaseType(process.env);
  if (engine === "mongodb") throw new Error("MongoDB uses Filter / Aggregate commands and is not supported by the SQL assistant.");
  const core = CoreService.fromEnvironment();
  const tested = await core.testConnection();
  const schemas = await core.listSchemas();
  const defaultSchema = engine === "sqlite" ? "main"
    : engine === "mysql" || engine === "mariadb" ? tested.database || schemas[0]
      : engine === "sqlserver" ? "dbo"
        : engine === "oracle" ? process.env.ORACLE_USER?.toUpperCase() || schemas[0]
          : "public";
  const schema = requestedSchema || defaultSchema;
  if (!schema || (requestedSchema && !schemas.includes(requestedSchema))) throw new Error("The requested schema is not visible to the current connection.");
  return { engine, serverVersion: tested.serverVersion, database: tested.database, schema, tables: [] };
}

function outputAiSql(response: Awaited<ReturnType<typeof runSqlAssistant>>, format: "sql" | "json"): void {
  if (format === "json") { writeJson(response); return; }
  if (response.validation && !response.validation.valid) throw new Error(response.validation.errors.join("\n"));
  const output = response.result.sql?.trim() ? response.result.sql : response.result.explanation;
  process.stdout.write(output + "\n");
  for (const warning of response.result.warnings ?? []) process.stderr.write("Warning: " + warning + "\n");
}

function hasPostgresEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DBSTUDIO_DATABASE_URL || env.DATABASE_URL || (env.PGDATABASE && env.PGUSER));
}

function hasConfiguredDatabase(env: NodeJS.ProcessEnv): boolean {
  const databaseType = configuredDatabaseType(env);
  if (databaseType === "sqlite") return Boolean(env.DBSTUDIO_SQLITE_PATH?.trim());
  if (databaseType === "mongodb") return Boolean(env.DBSTUDIO_MONGODB_URL || env.MONGODB_URI);
  if (databaseType === "sqlserver") return Boolean(env.DBSTUDIO_SQLSERVER_URL || env.SQLSERVER_URL || env.SQLSERVER_USER);
  if (databaseType === "oracle") {
    const hasConnection = Boolean(env.DBSTUDIO_ORACLE_CONNECT_STRING || env.ORACLE_CONNECT_STRING || (env.ORACLE_HOST && env.ORACLE_SERVICE_NAME));
    return Boolean(env.ORACLE_USER && env.ORACLE_PASSWORD && hasConnection);
  }
  if (databaseType === "mysql" || databaseType === "mariadb") {
    return Boolean(
      env.DBSTUDIO_MARIADB_URL ||
        env.DBSTUDIO_MYSQL_URL ||
        env.DBSTUDIO_DATABASE_URL ||
        env.DATABASE_URL ||
        env.MARIADB_USER ||
        env.MYSQL_USER,
    );
  }
  return hasPostgresEnvironment(env);
}

function configuredDatabaseType(env: NodeJS.ProcessEnv): "postgres" | "sqlite" | "mysql" | "mariadb" | "mongodb" | "sqlserver" | "oracle" {
  const value = env.DBSTUDIO_DATABASE_TYPE?.trim().toLowerCase();
  if (value === "sqlite") return "sqlite";
  if (value === "mysql" || value === "mysql2") return "mysql";
  if (value === "mariadb") return "mariadb";
  if (value === "mongodb") return "mongodb";
  if (value === "sqlserver" || value === "mssql") return "sqlserver";
  if (value === "oracle") return "oracle";
  return "postgres";
}

function assertEnvironmentConnection(name: string): void {
  if (name !== "environment" && name !== "default" && !name) throw new Error("Connection name cannot be empty.");
  if (!hasConfiguredDatabase(process.env)) {
    if (configuredDatabaseType(process.env) === "sqlite") {
      throw new Error("Configure SQLite with DBSTUDIO_SQLITE_PATH.");
    }
    if (configuredDatabaseType(process.env) === "mysql") {
      throw new Error("Configure MySQL with DBSTUDIO_MYSQL_URL or MYSQL_USER and MYSQL_HOST.");
    }
    if (configuredDatabaseType(process.env) === "mariadb") {
      throw new Error("Configure MariaDB with DBSTUDIO_MARIADB_URL or MARIADB_USER and MARIADB_HOST.");
    }
    if (configuredDatabaseType(process.env) === "mongodb") {
      throw new Error("Configure MongoDB with DBSTUDIO_MONGODB_URL or MONGODB_URI.");
    }
    if (configuredDatabaseType(process.env) === "sqlserver") {
      throw new Error("Configure SQL Server with DBSTUDIO_SQLSERVER_URL or SQLSERVER_USER and SQLSERVER_HOST.");
    }
    if (configuredDatabaseType(process.env) === "oracle") {
      throw new Error("Configure Oracle with ORACLE_USER and ORACLE_CONNECT_STRING, or ORACLE_HOST and ORACLE_SERVICE_NAME.");
    }
    throw new Error("Configure PostgreSQL with DATABASE_URL or PGDATABASE and PGUSER.");
  }
}

function assertMongoConnection(name: string): void {
  assertEnvironmentConnection(name);
  if (configuredDatabaseType(process.env) !== "mongodb") {
    throw new Error("Set DBSTUDIO_DATABASE_TYPE=mongodb to use MongoDB document commands.");
  }
}

function parseMongoDocument(json: string, label: string): Record<string, unknown> {
  const value = parseMongoEjson(json, `MongoDB ${label}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`MongoDB ${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new Error("Count must be an integer from 0 to 1000000.");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new Error("Limit must be an integer from 1 to 100000.");
  }
  return parsed;
}

function parseTableTransferMappings(entries: string[]): Array<{ sourceColumn: string; targetColumn: string }> {
  const seenSources = new Set<string>();
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    const sourceColumn = entry.slice(0, separator).trim();
    const targetColumn = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!sourceColumn || !targetColumn) throw new Error("--map must use source=target.");
    if (seenSources.has(sourceColumn)) throw new Error(`--map is repeated for source column '${sourceColumn}'.`);
    seenSources.add(sourceColumn);
    return { sourceColumn, targetColumn };
  });
}

function parseGisBoundingBox(value: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const parts = value.split(",").map((part) => part.trim());
  const numbers = parts.map(Number);
  if (parts.length !== 4 || parts.some((part) => !part) || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error("--bbox requires four finite coordinates: minX,minY,maxX,maxY.");
  }
  const [minX, minY, maxX, maxY] = numbers as [number, number, number, number];
  if (minX >= maxX || minY >= maxY) {
    throw new Error("--bbox minimum bounds must be smaller than maximum bounds.");
  }
  return { minX, minY, maxX, maxY };
}

function parseGisFieldMappings(
  fieldMaps: string[],
  fieldTypes: string[],
): Array<{ source: string; target: string; targetType?: "string" | "integer" | "integer64" | "real" | "date" | "time" | "datetime" }> {
  const mappings = new Map<string, { source: string; target: string; targetType?: "string" | "integer" | "integer64" | "real" | "date" | "time" | "datetime" }>();
  const readPair = (entry: string, option: string): [string, string] => {
    const separator = entry.indexOf("=");
    const source = entry.slice(0, separator).trim();
    const value = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!source || !value) throw new Error(`${option} must use source=value.`);
    return [source, value];
  };
  for (const entry of fieldMaps) {
    const [source, target] = readPair(entry, "--field-map");
    const current = mappings.get(source);
    if (current && current.target !== source) throw new Error(`--field-map is repeated for source field ${source}.`);
    mappings.set(source, { source, target, ...(current?.targetType ? { targetType: current.targetType } : {}) });
  }
  const supportedTypes = new Set(["string", "integer", "integer64", "real", "date", "time", "datetime"]);
  for (const entry of fieldTypes) {
    const [source, rawType] = readPair(entry, "--field-type");
    if (mappings.get(source)?.targetType) throw new Error(`--field-type is repeated for source field ${source}.`);
    const targetType = rawType.toLowerCase();
    if (!supportedTypes.has(targetType)) {
      throw new Error("--field-type must be one of string, integer, integer64, real, date, time, or datetime.");
    }
    const current = mappings.get(source);
    mappings.set(source, { source, target: current?.target ?? source, targetType: targetType as "string" | "integer" | "integer64" | "real" | "date" | "time" | "datetime" });
  }
  return [...mappings.values()];
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (error instanceof GisOperationError) {
      process.stderr.write(JSON.stringify({ error: message, report: error.report }, null, 2) + "\n");
      process.exitCode = error.report.status === "cancelled" ? 130 : 1;
    } else {
      process.stderr.write(message + "\n");
      process.exitCode = 1;
    }
  });
}

async function withGisProgress<T>(run: (options: GdalOperationOptions) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let lastPercent = -1;
  let printedProgress = false;
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    return await run({
      signal: controller.signal,
      onProgress: (percent) => {
        const rounded = Math.floor(percent);
        if (rounded <= lastPercent) return;
        lastPercent = rounded;
        printedProgress = true;
        process.stderr.write(`\rGIS ${rounded}%`);
      },
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    if (printedProgress) process.stderr.write("\n");
  }
}
