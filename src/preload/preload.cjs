const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xananode", {
  appMetadata: () => ipcRenderer.invoke("app:metadata"),
  openWorkspace: () => ipcRenderer.invoke("dialog:openWorkspace"),
  openPack: () => ipcRenderer.invoke("dialog:openPack"),
  createWorkspace: (defaults) => ipcRenderer.invoke("dialog:createWorkspace", defaults),
  refreshWorkspace: () => ipcRenderer.invoke("workspace:refresh"),
  workspaceStatus: () => ipcRenderer.invoke("workspace:status"),
  createNode: (payload) => ipcRenderer.invoke("workspace:createNode", payload),
  updateNode: (payload) => ipcRenderer.invoke("workspace:updateNode", payload),
  importAssets: () => ipcRenderer.invoke("workspace:importAssets"),
  saveSnapshot: (payload) => ipcRenderer.invoke("workspace:saveSnapshot", payload),
  build: () => ipcRenderer.invoke("workspace:build"),
  exportPack: () => ipcRenderer.invoke("workspace:exportPack"),
  validate: () => ipcRenderer.invoke("workspace:validate"),
  openInShell: (targetPath) => ipcRenderer.invoke("workspace:openInShell", targetPath),
  startHugoPreview: () => ipcRenderer.invoke("preview:startHugo"),
  rebuildHugoPreview: () => ipcRenderer.invoke("preview:rebuildHugo"),
  stopHugoPreview: () => ipcRenderer.invoke("preview:stopHugo"),
  readTextFile: (absolutePath) => ipcRenderer.invoke("file:readText", absolutePath),
  onPreviewLog: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("preview:log", listener);
    return () => ipcRenderer.removeListener("preview:log", listener);
  },
  onPreviewStopped: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("preview:stopped", listener);
    return () => ipcRenderer.removeListener("preview:stopped", listener);
  }
});
