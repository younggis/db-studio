"use strict";
function createGisExportBridge(ipcRenderer) {
  return {
    export: (id, table, output, options, operationId) => ipcRenderer.invoke("gis:export", id, table, output, options, operationId),
  };
}
module.exports = { createGisExportBridge };
