import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { applyPostgisSpatialMetadata, createEmbedding, emptySchemaIndex, findSchemaIndexTableCoverageDifferences, findStaleSchemaIndexTableKeys, isSchemaIndexSnapshot, loadPostgisSchemaMetadata, loadSchemaCandidateMetadata, rankSchemaCandidatesByRerank, replaceSchemaIndexChunks, rerank, runMongoAssistant, runSqlAssistant, schemaIndexScope, schemaModelFingerprint, schemaTableDocument, schemaTableDocumentChunks, searchSchemaIndex, selectRelevantTables, testChatModel, testEmbeddingModel, testRerankModel } from "@db-studio/ai";
import { schemaTableKey } from "@db-studio/shared/schema-table-key";
import type { AiModelSettings, ChatModelConfig, EmbeddingModelConfig, MongoAssistantRequest, MongoAssistantTask, MongoQueryMode, PostgisSchemaMetadata, PublicAiModelSettings, RerankModelConfig, SchemaIndexSnapshot, SchemaTable, SqlAssistantContext, SqlAssistantTask } from "@db-studio/ai";
import { CoreService, GisOperationError, MongoDocumentService, stringifyMongoJson } from "@db-studio/core";
import { SshTunnelManager, validateSshTunnelConfig } from "@db-studio/database";
import type { MySqlConnectionConfig, OracleConnectionConfig, PostgresConnectionConfig, SshTunnelConfig, SqliteConnectionConfig, SqlServerConnectionConfig } from "@db-studio/database";
import type { DatabaseEngine, QueryHistorySnapshot, TableRowChange } from "@db-studio/shared";
import { parseExcelWorkbook, parseTabularData, queryResultToCsv, queryResultToXlsx } from "@db-studio/shared";
import {
  appendQueryHistory,
  clearQueryHistory,
  createEmptyQueryHistorySnapshot,
  normalizeQueryHistorySnapshot,
  removeQueryFavorite,
  upsertQueryFavorite,
} from "@db-studio/shared";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAsyncSerialQueue } from "./async-serial-queue.js";
import { finishAiOperation, handleAiCancellationRequest, registerAiOperation, throwIfAiOperationCancelled } from "./ai-operation-registry.js";
import { assertConnectionStoreShape, backupAndResetUnreadableConnectionStore, ConnectionStoreUnreadableError } from "./connection-store-recovery.js";
import { commitConnectionRemoval } from "./connection-store-mutations.js";

const userDataOverride = process.env.DBSTUDIO_USER_DATA_DIR?.trim();
if (userDataOverride) {
  const userDataPath = path.resolve(userDataOverride);
  const sessionDataPath = path.join(userDataPath, "session");
  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(sessionDataPath, { recursive: true });
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
}

interface SavedConnection {
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
  ssh?: SshTunnelConfig;
}

interface SshConnectionDraft extends SshTunnelConfig {
  enabled: boolean;
}

const desktopEngines = new Set<DatabaseEngine>(["postgres", "mysql", "sqlite", "mariadb", "mongodb", "sqlserver", "oracle"]);
const sshTunnelManager = new SshTunnelManager();
const activeGisOperations = new Map<string, { senderId: number; controller: AbortController }>();
const activeAiOperations = new Map<string, import("./ai-operation-registry.js").ActiveAiOperation>();
const aiSchemaMetadataCache = new Map<string, { fetchedAt: number; table: SchemaTable; warnings: string[] }>();
const aiSettingsHeader = Buffer.from("DBSTUDIO\0AI-MODELS\0V1\0", "utf8");
const aiDpapiHeader = Buffer.concat([aiSettingsHeader, Buffer.from("DPAPI\0", "ascii")]);
const aiSafeStorageHeader = Buffer.concat([aiSettingsHeader, Buffer.from("SAFE-STORAGE\0", "ascii")]);
const aiSchemaIndexHeader = Buffer.from("DBSTUDIO\0AI-SCHEMA-INDEX\0V1\0", "utf8");
const aiSchemaIndexDpapiHeader = Buffer.concat([aiSchemaIndexHeader, Buffer.from("DPAPI\0", "ascii")]);
const aiSchemaIndexSafeStorageHeader = Buffer.concat([aiSchemaIndexHeader, Buffer.from("SAFE-STORAGE\0", "ascii")]);
const queryHistoryHeader = Buffer.from("DBSTUDIO\0QUERY-HISTORY\0V1\0", "utf8");
const queryHistoryDpapiHeader = Buffer.concat([queryHistoryHeader, Buffer.from("DPAPI\0", "ascii")]);
const queryHistorySafeStorageHeader = Buffer.concat([queryHistoryHeader, Buffer.from("SAFE-STORAGE\0", "ascii")]);

const connectionsPath = () => path.join(app.getPath("userData"), "connections.enc");
const aiSettingsPath = () => path.join(app.getPath("userData"), "ai-models.enc");
const aiSchemaIndexPath = () => path.join(app.getPath("userData"), "ai-schema-index.enc");
const queryHistoryPath = () => path.join(app.getPath("userData"), "query-history.enc");
let queryHistoryMutationQueue: Promise<void> = Promise.resolve();
// Keep connection read-modify-write transactions and legacy rewrites ordered;
// ordinary reads remain concurrent unless they need to rewrite the store.
const runConnectionStoreOperation = createAsyncSerialQueue();

function clearAiSchemaCache(connectionId: string): void {
  for (const key of aiSchemaMetadataCache.keys()) {
    if (key.startsWith(connectionId + "\0")) aiSchemaMetadataCache.delete(key);
  }
}

async function getAiSchemaTable(
  core: CoreService,
  connectionId: string,
  table: { schema: string; name: string; type: "table" | "view"; comment?: string | null },
  refresh: boolean,
): Promise<{ table: SchemaTable; warnings: string[] }> {
  const key = [connectionId, table.schema, table.name].join("\0");
  const cached = aiSchemaMetadataCache.get(key);
  if (!refresh && cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
    return { table: cached.table, warnings: [...cached.warnings] };
  }
  const [columns, foreignKeys] = await Promise.all([
    core.getTableColumns(table.name, table.schema),
    core.getTableForeignKeys(table.name, table.schema).catch(() => undefined),
  ]);
  const warnings = foreignKeys === undefined ? ["未能读取 " + table.schema + "." + table.name + " 的外键元数据；助手不得假设关联关系。"] : [];
  const result: SchemaTable = {
    ...table,
    columns: columns.map((column) => ({
      name: column.name, dataType: column.dataType, nullable: column.nullable, primaryKey: column.primaryKey,
      comment: column.comment ?? undefined,
    })),
    comment: table.comment ?? undefined,
    foreignKeys: (foreignKeys ?? []).map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns,
      referencedSchema: foreignKey.referencedSchema,
      referencedTable: foreignKey.referencedTable,
      referencedColumns: foreignKey.referencedColumns,
    })),
  };
  if (aiSchemaMetadataCache.size >= 500) {
    const oldest = aiSchemaMetadataCache.keys().next().value;
    if (oldest) aiSchemaMetadataCache.delete(oldest);
  }
  aiSchemaMetadataCache.set(key, { fetchedAt: Date.now(), table: result, warnings });
  return { table: result, warnings: [...warnings] };
}

async function getPostgisSchemaMetadata(
  core: CoreService,
  schema: string,
  tables: SchemaTable[],
): Promise<Awaited<ReturnType<typeof loadPostgisSchemaMetadata>>> {
  return loadPostgisSchemaMetadata((sql, parameters) => core.query(sql, parameters), schema, tables);
}
const here = path.dirname(fileURLToPath(import.meta.url));

function configureGdalRuntime(): void {
  const bundledRoot = app.isPackaged
    ? path.join(process.resourcesPath, "gdal")
    : path.resolve(here, "../../resources/gdal");
  const bundledBin = path.join(bundledRoot, "bin");
  const configuredBin = process.env.DBSTUDIO_GDAL_BIN;
  const hasConfiguredRuntime = Boolean(configuredBin && existsSync(path.join(configuredBin, "ogr2ogr.exe")));
  const hasBundledRuntime = existsSync(path.join(bundledBin, "ogr2ogr.exe"));
  const binaryDirectory = hasConfiguredRuntime ? configuredBin! : hasBundledRuntime ? bundledBin : undefined;
  if (!binaryDirectory) return;

  process.env.DBSTUDIO_GDAL_BIN = binaryDirectory;
  process.env.PATH = [binaryDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);
  if (hasBundledRuntime && !hasConfiguredRuntime) {
    const gdalData = path.join(bundledRoot, "data");
    const projData = path.join(bundledRoot, "proj");
    if (!process.env.GDAL_DATA && existsSync(gdalData)) process.env.GDAL_DATA = gdalData;
    if (!process.env.PROJ_DATA && existsSync(projData)) process.env.PROJ_DATA = projData;
    if (!process.env.PROJ_LIB && existsSync(projData)) process.env.PROJ_LIB = process.env.PROJ_DATA ?? projData;
  }
}

configureGdalRuntime();
const dpapiHeader = Buffer.concat([connectionFileHeader, Buffer.from("DPAPI\0", "ascii")]);
const safeStorageHeader = Buffer.concat([connectionFileHeader, Buffer.from("SAFE-STORAGE\0", "ascii")]);

async function runWindowsDpapi(operation: "protect" | "unprotect", value: Buffer, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  // Use user-scoped DPAPI on Windows so the ciphertext survives Electron profile restarts.
  if (process.platform !== "win32") throw new Error("Windows DPAPI is only available on Windows.");
  if (value.length > maxBytes) throw new Error("Encrypted configuration exceeds the secure storage limit.");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$encoded = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($encoded)",
    operation === "protect"
      ? "$result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)"
      : "$result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join("; ");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output: Buffer[] = [];
    let outputLength = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill();
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      outputLength += chunk.length;
      if (outputLength > 4 * 1024 * 1024) {
        fail(new Error("Windows DPAPI returned an oversized result."));
        return;
      }
      output.push(chunk);
    });
    child.once("error", () => fail(new Error("Could not start Windows secure storage.")));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Windows secure storage operation failed."));
        return;
      }
      const encoded = Buffer.concat(output).toString("ascii").trim();
      if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
        reject(new Error("Windows secure storage returned invalid data."));
        return;
      }
      const result = Buffer.from(encoded, "base64");
      if (!result.length) {
        reject(new Error("Windows secure storage returned empty data."));
        return;
      }
      resolve(result);
    });
    child.stdin.once("error", () => fail(new Error("Could not send data to Windows secure storage.")));
    child.stdin.end(value.toString("base64"), "utf8");
    timer = setTimeout(() => fail(new Error("Windows secure storage operation timed out.")), 15_000);
    timer.unref();
  });
}

async function readConnectionsFromStore(): Promise<{ connections: SavedConnection[]; needsRewrite: boolean }> {
  try {
    const encrypted = await readFile(connectionsPath());
    const hasDpapiHeader = encrypted.subarray(0, dpapiHeader.length).equals(dpapiHeader);
    const hasSafeStorageHeader = encrypted.subarray(0, safeStorageHeader.length).equals(safeStorageHeader);
    let plaintext: string;
    let needsRewrite = !hasDpapiHeader && !hasSafeStorageHeader;

    if (hasDpapiHeader) {
      try {
        plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(dpapiHeader.length))).toString("utf8");
      } catch (error) {
        throw new ConnectionStoreUnreadableError("连接配置无法由当前 Windows 用户解密。", { cause: error });
      }
    } else {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error("系统安全存储不可用，无法安全读取连接配置。");
      }
      const ciphertext = hasSafeStorageHeader ? encrypted.subarray(safeStorageHeader.length) : encrypted;
      let decrypted: Awaited<ReturnType<typeof safeStorage.decryptStringAsync>>;
      try {
        decrypted = await safeStorage.decryptStringAsync(ciphertext);
      } catch (error) {
        throw new ConnectionStoreUnreadableError("连接配置无法由当前系统安全存储解密。", { cause: error });
      }
      plaintext = decrypted.result;
      needsRewrite ||= decrypted.shouldReEncrypt;
    }

    let saved: unknown;
    try {
      saved = JSON.parse(plaintext) as unknown;
    } catch (error) {
      throw new ConnectionStoreUnreadableError("连接配置解密后不是有效的连接数据。", { cause: error });
    }
    assertConnectionStoreShape(saved);
    const normalized = saved.map((connection) => ({
      ...connection,
      engine: connection.engine ?? "postgres",
      name: connection.name ?? "",
      password: connection.password ?? "",
    })) as SavedConnection[];
    return { connections: normalized, needsRewrite };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connections: [], needsRewrite: false };
    throw error;
  }
}

async function readConnections(): Promise<SavedConnection[]> {
  const current = await readConnectionsFromStore();
  if (!current.needsRewrite) return current.connections;
  return runConnectionStoreOperation(async () => {
    const latest = await readConnectionsFromStore();
    if (latest.needsRewrite) await writeConnections(latest.connections);
    return latest.connections;
  });
}

async function writeConnections(connections: SavedConnection[]): Promise<void> {
  const serialized = Buffer.from(JSON.stringify(connections), "utf8");
  let encrypted: Buffer;
  if (process.platform === "win32") {
    encrypted = Buffer.concat([dpapiHeader, await runWindowsDpapi("protect", serialized)]);
  } else {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("系统安全存储不可用，连接密码未保存。");
    }
    encrypted = Buffer.concat([safeStorageHeader, await safeStorage.encryptStringAsync(serialized.toString("utf8"))]);
  }
  const file = connectionsPath();
  const temporaryFile = `${file}.tmp`;
  await writeFile(temporaryFile, encrypted, { mode: 0o600 });
  try {
    await rename(temporaryFile, file);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    // Some Windows profile directories reject rename; preserve encryption with a copy fallback.
    await copyFile(temporaryFile, file);
    await unlink(temporaryFile).catch(() => undefined);
  }
}

function emptyAiSettings(): AiModelSettings {
  return { enabled: false, chatModels: [], embedding: undefined, rerank: undefined };
}

async function readAiModelSettings(): Promise<AiModelSettings> {
  let encrypted: Buffer;
  try { encrypted = await readFile(aiSettingsPath()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAiSettings();
    throw error;
  }
  const hasDpapi = encrypted.subarray(0, aiDpapiHeader.length).equals(aiDpapiHeader);
  const hasSafeStorage = encrypted.subarray(0, aiSafeStorageHeader.length).equals(aiSafeStorageHeader);
  let plaintext: string;
  if (hasDpapi) plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(aiDpapiHeader.length))).toString("utf8");
  else {
    if (!hasSafeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("AI 模型配置无法通过系统安全存储解密。");
    plaintext = (await safeStorage.decryptStringAsync(encrypted.subarray(aiSafeStorageHeader.length))).result;
  }
  const value = JSON.parse(plaintext) as Partial<AiModelSettings>;
  if (!Array.isArray(value.chatModels)) throw new Error("AI 模型配置文件格式无效。");
  return {
    enabled: value.enabled === true,
    chatModels: value.chatModels.filter((model): model is ChatModelConfig => Boolean(
      model && typeof model.id === "string" && typeof model.baseURL === "string" && typeof model.model === "string" && typeof model.apiKey === "string",
    )),
    defaultChatModelId: typeof value.defaultChatModelId === "string" ? value.defaultChatModelId : undefined,
    embedding: value.embedding && typeof value.embedding.baseURL === "string" && typeof value.embedding.model === "string"
      ? value.embedding as EmbeddingModelConfig : undefined,
    rerank: value.rerank && typeof value.rerank.baseURL === "string" && typeof value.rerank.model === "string"
      ? value.rerank as RerankModelConfig : undefined,
  };
}

async function writeAiModelSettings(settings: AiModelSettings): Promise<void> {
  const serialized = JSON.stringify(settings);
  let encrypted: Buffer;
  if (process.platform === "win32") encrypted = Buffer.concat([aiDpapiHeader, await runWindowsDpapi("protect", Buffer.from(serialized, "utf8"))]);
  else {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统安全存储不可用，AI API Key 未保存。");
    encrypted = Buffer.concat([aiSafeStorageHeader, await safeStorage.encryptStringAsync(serialized)]);
  }
  const file = aiSettingsPath();
  const temporaryFile = file + ".tmp";
  await writeFile(temporaryFile, encrypted, { mode: 0o600 });
  try { await rename(temporaryFile, file); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    await copyFile(temporaryFile, file);
    await unlink(temporaryFile).catch(() => undefined);
  }
}

async function readAiSchemaIndex(): Promise<SchemaIndexSnapshot> {
  let encrypted: Buffer;
  try { encrypted = await readFile(aiSchemaIndexPath()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySchemaIndex();
    throw error;
  }
  if (encrypted.length > 34 * 1024 * 1024) throw new Error("本机 Schema 索引文件超过安全上限。");
  const hasDpapi = encrypted.subarray(0, aiSchemaIndexDpapiHeader.length).equals(aiSchemaIndexDpapiHeader);
  const hasSafeStorage = encrypted.subarray(0, aiSchemaIndexSafeStorageHeader.length).equals(aiSchemaIndexSafeStorageHeader);
  let plaintext: string;
  if (hasDpapi) {
    plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(aiSchemaIndexDpapiHeader.length), 32 * 1024 * 1024)).toString("utf8");
  } else {
    if (!hasSafeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("本机 Schema 索引无法通过系统安全存储解密。");
    plaintext = (await safeStorage.decryptStringAsync(encrypted.subarray(aiSchemaIndexSafeStorageHeader.length))).result;
  }
  const value: unknown = JSON.parse(plaintext);
  if (!isSchemaIndexSnapshot(value)) throw new Error("本机 Schema 索引格式无效；请重新建立所选表索引。");
  return value;
}

async function writeAiSchemaIndex(snapshot: SchemaIndexSnapshot, signal?: AbortSignal): Promise<void> {
  const serialized = Buffer.from(JSON.stringify(snapshot), "utf8");
  if (serialized.length > 32 * 1024 * 1024) throw new Error("本机 Schema 索引超过 32 MiB 安全上限，请减少已索引表数量。");
  let encrypted: Buffer;
  if (process.platform === "win32") {
    encrypted = Buffer.concat([aiSchemaIndexDpapiHeader, await runWindowsDpapi("protect", serialized, 32 * 1024 * 1024)]);
  } else {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统安全存储不可用，Schema 索引未保存。");
    encrypted = Buffer.concat([aiSchemaIndexSafeStorageHeader, await safeStorage.encryptStringAsync(serialized.toString("utf8"))]);
  }
  if (signal?.aborted) throw new Error("AI 请求已取消。");
  const file = aiSchemaIndexPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temporaryFile, encrypted, { mode: 0o600 }); }
  catch (error) {
    await unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
  try {
    if (signal?.aborted) throw new Error("AI 请求已取消。");
    await rename(temporaryFile, file);
  }
  catch (error) {
    if (signal?.aborted) {
      await unlink(temporaryFile).catch(() => undefined);
      throw new Error("AI 请求已取消。");
    }
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    await copyFile(temporaryFile, file);
    await unlink(temporaryFile).catch(() => undefined);
  }
}

async function readQueryHistorySnapshot(): Promise<QueryHistorySnapshot> {
  let encrypted: Buffer;
  try { encrypted = await readFile(queryHistoryPath()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyQueryHistorySnapshot();
    throw error;
  }
  if (encrypted.length > 2 * 1024 * 1024) throw new Error("本机查询历史文件超过安全上限。");
  const hasDpapi = encrypted.subarray(0, queryHistoryDpapiHeader.length).equals(queryHistoryDpapiHeader);
  const hasSafeStorage = encrypted.subarray(0, queryHistorySafeStorageHeader.length).equals(queryHistorySafeStorageHeader);
  let plaintext: string;
  if (hasDpapi) {
    plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(queryHistoryDpapiHeader.length))).toString("utf8");
  } else {
    if (!hasSafeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("本机查询历史无法通过系统安全存储解密。");
    }
    plaintext = (await safeStorage.decryptStringAsync(encrypted.subarray(queryHistorySafeStorageHeader.length))).result;
  }
  return normalizeQueryHistorySnapshot(JSON.parse(plaintext) as unknown);
}

async function writeQueryHistorySnapshot(snapshot: QueryHistorySnapshot): Promise<void> {
  const serialized = Buffer.from(JSON.stringify(snapshot), "utf8");
  const maxPlaintextBytes = 1800 * 1024;
  if (serialized.length > maxPlaintextBytes) throw new Error("本机查询历史超过安全存储上限，请清理较早记录或收藏较短 SQL。");
  let encrypted: Buffer;
  if (process.platform === "win32") {
    encrypted = Buffer.concat([queryHistoryDpapiHeader, await runWindowsDpapi("protect", serialized, maxPlaintextBytes)]);
  } else {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统安全存储不可用，查询历史未保存。");
    encrypted = Buffer.concat([queryHistorySafeStorageHeader, await safeStorage.encryptStringAsync(serialized.toString("utf8"))]);
  }
  const file = queryHistoryPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  await writeFile(temporaryFile, encrypted, { mode: 0o600 });
  try { await rename(temporaryFile, file); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    await copyFile(temporaryFile, file);
    await unlink(temporaryFile).catch(() => undefined);
  }
}

function mutateQueryHistory(update: (snapshot: QueryHistorySnapshot) => QueryHistorySnapshot): Promise<QueryHistorySnapshot> {
  const operation = queryHistoryMutationQueue.then(async () => {
    const next = update(await readQueryHistorySnapshot());
    await writeQueryHistorySnapshot(next);
    return next;
  });
  queryHistoryMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

let schemaIndexWrites = Promise.resolve();






























































































    rerank: mergeOptional<RerankModelConfig>(raw.rerank, current.rerank, "rerank"),
  };
}

function publicConnection(connection: SavedConnection) {
  const { password, uri, ssh, ...metadata } = connection;
  return {
    ...metadata,
    ...(connection.engine === "mongodb" ? { endpoint: mongoEndpoint(uri), database: connection.database ?? mongoDatabaseFromUri(uri) } : {}),
    hasPassword: password.length > 0,
    hasUri: Boolean(uri),
    ...(ssh ? { ssh: {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      authentication: ssh.authentication,
      hostFingerprint: ssh.hostFingerprint,
      hasCredentials: Boolean(ssh.password || ssh.privateKey),
      hasPassphrase: Boolean(ssh.passphrase),
    } } : {}),
  };
}

function mongoEndpoint(uri?: string): string {
  if (!uri) return "MongoDB URI";
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "MongoDB URI";
  }
}

function mongoDatabaseFromUri(uri?: string): string | undefined {
  if (!uri) return undefined;
  try { return decodeURIComponent(new URL(uri).pathname.replace(/^\/+/, "")) || undefined; }
  catch { return undefined; }
}

async function connectionFor(id: string): Promise<SavedConnection> {
  const connection = (await readConnections()).find((candidate) => candidate.id === id);
  if (!connection) throw new Error("连接不存在或已被删除。");
  if (!connection.ssh) return connection;
  if (connection.engine === "sqlite" || connection.engine === "mongodb") {
    throw new Error("当前版本的 SSH 隧道仅支持单主机关系型数据库连接。");
  }
  const endpoint = await sshTunnelManager.endpointFor(connection.id, connection.ssh, {
    host: connection.host ?? "127.0.0.1",
    port: connection.port ?? defaultPortForEngine(connection.engine),
  });
  return { ...connection, host: endpoint.host, port: endpoint.port };
}

function defaultPortForEngine(engine: DatabaseEngine): number {
  switch (engine) {
    case "postgres": return 5432;
    case "mysql":
    case "mariadb": return 3306;
    case "sqlserver": return 1433;
    case "oracle": return 1521;
    default: throw new Error("该数据库类型没有可转发的 TCP 端口。");
  }
}

function storedSshConfig(
  draft: SshConnectionDraft | undefined,
  previous: SavedConnection | undefined,
  engine: DatabaseEngine,
): SshTunnelConfig | undefined {
  if (!draft?.enabled) return undefined;
  if (engine === "sqlite" || engine === "mongodb") {
    throw new Error("SSH 隧道暂不支持 SQLite 或 MongoDB 连接。");
  }
  const old = previous?.engine === engine ? previous.ssh : undefined;
  const authentication = draft.authentication ?? old?.authentication ?? "password";
  return validateSshTunnelConfig({
    host: draft.host ?? "",
    port: draft.port ?? 22,
    username: draft.username ?? "",
    authentication,
    hostFingerprint: draft.hostFingerprint ?? "",
    password: draft.password || reuse?.password,
    privateKey: draft.privateKey || reuse?.privateKey,
    passphrase: draft.passphrase || reuse?.passphrase,
  });
}

function coreFor(connection: SavedConnection): CoreService {
  if (connection.engine === "sqlite") {
    const config: SqliteConnectionConfig = { path: connection.path ?? "" };
    return CoreService.fromSqliteConfig(config);
  }
  if (connection.engine === "mysql" || connection.engine === "mariadb") {
    const config: MySqlConnectionConfig = {
      host: connection.host ?? "127.0.0.1",
      port: connection.port ?? 3306,
      user: connection.user ?? "",
      password: connection.password,
      database: connection.database,
      connectTimeout: 8_000,
    };
    return connection.engine === "mariadb"
      ? CoreService.fromMariaDbConfig(config)
      : CoreService.fromMySqlConfig(config);
  }
  if (connection.engine === "sqlserver") {
    const config: SqlServerConnectionConfig = {
      server: connection.host ?? "127.0.0.1",
      port: connection.port ?? 1433,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      encrypt: connection.encrypt,
      trustServerCertificate: connection.trustServerCertificate,
      connectionTimeout: 8_000,
      requestTimeout: 30_000,
    };
    return CoreService.fromSqlServerConfig(config);
  }
  if (connection.engine === "oracle") {
    const config: OracleConnectionConfig = {
      user: connection.user ?? "",
      password: connection.password,
      connectString: `//${connection.host ?? "127.0.0.1"}:${connection.port ?? 1521}/${connection.database ?? ""}`,
      connectTimeout: 8,
      callTimeout: 30_000,
    };
    return CoreService.fromOracleConfig(config);
  }
  if (connection.engine !== "postgres") {
    throw new Error(`桌面端暂不支持 ${connection.engine} 连接。`);
  }
  const config: PostgresConnectionConfig = {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl,
    connectionTimeoutMillis: 8_000,
  };
  return CoreService.fromPostgresConfig(config);
}

function mongoFor(connection: SavedConnection): MongoDocumentService {
  if (connection.engine !== "mongodb") throw new Error("请选择 MongoDB 连接以执行文档操作。");
  return MongoDocumentService.fromConfig({
    uri: connection.uri ?? "",
    database: connection.database,
    connectTimeoutMS: 8_000,
  });
}

function registerHandlers(): void {
  ipcMain.on("ai:cancel", (event, requestId: unknown) => {
    handleAiCancellationRequest(activeAiOperations, requestId, event.sender.id);
  });
  ipcMain.on("gis:cancel", (event, operationId: unknown) => {
    if (typeof operationId !== "string") return;
    const operation = activeGisOperations.get(operationId);
    if (operation?.senderId === event.sender.id) operation.controller.abort();
  });
  ipcMain.handle("ai:settings:get", async () => publicAiSettings(await readAiModelSettings()));
  ipcMain.handle("ai:settings:save", async (_event, input: unknown) => {





































































































































































































      const refreshSchema = input.refreshSchema === true;
      const selectedSql = typeof input.selectedSql === "string" ? input.selectedSql.slice(0, 30_000) : "";
      const executionPlan = typeof input.executionPlan === "string" ? input.executionPlan.trim() : "";
      if (task === "explain-plan" && !executionPlan) throw new Error("请粘贴数据库客户端生成的执行计划；本应用不会自动运行 EXPLAIN。");
      if (executionPlan.length > 12_000) throw new Error("执行计划不能超过 12,000 个字符。");
      const errorPayload = input.error && typeof input.error === "object" ? input.error as Record<string, unknown> : undefined;
      const errorMessage = typeof errorPayload?.message === "string" ? errorPayload.message.slice(0, 4_000) : "";
      let schemaTables: import("@db-studio/ai").SchemaTable[] = [];
      let metadataWarnings: string[] = [];
      let postgis: PostgisSchemaMetadata | undefined;
      let loadedSchemaIndex: SchemaIndexSnapshot | undefined;
      let semanticScopes: string[] = [];
      let semanticModelFingerprint = "";
      if (includeSchema) {
        if (task === "gis" && selectedSchemas.length !== 1) {
          throw new Error("PostGIS 空间 SQL 当前要求选择一个 Schema。");
        }
        const availableTablesBySchema = await Promise.all(selectedSchemas.map((selected) => core.listTables(selected)));
        const availableTables = availableTablesBySchema.flat();
        throwIfAiOperationCancelled(operation);
        const requestedKeys = Array.isArray(input.selectedTables)
          ? input.selectedTables.filter((value): value is string => typeof value === "string" && value.length <= 400).slice(0, 100)
          : [];
        const validKeys = availableTables
          .filter((table) => requestedKeys.includes(schemaTableKey(table.schema, table.name))
            || (selectedSchemas.length === 1 && requestedKeys.includes(table.schema + "." + table.name)))
          .map((table) => schemaTableKey(table.schema, table.name));
        if (task === "gis" && !validKeys.length) throw new Error("GIS SQL 助手需要你明确选择一个或多个空间表。");
        const candidates = availableTables.map((table) => ({
          schema: table.schema, name: table.name, type: table.type, comment: table.comment ?? undefined, columns: [],
        })) as import("@db-studio/ai").SchemaTable[];
        let keywordRows = selectRelevantTables(prompt + "\n" + selectedSql, candidates, [], 100);
        let semanticMatches: Array<{ tableKey: string; score: number }> = [];
        const embedding = settings.embedding;
        if (embedding?.enabled && embedding.apiKey && prompt) {
          try {
            const index = await readAiSchemaIndex();
            const scopes = selectedSchemas.map((selected) => schemaIndexScope(connectionId, tested.database, selected));
            loadedSchemaIndex = index;
            semanticScopes = scopes;
            const inScope = index.entries.filter((entry) => scopes.includes(entry.scope));
            const indexedScopes = new Set(inScope.map((entry) => entry.scope));
            const missingSchemas = selectedSchemas.filter((_, index) => !indexedScopes.has(scopes[index]!));
            if (missingSchemas.length) {
              metadataWarnings.push(`以下 Schema 没有本机语义索引，将仅使用关键词匹配：${missingSchemas.join(", ")}`);
            }
            const modelFingerprint = schemaModelFingerprint(embedding);
            semanticModelFingerprint = modelFingerprint;
            if (inScope.length) {
              const compatible = inScope.some((entry) => entry.modelFingerprint === modelFingerprint);
              if (!compatible) metadataWarnings.push("Embedding 模型、维度或索引格式已变化；当前请求退回关键词匹配。重建时所选 Schema 的旧索引将被替换，请选择所有需要语义检索的表。");
              else {
                const coverage = findSchemaIndexTableCoverageDifferences(index, scopes, candidates, modelFingerprint);
                if (coverage.unindexedTableKeys.length || coverage.orphanedTableKeys.length) {
                  metadataWarnings.push(`当前表清单与本机语义索引覆盖范围不同：${coverage.unindexedTableKeys.length} 张当前表未建立该模型索引，${coverage.orphanedTableKeys.length} 个索引表已不在当前表清单中。可用当前表选择重建索引；本次仍会结合可用索引和关键词检索。`);
                }
                const queryVector = (await createEmbedding(embedding, prompt, operation.controller.signal))[0]!;
                const searched = searchSchemaIndex(index, scopes, prompt, queryVector, modelFingerprint, 100);
                semanticMatches = searched.matches;
                if (searched.rebuildRequired) metadataWarnings.push("部分 Schema 语义索引的模型、维度或格式已变化；请重建所选范围内的索引。");
              }
            } else metadataWarnings.push("所选 Schema 尚无可用语义索引；本次先按表名和表注释匹配，若无表级命中则扫描列元数据查找字段名。");
          } catch (error) {
            if (operation.controller.signal.aborted) throw new Error("AI 请求已取消。");
            metadataWarnings.push("Schema 语义检索暂不可用，当前请求退回本地关键词匹配（先匹配表名和注释，无命中时扫描列元数据）：" + (error instanceof Error ? error.message.slice(0, 180) : "模型错误"));
          }
        }
        if (!keywordRows.length && !semanticMatches.length && !validKeys.length) {
          const loaded = await loadSchemaCandidateMetadata(candidates, async (table) => (
            await getAiSchemaTable(core, connectionId, {
              schema: table.schema, name: table.name, type: table.type, comment: table.comment ?? null,
            }, refreshSchema)
          ).table, { signal: operation.controller.signal, concurrency: 8 });
          throwIfAiOperationCancelled(operation);
          keywordRows = selectRelevantTables(prompt + "\n" + selectedSql, loaded.tables, [], 100);
          metadataWarnings.push("关键词预筛选未命中表名或注释；已扫描所选 Schema 的列元数据以查找字段名。");
          if (loaded.failedCount) metadataWarnings.push(`${loaded.failedCount} 张表的列元数据读取失败，字段关键词检索覆盖不完整。`);
        }
        const semanticRank = new Map(semanticMatches.map((match, index) => [match.tableKey, { rank: index, score: match.score }]));
        const keywordRank = new Map(keywordRows.map((table, index) => [schemaTableKey(table.schema, table.name), index]));
        const selected = new Set(validKeys);
        let rankedCandidates = candidates.map((table, index) => {
          const key = schemaTableKey(table.schema, table.name);
          const semantic = semanticRank.get(key);
          const keywordPosition = keywordRank.get(key);
          return { table, index, key, selected: selected.has(key), score: (semantic ? 0.6 * semantic.score + 0.2 / (semantic.rank + 1) : 0)
            + (keywordPosition === undefined ? 0 : 0.5 / (keywordPosition + 1)) };
        }).filter((item) => item.selected || item.score > 0)
          .sort((left, right) => Number(right.selected) - Number(left.selected) || right.score - left.score || left.index - right.index)
        const rerankConfig = settings.rerank;
        const rerankMetadata = new Map<string, { table: SchemaTable; warnings: string[] }>();
        if (rerankConfig?.enabled && rerankConfig.apiKey && prompt && rankedCandidates.length > 1) {
          const rerankPool = rankedCandidates.slice(0, 12);
          try {
            const candidateMetadata = await Promise.all(rerankPool.map((item) =>
              getAiSchemaTable(core, connectionId, item.table, refreshSchema),
            ));
            throwIfAiOperationCancelled(operation);
            const documents = candidateMetadata.map(({ table }) => schemaTableDocument(table).slice(0, 1_200));
            const ranked = await rerank(rerankConfig, prompt.slice(0, 1_000), documents, operation.controller.signal);
            const rerankedPool = rankSchemaCandidatesByRerank(
              rerankPool.map((item) => ({ key: item.key, score: item.score, selected: item.selected })),
              ranked,
              rerankPool.length,
            );
            const candidatesByKey = new Map(rerankPool.map((item) => [item.key, item]));
            const rerankedKeys = new Set(rerankedPool.map((item) => item.key));
            rankedCandidates = [
              ...rerankedPool.map((item) => candidatesByKey.get(item.key)!).filter(Boolean),
              ...rankedCandidates.filter((item) => !rerankedKeys.has(item.key)),
            ];
            rerankPool.forEach((item, index) => rerankMetadata.set(item.key, candidateMetadata[index]!));
            if (prompt.length > 1_000) metadataWarnings.push("Rerank 查询仅使用需求前 1,000 个字符；SQL 助手仍使用完整需求。");
          } catch (error) {
            if (operation.controller.signal.aborted) throw new Error("AI 请求已取消。");
            metadataWarnings.push("Schema Rerank 暂不可用，当前请求退回关键词和向量排序：" + (error instanceof Error ? error.message.slice(0, 180) : "模型错误"));
          }
        } else if (rerankConfig?.enabled && !rerankConfig.apiKey && prompt) {
          metadataWarnings.push("Rerank 已启用但尚未配置 API Key，当前请求继续使用关键词和向量排序。");
        }
        let relevant = rankedCandidates.slice(0, 8).map((item) => item.table);
        if (!relevant.length && candidates.length) {
          // Nothing matched the prompt (no table/column keywords, no embedding hit,
          // no explicit selection). Rather than blocking the user, send a small
          // bounded set from the selected scope and explain how to improve it.
          relevant = candidates.slice(0, 8);
          metadataWarnings.push(`未能按需求匹配到具体表，已将所选 Schema 的前 ${relevant.length} 张表作为候选发送；在需求中写出表名或字段名、或在下方勾选候选表可提高准确度。`);
        }
        if (!relevant.length) throw new Error("所选范围内没有可用的表。请先选择数据库连接与 Schema，或在需求中写出准确表名。");
        const metadata = await Promise.all(relevant.map((table) => {
          const key = schemaTableKey(table.schema, table.name);
          return rerankMetadata.get(key) ?? getAiSchemaTable(core, connectionId, table, refreshSchema);
        }));
        throwIfAiOperationCancelled(operation);
        schemaTables = metadata.map((item) => item.table);
        metadataWarnings.push(...metadata.flatMap((item) => item.warnings));
        if (task === "gis") {
          const result = await getPostgisSchemaMetadata(core, schema, schemaTables);
          throwIfAiOperationCancelled(operation);
          if (!result.metadata.spatialColumns.length) {
            throw new Error("所选表没有可用的 PostGIS geometry/geography 字段；请检查 PostGIS 扩展并选择包含空间列的表。");
          }
          postgis = result.metadata;
          metadataWarnings.push(...result.warnings);






































































































































      return response;
    } finally {
      releaseOperation();
    }
  });
  ipcMain.handle("connections:list", async () => (await readConnections()).map(publicConnection));
  ipcMain.handle("connections:backup-and-reset-unreadable", async () => runConnectionStoreOperation(async () => {
    const backupPath = await backupAndResetUnreadableConnectionStore(
      connectionsPath(),
      async () => (await readConnectionsFromStore()).connections,
      async () => writeConnections([]),
    );
    return { backupPath };
  }));
  ipcMain.handle("connections:save", async (_event, input: SavedConnection & { ssh?: SshConnectionDraft }) => runConnectionStoreOperation(async () => {
    if (!input.name.trim()) throw new Error("连接名称不能为空。");
    if (!desktopEngines.has(input.engine)) {
      throw new Error("当前桌面版本支持 PostgreSQL、MySQL、MariaDB、SQLite、SQL Server、Oracle 和 MongoDB。");
    }
    if (input.engine === "mongodb") {
      const old = (await readConnectionsFromStore()).connections.find((candidate) => candidate.id === input.id);
      const uri = input.uri?.trim() || (old?.engine === "mongodb" ? old.uri : "") || "";
      let parsed: URL;
      try { parsed = new URL(uri); }
      catch { throw new Error("请输入有效的 MongoDB URI（mongodb:// 或 mongodb+srv://）。"); }
      if (!["mongodb:", "mongodb+srv:"].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error("MongoDB URI 必须以 mongodb:// 或 mongodb+srv:// 开头，并包含主机名。");
      }
    } else if (input.engine === "sqlite") {
      if (!input.path?.trim()) throw new Error("SQLite 数据库文件路径不能为空。");
    } else {
      if (!input.host?.trim() || !input.user?.trim()) {
        throw new Error("主机和用户名不能为空。");
      }
      if (input.engine === "postgres" && !input.database?.trim()) {
        throw new Error("PostgreSQL 默认数据库不能为空。");
      }
      if (input.engine === "oracle" && !input.database?.trim()) {
        throw new Error("Oracle 必须指定服务名，例如 FREEPDB1。");
      }
      if (!Number.isInteger(input.port) || input.port! < 1 || input.port! > 65535) {
        throw new Error("端口必须是 1 到 65535 之间的整数。");
      }
    }
    const connections = (await readConnectionsFromStore()).connections;
    const old = connections.find((candidate) => candidate.id === input.id);
    const password = input.password || (old?.engine === input.engine ? old.password : "") || "";
    const ssh = storedSshConfig(input.ssh, old, input.engine);
    if (input.engine === "sqlserver" && !password) throw new Error("SQL Server SQL 身份验证需要密码。");
    if (input.engine === "oracle" && !password) throw new Error("Oracle 连接必须提供密码。");
    const baseConnection = input.engine === "sqlite"
      ? { id: input.id, name: input.name.trim(), engine: input.engine, path: input.path!.trim(), password: "", ssl: false }
      : input.engine === "mongodb"
        ? {
            id: input.id,
            name: input.name.trim(),
            engine: input.engine,
            uri: input.uri?.trim() || (old?.engine === "mongodb" ? old.uri : ""),
            database: input.database?.trim() || undefined,
            password: "",
          }
        : input.engine === "sqlserver"
          ? {
              ...input,
              name: input.name.trim(),
              password,
              encrypt: input.encrypt ?? old?.encrypt ?? true,
              trustServerCertificate: input.trustServerCertificate ?? old?.trustServerCertificate ?? true,
            }
          : { ...input, name: input.name.trim(), password };
    const connection: SavedConnection = { ...baseConnection, ssh };
    const next = old
      ? connections.map((candidate) => candidate.id === input.id ? connection : candidate)
      : [...connections, connection];
    // Invalidate potentially stale vectors before committing the connection. If
    // this fails, the connection file must remain unchanged so the renderer's
    // save failure accurately reflects persistence state.
    await clearAiSchemaIndex(input.id);
    await sshTunnelManager.close(input.id);
    await writeConnections(next);
    clearAiSchemaCache(input.id);
    for (const operation of activeAiOperations.values()) {
      if (operation.connectionId === input.id) operation.controller.abort();
    }
  }));
  ipcMain.handle("connections:remove", async (_event, id: string) => runConnectionStoreOperation(async () => {
    const connections = (await readConnectionsFromStore()).connections;
    await commitConnectionRemoval(connections, id, async () => {
      await clearAiSchemaIndex(id);
      await sshTunnelManager.close(id);
    }, writeConnections);
    clearAiSchemaCache(id);
    for (const operation of activeAiOperations.values()) {
      if (operation.connectionId === id) operation.controller.abort();
    }
  }));
  ipcMain.handle("connections:test", async (_event, id: string) => {
    const connection = await connectionFor(id);
    return connection.engine === "mongodb"
      ? mongoFor(connection).testConnection()
      : coreFor(connection).testConnection();
  });
  ipcMain.handle("database:databases", async (_event, id: string) => {
    const connection = await connectionFor(id);
    return connection.engine === "mongodb" ? mongoFor(connection).listDatabases() : coreFor(connection).listDatabases();
  });
  ipcMain.handle("database:schemas", async (_event, id: string) => coreFor(await connectionFor(id)).listSchemas());
  ipcMain.handle("database:tables", async (_event, id: string, schema?: string) => coreFor(await connectionFor(id)).listTables(schema));
  ipcMain.handle("database:transfer-table", async (_event, sourceId: unknown, payload: unknown) => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>

























































































    const connection = await connectionFor(id);
    if (connection.engine === "mongodb") throw new Error("MongoDB 文档不能通过 SQL 表格编辑器修改。");
    return coreFor(connection).updateTableRows(connection.engine, input.schema, input.table, changes);
  });
  ipcMain.handle("query-history:list", async () => {
    await queryHistoryMutationQueue;
    return readQueryHistorySnapshot();
  });
  ipcMain.handle("query-history:record", async (_event, input: unknown) =>
    mutateQueryHistory((snapshot) => appendQueryHistory(snapshot, input)));
  ipcMain.handle("query-history:clear", async (_event, connectionId: unknown) => {
    if (connectionId !== undefined && (typeof connectionId !== "string" || !connectionId.trim() || connectionId.length > 200)) {
      throw new Error("查询历史连接标识无效。");
    }
    return mutateQueryHistory((snapshot) => clearQueryHistory(snapshot, connectionId as string | undefined));
  });
  ipcMain.handle("query-history:favorite:save", async (_event, input: unknown) =>
    mutateQueryHistory((snapshot) => upsertQueryFavorite(snapshot, input)));
  ipcMain.handle("query-history:favorite:remove", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim() || id.length > 120) throw new Error("查询收藏标识无效。");
    return mutateQueryHistory((snapshot) => removeQueryFavorite(snapshot, id));
  });
  ipcMain.handle("database:export-table", async (_event, id: string, table: string, schema?: string) => {
    if (typeof table !== "string" || !table.trim()) throw new Error("表名不能为空。");
