const { contextBridge, ipcRenderer } = require("electron");
const { createGisExportBridge } = require("./gis-export-bridge.cjs");
const { createAiCancellationBridge } = require("./ai-cancellation-bridge.cjs");
const gisExportBridge = createGisExportBridge(ipcRenderer);
const aiCancellationBridge = createAiCancellationBridge(ipcRenderer);
const { validateIpcArgs } = require("@db-studio/shared/ipc-contracts");

// Validate renderer-supplied arguments at the preload boundary. Invalid calls
// reject with a structured error before crossing into the main process.
function invoke(channel, ...args) {
  const error = validateIpcArgs(channel, args);
  if (error) {
    const detail = error.issues.map((issue) => (issue.path || "(root)") + ": " + issue.message).join("; ");
    throw new Error("Invalid IPC arguments for " + channel + ": " + detail);
  }
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("dbStudio", {
  queryHistory: {
    list: () => ipcRenderer.invoke("query-history:list"),
    record: (entry) => invoke("query-history:record", entry),
    clear: (connectionId) => invoke("query-history:clear", connectionId),
    saveFavorite: (favorite) => ipcRenderer.invoke("query-history:favorite:save", favorite),
    removeFavorite: (id) => invoke("query-history:favorite:remove", id),
  },
  ai: {
    settings: () => ipcRenderer.invoke("ai:settings:get"),
    saveSettings: (settings) => ipcRenderer.invoke("ai:settings:save", settings),
    testModel: (kind, profile) => invoke("ai:model:test", kind, profile),
    buildSchemaIndex: (connectionId, schema, selectedTables, requestId) => ipcRenderer.invoke("ai:schema-index:build", { connectionId, schema, selectedTables, requestId }),
    clearSchemaIndex: (connectionId, schema) => ipcRenderer.invoke("ai:schema-index:clear", { connectionId, schema }),
    run: (request) => invoke("ai:assistant:run", request),
    runMongo: (request) => ipcRenderer.invoke("ai:mongo-assistant:run", request),
    cancel: aiCancellationBridge.cancel,
    onDelta: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("ai:assistant:delta", handler);
      return () => ipcRenderer.removeListener("ai:assistant:delta", handler);
    },
  },
  connections: {
    list: () => ipcRenderer.invoke("connections:list"),
    backupAndResetUnreadable: () => ipcRenderer.invoke("connections:backup-and-reset-unreadable"),
    save: (connection) => invoke("connections:save", connection),
    remove: (id) => invoke("connections:remove", id),
    test: (id) => invoke("connections:test", id),
  },
  database: {
    databases: (id) => ipcRenderer.invoke("database:databases", id),
    schemas: (id) => ipcRenderer.invoke("database:schemas", id),
    tables: (id, schema) => invoke("database:tables", id, schema),
    columns: (id, table, schema) => invoke("database:columns", id, table, schema),
    query: (id, sql, parameters) => invoke("database:query", id, sql, parameters),
    updateRows: (id, input) => invoke("database:update-rows", id, input),
    exportTable: (id, table, schema) => ipcRenderer.invoke("database:export-table", id, table, schema),
    importTable: (id, table, schema) => ipcRenderer.invoke("database:import-table", id, table, schema),
    importTableToNewTable: (id, table, schema) => ipcRenderer.invoke("database:import-table-new", id, table, schema),
    transferTable: (id, input) => invoke("database:transfer-table", id, input),
  },
  mongo: {
    databases: (id) => ipcRenderer.invoke("mongo:databases", id),
    collections: (id, database) => ipcRenderer.invoke("mongo:collections", id, database),
    indexes: (id, database, collection) => ipcRenderer.invoke("mongo:indexes", id, database, collection),
    createTwoDSphereIndex: (id, database, collection, field) => ipcRenderer.invoke("mongo:create-2dsphere-index", id, database, collection, field),
    find: (id, database, collection, options) => invoke("mongo:find", id, database, collection, options),
    deleteDocument: (id, database, collection, filterJson) => invoke("mongo:delete-document", id, database, collection, filterJson),
    replaceDocument: (id, database, collection, filterJson, replacementJson) => invoke("mongo:replace-document", id, database, collection, filterJson, replacementJson),
    aggregate: (id, database, collection, pipeline, limit) => invoke("mongo:aggregate", id, database, collection, pipeline, limit),
    import: (id, database, collection) => ipcRenderer.invoke("mongo:import", id, database, collection),
    export: (id, database, collection, filter) => ipcRenderer.invoke("mongo:export", id, database, collection, filter),
    importGeoJson: (id, database, collection, geometryField) => ipcRenderer.invoke("mongo:geo-import", id, database, collection, geometryField),
    exportGeoJson: (id, database, collection, geometryField, filter) => ipcRenderer.invoke("mongo:geo-export", id, database, collection, geometryField, filter),
  },
  gis: {
    inspect: (file, options) => ipcRenderer.invoke("gis:inspect", file, options),
    preview: (file, options) => ipcRenderer.invoke("gis:preview", file, options),
    validate: (file, options) => ipcRenderer.invoke("gis:validate", file, options),
    inspectTable: (id, table) => ipcRenderer.invoke("gis:inspect-table", id, table),
    import: (id, file, table, options, operationId) => invoke("gis:import", id, file, table, options, operationId),
    export: gisExportBridge.export,
    cancel: (operationId) => ipcRenderer.send("gis:cancel", operationId),
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress);
      ipcRenderer.on("gis:progress", handler);
      return () => ipcRenderer.removeListener("gis:progress", handler);
    },
  },
  files: {
    openSql: () => ipcRenderer.invoke("files:open-sql"),
    saveSql: (initial, text) => ipcRenderer.invoke("files:save-sql", initial, text),
    saveResult: (format, content) => ipcRenderer.invoke("files:save-result", format, content),
    openVector: () => ipcRenderer.invoke("files:open-vector"),
    saveVector: () => ipcRenderer.invoke("files:save-vector"),
  },
});