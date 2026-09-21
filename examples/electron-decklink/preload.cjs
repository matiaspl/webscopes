const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("A listener function is required.");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("decklink", {
  listDevices: () => ipcRenderer.invoke("decklink:list-devices"),
  listFormats: (device) => ipcRenderer.invoke("decklink:list-formats", device),
  start: (request) => ipcRenderer.invoke("decklink:start", request),
  stop: () => ipcRenderer.invoke("decklink:stop"),
  setAnalysisOptions: (options) => ipcRenderer.invoke("decklink:analysis-options", options),
  getGpuStatus: () => ipcRenderer.invoke("decklink:gpu-status"),
  onStatus: (callback) => subscribe("decklink:status", callback),
  onPreview: (callback) => subscribe("decklink:preview", callback),
  onScopes: (callback) => subscribe("decklink:scopes", callback),
  onTelemetry: (callback) => subscribe("decklink:telemetry", callback),
  onGpuStatus: (callback) => subscribe("decklink:gpu-status", callback),
});
