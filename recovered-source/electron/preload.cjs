const { contextBridge, ipcRenderer } = require("electron");
const { createGisExportBridge } = require("./gis-export-bridge.cjs");
const { createAiCancellationBridge } = require("./ai-cancellation-bridge.cjs");
const gisExportBridge = createGisExportBridge(ipcRenderer);
const aiCancellationBridge = createAiCancellationBridge(ipcRenderer);

contextBridge.exposeInMainWorld("dbStudio", {
  queryHistory: {
    list: () => ipcRenderer.invoke("query-history:list"),
    record: (entry) => ipcRenderer.invoke("query-history:record", entry),
    clear: (connectionId) => ipcRenderer.invoke("query-history:clear", connectionId),
    saveFavorite: (favorite) => ipcRenderer.invoke("query-history:favorite:save", favorite),
    removeFavorite: (id) => ipcRenderer.invoke("query-history:favorite:remove", id),
  },
  ai: {
    settings: () => ipcRenderer.invoke("ai:settings:get"),
    saveSettings: (settings) => ipcRenderer.invoke("ai:settings:save", settings),
    testModel: (kind, profile) => ipcRenderer.invoke("ai:model:test", kind, profile),
    buildSchemaIndex: (connectionId, schema, selectedTables, requestId) => ipcRenderer.invoke("ai:schema-index:build", { connectionId, schema, selectedTables, requestId }),
    clearSchemaIndex: (connectionId, schema) => ipcRenderer.invoke("ai:schema-index:clear", { connectionId, schema }),
    run: (request) => ipcRenderer.invoke("ai:assistant:run", request),
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
    save: (connection) => ipcRenderer.invoke("connections:save", connection),
    remove: (id) => ipcRenderer.invoke("connections:remove", id),
    test: (id) => ipcRenderer.invoke("connections:test", id),
  },
  database: {
    databases: (id) => ipcRenderer.invoke("database:databases", id),
    schemas: (id) => ipcRenderer.invoke("database:schemas", id),
    tables: (id, schema) => ipcRenderer.invoke("database:tables", id, schema),
    columns: (id, table, schema) => ipcRenderer.invoke("database:columns", id, table, schema),
    query: (id, sql, parameters) => ipcRenderer.invoke("database:query", id, sql, parameters),
    updateRows: (id, input) => ipcRenderer.invoke("database:update-rows", id, input),
    exportTable: (id, table, schema) => ipcRenderer.invoke("database:export-table", id, table, schema),
    importTable: (id, table, schema) => ipcRenderer.invoke("database:import-table", id, table, schema),
    importTableToNewTable: (id, table, schema) => ipcRenderer.invoke("database:import-table-new", id, table, schema),
    transferTable: (id, input) => ipcRenderer.invoke("database:transfer-table", id, input),
  },
  mongo: {
    databases: (id) => ipcRenderer.invoke("mongo:databases", id),
    collections: (id, database) => ipcRenderer.invoke("mongo:collections", id, database),
    indexes: (id, database, collection) => ipcRenderer.invoke("mongo:indexes", id, database, collection),
    createTwoDSphereIndex: (id, database, collection, field) => ipcRenderer.invoke("mongo:create-2dsphere-index", id, database, collection, field),
    find: (id, database, collection, options) => ipcRenderer.invoke("mongo:find", id, database, collection, options),
    aggregate: (id, database, collection, pipeline, limit) => ipcRenderer.invoke("mongo:aggregate", id, database, collection, pipeline, limit),
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
    import: (id, file, table, options, operationId) => ipcRenderer.invoke("gis:import", id, file, table, options, operationId),
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