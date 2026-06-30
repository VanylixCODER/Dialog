"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Bridge real connectivity/status events from the main process into the
// loader page so the status line under the logo reflects actual state.
contextBridge.exposeInMainWorld("loaderBridge", {
  onStatus: (cb) =>
    ipcRenderer.on("status", (_e, payload) => cb(payload))
});
