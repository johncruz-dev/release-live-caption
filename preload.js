const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Caption control
  launchCaptions: () => ipcRenderer.invoke("launch-captions"),
  hideCaptionWindow: () => ipcRenderer.invoke("hide-caption-window"),
  showCaptionWindow: () => ipcRenderer.invoke("show-caption-window"),

  // Reading captions
  readCaptionText: () => ipcRenderer.invoke("read-caption-text"),
  readCaptionScan: () => ipcRenderer.invoke("read-caption-scan"),

  // Diagnostic
  listWindows: () => ipcRenderer.invoke("list-windows"),

  // File
  openFile: (filepath) => ipcRenderer.invoke("open-file", filepath),
  exportTranscript: (text, title) => ipcRenderer.invoke("export-transcript", text, title),

  // AI
  summarize: (text) => ipcRenderer.invoke("summarize", text),

  // Window controls
  minimize: () => ipcRenderer.send("minimize"),
  maximize: () => ipcRenderer.send("maximize"),
  close: () => ipcRenderer.send("close"),
  isAlwaysOnTop: () => ipcRenderer.invoke("is-always-on-top"),
});
