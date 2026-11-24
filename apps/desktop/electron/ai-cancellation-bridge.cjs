"use strict";
function createAiCancellationBridge(ipcRenderer) {
  return {
    cancel: (requestId) => ipcRenderer.send("ai:cancel", requestId),
  };
}
module.exports = { createAiCancellationBridge };
