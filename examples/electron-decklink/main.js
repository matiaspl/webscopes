import { fork } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, MessageChannelMain, protocol, sharedTexture } from "electron";
import { colorMatrixFromCode, resolveCaptureMode, v210CaptureSlotSize } from "./macadam-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const helperPath = path.join(__dirname, "macadam-helper.js");
const require = createRequire(import.meta.url);
const rendererFiles = new Set([
  "examples/electron-decklink/index.html",
  "examples/electron-decklink/renderer.js",
  "examples/electron-decklink/macadam-utils.js",
  "examples/electron-decklink/v210-rgba.js",
  "examples/roi-controls.js",
  "src/index.js",
  "src/analyze.js",
  "src/render.js",
  "src/webgpu.js",
  "src/webgpu-render.js",
  "src/video-color.js",
]);
const allowedWaveformModes = new Set(["rgb", "rgb-parade", "luma", "ycbcr-parade", "composite"]);
const allowedColorMatrices = new Set(["auto", "bt601", "bt709", "bt2020", "bt2100"]);
let mainWindow;
let helper;
let helperStderr = "";
let capture;
let nextRequestId = 1;
const pendingRequests = new Map();
let discoveredDevices = [];
let deviceLabelsById = new Map();
let inputFormatDetectionByDevice = new Map();
const formatsByDevice = new Map();
let gpuInfoAvailable = false;
let presentationMode = "cpu";
let frameRing;
let frameRingName;
let frameRingSlotSize;
let framePort;
let frameTransferPool = [];
const frameOutstanding = new Set();
let frameTransportStats = { forwarded: 0, acknowledged: 0 };
let useSharedRgba = process.platform === "darwin" && process.env.WEBSCOPES_RGBA_SHARED_TEXTURE === "1";
const sharedPending = new Map();
let sharedRgbaValidated = false;
let analysisOptions = {
  region: { x: 0, y: 0, width: 1, height: 1 },
  waveformMode: "luma",
  colorMatrix: "auto",
  colorRange: "limited",
};

protocol.registerSchemesAsPrivileged([{
  scheme: "webscopes",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

function sendStatus(message, kind = "info") {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("decklink:status", { message, kind });
}

function acceptFrameAck(event, value) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  reclaimFrameBuffer(value);
}

function reclaimFrameBuffer(value) {
  const sequence = value?.sequence;
  const shared = sharedPending.get(sequence);
  if (shared && value?.sharedTextureError) {
    sharedPending.delete(sequence);
    useSharedRgba = false;
    sendStatus(`RGBA shared texture failed byte validation: ${value.sharedTextureError}. Using the v210 IPC path.`, "error");
    try { mainWindow?.webContents.postMessage("decklink:frame", shared); }
    catch (error) { frameOutstanding.delete(sequence); sendStatus(`Could not retry the v210 frame: ${error.message}`, "error"); }
    return;
  }
  if (!(typeof sequence === "bigint" || Number.isSafeInteger(sequence)) || !frameOutstanding.delete(sequence)) return;
  frameTransportStats.acknowledged += 1;
  sharedPending.delete(sequence);
  if (shared && value?.sharedTextureValidated === true && !sharedRgbaValidated) {
    sharedRgbaValidated = true;
    sendStatus("RGBA external-texture GPU byte validation passed; v210 scopes remain exact.");
  }
  const buffer = value?.buffer;
  if (buffer instanceof ArrayBuffer && buffer.byteLength >= frameRingSlotSize && frameTransferPool.length < 2) {
    frameTransferPool.push(new Uint8Array(buffer));
  } else if (shared?.frame?.data?.buffer instanceof ArrayBuffer && frameTransferPool.length < 2) {
    frameTransferPool.push(new Uint8Array(shared.frame.data.buffer));
  }
  forwardLatestFrame();
}

function loadFrameRingAddon() {
  return require("./frame-ring.cjs");
}

function closeFrameTransport() {
  try { framePort?.close(); } catch {}
  framePort = undefined;
  try { frameRing?.close(); } catch {}
  frameRing = undefined;
  frameRingName = undefined;
  frameRingSlotSize = undefined;
  frameTransferPool = [];
  frameOutstanding.clear();
  sharedPending.clear();
  frameTransportStats = { forwarded: 0, acknowledged: 0 };
  sharedRgbaValidated = false;
}

function openFrameTransport(slotSize) {
  closeFrameTransport();
  const addon = loadFrameRingAddon();
  // macOS POSIX shared-memory names are limited to 31 characters.
  frameRingName = `wsgpu-${process.pid}-${randomUUID().slice(0, 8)}`;
  frameRingSlotSize = slotSize;
  frameRing = new addon.FrameRing(frameRingName, 3, slotSize, true);
  frameTransferPool = Array.from({ length: 2 }, () => new Uint8Array(slotSize));
  if (!MessageChannelMain) return;
  const channel = new MessageChannelMain();
  framePort = channel.port1;
  framePort.on("message", ({ data }) => {
    if (data?.type === "ack") reclaimFrameBuffer(data);
  });
  framePort.start();
  mainWindow?.webContents.postMessage("decklink:frame-port", {}, [channel.port2]);
}

function forwardLatestFrame() {
  if (!frameRing || !mainWindow || mainWindow.isDestroyed() || frameOutstanding.size >= 2) return;
  const packet = frameRing.readLatest(frameTransferPool.shift());
  if (!packet) return;
  const packetBuffer = ArrayBuffer.isView(packet.data) ? packet.data.buffer : packet.data;
  const packetOffset = ArrayBuffer.isView(packet.data) ? packet.data.byteOffset : 0;
  const frame = {
    format: "v210",
    data: new Uint8Array(packetBuffer, packetOffset, packet.byteLength),
    width: packet.width,
    height: packet.height,
    bytesPerRow: packet.bytesPerRow,
    timestamp: packet.timestamp,
    sequence: packet.sequence,
    colorMatrix: colorMatrixFromCode(packet.colorMatrixCode),
    colorMatrixCode: packet.colorMatrixCode,
    eotf: packet.eotf,
  };
  frameTransportStats.forwarded += 1;
  frameOutstanding.add(frame.sequence);
  const dropped = Number(frameRing.stats().dropped ?? 0);
  // Keep the reusable frame pool bounded. The renderer preserves this view
  // instead of copying each large payload into another Uint8Array.
  try {
    if (useSharedRgba) {
      sharedPending.set(frame.sequence, { frame, dropped });
      void forwardSharedRgba(frame, dropped);
    } else mainWindow.webContents.postMessage("decklink:frame", { frame, dropped });
  } catch (error) {
    frameOutstanding.delete(frame.sequence);
    sendStatus(`Could not forward a GPU frame: ${error.message}`, "error");
  }
}

async function forwardSharedRgba(frame, dropped) {
  let surface;
  let imported;
  try {
    if (typeof sharedTexture?.importSharedTexture !== "function" || typeof sharedTexture?.sendSharedTexture !== "function") {
      throw new Error("Electron sharedTexture is unavailable");
    }
    surface = require("./shared-rgba.cjs").createPackedSurface(frame.data, frame.width, frame.height, frame.bytesPerRow);
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: "rgba",
        colorSpace: { matrix: "rgb", primaries: "bt709", transfer: "srgb", range: "full" },
        codedSize: { width: surface.width, height: surface.height },
        handle: { ioSurface: surface.ioSurface },
      },
      allReferencesReleased: () => surface.close(),
    });
    const sha256 = sharedRgbaValidated ? undefined : createHash("sha256").update(frame.data).digest("hex");
    await sharedTexture.sendSharedTexture({ frame: mainWindow.webContents.mainFrame, importedSharedTexture: imported }, {
      width: frame.width, height: frame.height, bytesPerRow: frame.bytesPerRow,
      rgbaWidth: surface.width, sequence: frame.sequence, timestamp: frame.timestamp,
      colorMatrix: frame.colorMatrix, colorMatrixCode: frame.colorMatrixCode, eotf: frame.eotf,
      dropped, sha256,
    });
  } catch (error) {
    useSharedRgba = false;
    sendStatus(`RGBA shared texture unavailable: ${error.message}. Using the v210 IPC path.`, "error");
    const pending = sharedPending.get(frame.sequence);
    if (pending && mainWindow && !mainWindow.isDestroyed()) {
      sharedPending.delete(frame.sequence);
      try { mainWindow.webContents.postMessage("decklink:frame", { frame, dropped }); }
      catch (forwardError) {
        frameOutstanding.delete(frame.sequence);
        sendStatus(`Could not retry the v210 frame: ${forwardError.message}`, "error");
      }
    }
    if (!imported) surface?.close();
  } finally {
    imported?.release();
  }
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted IPC sender");
}

function getGpuStatus() {
  if (!gpuInfoAvailable) return { ready: false };
  try {
    const features = app.getGPUFeatureStatus();
    return {
      ready: true,
      hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
      gpuCompositing: features.gpu_compositing ?? "unknown",
      canvas2d: features["2d_canvas"] ?? "unknown",
    };
  } catch {
    return { ready: false };
  }
}

app.on("gpu-info-update", () => {
  gpuInfoAvailable = true;
  const status = getGpuStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("decklink:gpu-status", status);
});

function helperExitError(signal, code) {
  const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const detail = helperStderr.trim().split(/\r?\n/).slice(-5).join(" ");
  return new Error(`Macadam helper terminated (${reason}). ${detail || `The native DeckLink SDK stopped unexpectedly; its crash log, if written, is in ${os.tmpdir()}.`}`);
}

function settleRequest(id, error, result) {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(result);
}

function handleHelperMessage(message) {
  if (message?.type === "response") {
    settleRequest(message.id, message.ok ? undefined : new Error(message.error), message.result);
    return;
  }
  if (message?.type !== "event" || !mainWindow || mainWindow.isDestroyed()) return;
  if (message.name === "status" && (message.value?.kind === "error" || /stopped|exited/i.test(message.value?.message ?? ""))) {
    capture = undefined;
  }
  if (message.name === "frame-ready") {
    forwardLatestFrame();
    return;
  }
  const channels = {
    status: "decklink:status",
    preview: "decklink:preview",
    scopes: "decklink:scopes",
    telemetry: "decklink:telemetry",
    vitc: "decklink:vitc",
  };
  const channel = channels[message.name];
  if (channel) mainWindow.webContents.send(channel, message.value);
}

function ensureHelper() {
  if (helper && helper.connected && helper.exitCode === null) return helper;
  helperStderr = "";
  helper = fork(helperPath, [], {
    // Keep advanced IPC serialization on the same Node/V8 version as Electron.
    execPath: process.env.WEBSCOPES_NODE_PATH || process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      WEBSCOPES_FRAME_RING_ABI: process.env.WEBSCOPES_NODE_PATH ? "node" : "electron",
    },
    cwd: os.tmpdir(),
    silent: true,
    serialization: "advanced",
  });
  const child = helper;
  child.stderr?.on("data", (chunk) => {
    helperStderr = `${helperStderr}${chunk.toString("utf8")}`.slice(-6000);
  });
  child.on("message", handleHelperMessage);
  child.on("error", (error) => {
    for (const [id, pending] of pendingRequests) {
      if (pending.child === child) settleRequest(id, new Error(`Could not start the Macadam helper: ${error.message}`));
    }
  });
  child.on("exit", (code, signal) => {
    if (code === 0 && !signal) {
      if (helper === child) helper = undefined;
      return;
    }
    const error = helperExitError(signal, code);
    console.error(error.message);
    if (helper === child) helper = undefined;
    for (const [id, pending] of pendingRequests) {
      if (pending.child === child) settleRequest(id, error);
    }
    if (capture?.child === child) {
      capture = undefined;
      closeFrameTransport();
      sendStatus(error.message, "error");
    }
  });
  return child;
}

function terminateHelper(child) {
  if (!child || child.exitCode !== null) {
    if (helper === child) helper = undefined;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (helper === child) helper = undefined;
      resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish();
    }, 1000);
    timer.unref?.();
    child.once("exit", finish);
    try {
      if (child.connected) child.disconnect();
      else finish();
    } catch {
      try { child.kill("SIGTERM"); } catch {}
      finish();
    }
  });
}

function requestHelper(action, payload = {}, timeoutMs = 15000) {
  const child = ensureHelper();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settleRequest(id, new Error(`Macadam did not respond to ${action} within ${timeoutMs} ms.`));
      child.kill("SIGTERM");
    }, timeoutMs);
    pendingRequests.set(id, { child, resolve, reject, timer });
    try {
      child.send({ id, action, payload }, (error) => {
        if (error) settleRequest(id, new Error(`Could not send a request to Macadam: ${error.message}`));
      });
    } catch (error) {
      settleRequest(id, new Error(`Could not send a request to Macadam: ${error.message}`));
    }
  });
}

async function listDeckLinkDevices() {
  const devices = await requestHelper("list-devices");
  discoveredDevices = devices.map((device) => device.id);
  deviceLabelsById = new Map(devices.map((device) => [String(device.id), device.label]));
  inputFormatDetectionByDevice = new Map(devices.map((device) => [String(device.id), device.supportsInputFormatDetection === true]));
  formatsByDevice.clear();
  return devices;
}

async function listDeviceFormats(deviceId) {
  if (!discoveredDevices.includes(String(deviceId))) throw new Error("Select a DeckLink device from the refreshed device list.");
  const formats = await requestHelper("list-formats", { deviceId: String(deviceId) });
  formatsByDevice.set(String(deviceId), new Map(formats.map((format) => [format.key, format])));
  return formats;
}

function normalizeAnalysisOptions(nextOptions = {}) {
  const region = nextOptions.region ?? analysisOptions.region;
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new RangeError("ROI must be a positive rectangle inside the source frame.");
  }
  const waveformMode = nextOptions.waveformMode ?? analysisOptions.waveformMode;
  const colorMatrix = nextOptions.colorMatrix ?? analysisOptions.colorMatrix;
  const colorRange = nextOptions.colorRange ?? analysisOptions.colorRange;
  if (!allowedWaveformModes.has(waveformMode)) throw new RangeError("Unsupported waveform mode.");
  if (!allowedColorMatrices.has(colorMatrix)) throw new RangeError("Unsupported color matrix.");
  if (colorRange !== "limited" && colorRange !== "full") throw new RangeError("Color range must be limited or full.");
  return { region: { ...region }, waveformMode, colorMatrix, colorRange };
}

async function startCapture({ device, formatKey, options }) {
  if (capture) await stopCapture("Switching DeckLink capture mode…");
  const deviceId = String(device);
  if (!discoveredDevices.includes(deviceId)) throw new Error("Refresh the device and mode lists before starting capture.");
  const listedModes = formatsByDevice.get(deviceId);
  if (!listedModes) throw new Error("Refresh the device and mode lists before starting capture.");
  const modes = [...listedModes.values()];
  const { format: mode, autoDetect } = resolveCaptureMode(
    formatKey,
    modes,
    inputFormatDetectionByDevice.get(deviceId) === true,
  );
  if (mode.width > 16384 || mode.height > 16384) throw new RangeError("The selected frame dimensions exceed the sample's safe limit.");
  analysisOptions = normalizeAnalysisOptions(options);

  let outputMode = "cpu";
  if (presentationMode === "gpu") {
    try {
      // Auto-detection starts with a probe mode but can switch to any advertised
      // input mode. Size the bounded ring for the largest supported v210 frame
      // so a valid 4K signal cannot force an unnecessary CPU fallback.
      openFrameTransport(v210CaptureSlotSize(modes, mode, autoDetect));
      outputMode = "v210-ring";
    } catch (error) {
      closeFrameTransport();
      sendStatus(`WebGPU frame transport unavailable; using CPU fallback. ${error.message}`, "info");
    }
  }
  let result;
  try {
    result = await requestHelper("start", {
      deviceId,
      formatKey: mode.key,
      autoDetect,
      options: analysisOptions,
      outputMode,
      ring: outputMode === "v210-ring" ? { name: frameRingName, slotCount: 3, slotSize: frameRingSlotSize } : undefined,
    });
  } catch (error) {
    closeFrameTransport();
    throw error;
  }
  if (outputMode === "v210-ring" && result.outputMode !== "v210-ring") closeFrameTransport();
  capture = { child: helper, width: result.width, height: result.height, outputMode: result.outputMode ?? outputMode };
  const deviceLabel = deviceLabelsById.get(deviceId) ?? `device ${deviceId}`;
  sendStatus(autoDetect
    ? `Capturing ${deviceLabel} · following the detected input format as 10-bit v210.`
    : `Capturing ${deviceLabel} · ${result.format} · 10-bit v210 input.`);
  return { ...result, autoDetect, outputMode: capture.outputMode };
}

async function stopCapture(message = "Capture stopped.", kind = "info") {
  const active = capture;
  capture = undefined;
  if (helper?.connected && active) {
    const child = active.child;
    try {
      await requestHelper("stop", {}, 3000);
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
    // Macadam does not settle an outstanding frame() promise on stop. Recycle
    // the isolated helper so a later capture starts with a fresh native queue.
    await terminateHelper(child);
  }
  closeFrameTransport();
  if (active || message !== "Capture stopped.") sendStatus(message, kind);
  return Boolean(active);
}

ipcMain.handle("decklink:list-devices", async (event) => {
  assertTrustedSender(event);
  return listDeckLinkDevices();
});

ipcMain.handle("decklink:list-formats", async (event, device) => {
  assertTrustedSender(event);
  return listDeviceFormats(device);
});

ipcMain.handle("decklink:start", (event, request) => {
  assertTrustedSender(event);
  return startCapture(request);
});

ipcMain.handle("decklink:stop", async (event) => {
  assertTrustedSender(event);
  await stopCapture();
  return true;
});

ipcMain.handle("decklink:analysis-options", async (event, options) => {
  assertTrustedSender(event);
  analysisOptions = normalizeAnalysisOptions(options);
  if (capture) await requestHelper("analysis-options", { options: analysisOptions });
  return true;
});

ipcMain.handle("decklink:gpu-status", (event) => {
  assertTrustedSender(event);
  return getGpuStatus();
});

ipcMain.on("decklink:frame-ack", acceptFrameAck);

ipcMain.handle("decklink:presentation-mode", async (event, mode) => {
  assertTrustedSender(event);
  if (mode !== "gpu" && mode !== "cpu") throw new RangeError("Presentation mode must be gpu or cpu.");
  presentationMode = mode;
  if (capture) {
    await requestHelper("output-mode", { mode: mode === "gpu" ? "v210-ring" : "cpu" });
    capture.outputMode = mode === "gpu" ? "v210-ring" : "cpu";
    if (mode === "cpu") closeFrameTransport();
  }
  return { mode: presentationMode, outputMode: capture?.outputMode ?? presentationMode };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 720,
    minHeight: 650,
    backgroundColor: "#080b10",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== "webscopes://app/examples/electron-decklink/index.html") event.preventDefault();
  });
  mainWindow.loadURL("webscopes://app/examples/electron-decklink/index.html");
  mainWindow.on("closed", () => {
    void stopCapture("Window closed.");
    mainWindow = undefined;
  });
}

app.whenReady().then(() => {
  protocol.handle("webscopes", async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = path.resolve(projectRoot, relativePath);
    const normalizedPath = path.relative(projectRoot, filePath).split(path.sep).join("/");
    if (url.hostname !== "app" || !rendererFiles.has(normalizedPath) || !filePath.startsWith(`${projectRoot}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await readFile(filePath);
      const contentType = path.extname(filePath) === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8";
      return new Response(body, { headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (helper?.connected) {
    try {
      helper.send({ id: nextRequestId++, action: "shutdown", payload: {} });
      const child = helper;
      const timer = setTimeout(() => child.kill("SIGTERM"), 800);
      timer.unref?.();
    } catch {
      helper.kill("SIGTERM");
    }
  }
});
