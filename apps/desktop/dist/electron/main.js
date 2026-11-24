// RECONSTRUCTED from dist/electron/main.js (tsc output of the lost source).
// @ts-nocheck -- temporary: original type annotations were not preserved in the build output.
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { applyPostgisSpatialMetadata, createEmbedding, emptySchemaIndex, findSchemaIndexTableCoverageDifferences, findStaleSchemaIndexTableKeys, isSchemaIndexSnapshot, loadPostgisSchemaMetadata, loadSchemaCandidateMetadata, rankSchemaCandidatesByRerank, replaceSchemaIndexChunks, rerank, runMongoAssistant, runSqlAssistant, schemaIndexScope, schemaModelFingerprint, schemaTableDocument, schemaTableDocumentChunks, searchSchemaIndex, selectRelevantTables, testChatModel, testEmbeddingModel, testRerankModel } from "@db-studio/ai";
import { schemaTableKey } from "@db-studio/shared/schema-table-key";
import { CoreService, GisOperationError, MongoDocumentService, stringifyMongoJson } from "@db-studio/core";
import { SshTunnelManager, validateSshTunnelConfig } from "@db-studio/database";
import { parseExcelWorkbook, parseTabularData, queryResultToCsv, queryResultToXlsx } from "@db-studio/shared";
import { appendQueryHistory, clearQueryHistory, createEmptyQueryHistorySnapshot, normalizeQueryHistorySnapshot, removeQueryFavorite, upsertQueryFavorite, } from "@db-studio/shared";
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
const desktopEngines = new Set(["postgres", "mysql", "sqlite", "mariadb", "mongodb", "sqlserver", "oracle"]);
const sshTunnelManager = new SshTunnelManager();
const activeGisOperations = new Map();
const activeAiOperations = new Map();
const aiSchemaMetadataCache = new Map();
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
let queryHistoryMutationQueue = Promise.resolve();
// Keep connection read-modify-write transactions and legacy rewrites ordered;
// ordinary reads remain concurrent unless they need to rewrite the store.
const runConnectionStoreOperation = createAsyncSerialQueue();
function clearAiSchemaCache(connectionId) {
    for (const key of aiSchemaMetadataCache.keys()) {
        if (key.startsWith(connectionId + "\0"))
            aiSchemaMetadataCache.delete(key);
    }
}
async function getAiSchemaTable(core, connectionId, table, refresh) {
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
    const result = {
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
        if (oldest)
            aiSchemaMetadataCache.delete(oldest);
    }
    aiSchemaMetadataCache.set(key, { fetchedAt: Date.now(), table: result, warnings });
    return { table: result, warnings: [...warnings] };
}
async function getPostgisSchemaMetadata(core, schema, tables) {
    return loadPostgisSchemaMetadata((sql, parameters) => core.query(sql, parameters), schema, tables);
}
const here = path.dirname(fileURLToPath(import.meta.url));
function configureGdalRuntime() {
    const bundledRoot = app.isPackaged
        ? path.join(process.resourcesPath, "gdal")
        : path.resolve(here, "../../resources/gdal");
    const bundledBin = path.join(bundledRoot, "bin");
    const configuredBin = process.env.DBSTUDIO_GDAL_BIN;
    const hasConfiguredRuntime = Boolean(configuredBin && existsSync(path.join(configuredBin, "ogr2ogr.exe")));
    const hasBundledRuntime = existsSync(path.join(bundledBin, "ogr2ogr.exe"));
    const binaryDirectory = hasConfiguredRuntime ? configuredBin : hasBundledRuntime ? bundledBin : undefined;
    if (!binaryDirectory)
        return;
    process.env.DBSTUDIO_GDAL_BIN = binaryDirectory;
    process.env.PATH = [binaryDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);
    if (hasBundledRuntime && !hasConfiguredRuntime) {
        const gdalData = path.join(bundledRoot, "data");
        const projData = path.join(bundledRoot, "proj");
        if (!process.env.GDAL_DATA && existsSync(gdalData))
            process.env.GDAL_DATA = gdalData;
        if (!process.env.PROJ_DATA && existsSync(projData))
            process.env.PROJ_DATA = projData;
        if (!process.env.PROJ_LIB && existsSync(projData))
            process.env.PROJ_LIB = process.env.PROJ_DATA ?? projData;
    }
}
configureGdalRuntime();
const connectionFileHeader = Buffer.from("DBSTUDIO\0CONNECTIONS\0V1\0", "utf8");
const dpapiHeader = Buffer.concat([connectionFileHeader, Buffer.from("DPAPI\0", "ascii")]);
const safeStorageHeader = Buffer.concat([connectionFileHeader, Buffer.from("SAFE-STORAGE\0", "ascii")]);
async function runWindowsDpapi(operation, value, maxBytes = 2 * 1024 * 1024) {
    // Use user-scoped DPAPI on Windows so the ciphertext survives Electron profile restarts.
    if (process.platform !== "win32")
        throw new Error("Windows DPAPI is only available on Windows.");
    if (value.length > maxBytes)
        throw new Error("Encrypted configuration exceeds the secure storage limit.");
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
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new Promise((resolve, reject) => {
        const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
        });
        const output = [];
        let outputLength = 0;
        let settled = false;
        let timer;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            child.kill();
            reject(error);
        };
        child.stdout.on("data", (chunk) => {
            outputLength += chunk.length;
            if (outputLength > 4 * 1024 * 1024) {
                fail(new Error("Windows DPAPI returned an oversized result."));
                return;
            }
            output.push(chunk);
        });
        child.once("error", () => fail(new Error("Could not start Windows secure storage.")));
        child.once("close", (code) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
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
async function readConnectionsFromStore() {
    try {
        const encrypted = await readFile(connectionsPath());
        const hasDpapiHeader = encrypted.subarray(0, dpapiHeader.length).equals(dpapiHeader);
        const hasSafeStorageHeader = encrypted.subarray(0, safeStorageHeader.length).equals(safeStorageHeader);
        let plaintext;
        let needsRewrite = !hasDpapiHeader && !hasSafeStorageHeader;
        if (hasDpapiHeader) {
            try {
                plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(dpapiHeader.length))).toString("utf8");
            }
            catch (error) {
                throw new ConnectionStoreUnreadableError("连接配置无法由当前 Windows 用户解密。", { cause: error });
            }
        }
        else {
            if (!(await safeStorage.isAsyncEncryptionAvailable())) {
                throw new Error("系统安全存储不可用，无法安全读取连接配置。");
            }
            const ciphertext = hasSafeStorageHeader ? encrypted.subarray(safeStorageHeader.length) : encrypted;
            let decrypted;
            try {
                decrypted = await safeStorage.decryptStringAsync(ciphertext);
            }
            catch (error) {
                throw new ConnectionStoreUnreadableError("连接配置无法由当前系统安全存储解密。", { cause: error });
            }
            plaintext = decrypted.result;
            needsRewrite ||= decrypted.shouldReEncrypt;
        }
        let saved;
        try {
            saved = JSON.parse(plaintext);
        }
        catch (error) {
            throw new ConnectionStoreUnreadableError("连接配置解密后不是有效的连接数据。", { cause: error });
        }
        assertConnectionStoreShape(saved);
        const normalized = saved.map((connection) => ({
            ...connection,
            engine: connection.engine ?? "postgres",
            name: connection.name ?? "",
            password: connection.password ?? "",
        }));
        return { connections: normalized, needsRewrite };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { connections: [], needsRewrite: false };
        throw error;
    }
}
async function readConnections() {
    const current = await readConnectionsFromStore();
    if (!current.needsRewrite)
        return current.connections;
    return runConnectionStoreOperation(async () => {
        const latest = await readConnectionsFromStore();
        if (latest.needsRewrite)
            await writeConnections(latest.connections);
        return latest.connections;
    });
}
async function writeConnections(connections) {
    const serialized = Buffer.from(JSON.stringify(connections), "utf8");
    let encrypted;
    if (process.platform === "win32") {
        encrypted = Buffer.concat([dpapiHeader, await runWindowsDpapi("protect", serialized)]);
    }
    else {
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
    }
    catch (error) {
        if (process.platform !== "win32" || error.code !== "EBADF")
            throw error;
        // Some Windows profile directories reject rename; preserve encryption with a copy fallback.
        await copyFile(temporaryFile, file);
        await unlink(temporaryFile).catch(() => undefined);
    }
}
function emptyAiSettings() {
    return { enabled: false, chatModels: [], embedding: undefined, rerank: undefined };
}
async function readAiModelSettings() {
    let encrypted;
    try {
        encrypted = await readFile(aiSettingsPath());
    }
    catch (error) {
        if (error.code === "ENOENT")
            return emptyAiSettings();
        throw error;
    }
    const hasDpapi = encrypted.subarray(0, aiDpapiHeader.length).equals(aiDpapiHeader);
    const hasSafeStorage = encrypted.subarray(0, aiSafeStorageHeader.length).equals(aiSafeStorageHeader);
    let plaintext;
    if (hasDpapi)
        plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(aiDpapiHeader.length))).toString("utf8");
    else {
        if (!hasSafeStorage || !(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error("AI 模型配置无法通过系统安全存储解密。");
        plaintext = (await safeStorage.decryptStringAsync(encrypted.subarray(aiSafeStorageHeader.length))).result;
    }
    const value = JSON.parse(plaintext);
    if (!Array.isArray(value.chatModels))
        throw new Error("AI 模型配置文件格式无效。");
    return {
        enabled: value.enabled === true,
        chatModels: value.chatModels.filter((model) => Boolean(model && typeof model.id === "string" && typeof model.baseURL === "string" && typeof model.model === "string" && typeof model.apiKey === "string")),
        defaultChatModelId: typeof value.defaultChatModelId === "string" ? value.defaultChatModelId : undefined,
        embedding: value.embedding && typeof value.embedding.baseURL === "string" && typeof value.embedding.model === "string"
            ? value.embedding : undefined,
        rerank: value.rerank && typeof value.rerank.baseURL === "string" && typeof value.rerank.model === "string"
            ? value.rerank : undefined,
    };
}
async function writeAiModelSettings(settings) {
    const serialized = JSON.stringify(settings);
    let encrypted;
    if (process.platform === "win32")
        encrypted = Buffer.concat([aiDpapiHeader, await runWindowsDpapi("protect", Buffer.from(serialized, "utf8"))]);
    else {
        if (!(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error("系统安全存储不可用，AI API Key 未保存。");
        encrypted = Buffer.concat([aiSafeStorageHeader, await safeStorage.encryptStringAsync(serialized)]);
    }
    const file = aiSettingsPath();
    const temporaryFile = file + ".tmp";
    await writeFile(temporaryFile, encrypted, { mode: 0o600 });
    try {
        await rename(temporaryFile, file);
    }
    catch (error) {
        if (process.platform !== "win32" || error.code !== "EBADF")
            throw error;
        await copyFile(temporaryFile, file);
        await unlink(temporaryFile).catch(() => undefined);
    }
}
async function readAiSchemaIndex() {
    let encrypted;
    try {
        encrypted = await readFile(aiSchemaIndexPath());
    }
    catch (error) {
        if (error.code === "ENOENT")
            return emptySchemaIndex();
        throw error;
    }
    if (encrypted.length > 34 * 1024 * 1024)
        throw new Error("本机 Schema 索引文件超过安全上限。");
    const hasDpapi = encrypted.subarray(0, aiSchemaIndexDpapiHeader.length).equals(aiSchemaIndexDpapiHeader);
    const hasSafeStorage = encrypted.subarray(0, aiSchemaIndexSafeStorageHeader.length).equals(aiSchemaIndexSafeStorageHeader);
    let plaintext;
    if (hasDpapi) {
        plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(aiSchemaIndexDpapiHeader.length), 32 * 1024 * 1024)).toString("utf8");
    }
    else {
        if (!hasSafeStorage || !(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error("本机 Schema 索引无法通过系统安全存储解密。");
        plaintext = (await safeStorage.decryptStringAsync(encrypted.subarray(aiSchemaIndexSafeStorageHeader.length))).result;
    }
    const value = JSON.parse(plaintext);
    if (!isSchemaIndexSnapshot(value))
        throw new Error("本机 Schema 索引格式无效；请重新建立所选表索引。");
    return value;
}
async function writeAiSchemaIndex(snapshot, signal) {
    const serialized = Buffer.from(JSON.stringify(snapshot), "utf8");
    if (serialized.length > 32 * 1024 * 1024)
        throw new Error("本机 Schema 索引超过 32 MiB 安全上限，请减少已索引表数量。");
    let encrypted;
    if (process.platform === "win32") {
        encrypted = Buffer.concat([aiSchemaIndexDpapiHeader, await runWindowsDpapi("protect", serialized, 32 * 1024 * 1024)]);
    }
    else {
        if (!(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error("系统安全存储不可用，Schema 索引未保存。");
        encrypted = Buffer.concat([aiSchemaIndexSafeStorageHeader, await safeStorage.encryptStringAsync(serialized.toString("utf8"))]);
    }
    if (signal?.aborted)
        throw new Error("AI 请求已取消。");
    const file = aiSchemaIndexPath();
    await mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = file + "." + randomUUID() + ".tmp";
    try {
        await writeFile(temporaryFile, encrypted, { mode: 0o600 });
    }
    catch (error) {
        await unlink(temporaryFile).catch(() => undefined);
        throw error;
    }
    try {
        if (signal?.aborted)
            throw new Error("AI 请求已取消。");
        await rename(temporaryFile, file);
    }
    catch (error) {
        if (signal?.aborted) {
            await unlink(temporaryFile).catch(() => undefined);
            throw new Error("AI 请求已取消。");
        }
        if (process.platform !== "win32" || error.code !== "EBADF")
            throw error;
        await copyFile(temporaryFile, file);
        await unlink(temporaryFile).catch(() => undefined);
    }
}
async function readQueryHistorySnapshot() {
    let encrypted;
    try {
        encrypted = await readFile(queryHistoryPath());
    }
    catch (error) {
        if (error.code === "ENOENT")
            return createEmptyQueryHistorySnapshot();
        throw error;
    }
    if (encrypted.length > 2 * 1024 * 1024)
        throw new Error("本机查询历史文件超过安全上限。");
    const hasDpapi = encrypted.subarray(0, queryHistoryDpapiHeader.length).equals(queryHistoryDpapiHeader);
    const hasSafeStorage = encrypted.subarray(0, queryHistorySafeStorageHeader.length).equals(queryHistorySafeStorageHeader);
    let plaintext;
    if (hasDpapi) {
        plaintext = (await runWindowsDpapi("unprotect", encrypted.subarray(queryHistoryDpapiHeader.length))).toString("utf8");
    }
    else {
        if (!hasSafeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) {
            throw new Error("本机查询历史无法通过系统安全存储解密。");
        }
        plaintext = (await safeStorage.decryptStringAsync(encrypted.subarray(queryHistorySafeStorageHeader.length))).result;
    }
    return normalizeQueryHistorySnapshot(JSON.parse(plaintext));
}
async function writeQueryHistorySnapshot(snapshot) {
    const serialized = Buffer.from(JSON.stringify(snapshot), "utf8");
    const maxPlaintextBytes = 1800 * 1024;
    if (serialized.length > maxPlaintextBytes)
        throw new Error("本机查询历史超过安全存储上限，请清理较早记录或收藏较短 SQL。");
    let encrypted;
    if (process.platform === "win32") {
        encrypted = Buffer.concat([queryHistoryDpapiHeader, await runWindowsDpapi("protect", serialized, maxPlaintextBytes)]);
    }
    else {
        if (!(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error("系统安全存储不可用，查询历史未保存。");
        encrypted = Buffer.concat([queryHistorySafeStorageHeader, await safeStorage.encryptStringAsync(serialized.toString("utf8"))]);
    }
    const file = queryHistoryPath();
    await mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    await writeFile(temporaryFile, encrypted, { mode: 0o600 });
    try {
        await rename(temporaryFile, file);
    }
    catch (error) {
        if (process.platform !== "win32" || error.code !== "EBADF")
            throw error;
        await copyFile(temporaryFile, file);
        await unlink(temporaryFile).catch(() => undefined);
    }
}
function mutateQueryHistory(update) {
    const operation = queryHistoryMutationQueue.then(async () => {
        const next = update(await readQueryHistorySnapshot());
        await writeQueryHistorySnapshot(next);
        return next;
    });
    queryHistoryMutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
}
let schemaIndexWrites = Promise.resolve();
function mutateAiSchemaIndex(mutate) {
    const pending = schemaIndexWrites.then(async () => mutate(await readAiSchemaIndex()));
    schemaIndexWrites = pending.then(() => undefined, () => undefined);
    return pending;
}
async function clearAiSchemaIndex(connectionId) {
    await mutateAiSchemaIndex(async (snapshot) => {
        const entries = snapshot.entries.filter((entry) => !entry.scope.startsWith(connectionId + "\0"));
        if (entries.length !== snapshot.entries.length)
            await writeAiSchemaIndex({ version: 1, entries });
    });
}
function publicAiSettings(settings) {
    return {
        enabled: settings.enabled,
        chatModels: settings.chatModels.map(({ apiKey, ...model }) => ({ ...model, apiKeySet: Boolean(apiKey) })),
        defaultChatModelId: settings.defaultChatModelId,
        embedding: settings.embedding ? (({ apiKey, ...model }) => ({ ...model, apiKeySet: Boolean(apiKey) }))(settings.embedding) : undefined,
        rerank: settings.rerank ? (({ apiKey, ...model }) => ({ ...model, apiKeySet: Boolean(apiKey) }))(settings.rerank) : undefined,
    };
}
function validateAiBaseUrl(value) {
    if (typeof value !== "string" || value.length > 2_000)
        throw new Error("Base URL 不能为空且不能超过 2,000 个字符。");
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new Error("请输入有效的 Base URL。");
    }
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
        throw new Error("Base URL 只能使用无凭据、无查询参数的 HTTP(S) 地址。");
    }
    return url.toString().replace(/\/+$/, "");
}
function validateAiModelSettings(input, current) {
    if (!input || typeof input !== "object")
        throw new Error("AI 模型配置格式无效。");
    const raw = input;
    if (!Array.isArray(raw.chatModels) || raw.chatModels.length > 10)
        throw new Error("最多可配置 10 个 Chat 模型。");
    const oldModels = new Map(current.chatModels.map((model) => [model.id, model]));
    const chatModels = raw.chatModels.map((item) => {
        if (!item || typeof item !== "object")
            throw new Error("Chat 模型配置无效。");
        const model = item;
        const id = typeof model.id === "string" ? model.id.trim() : "";
        const name = typeof model.name === "string" ? model.name.trim() : "";
        const modelId = typeof model.model === "string" ? model.model.trim() : "";
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !name || name.length > 100 || !modelId || modelId.length > 200)
            throw new Error("Chat 模型名称或 Model ID 无效。");
        const apiKey = typeof model.apiKey === "string" && model.apiKey.trim()
            ? model.apiKey.trim()
            : oldModels.get(id)?.apiKey ?? "";
        if (apiKey.length > 4_096)
            throw new Error("API Key 长度超过限制。");
        const timeoutMs = Number(model.timeoutMs ?? 60_000);
        const maxOutputTokens = Number(model.maxOutputTokens ?? 2_048);
        const temperature = Number(model.temperature ?? 0.2);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)
            throw new Error("模型超时需在 1 秒至 5 分钟之间。");
        if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 16_384)
            throw new Error("最大输出 Token 数需在 64 至 16,384 之间。");
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
            throw new Error("Temperature 需在 0 至 2 之间。");
        return {
            id, name, provider: "openai-compatible", baseURL: validateAiBaseUrl(model.baseURL),
            model: modelId, apiKey, timeoutMs, maxOutputTokens, temperature,
            streaming: model.streaming === true, enabled: model.enabled === true,
        };
    });
    if (new Set(chatModels.map((model) => model.id)).size !== chatModels.length)
        throw new Error("Chat 模型 ID 不能重复。");
    const defaultChatModelId = typeof raw.defaultChatModelId === "string" && chatModels.some((model) => model.id === raw.defaultChatModelId && model.enabled)
        ? raw.defaultChatModelId : chatModels.find((model) => model.enabled)?.id;
    const mergeOptional = (candidate, previous, kind) => {
        if (!candidate || typeof candidate !== "object")
            return undefined;
        const item = candidate;
        const baseURL = validateAiBaseUrl(item.baseURL);
        const model = typeof item.model === "string" ? item.model.trim() : "";
        if (!model || model.length > 200)
            throw new Error(kind + " Model ID 无效。");
        const apiKey = typeof item.apiKey === "string" && item.apiKey.trim() ? item.apiKey.trim() : previous?.apiKey ?? "";
        if (apiKey.length > 4_096)
            throw new Error("API Key 长度超过限制。");
        const timeoutMs = Number(item.timeoutMs ?? 60_000);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)
            throw new Error("模型超时需在 1 秒至 5 分钟之间。");
        const common = { baseURL, model, apiKey, timeoutMs, enabled: item.enabled === true };
        if (kind === "embedding") {
            const dimensions = item.dimensions === undefined || item.dimensions === null || item.dimensions === "" ? undefined : Number(item.dimensions);
            const batchSize = Number(item.batchSize ?? 10);
            if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8_192))
                throw new Error("Embedding 维度无效。");
            if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10)
                throw new Error("Embedding 批次大小需为 1 到 10。");
            const provider = item.provider === "dashscope" ? "dashscope" : "openai-compatible";
            return { ...common, provider, dimensions, batchSize };
        }
        return { ...common, provider: "dashscope" };
    };
    return {
        enabled: raw.enabled === true && Boolean(defaultChatModelId),
        chatModels,
        defaultChatModelId,
        embedding: mergeOptional(raw.embedding, current.embedding, "embedding"),
        rerank: mergeOptional(raw.rerank, current.rerank, "rerank"),
    };
}
function publicConnection(connection) {
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
function mongoEndpoint(uri) {
    if (!uri)
        return "MongoDB URI";
    try {
        const parsed = new URL(uri);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    }
    catch {
        return "MongoDB URI";
    }
}
function mongoDatabaseFromUri(uri) {
    if (!uri)
        return undefined;
    try {
        return decodeURIComponent(new URL(uri).pathname.replace(/^\/+/, "")) || undefined;
    }
    catch {
        return undefined;
    }
}
async function connectionFor(id) {
    const connection = (await readConnections()).find((candidate) => candidate.id === id);
    if (!connection)
        throw new Error("连接不存在或已被删除。");
    if (!connection.ssh)
        return connection;
    if (connection.engine === "sqlite" || connection.engine === "mongodb") {
        throw new Error("当前版本的 SSH 隧道仅支持单主机关系型数据库连接。");
    }
    const endpoint = await sshTunnelManager.endpointFor(connection.id, connection.ssh, {
        host: connection.host ?? "127.0.0.1",
        port: connection.port ?? defaultPortForEngine(connection.engine),
    });
    return { ...connection, host: endpoint.host, port: endpoint.port };
}
function defaultPortForEngine(engine) {
    switch (engine) {
        case "postgres": return 5432;
        case "mysql":
        case "mariadb": return 3306;
        case "sqlserver": return 1433;
        case "oracle": return 1521;
        default: throw new Error("该数据库类型没有可转发的 TCP 端口。");
    }
}
function storedSshConfig(draft, previous, engine) {
    if (!draft?.enabled)
        return undefined;
    if (engine === "sqlite" || engine === "mongodb") {
        throw new Error("SSH 隧道暂不支持 SQLite 或 MongoDB 连接。");
    }
    const old = previous?.engine === engine ? previous.ssh : undefined;
    const authentication = draft.authentication ?? old?.authentication ?? "password";
    const reuse = old?.authentication === authentication ? old : undefined;
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
function coreFor(connection) {
    if (connection.engine === "sqlite") {
        const config = { path: connection.path ?? "" };
        return CoreService.fromSqliteConfig(config);
    }
    if (connection.engine === "mysql" || connection.engine === "mariadb") {
        const config = {
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
        const config = {
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
        const config = {
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
    const config = {
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
function mongoFor(connection) {
    if (connection.engine !== "mongodb")
        throw new Error("请选择 MongoDB 连接以执行文档操作。");
    return MongoDocumentService.fromConfig({
        uri: connection.uri ?? "",
        database: connection.database,
        connectTimeoutMS: 8_000,
    });
}
function registerHandlers() {
    ipcMain.on("ai:cancel", (event, requestId) => {
        handleAiCancellationRequest(activeAiOperations, requestId, event.sender.id);
    });
    ipcMain.on("gis:cancel", (event, operationId) => {
        if (typeof operationId !== "string")
            return;
        const operation = activeGisOperations.get(operationId);
        if (operation?.senderId === event.sender.id)
            operation.controller.abort();
    });
    ipcMain.handle("ai:settings:get", async () => publicAiSettings(await readAiModelSettings()));
    ipcMain.handle("ai:settings:save", async (_event, input) => {
        const current = await readAiModelSettings();
        const next = validateAiModelSettings(input, current);
        await writeAiModelSettings(next);
        return publicAiSettings(next);
    });
    ipcMain.handle("ai:model:test", async (_event, kind, profileInput) => {
        if (!profileInput || typeof profileInput !== "object")
            throw new Error("模型配置格式无效。");
        const input = profileInput;
        const settings = await readAiModelSettings();
        const id = typeof input.id === "string" ? input.id : "";
        const providedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
        const signal = new AbortController().signal;
        if (kind === "chat") {
            const saved = settings.chatModels.find((model) => model.id === id);
            const model = {
                id, name: String(input.name ?? "Chat model"), provider: "openai-compatible",
                baseURL: validateAiBaseUrl(input.baseURL), model: String(input.model ?? ""),
                apiKey: providedKey || saved?.apiKey || "",
                timeoutMs: Number(input.timeoutMs ?? saved?.timeoutMs ?? 60_000),
                maxOutputTokens: Number(input.maxOutputTokens ?? saved?.maxOutputTokens ?? 2_048),
                temperature: Number(input.temperature ?? saved?.temperature ?? 0.2),
                streaming: input.streaming === true,
                enabled: true,
            };
            await testChatModel(model, signal);
            return { ok: true, message: "模型连接和最小文本响应检查通过。" };
        }
        if (kind === "embedding") {
            const saved = settings.embedding;
            const model = {
                provider: input.provider === "dashscope" ? "dashscope" : "openai-compatible", baseURL: validateAiBaseUrl(input.baseURL),
                model: String(input.model ?? ""), apiKey: providedKey || saved?.apiKey || "",
                dimensions: input.dimensions === undefined || input.dimensions === "" ? undefined : Number(input.dimensions),
                batchSize: Number(input.batchSize ?? 10), timeoutMs: Number(input.timeoutMs ?? saved?.timeoutMs ?? 60_000), enabled: true,
            };
            const dimensions = await testEmbeddingModel(model, signal);
            return { ok: true, dimensions, message: "Embedding 响应有效，向量维度 " + dimensions + "。" };
        }
        if (kind === "rerank") {
            const saved = settings.rerank;
            const model = {
                provider: "dashscope", baseURL: validateAiBaseUrl(input.baseURL),
                model: String(input.model ?? ""), apiKey: providedKey || saved?.apiKey || "",
                timeoutMs: Number(input.timeoutMs ?? saved?.timeoutMs ?? 60_000), enabled: true,
            };
            await testRerankModel(model, signal);
            return { ok: true, message: "Rerank 响应格式和排序检查通过。" };
        }
        throw new Error("不支持的模型类型。");
    });
    ipcMain.handle("ai:schema-index:build", async (event, payload) => {
        if (!payload || typeof payload !== "object")
            throw new Error("Schema 索引请求格式无效。");
        const input = payload;
        const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
        const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
        const schema = typeof input.schema === "string" ? input.schema.trim() : "";
        const selectedKeys = Array.isArray(input.selectedTables)
            ? input.selectedTables.filter((value) => typeof value === "string" && value.length <= 400).slice(0, 100)
            : [];
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
            throw new Error("AI 请求标识无效。");
        if (!connectionId || !schema || !selectedKeys.length || new Set(selectedKeys).size !== selectedKeys.length) {
            throw new Error("请选择当前 Schema 中至少一张表来建立索引。");
        }
        const operation = registerAiOperation(activeAiOperations, requestId, event.sender.id, connectionId);
        const onSenderDestroyed = () => operation.controller.abort();
        event.sender.once("destroyed", onSenderDestroyed);
        try {
            const settings = await readAiModelSettings();
            throwIfAiOperationCancelled(operation);
            const embedding = settings.embedding;
            if (!embedding?.enabled || !embedding.apiKey)
                throw new Error("请先在设置中启用并配置 Embedding 模型。");
            const connection = await connectionFor(connectionId);
            throwIfAiOperationCancelled(operation);
            if (connection.engine === "mongodb")
                throw new Error("MongoDB 结构索引当前不支持。");
            const core = coreFor(connection);
            const [availableSchemas, availableTables] = await Promise.all([core.listSchemas(), core.listTables(schema)]);
            throwIfAiOperationCancelled(operation);
            if (!availableSchemas.includes(schema))
                throw new Error("请求的 Schema 不属于当前连接。");
            const chosen = selectedKeys.map((key) => availableTables.find((table) => schemaTableKey(table.schema, table.name) === key || schema + "." + table.name === key));
            if (chosen.some((table) => !table))
                throw new Error("索引表清单已过期，请刷新对象浏览器后重试。");
            const tables = await Promise.all(chosen.map((table) => getAiSchemaTable(core, connectionId, table, true)));
            throwIfAiOperationCancelled(operation);
            const tested = await core.testConnection();
            throwIfAiOperationCancelled(operation);
            let schemaTables = tables.map((item) => item.table);
            if (connection.engine === "postgres") {
                const spatial = await getPostgisSchemaMetadata(core, schema, schemaTables);
                throwIfAiOperationCancelled(operation);
                schemaTables = applyPostgisSpatialMetadata(schemaTables, spatial.metadata.spatialColumns);
            }
            const documents = schemaTables.flatMap((table) => schemaTableDocumentChunks(table).map((document) => ({ table, document })));
            if (documents.length > 200)
                throw new Error("本次 Schema 需要超过 200 个 Embedding 文档；请减少所选表，或先缩短超长字段备注。");
            const batchSize = Math.min(10, embedding.batchSize ?? 10);
            const vectors = [];
            for (let index = 0; index < documents.length; index += batchSize) {
                throwIfAiOperationCancelled(operation);
                vectors.push(...await createEmbedding(embedding, documents.slice(index, index + batchSize).map((item) => item.document), operation.controller.signal));
                throwIfAiOperationCancelled(operation);
            }
            const scope = schemaIndexScope(connectionId, tested.database, schema);
            const fingerprint = schemaModelFingerprint(embedding);
            await mutateAiSchemaIndex(async (snapshot) => {
                throwIfAiOperationCancelled(operation);
                const chunks = documents.map((item, index) => ({ ...item, vector: vectors[index] }));
                const next = replaceSchemaIndexChunks(snapshot, scope, chunks, fingerprint);
                await writeAiSchemaIndex(next, operation.controller.signal);
            });
            throwIfAiOperationCancelled(operation);
            return { tableCount: schemaTables.length, documentCount: documents.length, dimensions: vectors[0].length, schema };
        }
        finally {
            event.sender.removeListener("destroyed", onSenderDestroyed);
            finishAiOperation(activeAiOperations, requestId, operation);
        }
    });
    ipcMain.handle("ai:schema-index:clear", async (_event, payload) => {
        if (!payload || typeof payload !== "object")
            throw new Error("Schema 索引清理请求格式无效。");
        const input = payload;
        const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
        const schema = typeof input.schema === "string" ? input.schema.trim() : "";
        if (!connectionId || !schema)
            throw new Error("请选择连接和 Schema。");
        const connection = await connectionFor(connectionId);
        const core = coreFor(connection);
        const [tested, schemas] = await Promise.all([core.testConnection(), core.listSchemas()]);
        if (!schemas.includes(schema))
            throw new Error("请求的 Schema 不属于当前连接。");
        const scope = schemaIndexScope(connectionId, tested.database, schema);
        return mutateAiSchemaIndex(async (snapshot) => {
            const entries = snapshot.entries.filter((entry) => entry.scope !== scope);
            const removedCount = snapshot.entries.length - entries.length;
            if (removedCount)
                await writeAiSchemaIndex({ version: 1, entries });
            return { removedCount };
        });
    });
    ipcMain.handle("ai:assistant:run", async (event, payload) => {
        if (!payload || typeof payload !== "object")
            throw new Error("AI 请求格式无效。");
        const input = payload;
        const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
        const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
        const task = input.task;
        const prompt = typeof input.request === "string" ? input.request.trim() : "";
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
            throw new Error("AI 请求标识无效。");
        if (!connectionId)
            throw new Error("请选择数据库连接。");
        if (!["generate", "repair", "explain", "explain-plan", "optimize", "gis"].includes(task))
            throw new Error("AI 任务类型无效。");
        if (prompt.length > 6_000)
            throw new Error("自然语言需求不能超过 6,000 个字符。");
        const operation = registerAiOperation(activeAiOperations, requestId, event.sender.id, connectionId);
        const onSenderDestroyed = () => operation.controller.abort();
        event.sender.once("destroyed", onSenderDestroyed);
        const releaseOperation = () => {
            event.sender.removeListener("destroyed", onSenderDestroyed);
            finishAiOperation(activeAiOperations, requestId, operation);
        };
        let settings;
        let model;
        let connection;
        try {
            settings = await readAiModelSettings();
            throwIfAiOperationCancelled(operation);
            if (!settings.enabled)
                throw new Error("AI SQL Assistant 尚未启用，请先完成模型设置。");
            const modelId = typeof input.modelId === "string" ? input.modelId : settings.defaultChatModelId;
            const selectedModel = settings.chatModels.find((candidate) => candidate.id === modelId && candidate.enabled);
            if (!selectedModel)
                throw new Error("当前没有可用的 Chat 模型。");
            model = selectedModel;
            connection = await connectionFor(connectionId);
            throwIfAiOperationCancelled(operation);
            if (connection.engine === "mongodb")
                throw new Error("MongoDB 当前使用文档查询页；SQL 助手暂不支持 MongoDB Filter。");
            if (task === "gis" && connection.engine !== "postgres")
                throw new Error("PostGIS 助手当前仅支持 PostgreSQL 连接。");
        }
        catch (error) {
            releaseOperation();
            throw error;
        }
        try {
            const core = coreFor(connection);
            const tested = await core.testConnection();
            throwIfAiOperationCancelled(operation);
            const schemaInput = typeof input.schema === "string" ? input.schema.trim() : "";
            const availableSchemas = await core.listSchemas();
            throwIfAiOperationCancelled(operation);
            const defaultSchema = connection.engine === "sqlite" ? "main"
                : connection.engine === "mysql" || connection.engine === "mariadb" ? connection.database ?? availableSchemas[0]
                    : connection.engine === "sqlserver" ? "dbo"
                        : connection.engine === "oracle" ? connection.user?.toUpperCase() ?? availableSchemas[0]
                            : "public";
            const includeSchema = input.includeSchema === true;
            const fallbackSchema = (schemaInput && availableSchemas.includes(schemaInput) ? schemaInput : defaultSchema) ?? availableSchemas[0] ?? "";
            let selectedSchemas = [fallbackSchema];
            if (includeSchema) {
                const requestedSchemas = Array.isArray(input.schemas) ? input.schemas : [fallbackSchema];
                if (!requestedSchemas.length || requestedSchemas.length > 16
                    || requestedSchemas.some((value) => typeof value !== "string" || !value.trim() || value.length > 256)) {
                    throw new Error("Schema 范围无效；一次请选择 1 到 16 个有效 Schema。");
                }
                selectedSchemas = [...new Set(requestedSchemas)];
                if (selectedSchemas.some((selected) => !availableSchemas.includes(selected))) {
                    throw new Error("请求的 Schema 不属于当前连接。");
                }
            }
            const schema = selectedSchemas[0] || fallbackSchema;
            const refreshSchema = input.refreshSchema === true;
            const selectedSql = typeof input.selectedSql === "string" ? input.selectedSql.slice(0, 30_000) : "";
            const executionPlan = typeof input.executionPlan === "string" ? input.executionPlan.trim() : "";
            if (task === "explain-plan" && !executionPlan)
                throw new Error("请粘贴数据库客户端生成的执行计划；本应用不会自动运行 EXPLAIN。");
            if (executionPlan.length > 12_000)
                throw new Error("执行计划不能超过 12,000 个字符。");
            const errorPayload = input.error && typeof input.error === "object" ? input.error : undefined;
            const errorMessage = typeof errorPayload?.message === "string" ? errorPayload.message.slice(0, 4_000) : "";
            let schemaTables = [];
            let metadataWarnings = [];
            let postgis;
            let loadedSchemaIndex;
            let semanticScopes = [];
            let semanticModelFingerprint = "";
            if (includeSchema) {
                if (task === "gis" && selectedSchemas.length !== 1) {
                    throw new Error("PostGIS 空间 SQL 当前要求选择一个 Schema。");
                }
                const availableTablesBySchema = await Promise.all(selectedSchemas.map((selected) => core.listTables(selected)));
                const availableTables = availableTablesBySchema.flat();
                throwIfAiOperationCancelled(operation);
                const requestedKeys = Array.isArray(input.selectedTables)
                    ? input.selectedTables.filter((value) => typeof value === "string" && value.length <= 400).slice(0, 100)
                    : [];
                const validKeys = availableTables
                    .filter((table) => requestedKeys.includes(schemaTableKey(table.schema, table.name))
                    || (selectedSchemas.length === 1 && requestedKeys.includes(table.schema + "." + table.name)))
                    .map((table) => schemaTableKey(table.schema, table.name));
                if (task === "gis" && !validKeys.length)
                    throw new Error("GIS SQL 助手需要你明确选择一个或多个空间表。");
                const candidates = availableTables.map((table) => ({
                    schema: table.schema, name: table.name, type: table.type, comment: table.comment ?? undefined, columns: [],
                }));
                let keywordRows = selectRelevantTables(prompt + "\n" + selectedSql, candidates, [], 100);
                let semanticMatches = [];
                const embedding = settings.embedding;
                if (embedding?.enabled && embedding.apiKey && prompt) {
                    try {
                        const index = await readAiSchemaIndex();
                        const scopes = selectedSchemas.map((selected) => schemaIndexScope(connectionId, tested.database, selected));
                        loadedSchemaIndex = index;
                        semanticScopes = scopes;
                        const inScope = index.entries.filter((entry) => scopes.includes(entry.scope));
                        const indexedScopes = new Set(inScope.map((entry) => entry.scope));
                        const missingSchemas = selectedSchemas.filter((_, index) => !indexedScopes.has(scopes[index]));
                        if (missingSchemas.length) {
                            metadataWarnings.push(`以下 Schema 没有本机语义索引，将仅使用关键词匹配：${missingSchemas.join(", ")}`);
                        }
                        const modelFingerprint = schemaModelFingerprint(embedding);
                        semanticModelFingerprint = modelFingerprint;
                        if (inScope.length) {
                            const compatible = inScope.some((entry) => entry.modelFingerprint === modelFingerprint);
                            if (!compatible)
                                metadataWarnings.push("Embedding 模型、维度或索引格式已变化；当前请求退回关键词匹配。重建时所选 Schema 的旧索引将被替换，请选择所有需要语义检索的表。");
                            else {
                                const coverage = findSchemaIndexTableCoverageDifferences(index, scopes, candidates, modelFingerprint);
                                if (coverage.unindexedTableKeys.length || coverage.orphanedTableKeys.length) {
                                    metadataWarnings.push(`当前表清单与本机语义索引覆盖范围不同：${coverage.unindexedTableKeys.length} 张当前表未建立该模型索引，${coverage.orphanedTableKeys.length} 个索引表已不在当前表清单中。可用当前表选择重建索引；本次仍会结合可用索引和关键词检索。`);
                                }
                                const queryVector = (await createEmbedding(embedding, prompt, operation.controller.signal))[0];
                                const searched = searchSchemaIndex(index, scopes, prompt, queryVector, modelFingerprint, 100);
                                semanticMatches = searched.matches;
                                if (searched.rebuildRequired)
                                    metadataWarnings.push("部分 Schema 语义索引的模型、维度或格式已变化；请重建所选范围内的索引。");
                            }
                        }
                        else
                            metadataWarnings.push("所选 Schema 尚无可用语义索引；本次先按表名和表注释匹配，若无表级命中则扫描列元数据查找字段名。");
                    }
                    catch (error) {
                        if (operation.controller.signal.aborted)
                            throw new Error("AI 请求已取消。");
                        metadataWarnings.push("Schema 语义检索暂不可用，当前请求退回本地关键词匹配（先匹配表名和注释，无命中时扫描列元数据）：" + (error instanceof Error ? error.message.slice(0, 180) : "模型错误"));
                    }
                }
                if (!keywordRows.length && !semanticMatches.length && !validKeys.length) {
                    const loaded = await loadSchemaCandidateMetadata(candidates, async (table) => (await getAiSchemaTable(core, connectionId, {
                        schema: table.schema, name: table.name, type: table.type, comment: table.comment ?? null,
                    }, refreshSchema)).table, { signal: operation.controller.signal, concurrency: 8 });
                    throwIfAiOperationCancelled(operation);
                    keywordRows = selectRelevantTables(prompt + "\n" + selectedSql, loaded.tables, [], 100);
                    metadataWarnings.push("关键词预筛选未命中表名或注释；已扫描所选 Schema 的列元数据以查找字段名。");
                    if (loaded.failedCount)
                        metadataWarnings.push(`${loaded.failedCount} 张表的列元数据读取失败，字段关键词检索覆盖不完整。`);
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
                    .sort((left, right) => Number(right.selected) - Number(left.selected) || right.score - left.score || left.index - right.index);
                const rerankConfig = settings.rerank;
                const rerankMetadata = new Map();
                if (rerankConfig?.enabled && rerankConfig.apiKey && prompt && rankedCandidates.length > 1) {
                    const rerankPool = rankedCandidates.slice(0, 12);
                    try {
                        const candidateMetadata = await Promise.all(rerankPool.map((item) => getAiSchemaTable(core, connectionId, item.table, refreshSchema)));
                        throwIfAiOperationCancelled(operation);
                        const documents = candidateMetadata.map(({ table }) => schemaTableDocument(table).slice(0, 1_200));
                        const ranked = await rerank(rerankConfig, prompt.slice(0, 1_000), documents, operation.controller.signal);
                        const rerankedPool = rankSchemaCandidatesByRerank(rerankPool.map((item) => ({ key: item.key, score: item.score, selected: item.selected })), ranked, rerankPool.length);
                        const candidatesByKey = new Map(rerankPool.map((item) => [item.key, item]));
                        const rerankedKeys = new Set(rerankedPool.map((item) => item.key));
                        rankedCandidates = [
                            ...rerankedPool.map((item) => candidatesByKey.get(item.key)).filter(Boolean),
                            ...rankedCandidates.filter((item) => !rerankedKeys.has(item.key)),
                        ];
                        rerankPool.forEach((item, index) => rerankMetadata.set(item.key, candidateMetadata[index]));
                        if (prompt.length > 1_000)
                            metadataWarnings.push("Rerank 查询仅使用需求前 1,000 个字符；SQL 助手仍使用完整需求。");
                    }
                    catch (error) {
                        if (operation.controller.signal.aborted)
                            throw new Error("AI 请求已取消。");
                        metadataWarnings.push("Schema Rerank 暂不可用，当前请求退回关键词和向量排序：" + (error instanceof Error ? error.message.slice(0, 180) : "模型错误"));
                    }
                }
                else if (rerankConfig?.enabled && !rerankConfig.apiKey && prompt) {
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
                if (!relevant.length)
                    throw new Error("所选范围内没有可用的表。请先选择数据库连接与 Schema，或在需求中写出准确表名。");
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
                    schemaTables = applyPostgisSpatialMetadata(schemaTables, postgis.spatialColumns);
                }
                if (loadedSchemaIndex && semanticScopes.length && semanticModelFingerprint) {
                    const indexedByTable = new Map(loadedSchemaIndex.entries
                        .filter((entry) => semanticScopes.includes(entry.scope) && entry.modelFingerprint === semanticModelFingerprint)
                        .map((entry) => [entry.tableKey, entry]));
                    if (connection.engine === "postgres" && task !== "gis") {
                        const indexedTablesBySchema = new Map();
                        for (const table of schemaTables) {
                            if (!indexedByTable.has(schemaTableKey(table.schema, table.name)))
                                continue;
                            const schemaTablesForIndex = indexedTablesBySchema.get(table.schema) ?? [];
                            schemaTablesForIndex.push(table);
                            indexedTablesBySchema.set(table.schema, schemaTablesForIndex);
                        }
                        const indexedSchemas = [...indexedTablesBySchema.entries()];
                        if (indexedSchemas.length) {
                            const spatialResults = await Promise.all(indexedSchemas.map(([indexedSchema, indexedTables]) => getPostgisSchemaMetadata(core, indexedSchema, indexedTables)));
                            throwIfAiOperationCancelled(operation);
                            schemaTables = spatialResults.reduce((tables, spatial) => applyPostgisSpatialMetadata(tables, spatial.metadata.spatialColumns), schemaTables);
                        }
                    }
                    if (findStaleSchemaIndexTableKeys(loadedSchemaIndex, semanticScopes, schemaTables, semanticModelFingerprint).length) {
                        metadataWarnings.push("检测到已选表结构与本机语义索引不同；请用当前表选择重新建立索引以更新检索内容。");
                    }
                }
            }
            const selectedError = errorMessage ? {
                message: errorMessage,
                code: typeof errorPayload?.code === "string" ? errorPayload.code.slice(0, 128) : undefined,
                position: Number.isInteger(errorPayload?.position) ? Number(errorPayload?.position) : undefined,
            } : undefined;
            const response = await runSqlAssistant(model, {
                task,
                request: prompt || (task === "repair" ? "Repair the failed SQL while preserving its intent." : ""),
                context: {
                    engine: connection.engine,
                    serverVersion: tested.serverVersion,
                    database: tested.database,
                    schema,
                    tables: schemaTables,
                    postgis,
                    metadataWarnings,
                    selectedSql: selectedSql || undefined,
                    executionPlan: task === "explain-plan" ? executionPlan : undefined,
                    error: selectedError,
                },
            }, {
                signal: operation.controller.signal,
                onDelta: (delta) => {
                    if (!event.sender.isDestroyed())
                        event.sender.send("ai:assistant:delta", { requestId, delta });
                },
            });
            if (operation.controller.signal.aborted)
                throw new Error("AI 请求已取消。");
            return response;
        }
        finally {
            releaseOperation();
        }
    });
    ipcMain.handle("ai:mongo-assistant:run", async (event, payload) => {
        if (!payload || typeof payload !== "object")
            throw new Error("MongoDB AI 请求格式无效。");
        const input = payload;
        const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
        const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
        const database = typeof input.database === "string" ? input.database.trim() : "";
        const collection = typeof input.collection === "string" ? input.collection.trim() : "";
        const task = input.task;
        const mode = input.mode;
        const prompt = typeof input.request === "string" ? input.request.trim() : "";
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
            throw new Error("AI 请求标识无效。");
        if (activeAiOperations.has(requestId))
            throw new Error("该 AI 请求标识已在使用中。");
        if (!connectionId || !database || !collection)
            throw new Error("请选择 MongoDB 连接、数据库和 Collection。");
        if (!["generate", "repair", "explain"].includes(task))
            throw new Error("MongoDB AI 任务类型无效。");
        if (mode !== "find" && mode !== "aggregate")
            throw new Error("MongoDB 查询模式无效。");
        if (prompt.length > 6_000)
            throw new Error("自然语言需求不能超过 6,000 个字符。");
        if (input.includeContext !== true)
            throw new Error("请先确认要发送给所选模型的 MongoDB 查询上下文。");
        const operation = registerAiOperation(activeAiOperations, requestId, event.sender.id, connectionId);
        const onSenderDestroyed = () => operation.controller.abort();
        event.sender.once("destroyed", onSenderDestroyed);
        const releaseOperation = () => {
            event.sender.removeListener("destroyed", onSenderDestroyed);
            finishAiOperation(activeAiOperations, requestId, operation);
        };
        let settings;
        let model;
        let connection;
        try {
            settings = await readAiModelSettings();
            throwIfAiOperationCancelled(operation);
            if (!settings.enabled)
                throw new Error("AI SQL Assistant 尚未启用，请先完成模型设置。");
            const modelId = typeof input.modelId === "string" ? input.modelId : settings.defaultChatModelId;
            const selectedModel = settings.chatModels.find((candidate) => candidate.id === modelId && candidate.enabled);
            if (!selectedModel)
                throw new Error("当前没有可用的 Chat 模型。");
            model = selectedModel;
            connection = await connectionFor(connectionId);
            throwIfAiOperationCancelled(operation);
            if (connection.engine !== "mongodb")
                throw new Error("MongoDB AI 助手需要 MongoDB 连接。");
        }
        catch (error) {
            releaseOperation();
            throw error;
        }
        const queryInput = input.query && typeof input.query === "object" ? input.query : {};
        const errorInput = input.error && typeof input.error === "object" ? input.error : undefined;
        try {
            const response = await runMongoAssistant(model, {
                task,
                request: prompt,
                context: {
                    database: database.slice(0, 256),
                    collection: collection.slice(0, 256),
                    mode,
                    schemaHint: typeof input.schemaHint === "string" ? input.schemaHint.slice(0, 8_000) : undefined,
                    query: {
                        filter: typeof queryInput.filter === "string" ? queryInput.filter.slice(0, 10_000) : undefined,
                        projection: typeof queryInput.projection === "string" ? queryInput.projection.slice(0, 10_000) : undefined,
                        sort: typeof queryInput.sort === "string" ? queryInput.sort.slice(0, 10_000) : undefined,
                        pipeline: typeof queryInput.pipeline === "string" ? queryInput.pipeline.slice(0, 10_000) : undefined,
                    },
                    error: errorInput && typeof errorInput.message === "string" ? {
                        message: errorInput.message.slice(0, 4_000),
                        code: typeof errorInput.code === "string" ? errorInput.code.slice(0, 128) : undefined,
                    } : undefined,
                },
            }, {
                signal: operation.controller.signal,
                onDelta: (delta) => {
                    if (!event.sender.isDestroyed())
                        event.sender.send("ai:assistant:delta", { requestId, delta });
                },
            });
            if (operation.controller.signal.aborted)
                throw new Error("AI 请求已取消。");
            return response;
        }
        finally {
            releaseOperation();
        }
    });
    ipcMain.handle("connections:list", async () => (await readConnections()).map(publicConnection));
    ipcMain.handle("connections:backup-and-reset-unreadable", async () => runConnectionStoreOperation(async () => {
        const backupPath = await backupAndResetUnreadableConnectionStore(connectionsPath(), async () => (await readConnectionsFromStore()).connections, async () => writeConnections([]));
        return { backupPath };
    }));
    ipcMain.handle("connections:save", async (_event, input) => runConnectionStoreOperation(async () => {
        if (!input.name.trim())
            throw new Error("连接名称不能为空。");
        if (!desktopEngines.has(input.engine)) {
            throw new Error("当前桌面版本支持 PostgreSQL、MySQL、MariaDB、SQLite、SQL Server、Oracle 和 MongoDB。");
        }
        if (input.engine === "mongodb") {
            const old = (await readConnectionsFromStore()).connections.find((candidate) => candidate.id === input.id);
            const uri = input.uri?.trim() || (old?.engine === "mongodb" ? old.uri : "") || "";
            let parsed;
            try {
                parsed = new URL(uri);
            }
            catch {
                throw new Error("请输入有效的 MongoDB URI（mongodb:// 或 mongodb+srv://）。");
            }
            if (!["mongodb:", "mongodb+srv:"].includes(parsed.protocol) || !parsed.hostname) {
                throw new Error("MongoDB URI 必须以 mongodb:// 或 mongodb+srv:// 开头，并包含主机名。");
            }
        }
        else if (input.engine === "sqlite") {
            if (!input.path?.trim())
                throw new Error("SQLite 数据库文件路径不能为空。");
        }
        else {
            if (!input.host?.trim() || !input.user?.trim()) {
                throw new Error("主机和用户名不能为空。");
            }
            if (input.engine === "postgres" && !input.database?.trim()) {
                throw new Error("PostgreSQL 默认数据库不能为空。");
            }
            if (input.engine === "oracle" && !input.database?.trim()) {
                throw new Error("Oracle 必须指定服务名，例如 FREEPDB1。");
            }
            if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
                throw new Error("端口必须是 1 到 65535 之间的整数。");
            }
        }
        const connections = (await readConnectionsFromStore()).connections;
        const old = connections.find((candidate) => candidate.id === input.id);
        const password = input.password || (old?.engine === input.engine ? old.password : "") || "";
        const ssh = storedSshConfig(input.ssh, old, input.engine);
        if (input.engine === "sqlserver" && !password)
            throw new Error("SQL Server SQL 身份验证需要密码。");
        if (input.engine === "oracle" && !password)
            throw new Error("Oracle 连接必须提供密码。");
        const baseConnection = input.engine === "sqlite"
            ? { id: input.id, name: input.name.trim(), engine: input.engine, path: input.path.trim(), password: "", ssl: false }
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
        const connection = { ...baseConnection, ssh };
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
            if (operation.connectionId === input.id)
                operation.controller.abort();
        }
    }));
    ipcMain.handle("connections:remove", async (_event, id) => runConnectionStoreOperation(async () => {
        const connections = (await readConnectionsFromStore()).connections;
        await commitConnectionRemoval(connections, id, async () => {
            await clearAiSchemaIndex(id);
            await sshTunnelManager.close(id);
        }, writeConnections);
        clearAiSchemaCache(id);
        for (const operation of activeAiOperations.values()) {
            if (operation.connectionId === id)
                operation.controller.abort();
        }
    }));
    ipcMain.handle("connections:test", async (_event, id) => {
        const connection = await connectionFor(id);
        return connection.engine === "mongodb"
            ? mongoFor(connection).testConnection()
            : coreFor(connection).testConnection();
    });
    ipcMain.handle("database:databases", async (_event, id) => {
        const connection = await connectionFor(id);
        return connection.engine === "mongodb" ? mongoFor(connection).listDatabases() : coreFor(connection).listDatabases();
    });
    ipcMain.handle("database:schemas", async (_event, id) => coreFor(await connectionFor(id)).listSchemas());
    ipcMain.handle("database:tables", async (_event, id, schema) => coreFor(await connectionFor(id)).listTables(schema));
    ipcMain.handle("database:transfer-table", async (_event, sourceId, payload) => {
        const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)
            && Object.getPrototypeOf(value) === Object.prototype);
        const isName = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && Boolean(value.trim()) && !value.includes("\0");
        if (typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 120) {
            throw new Error("Source connection identifier is invalid.");
        }
        if (!isRecord(payload))
            throw new Error("Table transfer request is invalid.");
        const targetConnectionId = typeof payload.targetConnectionId === "string" ? payload.targetConnectionId.trim() : "";
        if (!targetConnectionId || targetConnectionId.length > 120)
            throw new Error("Choose a valid destination connection.");
        if (sourceId === targetConnectionId)
            throw new Error("Choose a different destination connection.");
        if (!isName(payload.sourceTable) || !isName(payload.targetTable))
            throw new Error("Table names are invalid.");
        const optionalSchema = (value, label) => {
            if (value === undefined)
                return undefined;
            if (!isName(value))
                throw new Error(`${label} is invalid.`);
            return value;
        };
        const sourceSchema = optionalSchema(payload.sourceSchema, "Source schema");
        const targetSchema = optionalSchema(payload.targetSchema, "Destination schema");
        let columnMappings;
        if (payload.columnMappings !== undefined) {
            if (!Array.isArray(payload.columnMappings) || payload.columnMappings.length > 4_096) {
                throw new Error("Column mappings must be an array with at most 4,096 entries.");
            }
            columnMappings = payload.columnMappings.map((mapping, index) => {
                if (!isRecord(mapping) || !isName(mapping.sourceColumn) || !isName(mapping.targetColumn)) {
                    throw new Error(`Column mapping ${index + 1} is invalid.`);
                }
                return { sourceColumn: mapping.sourceColumn, targetColumn: mapping.targetColumn };
            });
        }
        const pageSize = payload.pageSize ?? 250;
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
            throw new Error("Table transfer page size must be an integer from 1 to 1,000.");
        }
        const [source, target] = await Promise.all([connectionFor(sourceId), connectionFor(targetConnectionId)]);
        if (source.engine === "mongodb" || target.engine === "mongodb") {
            throw new Error("Cross-database table transfer currently supports relational databases only.");
        }
        return coreFor(source).transferTableRows(coreFor(target), {
            sourceTable: payload.sourceTable,
            sourceSchema,
            targetTable: payload.targetTable,
            targetSchema,
            pageSize: pageSize,
            columnMappings,
        });
    });
    ipcMain.handle("database:columns", async (_event, id, table, schema) => {
        if (typeof table !== "string" || !table.trim())
            throw new Error("表名不能为空。");
        return coreFor(await connectionFor(id)).getTableColumns(table, schema);
    });
    ipcMain.handle("database:query", async (_event, id, sql, parameters = []) => {
        if (typeof sql !== "string" || !sql.trim())
            throw new Error("SQL 不能为空。");
        return coreFor(await connectionFor(id)).query(sql, parameters);
    });
    ipcMain.handle("database:update-rows", async (_event, id, input) => {
        const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)
            && Object.getPrototypeOf(value) === Object.prototype);
        const isScalar = (value, allowDate) => value === null || typeof value === "string" || typeof value === "boolean"
            || typeof value === "number" && Number.isFinite(value)
            || allowDate && value instanceof Date && Number.isFinite(value.getTime());
        if (!isRecord(input) || typeof input.schema !== "string" || !input.schema.trim() || input.schema.length > 400
            || typeof input.table !== "string" || !input.table.trim() || input.table.length > 400
            || !Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 100) {
            throw new Error("表格更新必须包含有效的 schema、表名和 1 到 100 行修改。");
        }
        let textValueLength = 0;
        const changes = input.changes.map((entry) => {
            if (!isRecord(entry) || !isRecord(entry.primaryKeyValues) || !isRecord(entry.values)
                || !Object.keys(entry.primaryKeyValues).length || Object.keys(entry.primaryKeyValues).length > 256
                || !Object.keys(entry.values).length || Object.keys(entry.values).length > 256) {
                throw new Error("每行修改都必须包含主键值和至少一个字段值。");
            }
            for (const record of [entry.primaryKeyValues, entry.values]) {
                for (const [name, value] of Object.entries(record)) {
                    if (!name || name.length > 400 || !isScalar(value, record === entry.primaryKeyValues)) {
                        throw new Error("行定位值和字段值只能使用有效标量。");
                    }
                    if (typeof value === "string") {
                        textValueLength += value.length;
                        if (textValueLength > 1_000_000)
                            throw new Error("单次表格更新的文本内容不能超过 1 MB。");
                    }
                }
            }
            return { primaryKeyValues: entry.primaryKeyValues, values: entry.values };
        });
        const connection = await connectionFor(id);
        if (connection.engine === "mongodb")
            throw new Error("MongoDB 文档不能通过 SQL 表格编辑器修改。");
        return coreFor(connection).updateTableRows(connection.engine, input.schema, input.table, changes);
    });
    ipcMain.handle("query-history:list", async () => {
        await queryHistoryMutationQueue;
        return readQueryHistorySnapshot();
    });
    ipcMain.handle("query-history:record", async (_event, input) => mutateQueryHistory((snapshot) => appendQueryHistory(snapshot, input)));
    ipcMain.handle("query-history:clear", async (_event, connectionId) => {
        if (connectionId !== undefined && (typeof connectionId !== "string" || !connectionId.trim() || connectionId.length > 200)) {
            throw new Error("查询历史连接标识无效。");
        }
        return mutateQueryHistory((snapshot) => clearQueryHistory(snapshot, connectionId));
    });
    ipcMain.handle("query-history:favorite:save", async (_event, input) => mutateQueryHistory((snapshot) => upsertQueryFavorite(snapshot, input)));
    ipcMain.handle("query-history:favorite:remove", async (_event, id) => {
        if (typeof id !== "string" || !id.trim() || id.length > 120)
            throw new Error("查询收藏标识无效。");
        return mutateQueryHistory((snapshot) => removeQueryFavorite(snapshot, id));
    });
    ipcMain.handle("database:export-table", async (_event, id, table, schema) => {
        if (typeof table !== "string" || !table.trim())
            throw new Error("表名不能为空。");
        const safeName = table.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "table";
        const result = await dialog.showSaveDialog({
            defaultPath: `${safeName}.csv`,
            filters: [
                { name: "CSV 表格", extensions: ["csv"] },
                { name: "JSON 数据", extensions: ["json"] },
                { name: "Excel 工作簿", extensions: ["xlsx"] },
            ],
        });
        if (result.canceled || !result.filePath)
            return null;
        const extension = path.extname(result.filePath).toLowerCase();
        if (extension && extension !== ".csv" && extension !== ".json" && extension !== ".xlsx") {
            throw new Error("导出文件扩展名必须是 .csv、.json 或 .xlsx。");
        }
        const format = extension === ".json" ? "json" : extension === ".xlsx" ? "xlsx" : "csv";
        const rows = await coreFor(await connectionFor(id)).exportTable(table, schema);
        if (format === "xlsx") {
            await writeFile(result.filePath, await queryResultToXlsx(rows));
        }
        else {
            const content = format === "csv"
                ? `\uFEFF${queryResultToCsv(rows, { nullValue: "\\N" })}\n`
                : `${JSON.stringify({ columns: rows.columns, rows: rows.rows, rowCount: rows.rowCount }, null, 2)}\n`;
            await writeFile(result.filePath, content, "utf8");
        }
        return { path: result.filePath, format, rowCount: rows.rowCount, columnCount: rows.columns.length };
    });
    ipcMain.handle("database:import-table", async (_event, id, table, schema) => {
        if (typeof table !== "string" || !table.trim())
            throw new Error("表名不能为空。");
        const selection = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [
                { name: "CSV、JSON 或 Excel 数据", extensions: ["csv", "json", "xlsx"] },
                { name: "CSV", extensions: ["csv"] },
                { name: "JSON", extensions: ["json"] },
                { name: "Excel", extensions: ["xlsx"] },
            ],
        });
        if (selection.canceled || !selection.filePaths[0])
            return null;
        const file = selection.filePaths[0];
        const extension = path.extname(file).toLowerCase();
        if (extension !== ".csv" && extension !== ".json" && extension !== ".xlsx") {
            throw new Error("仅支持 CSV、JSON 或 XLSX 文件。");
        }
        const core = coreFor(await connectionFor(id));
        const imported = extension === ".xlsx"
            ? await core.importTableWorkbook(table, await readFile(file), schema)
            : await core.importRows(table, parseTabularData(await readFile(file, "utf8"), extension === ".csv" ? "csv" : "json"), schema);
        return { path: file, ...imported };
    });
    ipcMain.handle("database:import-table-new", async (_event, id, table, schema) => {
        if (typeof table !== "string" || !table.trim())
            throw new Error("表名不能为空。");
        if (schema !== undefined && (typeof schema !== "string" || !schema.trim()))
            throw new Error("Schema 名称不能为空。");
        const selection = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [
                { name: "CSV、JSON 或 Excel 数据", extensions: ["csv", "json", "xlsx"] },
                { name: "CSV", extensions: ["csv"] },
                { name: "JSON", extensions: ["json"] },
                { name: "Excel", extensions: ["xlsx"] },
            ],
        });
        if (selection.canceled || !selection.filePaths[0])
            return null;
        const file = selection.filePaths[0];
        const extension = path.extname(file).toLowerCase();
        if (extension !== ".csv" && extension !== ".json" && extension !== ".xlsx") {
            throw new Error("仅支持 CSV、JSON 或 XLSX 文件。");
        }
        const core = coreFor(await connectionFor(id));
        const imported = extension === ".xlsx"
            ? await core.importWorkbookToNewTable(table, await readFile(file), schema)
            : await core.createTableFromRows(table, parseTabularData(await readFile(file, "utf8"), extension === ".csv" ? "csv" : "json"), schema);
        return { path: file, ...imported };
    });
    ipcMain.handle("mongo:databases", async (_event, id) => mongoFor(await connectionFor(id)).listDatabases());
    ipcMain.handle("mongo:collections", async (_event, id, database) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        return mongoFor(await connectionFor(id)).listCollections(database);
    });
    ipcMain.handle("mongo:indexes", async (_event, id, database, collection) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        return mongoFor(await connectionFor(id)).listIndexes(database, collection);
    });
    ipcMain.handle("mongo:create-2dsphere-index", async (_event, id, database, collection, field) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        if (typeof field !== "string" || !field.trim())
            throw new Error("GeoJSON Geometry 字段名不能为空。");
        return mongoFor(await connectionFor(id)).createTwoDSphereIndex(database, collection, field);
    });
    ipcMain.handle("mongo:find", async (_event, id, database, collection, options = {}) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        const documents = await mongoFor(await connectionFor(id)).findDocuments(database, collection, options);
        return stringifyMongoJson(documents);
    });
    ipcMain.handle("mongo:aggregate", async (_event, id, database, collection, pipeline, limit = 100) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        const documents = await mongoFor(await connectionFor(id)).aggregateDocuments(database, collection, pipeline, limit);
        return stringifyMongoJson(documents);
    });
    ipcMain.handle("mongo:import", async (_event, id, database, collection) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        const selection = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "JSON / Extended JSON", extensions: ["json", "ejson"] }, { name: "所有文件", extensions: ["*"] }],
        });
        if (selection.canceled || !selection.filePaths[0])
            return null;
        const file = selection.filePaths[0];
        const insertedCount = await mongoFor(await connectionFor(id)).importJson(database, collection, await readFile(file, "utf8"));
        return { path: file, insertedCount };
    });
    ipcMain.handle("mongo:export", async (_event, id, database, collection, filter) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        const result = await dialog.showSaveDialog({
            defaultPath: `${collection.replace(/[<>:\"/\\\\|?*\\x00-\\x1f]/g, "_") || "documents"}.json`,
            filters: [{ name: "JSON / Extended JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath)
            return null;
        const documents = await mongoFor(await connectionFor(id)).exportDocuments(database, collection, { filter, limit: 100_000 });
        await writeFile(result.filePath, `${stringifyMongoJson(documents)}\\n`, "utf8");
        return { path: result.filePath, documentCount: documents.length };
    });
    ipcMain.handle("mongo:geo-import", async (_event, id, database, collection, geometryField = "geometry") => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        const selection = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }, { name: "所有文件", extensions: ["*"] }],
        });
        if (selection.canceled || !selection.filePaths[0])
            return null;
        const file = selection.filePaths[0];
        const insertedCount = await mongoFor(await connectionFor(id)).importGeoJson(database, collection, await readFile(file, "utf8"), geometryField);
        return { path: file, insertedCount };
    });
    ipcMain.handle("mongo:geo-export", async (_event, id, database, collection, geometryField = "geometry", filter) => {
        if (typeof database !== "string" || !database.trim())
            throw new Error("MongoDB 数据库名不能为空。");
        if (typeof collection !== "string" || !collection.trim())
            throw new Error("MongoDB Collection 名称不能为空。");
        const result = await dialog.showSaveDialog({
            defaultPath: `${collection.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "features"}.geojson`,
            filters: [{ name: "GeoJSON", extensions: ["geojson"] }],
        });
        if (result.canceled || !result.filePath)
            return null;
        const featureCollection = await mongoFor(await connectionFor(id)).exportGeoJson(database, collection, { filter, limit: 100_000 }, geometryField);
        await writeFile(result.filePath, `${stringifyMongoJson(featureCollection)}\n`, "utf8");
        return { path: result.filePath, featureCount: featureCollection.features.length };
    });
    ipcMain.handle("gis:inspect", async (_event, file, options = {}) => CoreService.fromEnvironment().inspectGisFile(file, options));
    ipcMain.handle("gis:preview", async (_event, file, options = {}) => CoreService.fromEnvironment().previewGisAttributes(file, options));
    ipcMain.handle("gis:validate", async (_event, file, options = {}) => CoreService.fromEnvironment().checkGisGeometry(file, options));
    ipcMain.handle("gis:inspect-table", async (_event, id, table) => {
        if (!table.trim())
            throw new Error("请输入空间源表名。");
        const connection = await connectionFor(id);
        const core = coreFor(connection);
        if (connection.engine === "sqlite")
            return core.inspectSqliteGisTable(table);
        return core.inspectPostgresGisTable(table);
    });
    ipcMain.handle("gis:import", async (event, id, file, table, options = {}, operationId) => {
        if (!table.trim())
            throw new Error("请输入目标表名。");
        if (typeof operationId !== "string" || operationId.length > 128 || activeGisOperations.has(operationId)) {
            throw new Error("GIS 操作标识无效或已在运行。");
        }
        const controller = new AbortController();
        activeGisOperations.set(operationId, { senderId: event.sender.id, controller });
        try {
            const connection = await connectionFor(id);
            const core = coreFor(connection);
            if (options.spatialColumnType !== undefined
                && options.spatialColumnType !== "geometry" && options.spatialColumnType !== "geography") {
                throw new Error("SQL Server spatial column type must be geometry or geography.");
            }
            if (options.spatialColumnType !== undefined && connection.engine !== "sqlserver") {
                throw new Error("SQL Server spatial column type can only be selected for SQL Server imports.");
            }
            if (options.createSpatialIndex !== undefined && typeof options.createSpatialIndex !== "boolean") {
                throw new Error("Spatial-index option must be a boolean.");
            }
            if (options.initializeSpatialite !== undefined && typeof options.initializeSpatialite !== "boolean") {
                throw new Error("SpatiaLite initialization option must be a boolean.");
            }
            if (options.initializeSpatialite && connection.engine !== "sqlite") {
                throw new Error("SpatiaLite initialization is only supported for SQLite GIS imports.");
            }
            if (options.createSpatialIndex && !["sqlite", "oracle", "mysql", "mariadb", "sqlserver"].includes(connection.engine)) {
                throw new Error("Spatial-index creation is currently available for SQLite/SpatiaLite, Oracle, MySQL, MariaDB, and SQL Server GIS imports.");
            }
            const operationOptions = {
                signal: controller.signal,
                onProgress: (percent) => {
                    if (!event.sender.isDestroyed())
                        event.sender.send("gis:progress", { operationId, percent });
                },
            };
            let report;
            if (connection.engine === "sqlite") {
                report = await core.importGisToSqlite(file, table, {
                    mode: options.mode,
                    sourceLayer: options.sourceLayer,
                    sourceCrs: options.sourceCrs,
                    targetCrs: options.targetCrs,
                    coordinateOperation: options.coordinateOperation,
                    fieldMappings: options.fieldMappings,
                    spatialFilter: options.spatialFilter,
                    makeValid: options.makeValid,
                    sourceEncoding: options.sourceEncoding,
                    zipFilenameEncoding: options.zipFilenameEncoding,
                    replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
                    createSpatialIndex: options.createSpatialIndex,
                    initializeSpatialite: options.initializeSpatialite,
                }, operationOptions);
            }
            else if (connection.engine === "mysql" || connection.engine === "mariadb") {
                report = await core.importGisToMysqlFamily(file, table, connection.database ?? "", {
                    mode: options.mode,
                    sourceLayer: options.sourceLayer,
                    sourceCrs: options.sourceCrs,
                    targetCrs: options.targetCrs,
                    coordinateOperation: options.coordinateOperation,
                    fieldMappings: options.fieldMappings,
                    spatialFilter: options.spatialFilter,
                    makeValid: options.makeValid,
                    sourceEncoding: options.sourceEncoding,
                    zipFilenameEncoding: options.zipFilenameEncoding,
                    replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
                    geometryColumn: options.geometryColumn,
                    createSpatialIndex: options.createSpatialIndex,
                }, operationOptions);
            }
            else if (connection.engine === "sqlserver") {
                const parts = table.split(".");
                if (parts.length > 2 || parts.some((part) => !part.trim())) {
                    throw new Error("SQL Server GIS target must be a table name or schema.table.");
                }
                const targetSchema = parts.length === 2 ? parts[0] : "dbo";
                const targetTable = parts.length === 2 ? parts[1] : parts[0];
                report = await core.importGisToSqlServer(file, targetTable, targetSchema, {
                    mode: options.mode,
                    sourceLayer: options.sourceLayer,
                    sourceCrs: options.sourceCrs,
                    targetCrs: options.targetCrs,
                    coordinateOperation: options.coordinateOperation,
                    fieldMappings: options.fieldMappings,
                    spatialFilter: options.spatialFilter,
                    makeValid: options.makeValid,
                    sourceEncoding: options.sourceEncoding,
                    zipFilenameEncoding: options.zipFilenameEncoding,
                    replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
                    geometryColumn: options.geometryColumn,
                    spatialColumnType: options.spatialColumnType,
                    createSpatialIndex: options.createSpatialIndex,
                }, operationOptions);
            }
            else if (connection.engine === "oracle") {
                const parts = table.split(".");
                if (parts.length !== 2 || parts.some((part) => !part.trim())) {
                    throw new Error("Oracle GIS target must use the form schema.table.");
                }
                report = await core.importGisToOracle(file, parts[1], parts[0], {
                    mode: options.mode,
                    sourceLayer: options.sourceLayer,
                    sourceCrs: options.sourceCrs,
                    targetCrs: options.targetCrs,
                    coordinateOperation: options.coordinateOperation,
                    fieldMappings: options.fieldMappings,
                    spatialFilter: options.spatialFilter,
                    makeValid: options.makeValid,
                    sourceEncoding: options.sourceEncoding,
                    zipFilenameEncoding: options.zipFilenameEncoding,
                    replaceIncompleteUtf8Tails: options.replaceIncompleteUtf8Tails,
                    geometryColumn: options.geometryColumn,
                    createSpatialIndex: options.createSpatialIndex,
                }, operationOptions);
            }
            else {
                report = await core.importGisToPostgres(file, table, options, operationOptions);
            }
            return { ok: true, report };
        }
        catch (error) {
            if (error instanceof GisOperationError)
                return { ok: false, error: error.message, report: error.report };
            throw error;
        }
        finally {
            activeGisOperations.delete(operationId);
        }
    });
    ipcMain.handle("gis:export", async (event, id, table, output, options = {}, operationId) => {
        if (!table.trim())
            throw new Error("请输入源表名。");
        if (typeof operationId !== "string" || operationId.length > 128 || activeGisOperations.has(operationId)) {
            throw new Error("GIS 操作标识无效或已在运行。");
        }
        const controller = new AbortController();
        activeGisOperations.set(operationId, { senderId: event.sender.id, controller });
        try {
            const connection = await connectionFor(id);
            const core = coreFor(connection);
            const operationOptions = {
                signal: controller.signal,
                onProgress: (percent) => {
                    if (!event.sender.isDestroyed())
                        event.sender.send("gis:progress", { operationId, percent });
                },
            };
            if (connection.engine === "sqlite") {
                return { ok: true, dataset: await core.exportGisFromSqlite(table, output, options, operationOptions) };
            }
            if (connection.engine === "mysql" || connection.engine === "mariadb") {
                const parts = table.split(".");
                if (parts.length > 2 || parts.some((part) => !part.trim())) {
                    throw new Error("MySQL/MariaDB GIS source must be a table name or database.table.");
                }
                const sourceSchema = parts.length === 2 ? parts[0] : connection.database ?? "";
                const sourceTable = parts.length === 2 ? parts[1] : parts[0];
                if (!sourceSchema)
                    throw new Error("Choose a database in the MySQL/MariaDB connection or enter database.table.");
                return { ok: true, dataset: await core.exportGisFromMysqlFamily(sourceTable, sourceSchema, output, options, operationOptions) };
            }
            if (connection.engine === "sqlserver") {
                const parts = table.split(".");
                if (parts.length > 2 || parts.some((part) => !part.trim())) {
                    throw new Error("SQL Server GIS source must be a table name or schema.table.");
                }
                const sourceSchema = parts.length === 2 ? parts[0] : "dbo";
                const sourceTable = parts.length === 2 ? parts[1] : parts[0];
                return { ok: true, dataset: await core.exportGisFromSqlServer(sourceTable, sourceSchema, output, options, operationOptions) };
            }
            if (connection.engine === "oracle") {
                const parts = table.split(".");
                if (parts.length !== 2 || parts.some((part) => !part.trim())) {
                    throw new Error("Oracle GIS source must use the form schema.table.");
                }
                return { ok: true, dataset: await core.exportGisFromOracle(parts[1], parts[0], output, options, operationOptions) };
            }
            return { ok: true, dataset: await core.exportGisFromPostgres(table, output, options, operationOptions) };
        }
        catch (error) {
            if (error instanceof GisOperationError)
                return { ok: false, error: error.message, report: error.report };
            throw error;
        }
        finally {
            activeGisOperations.delete(operationId);
        }
    });
    ipcMain.handle("files:open-sql", async () => {
        const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "SQL 文件", extensions: ["sql"] }] });
        if (result.canceled || !result.filePaths[0])
            return null;
        const file = result.filePaths[0];
        return { path: file, content: await readFile(file, "utf8") };
    });
    ipcMain.handle("files:save-sql", async (_event, initial, content) => {
        const result = await dialog.showSaveDialog({ defaultPath: initial ?? "query.sql", filters: [{ name: "SQL 文件", extensions: ["sql"] }] });
        if (result.canceled || !result.filePath)
            return null;
        await writeFile(result.filePath, content, "utf8");
        return result.filePath;
    });
    ipcMain.handle("files:save-result", async (_event, format, content) => {
        if (format !== "csv" && format !== "json")
            throw new Error("仅支持导出 CSV 或 JSON。");
        if (typeof content !== "string")
            throw new Error("导出内容必须是文本。");
        const result = await dialog.showSaveDialog({
            defaultPath: `query-result.${format}`,
            filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (result.canceled || !result.filePath)
            return null;
        await writeFile(result.filePath, content, "utf8");
        return result.filePath;
    });
    ipcMain.handle("files:open-vector", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "矢量数据", extensions: ["shp", "geojson", "json", "kml", "tab", "gpkg", "pbf", "zip"] }, { name: "所有文件", extensions: ["*"] }],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle("files:save-vector", async () => {
        const result = await dialog.showSaveDialog({
            defaultPath: "export.gpkg",
            filters: [
                { name: "GeoPackage", extensions: ["gpkg"] },
                { name: "GeoJSON", extensions: ["geojson"] },
                { name: "Shapefile", extensions: ["shp"] },
                { name: "KML", extensions: ["kml"] },
                { name: "MapInfo TAB", extensions: ["tab"] },
            ],
        });
        return result.canceled ? null : result.filePath ?? null;
    });
}
async function createWindow() {
    const window = new BrowserWindow({
        width: 1500,
        height: 960,
        minWidth: 1120,
        minHeight: 720,
        backgroundColor: "#f4f6f8",
        title: "DB Studio",
        webPreferences: {
            preload: path.join(here, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    if (process.env.VITE_DEV_SERVER_URL) {
        await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    }
    else {
        await window.loadFile(path.join(here, "../renderer/index.html"));
    }
}
app.whenReady().then(async () => {
    registerHandlers();
    let shuttingDown = false;
    app.on("before-quit", (event) => {
        for (const operation of activeGisOperations.values())
            operation.controller.abort();
        if (shuttingDown || (sshTunnelManager.activeCount === 0 && sshTunnelManager.pendingCount === 0))
            return;
        event.preventDefault();
        shuttingDown = true;
        void sshTunnelManager.closeAll().catch(() => undefined).finally(() => app.quit());
    });
    await createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0)
            void createWindow();
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});
//# sourceMappingURL=main.js.map
//# sourceMappingURL=main.js.map