const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("databaseManagerApi", {
  load: () => ipcRenderer.invoke("db:load"),
  saveAll: (payload) => ipcRenderer.invoke("db:save-all", payload),
  readImageDataUrl: (imagePath) => ipcRenderer.invoke("db:image-data-url", imagePath),
  rescanCard: (payload) => ipcRenderer.invoke("db:rescan-card", payload)
});
