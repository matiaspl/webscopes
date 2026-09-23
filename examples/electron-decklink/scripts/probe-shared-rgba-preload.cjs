const { contextBridge, ipcRenderer, sharedTexture } = require("electron");

let receiver;
contextBridge.exposeInMainWorld("sharedRgbaProbe", {
  onFrame: (callback) => { receiver = callback; },
  report: (result) => ipcRenderer.send("shared-rgba-probe:result", result),
});

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  let frame;
  try {
    if (typeof receiver !== "function") throw new Error("Renderer probe is not ready");
    frame = importedSharedTexture.getVideoFrame();
    const pixels = new Uint8Array(metadata.rgbaWidth * metadata.height * 4);
    await frame.copyTo(pixels, { format: "RGBA", colorSpace: "srgb",
      layout: [{ offset: 0, stride: metadata.rgbaWidth * 4 }] });
    await receiver({ ...metadata, data: pixels, format: frame.format });
  } catch (error) {
    ipcRenderer.send("shared-rgba-probe:result", { error: error.message });
  } finally {
    frame?.close();
    importedSharedTexture.release();
  }
});
