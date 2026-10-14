const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("classroom", {
  runtimeReady: () => ipcRenderer.invoke("client:runtime-ready"),
  snapshot: () => ipcRenderer.invoke("client:snapshot"),
  organization: () => ipcRenderer.invoke("client:organization"),
  questionBank: (input) => ipcRenderer.invoke("client:question-bank", input),
  saveQuestionPaper: (input) => ipcRenderer.invoke("client:question-save", input),
  organize: (input) => ipcRenderer.invoke("client:organize", input),
  saveSettings: (input) => ipcRenderer.invoke("client:settings", input),
  selectFolder: () => ipcRenderer.invoke("client:select-folder"),
  selectFiles: () => ipcRenderer.invoke("client:select-files"),
  createTask: () => ipcRenderer.invoke("client:create-task"),
  saveTaskDraft: (input) => ipcRenderer.invoke("client:task-draft", input),
  archiveTask: (input) => ipcRenderer.invoke("client:task-archive", input),
  readChat: (id) => ipcRenderer.invoke("client:chat-read", id),
  selectChatFiles: (id) => ipcRenderer.invoke("client:chat-select-files", id),
  importChatFiles: async ({ id, files }) => {
    const sources = [];
    for (const file of files) {
      const path = webUtils.getPathForFile(file);
      sources.push(path ? { path, mime: file.type } : { filename: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()) });
    }
    return ipcRenderer.invoke("client:chat-import-files", { id, files: sources });
  },
  removeChatAttachment: (input) => ipcRenderer.invoke("client:chat-remove-file", input),
  previewChatAttachment: (input) => ipcRenderer.invoke("client:chat-preview-file", input),
  saveChatAttachment: (input) => ipcRenderer.invoke("client:chat-save-file", input),
  openChatAttachment: (input) => ipcRenderer.invoke("client:chat-open-file", input),
  sendChat: (input) => ipcRenderer.invoke("client:chat-send", input),
  selectChatModel: (input) => ipcRenderer.invoke("client:chat-model", input),
  cancelChat: (id) => ipcRenderer.invoke("client:chat-cancel", id),
  openLink: (url) => ipcRenderer.invoke("client:open-link", url),
  copyText: (value) => ipcRenderer.invoke("client:copy-text", value),
  subscribeChat: (callback) => {
    const listener = (_event, view) => callback(view);
    ipcRenderer.on("client:chat", listener);
    return () => ipcRenderer.removeListener("client:chat", listener);
  },
  bindCandidate: (input) => ipcRenderer.invoke("client:bind-candidate", input),
  unbind: (id) => ipcRenderer.invoke("client:unbind", id),
  scan: () => ipcRenderer.invoke("client:scan"),
  pause: (paused) => ipcRenderer.invoke("client:pause", paused),
  retry: (id) => ipcRenderer.invoke("client:retry", id),
  health: () => ipcRenderer.invoke("client:health"),
  refreshStatus: () => ipcRenderer.invoke("client:status"),
  readResults: (id) => ipcRenderer.invoke("client:results", id),
  checkUpdates: () => ipcRenderer.invoke("client:check-updates"),
  installUpdate: () => ipcRenderer.invoke("client:install-update"),
  openDataDir: () => ipcRenderer.invoke("client:open-data"),
  subscribe: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("client:changed", listener);
    return () => ipcRenderer.removeListener("client:changed", listener);
  },
});
