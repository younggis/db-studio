// Phase 2.2: shared IPC argument contracts. Both the preload boundary and the
// renderer import these schemas so a type change breaks compilation and an
// invalid runtime call is rejected with a structured error.
import { z } from "zod";

const identifier = z.string().min(1).max(256);
const optionalIdentifier = z.string().max(256).optional();
const boundedText = z.string().max(200_000);
const parameters = z.array(z.unknown()).max(2_000).optional();

export const connectionProfileSchema = z.object({
  id: z.string().optional(),
  name: identifier,
  engine: z.enum(["postgres", "mysql", "mariadb", "sqlite", "sqlserver", "oracle", "mongodb"]),
  host: z.string().max(512).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().max(256).optional(),
  user: z.string().max(256).optional(),
  password: z.string().max(4096).optional(),
  uri: z.string().max(4096).optional(),
  path: z.string().max(2048).optional(),
  ssl: z.boolean().optional(),
  encrypt: z.boolean().optional(),
  trustServerCertificate: z.boolean().optional(),
  ssh: z.object({
    enabled: z.boolean(),
    host: z.string().max(512).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(256).optional(),
    authentication: z.enum(["password", "privateKey"]).optional(),
    hostFingerprint: z.string().max(512).optional(),
    password: z.string().max(4096).optional(),
    privateKey: z.string().max(1_000_000).optional(),
    passphrase: z.string().max(4096).optional(),
  }).optional(),
}).strict();

export const tableRowChangeSchema = z.object({
  primaryKeyValues: z.record(z.string(), z.unknown()),
  values: z.record(z.string(), z.unknown()),
}).strict();

export const columnMappingSchema = z.object({
  sourceColumn: identifier,
  targetColumn: identifier,
}).strict();

export const ipcArgSchemas = {
  "connections:save": z.tuple([connectionProfileSchema]),
  "connections:remove": z.tuple([identifier]),
  "connections:test": z.tuple([identifier]),
  "connections:list": z.tuple([]),
  "database:query": z.tuple([identifier, boundedText, parameters]),
  "database:tables": z.tuple([identifier, optionalIdentifier, z.object({ limit: z.number().int().min(0).max(5_000) }).optional()]),
  "database:columns": z.tuple([identifier, identifier, optionalIdentifier]),
  "database:update-rows": z.tuple([identifier, z.object({
    schema: identifier,
    table: identifier,
    changes: z.array(tableRowChangeSchema).max(100),
  }).strict()]),
  "database:transfer-table": z.tuple([identifier, z.object({
    targetConnectionId: identifier,
    sourceTable: identifier,
    sourceSchema: optionalIdentifier,
    targetTable: identifier,
    targetSchema: optionalIdentifier,
    pageSize: z.number().int().min(1).max(10_000).optional(),
    columnMappings: z.array(columnMappingSchema).max(1000).optional(),
  }).strict()]),
  "query-history:record": z.tuple([z.object({
    id: z.string().optional(),
    connectionId: z.string().optional(),
    connectionName: z.string().optional(),
    engine: z.string().optional(),
    sql: z.string(),
    executedAt: z.string().optional(),
    command: z.string().optional(),
    rowCount: z.number().optional(),
    durationMs: z.number().optional(),
    outcome: z.enum(["success", "error"]).optional(),
  }).passthrough()]),
  "query-history:clear": z.tuple([identifier.optional()]),
  "query-history:favorite:remove": z.tuple([identifier]),
  "ai:model:test": z.tuple([z.enum(["chat", "embedding", "rerank"]), z.record(z.string(), z.unknown())]),
  "ai:schema-index:build": z.tuple([identifier, identifier, z.array(identifier).max(1000), identifier]),
  "ai:schema-index:clear": z.tuple([identifier, identifier]),
  "ai:assistant:run": z.tuple([z.object({
    requestId: identifier,
    connectionId: identifier,
    modelId: optionalIdentifier,
    task: z.enum(["generate", "repair", "explain", "explain-plan", "optimize", "gis"]),
    request: z.string().max(20_000),
    schema: optionalIdentifier,
    schemas: z.array(identifier).max(32).optional(),
    selectedTables: z.array(identifier).max(1000).optional(),
    includeSchema: z.boolean(),
    refreshSchema: z.boolean().optional(),
    selectedSql: boundedText.optional(),
    executionPlan: boundedText.optional(),
    error: z.object({ code: z.string().optional(), message: z.string(), position: z.number().optional() }).optional(),
  }).strict()]),
  "mongo:find": z.tuple([identifier, identifier, identifier, z.record(z.string(), z.unknown()).optional()]),
  "mongo:aggregate": z.tuple([identifier, identifier, identifier, z.array(z.record(z.string(), z.unknown())).max(1000), z.number().int().min(1).max(1000)]),
  "mongo:delete-document": z.tuple([identifier, identifier, identifier, z.string().min(1).max(20_000)]),
  "mongo:replace-document": z.tuple([identifier, identifier, identifier, z.string().min(1).max(20_000), boundedText]),
  "gis:import": z.tuple([identifier, z.string().min(1).max(4096), identifier, z.record(z.string(), z.unknown()), identifier.optional()]),
  "gis:export": z.tuple([identifier, identifier, z.string().min(1).max(4096), z.record(z.string(), z.unknown()).optional(), identifier.optional()]),
} as const;

export type IpcChannel = keyof typeof ipcArgSchemas;

export interface IpcValidationError {
  channel: string;
  issues: Array<{ path: string; message: string }>;
}

export function validateIpcArgs(channel: IpcChannel, args: unknown[]): IpcValidationError | undefined {
  const schema = ipcArgSchemas[channel];
  const result = schema.safeParse(args);
  if (result.success) return undefined;
  return {
    channel,
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}

export function assertIpcArgs(channel: IpcChannel, args: unknown[]): void {
  const error = validateIpcArgs(channel, args);
  if (error) {
    const detail = error.issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid IPC arguments for ${error.channel}: ${detail}`);
  }
}
