import { createRequire } from "node:module";
import { analyzeFrame } from "../../src/index.js";
import { listTenBitModes, makeV210Preview, v210BytesPerRow } from "./macadam-utils.js";

const require = createRequire(import.meta.url);
let macadam;
let devices = [];
let modesByDevice = new Map();
let activeCapture;
let analysisOptions = {
  region: { x: 0, y: 0, width: 1, height: 1 },
  waveformMode: "luma",
  colorMatrix: "bt709",
  colorRange: "limited",
};

const ANALYSIS_INTERVAL_MS = 100;

function send(message) {
  if (process.connected) process.send(message);
}

function respond(id, result) {
  send({ type: "response", id, ok: true, result });
}

function reject(id, error) {
  send({ type: "response", id, ok: false, error: error?.message ?? String(error) });
}

function getMacadam() {
  if (!macadam) macadam = require("@spaceagetv/macadam");
  return macadam;
}

function listDevices() {
  const api = getMacadam();
  const reportedDevices = api.getDeviceInfo();
  if (!Array.isArray(reportedDevices)) throw new Error("Macadam returned an invalid device list.");
  devices = reportedDevices;
  modesByDevice = new Map();
  return devices.map((device, index) => ({
    id: String(index),
    label: device.displayName || device.modelName || `DeckLink ${index + 1}`,
    supportsInputFormatDetection: device.supportsInputFormatDetection === true,
  }));
}

function listFormats(deviceId) {
  const index = Number(deviceId);
  const device = devices[index];
  if (!device || String(index) !== String(deviceId)) throw new Error("Refresh the DeckLink device list first.");
  const formats = listTenBitModes(device, getMacadam(), index);
  if (!formats.length) {
    throw new Error(`Macadam found no 10-bit YUV input modes for ${device.displayName || device.modelName || deviceId}.`);
  }
  modesByDevice.set(String(deviceId), new Map(formats.map((format) => [format.key, format])));
  return formats.map(({ key, width, height, label }) => ({ key, width, height, label }));
}

function stopCapture() {
  const state = activeCapture;
  if (!state) return false;
  activeCapture = undefined;
  state.stopped = true;
  try {
    state.channel.stop();
  } catch {
    // The channel can already be stopped after a DeckLink/driver error.
  }
  return true;
}

function validateAnalysisOptions(next = {}) {
  const region = next.region ?? analysisOptions.region;
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new RangeError("ROI must be a positive rectangle inside the source frame.");
  }
  const waveformMode = next.waveformMode ?? analysisOptions.waveformMode;
  const colorMatrix = next.colorMatrix ?? analysisOptions.colorMatrix;
  const colorRange = next.colorRange ?? analysisOptions.colorRange;
  if (!["rgb", "rgb-parade", "luma", "ycbcr-parade", "composite"].includes(waveformMode)) throw new RangeError("Unsupported waveform mode.");
  if (!["bt601", "bt709", "bt2020", "bt2100"].includes(colorMatrix)) throw new RangeError("Unsupported color matrix.");
  if (colorRange !== "limited" && colorRange !== "full") throw new RangeError("Color range must be limited or full.");
  return { region: { ...region }, waveformMode, colorMatrix, colorRange };
}

function processCapturedFrame(state, frame) {
  const video = frame?.video;
  if (!video?.data) return;
  const width = video.width;
  const height = video.height;
  const bytesPerRow = video.rowBytes;
  if (width > 16384 || height > 16384 || v210BytesPerRow(width) * height > 128 * 1024 * 1024) {
    throw new RangeError("The detected v210 input exceeds this sample's 128 MiB frame limit.");
  }
  if (state.autoDetect && video.hasNoInputSource) {
    if (!state.reportedNoSignal) {
      state.reportedNoSignal = true;
      send({ type: "event", name: "status", value: { message: "Auto mode is waiting for a valid input signal.", kind: "info" } });
    }
    return;
  }
  if (state.width !== width || state.height !== height) {
    if (!state.autoDetect) {
      throw new Error(`DeckLink frame size changed from ${state.width}×${state.height} to ${width}×${height}.`);
    }
    state.width = width;
    state.height = height;
  }
  if (state.autoDetect && (!state.reportedInputMode || state.reportedInputWidth !== width || state.reportedInputHeight !== height)) {
    state.reportedInputMode = true;
    state.reportedInputWidth = width;
    state.reportedInputHeight = height;
    send({ type: "event", name: "status", value: { message: `Auto mode following the detected ${width}×${height} input.`, kind: "info" } });
  }
  const startedAt = performance.now();
  const result = analyzeFrame({
    format: "v210",
    data: video.data,
    width,
    height,
    bytesPerRow,
    colorRange: analysisOptions.colorRange,
  }, {
    ...analysisOptions,
    bitDepth: 10,
    inputResolutionScaling: 0.35,
    waveformWidth: 480,
    waveformHeight: 1024,
    vectorscopeSize: 160,
  });
  const frameTimeMs = performance.now() - startedAt;
  state.averageAnalysisMs = state.averageAnalysisMs === undefined
    ? frameTimeMs
    : state.averageAnalysisMs + (frameTimeMs - state.averageAnalysisMs) * 0.2;
  const publishedAt = performance.now();
  if (state.lastScopeUpdateAt !== undefined) {
    const intervalMs = publishedAt - state.lastScopeUpdateAt;
    state.averageScopeIntervalMs = state.averageScopeIntervalMs === undefined
      ? intervalMs
      : state.averageScopeIntervalMs + (intervalMs - state.averageScopeIntervalMs) * 0.2;
  }
  state.lastScopeUpdateAt = publishedAt;
  const updateFps = state.averageScopeIntervalMs > 0 ? 1000 / state.averageScopeIntervalMs : 0;
  result.stats.performance = {
    backend: "cpu",
    frameTimeMs,
    fps: frameTimeMs > 0 ? 1000 / frameTimeMs : 0,
    averageFrameTimeMs: state.averageAnalysisMs,
    averageFps: state.averageAnalysisMs > 0 ? 1000 / state.averageAnalysisMs : 0,
    updateFps,
  };
  send({ type: "event", name: "scopes", value: result });

  const now = performance.now();
  let previewTimeMs = 0;
  if (now - state.lastPreviewAt >= ANALYSIS_INTERVAL_MS) {
    state.lastPreviewAt = now;
    const previewStartedAt = performance.now();
    const preview = makeV210Preview(video.data, width, height, bytesPerRow, analysisOptions);
    previewTimeMs = performance.now() - previewStartedAt;
    send({ type: "event", name: "preview", value: preview });
  }
  send({
    type: "event",
    name: "telemetry",
    value: { width, height, receivedFrames: state.receivedFrames, frameTimeMs, previewTimeMs, updateFps },
  });
}

async function captureLoop(state) {
  let nextFrame;
  try {
    while (activeCapture === state && !state.stopped) {
      const frame = await (nextFrame ?? state.channel.frame());
      if (activeCapture !== state || state.stopped) break;
      // Keep one frame request outstanding while analysis runs. Macadam drops
      // surplus callback frames and releases their DeckLink references instead
      // of building a stale frame queue.
      nextFrame = state.channel.frame();
      state.receivedFrames += 1;
      if (performance.now() - state.lastAnalysisAt < ANALYSIS_INTERVAL_MS) continue;
      state.lastAnalysisAt = performance.now();
      processCapturedFrame(state, frame);
    }
  } catch (error) {
    if (activeCapture !== state || state.stopped) return;
    stopCapture();
    send({ type: "event", name: "status", value: { message: `Macadam capture stopped: ${error.message}`, kind: "error" } });
  }
}

async function startCapture(request) {
  stopCapture();
  const deviceId = String(request.deviceId);
  const deviceIndex = Number(deviceId);
  const device = devices[deviceIndex];
  const format = modesByDevice.get(deviceId)?.get(String(request.formatKey));
  const autoDetect = request.autoDetect === true;
  if (autoDetect && device?.supportsInputFormatDetection !== true) {
    throw new Error("This device does not support automatic input format detection.");
  }
  if (!device || !format) throw new Error("Refresh the device and mode lists before starting capture.");
  if (format.width > 16384 || format.height > 16384) throw new RangeError("The selected frame dimensions exceed the sample's safe limit.");
  if (v210BytesPerRow(format.width) * format.height > 128 * 1024 * 1024) throw new RangeError("This sample supports v210 frames up to 128 MiB each.");

  analysisOptions = validateAnalysisOptions(request.options);
  const api = getMacadam();
  const channel = await api.capture({
    deviceIndex,
    displayMode: format.displayMode,
    pixelFormat: api.bmdFormat10BitYUV,
    autoDetect,
  });
  if (channel.pixelFormat !== "10-bit YUV") {
    channel.stop();
    throw new Error(`DeckLink capture opened as ${channel.pixelFormat || "an unknown format"}, not 10-bit YUV/v210.`);
  }

  const state = {
    channel,
    width: channel.width,
    height: channel.height,
    autoDetect,
    receivedFrames: 0,
    lastAnalysisAt: 0,
    lastPreviewAt: 0,
    stopped: false,
  };
  activeCapture = state;
  void captureLoop(state);
  return { width: state.width, height: state.height, format: format.label, autoDetect };
}

process.on("message", async (message) => {
  const { id, action, payload = {} } = message ?? {};
  try {
    if (action === "list-devices") respond(id, listDevices());
    else if (action === "list-formats") respond(id, listFormats(payload.deviceId));
    else if (action === "start") respond(id, await startCapture(payload));
    else if (action === "stop") respond(id, { stopped: stopCapture() });
    else if (action === "analysis-options") {
      analysisOptions = validateAnalysisOptions(payload.options);
      respond(id, true);
    } else if (action === "shutdown") {
      stopCapture();
      respond(id, true);
      setImmediate(() => process.disconnect());
    } else reject(id, new Error(`Unknown Macadam helper action: ${action}`));
  } catch (error) {
    reject(id, error);
  }
});

process.on("disconnect", () => {
  stopCapture();
  process.exit(0);
});
