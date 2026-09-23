const { app, BrowserWindow, ipcMain, sharedTexture } = require("electron");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { createPackedSurface } = require("../shared-rgba.cjs");

async function run() {
  if (process.platform !== "darwin") throw new Error("The RGBA IOSurface probe requires macOS");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "probe-shared-rgba-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const width = 1920;
  const height = 1080;
  const bytesPerRow = 5120;
  const data = Uint8Array.from({ length: bytesPerRow * height }, (_, index) => (index * 73 + 19) & 255);
  const surface = createPackedSurface(data, width, height, bytesPerRow);
  let imported;
  try {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RGBA shared-texture receiver timed out")), 10000);
      ipcMain.once("shared-rgba-probe:result", (_event, value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    await window.loadFile(path.join(__dirname, "probe-shared-rgba.html"));
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: "rgba",
        colorSpace: { matrix: "rgb", primaries: "bt709", transfer: "srgb", range: "full" },
        codedSize: { width: surface.width, height: surface.height },
        handle: { ioSurface: surface.ioSurface },
      },
      allReferencesReleased: () => surface.close(),
    });
    await sharedTexture.sendSharedTexture({ frame: window.webContents.mainFrame, importedSharedTexture: imported }, {
      rgbaWidth: surface.width, height, bytesPerRow,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    const value = await result;
    if (value.error || value.parity !== true || value.typedArray !== true || value.format !== "RGBA") {
      throw new Error(`RGBA shared-texture byte parity failed: ${JSON.stringify(value)}`);
    }
    console.log(`RGBA sharedTexture ${width}×${height}: exact byte parity PASS`);
  } finally {
    imported?.release();
    if (!imported) surface.close();
    window.close();
  }
}

run().then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
