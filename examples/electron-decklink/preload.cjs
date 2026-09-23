const { contextBridge, ipcRenderer, sharedTexture } = require("electron");

try {
  sharedTexture?.setSharedTextureReceiver?.(({ importedSharedTexture }, metadata) => {
    let frame;
    try {
      frame = importedSharedTexture.getVideoFrame();
      // VideoFrame is transferable through postMessage into the page world;
      // contextBridge cannot expose its GPU-backed resource directly.
      window.postMessage({ type: "webscopes:shared-v210", metadata, frame }, window.location.origin, [frame]);
      frame = undefined;
    } catch (error) {
      ipcRenderer.send("decklink:frame-ack", {
        sequence: metadata?.sequence,
        sharedTextureError: error?.message ?? String(error),
      });
    } finally {
      frame?.close();
      importedSharedTexture.release();
    }
  });
} catch (error) {
  console.error("Could not register RGBA shared-texture receiver:", error);
}

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
  setPresentationMode: (mode) => ipcRenderer.invoke("decklink:presentation-mode", mode),
  ackFrame: (value) => ipcRenderer.send("decklink:frame-ack", value),
  getGpuStatus: () => ipcRenderer.invoke("decklink:gpu-status"),
  onStatus: (callback) => subscribe("decklink:status", callback),
  onPreview: (callback) => subscribe("decklink:preview", callback),
  onScopes: (callback) => subscribe("decklink:scopes", callback),
  onTelemetry: (callback) => subscribe("decklink:telemetry", callback),
  onVITC: (callback) => subscribe("decklink:vitc", callback),
  onGpuStatus: (callback) => subscribe("decklink:gpu-status", callback),
  onFramePort: (callback) => {
    if (typeof callback !== "function") throw new TypeError("A frame-port listener function is required.");
    const listener = (event) => callback(event.ports?.[0]);
    ipcRenderer.on("decklink:frame-port", listener);
    return () => ipcRenderer.removeListener("decklink:frame-port", listener);
  },
  onFrame: (callback) => subscribe("decklink:frame", callback),
});
