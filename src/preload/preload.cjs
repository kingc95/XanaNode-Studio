const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xananode", {
  appMetadata: () => ipcRenderer.invoke("app:metadata"),
  openWorkspace: () => ipcRenderer.invoke("dialog:openWorkspace"),
  openWorkspaceAtPath: (payload) => ipcRenderer.invoke("workspace:openAtPath", payload),
  intertwingleSubstrate: () => ipcRenderer.invoke("dialog:intertwingleSubstrate"),
  openSubstrateFile: () => ipcRenderer.invoke("dialog:openSubstrateFile"),
  openSubstrateFolder: () => ipcRenderer.invoke("dialog:openSubstrateFolder"),
  openPack: () => ipcRenderer.invoke("dialog:intertwingleSubstrate"),
  createWorkspace: (defaults) => ipcRenderer.invoke("dialog:createWorkspace", defaults),
  refreshWorkspace: () => ipcRenderer.invoke("workspace:refresh"),
  workspaceStatus: () => ipcRenderer.invoke("workspace:status"),
  createNode: (payload) => ipcRenderer.invoke("workspace:createNode", payload),
  updateNode: (payload) => ipcRenderer.invoke("workspace:updateNode", payload),
  planNodeDeletion: (payload) => ipcRenderer.invoke("workspace:planNodeDeletion", payload),
  deleteNode: (payload) => ipcRenderer.invoke("workspace:deleteNode", payload),
  importAssets: () => ipcRenderer.invoke("workspace:importAssets"),
  applyAugmentSession: (payload) => ipcRenderer.invoke("workspace:applyAugmentSession", payload),
  saveSnapshot: (payload) => ipcRenderer.invoke("workspace:saveSnapshot", payload),
  build: (payload) => ipcRenderer.invoke("workspace:build", payload),
  exportSubstrate: () => ipcRenderer.invoke("workspace:exportSubstrate"),
  exportPack: () => ipcRenderer.invoke("workspace:exportSubstrate"),
  removeImport: (importId) => ipcRenderer.invoke("workspace:removeImport", { importId }),
  toggleImportNodeVisibility: (payload) => ipcRenderer.invoke("workspace:toggleImportNodeVisibility", payload),
  listFederationTargets: () => ipcRenderer.invoke("workspace:listFederationTargets"),
  openFederationTarget: (payload) => ipcRenderer.invoke("workspace:openFederationTarget", payload),
  validate: () => ipcRenderer.invoke("workspace:validate"),
  openInShell: (targetPath) => ipcRenderer.invoke("workspace:openInShell", targetPath),
  augmentStatus: () => ipcRenderer.invoke("augment:status"),
  startAugment: (payload) => ipcRenderer.invoke("augment:start", payload),
  stopAugment: () => ipcRenderer.invoke("augment:stop"),
  augmentCreateSession: (payload) => ipcRenderer.invoke("augment:createSession", payload),
  augmentExtractSession: (payload) => ipcRenderer.invoke("augment:extractSession", payload),
  augmentListCandidates: (payload) => ipcRenderer.invoke("augment:listCandidates", payload),
  augmentBulkReview: (payload) => ipcRenderer.invoke("augment:bulkReview", payload),
  augmentUpdateCandidate: (payload) => ipcRenderer.invoke("augment:updateCandidate", payload),
  augmentSuggestRelationships: (payload) => ipcRenderer.invoke("augment:suggestRelationships", payload),
  augmentGetSubstrate: (payload) => ipcRenderer.invoke("augment:getSubstrate", payload),
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
  },
  onStudioCommand: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("studio:command", listener);
    return () => ipcRenderer.removeListener("studio:command", listener);
  },
  onWorkspaceProgress: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("workspace:progress", listener);
    return () => ipcRenderer.removeListener("workspace:progress", listener);
  },
  onAugmentLog: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("augment:log", listener);
    return () => ipcRenderer.removeListener("augment:log", listener);
  },
  onAugmentStopped: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on("augment:stopped", listener);
    return () => ipcRenderer.removeListener("augment:stopped", listener);
  }
});
