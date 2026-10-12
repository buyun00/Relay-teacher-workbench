const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("classroom", {
  snapshot: () => ipcRenderer.invoke("client:snapshot"),
  saveSettings: (input) => ipcRenderer.invoke("client:settings", input),
  selectFolder: () => ipcRenderer.invoke("client:select-folder"),
  bindCandidate: (input) => ipcRenderer.invoke("client:bind-candidate", input),
  unbind: (id) => ipcRenderer.invoke("client:unbind", id),
  scan: () => ipcRenderer.invoke("client:scan"),
  pause: (paused) => ipcRenderer.invoke("client:pause", paused),
  retry: (id) => ipcRenderer.invoke("client:retry", id),
  health: () => ipcRenderer.invoke("client:health"),
  refreshStatus: () => ipcRenderer.invoke("client:status"),
  checkUpdates: () => ipcRenderer.invoke("client:check-updates"),
  installUpdate: () => ipcRenderer.invoke("client:install-update"),
  openDataDir: () => ipcRenderer.invoke("client:open-data"),
  subscribe: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("client:changed", listener);
    return () => ipcRenderer.removeListener("client:changed", listener);
  },
});
