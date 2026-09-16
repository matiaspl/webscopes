import { fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, protocol } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const helperPath = path.join(__dirname, "macadam-helper.js");
const rendererFiles = new Set([
  "examples/electron-decklink/index.html",
  "examples/electron-decklink/renderer.js",
  "examples/roi-controls.js",
  "src/index.js",
  "src/analyze.js",
  "src/render.js",
  "src/webgpu.js",
]);
const allowedWaveformModes = new Set(["rgb", "rgb-parade", "luma", "ycbcr-parade", "composite"]);
const allowedColorMatrices = new Set(["bt601", "bt709", "bt2020", "bt2100"]);
let mainWindow;
let helper;
let helperStderr = "";
let capture;
let nextRequestId = 1;
const pendingRequests = new Map();
let discoveredDevices = [];
const formatsByDevice = new Map();
let analysisOptions = {
  region: { x: 0, y: 0, width: 1, height: 1 },
  waveformMode: "luma",
  colorMatrix: "bt709",
  colorRange: "limited",
};

protocol.registerSchemesAsPrivileged([{
  scheme: "webscopes",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

function sendStatus(message, kind = "info") {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("decklink:status", { message, kind });
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted IPC sender");
}

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
  if (message?.type !== "event" || mainWindow?.isDestroyed()) return;
  if (message.name === "status" && (message.value?.kind === "error" || /stopped|exited/i.test(message.value?.message ?? ""))) {
    capture = undefined;
  }
  const channels = {
    status: "decklink:status",
    preview: "decklink:preview",
    scopes: "decklink:scopes",
    telemetry: "decklink:telemetry",
  };
  const channel = channels[message.name];
  if (channel) mainWindow.webContents.send(channel, message.value);
}

function ensureHelper() {
  if (helper && helper.connected && helper.exitCode === null) return helper;
  helperStderr = "";
  helper = fork(helperPath, [], {
    execPath: process.env.WEBSCOPES_NODE_PATH || process.env.npm_node_execpath || "node",
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
  const mode = formatsByDevice.get(deviceId)?.get(String(formatKey));
  if (!discoveredDevices.includes(deviceId) || !mode) throw new Error("Refresh the device and mode lists before starting capture.");
  if (mode.width > 16384 || mode.height > 16384) throw new RangeError("The selected frame dimensions exceed the sample's safe limit.");
  analysisOptions = normalizeAnalysisOptions(options);

  const result = await requestHelper("start", { deviceId, formatKey: String(formatKey), options: analysisOptions });
  capture = { child: helper, width: result.width, height: result.height };
  sendStatus(`Capturing ${deviceId} · ${result.format} · 10-bit v210 SDI input.`);
  return result;
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
    // Macadam 2.0.18 does not settle outstanding frame() promises on stop.
    // Recycle the helper so its native frame queue and SDK references cannot
    // accumulate across capture sessions.
    await terminateHelper(child);
  }
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
      return new Response(body, { headers: { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" } });
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
