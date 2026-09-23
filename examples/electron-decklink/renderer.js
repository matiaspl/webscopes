import { renderScopes } from "../../src/render.js";
import { createScopeDisplay } from "../../src/webgpu.js";
import { colorMatrixFromCode, resolveCapturedColorMatrix } from "./macadam-utils.js";
import { bindRoiSelection, createRoiSelectionController, regionForPreset } from "../roi-controls.js";

const deviceSelect = document.querySelector("#device");
const modeSelect = document.querySelector("#mode");
const refreshButton = document.querySelector("#refresh");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const stage = document.querySelector("#stage");
const preview = document.querySelector("#preview");
const previewContext = preview.getContext("2d", { alpha: false, desynchronized: true });
const previewGpu = document.querySelector("#preview-gpu");
const roiBox = document.querySelector("#roi-box");
const roiMeta = document.querySelector("#roi-meta");
const videoMeta = document.querySelector("#video-meta");
const vitcDisplay = document.querySelector("#vitc-display");
const vitcMeta = document.querySelector("#vitc-meta");
const scopeMeta = document.querySelector("#scope-meta");
const scopeCanvas = document.querySelector("#scope");
const scopeGpu = document.querySelector("#scope-gpu");
const status = document.querySelector("#status");
const waveformSelect = document.querySelector("#waveform");
const matrixSelect = document.querySelector("#matrix");
const rangeSelect = document.querySelector("#range");
const waveformLabel = document.querySelector("#waveform-label");
const signalMeta = document.querySelector("#signal-meta");
const gpuStatusLabel = document.querySelector("#gpu-status");
const liveScopeSampleBudget = 120_000;

let region = regionForPreset("full");
let selectedMode;
let captureActive = false;
let deviceCapabilities = new Map();
let gpuDisplay;
let gpuReady = false;
let gpuInitPromise;
let framePort;
let latestGpuFrame;
let gpuPumpRunning = false;
let gpuSubmitted = 0;
let gpuCompleted = 0;
let transportDropped = 0;
let receivedFrames = 0;
let sharedExternalValidated = false;

function acknowledgeGpuFrame(sequence, data, extra = {}) {
  const buffer = ArrayBuffer.isView(data) ? data.buffer : data;
  if (buffer instanceof ArrayBuffer && typeof framePort?.postMessage === "function" && Object.keys(extra).length === 0) {
    const message = { type: "ack", sequence, buffer };
    framePort.postMessage(message, [buffer]);
    return;
  }
  window.decklink.ackFrame({ sequence, buffer, ...extra });
}

function closeExternalFrame(frame) {
  if (frame?.format === "v210-rgba-external") frame.frame?.close();
}

function setSurfaceBackend(useGpu) {
  preview.style.display = useGpu ? "none" : "block";
  previewGpu.style.display = useGpu ? "block" : "none";
  scopeCanvas.style.display = useGpu ? "none" : "block";
  scopeGpu.style.display = useGpu ? "block" : "none";
}

function resizeGpuPreview() {
  if (!gpuReady) return;
  const { width: cssWidth, height: cssHeight } = previewGpu.getBoundingClientRect();
  if (cssWidth <= 0 || cssHeight <= 0) return;
  const scale = Math.min(window.devicePixelRatio || 1, 1920 / cssWidth, 1080 / cssHeight);
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  if (previewGpu.width !== width) previewGpu.width = width;
  if (previewGpu.height !== height) previewGpu.height = height;
}

async function fallbackToCpu(message) {
  if (latestGpuFrame) {
    try { acknowledgeGpuFrame(latestGpuFrame.frame.sequence, latestGpuFrame.frame.data,
      latestGpuFrame.frame.format === "v210-rgba-external" ? { sharedTextureSkipped: true } : {}); } catch {}
    closeExternalFrame(latestGpuFrame.frame);
    latestGpuFrame = undefined;
  }
  if (gpuDisplay) {
    const display = gpuDisplay;
    gpuDisplay = undefined;
    try { await display.destroy(); } catch {}
  }
  gpuReady = false;
  setSurfaceBackend(false);
  try { await window.decklink.setPresentationMode("cpu"); } catch {}
  if (message) setStatus(`${message} CPU fallback active.`, "error");
}

async function initializeGpu() {
  try {
    if (!navigator.gpu) throw new Error("navigator.gpu is unavailable");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    device.lost.then((info) => { void fallbackToCpu(`WebGPU device lost: ${info.message || "unknown reason"}`); });
    gpuDisplay = await createScopeDisplay({
      canvas: scopeGpu,
      previewCanvas: previewGpu,
      device,
      waveformMode: waveformSelect.value,
      colorMatrix: matrixSelect.value,
      colorRange: rangeSelect.value,
      renderOptions: { layout: "side-by-side", dither: 0, vectorscopeDither: 0, gain: 0.18 },
      onDeviceLost: (error) => { void fallbackToCpu(error.message); },
      onError: (error) => setStatus(`WebGPU presentation error: ${error.message}`, "error"),
    });
    gpuReady = true;
    setSurfaceBackend(true);
    resizeGpuPreview();
    await window.decklink.setPresentationMode("gpu");
    gpuStatusLabel.dataset.backend = "webgpu";
    void window.decklink.getGpuStatus().then(updateGpuStatus).catch(() => {});
    setStatus("WebGPU v210 display and analysis ready. Start capture when an input is selected.");
  } catch (error) {
    await fallbackToCpu(`WebGPU unavailable: ${error.message}`);
  }
}

function updateGpuCounters() {
  const captured = receivedFrames > 0 ? `${receivedFrames} captured` : "waiting for frames";
  scopeMeta.textContent = `${captured} · GPU submitted ${gpuSubmitted} · completed ${gpuCompleted} · transport drops ${transportDropped}`;
}

async function pumpGpuFrames() {
  if (gpuPumpRunning) return;
  gpuPumpRunning = true;
  try {
    while (gpuReady && latestGpuFrame) {
      const packet = latestGpuFrame;
      latestGpuFrame = undefined;
      const frameData = packet.frame.data;
      const capturedMatrix = packet.frame.colorMatrix ?? colorMatrixFromCode(packet.frame.colorMatrixCode);
      const colorMatrix = resolveCapturedColorMatrix(matrixSelect.value, { colorMatrix: capturedMatrix });
      const frame = {
        ...packet.frame,
        ...(frameData === undefined ? {} : { data: ArrayBuffer.isView(frameData) ? frameData : new Uint8Array(frameData) }),
        colorMatrix,
        colorRange: rangeSelect.value,
      };
      if (frame.format === "v210-rgba-external") frame.validateBytes = !sharedExternalValidated;
      updateSignalMeta(colorMatrix, frame.eotf, matrixSelect.value === "auto" ? (capturedMatrix ? "decklink" : "fallback") : undefined);
      resizeGpuPreview();
      const roiPixelCount = frame.width * frame.height * region.width * region.height;
      const minimumWaveformScale = Math.min(0.35, 480 / (frame.width * region.width));
      const inputResolutionScaling = Math.min(0.35, Math.max(
        minimumWaveformScale,
        Math.sqrt(liveScopeSampleBudget / roiPixelCount),
      ));
      try {
        const presented = await gpuDisplay.present(frame, {
          ...currentAnalysisOptions(),
          colorMatrix,
          bitDepth: 10,
          inputResolutionScaling,
          waveformWidth: 480,
          waveformHeight: 1024,
          vectorscopeSize: 160,
          renderOptions: { layout: "side-by-side", dither: 0, vectorscopeDither: 0, gain: 0.18 },
        });
        if (presented.status === "submitted") {
          gpuSubmitted = presented.submittedFrames;
          gpuCompleted = presented.queueCompletedFrames;
          updateGpuCounters();
        }
        let validated = false;
        if (frame.format === "v210-rgba-external" && !sharedExternalValidated && presented.status === "submitted") {
          if (!presented.validationBytes || !frame.sha256) throw new Error("GPU byte validation was unavailable");
          const bytes = await presented.validationBytes;
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          const actualHash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
          if (actualHash !== frame.sha256) throw new Error("External texture changed packed v210 bytes");
          sharedExternalValidated = true;
          validated = true;
        }
        acknowledgeGpuFrame(frame.sequence, frameData, frame.format === "v210-rgba-external"
          ? validated ? { sharedTextureValidated: true } : { sharedTextureSkipped: !sharedExternalValidated }
          : {});
      } catch (error) {
        if (frame.format === "v210-rgba-external") {
          window.decklink.ackFrame({ sequence: frame.sequence, sharedTextureError: error.message });
          setStatus(`RGBA shared texture failed: ${error.message}. Retrying v210 IPC.`, "error");
        } else {
          try { acknowledgeGpuFrame(frame.sequence, frameData); } catch {}
          await fallbackToCpu(`WebGPU presentation failed: ${error.message}`);
          break;
        }
      } finally {
        closeExternalFrame(frame);
      }
    }
  } finally {
    gpuPumpRunning = false;
    if (gpuReady && latestGpuFrame) void pumpGpuFrames();
  }
}

function receiveGpuFrame(packet) {
  if (!packet?.frame) return;
  transportDropped = Math.max(transportDropped, Number(packet.dropped ?? 0));
  if (!gpuReady) {
    try { acknowledgeGpuFrame(packet.frame.sequence, packet.frame.data,
      packet.frame.format === "v210-rgba-external" ? { sharedTextureError: "WebGPU is not ready" } : {}); } catch {}
    closeExternalFrame(packet.frame);
    return;
  }
  if (latestGpuFrame) {
    const superseded = latestGpuFrame.frame;
    try { acknowledgeGpuFrame(superseded.sequence, superseded.data,
      superseded.format === "v210-rgba-external" ? { sharedTextureSkipped: true } : {}); } catch {}
    closeExternalFrame(superseded);
  }
  latestGpuFrame = packet;
  void pumpGpuFrames();
}

function receiveSharedRgbaFrame({ metadata, frame }) {
  if (!metadata || !(frame instanceof VideoFrame)) return;
  const { dropped, ...details } = metadata;
  receiveGpuFrame({ frame: { ...details, format: "v210-rgba-external", frame,
    validateBytes: !sharedExternalValidated }, dropped });
}

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function updateVITC(vitc) {
  if (vitc?.available === true) {
    vitcDisplay.textContent = vitc.display;
    vitcDisplay.dataset.state = "available";
    const mode = [
      vitc.dropFrame ? "DF" : "NDF",
      vitc.framePair === null ? null : `PAIR ${vitc.framePair}`,
    ].filter(Boolean).join(" · ");
    vitcMeta.textContent = `${mode} · UB ${vitc.userBitsHex ?? "—"}`;
    return;
  }

  const invalid = vitc?.reason === "invalid";
  vitcDisplay.textContent = invalid ? "INVALID" : "--:--:--:--";
  vitcDisplay.dataset.state = invalid ? "invalid" : "missing";
  vitcMeta.textContent = invalid ? `Malformed metadata · UB ${vitc.userBitsHex ?? "—"}` : "NO VITC · UB —";
}

function contentRect() {
  const box = stage.getBoundingClientRect();
  const mode = selectedMode;
  const sourceWidth = mode?.width ?? 16;
  const sourceHeight = mode?.height ?? 9;
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

function drawRegion() {
  const bounds = contentRect();
  roiBox.style.display = "block";
  roiBox.style.left = `${bounds.left + region.x * bounds.width}px`;
  roiBox.style.top = `${bounds.top + region.y * bounds.height}px`;
  roiBox.style.width = `${region.width * bounds.width}px`;
  roiBox.style.height = `${region.height * bounds.height}px`;
  const percent = Math.round(region.width * region.height * 100);
  roiMeta.textContent = `ROI ${percent}% · ${Math.round(region.width * 100)}% × ${Math.round(region.height * 100)}%`;
}

function pointToSource(event) {
  const stageBounds = stage.getBoundingClientRect();
  const bounds = contentRect();
  const x = event.clientX - stageBounds.left - bounds.left;
  const y = event.clientY - stageBounds.top - bounds.top;
  return {
    x: Math.min(1, Math.max(0, x / bounds.width)),
    y: Math.min(1, Math.max(0, y / bounds.height)),
    inside: x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height,
  };
}

function currentAnalysisOptions() {
  return {
    region: { ...region },
    waveformMode: waveformSelect.value,
    colorMatrix: matrixSelect.value,
    colorRange: rangeSelect.value,
  };
}

function matrixLabel(matrix) {
  return matrix === "bt601" ? "BT.601"
    : matrix === "bt2020" ? "BT.2020"
      : matrix === "bt2100" ? "BT.2100 HDR"
        : matrix === "auto" ? "AUTO"
          : "BT.709";
}

function updateSignalMeta(effectiveMatrix = matrixSelect.value, eotf, source) {
  const selected = matrixSelect.value;
  const matrix = selected === "auto" && effectiveMatrix !== "auto"
    ? `AUTO → ${matrixLabel(effectiveMatrix)}${source === "decklink" ? " · DeckLink" : source === "fallback" ? " · fallback" : ""}`
    : matrixLabel(effectiveMatrix);
  const transfer = Number.isInteger(eotf) && eotf >= 0 ? ` · EOTF ${eotf}` : "";
  signalMeta.textContent = `${matrix} · ${rangeSelect.value.toUpperCase()} · 10-BIT${transfer}`;
}

function updateAnalysisOptions() {
  waveformLabel.textContent = waveformSelect.selectedOptions[0].textContent.toUpperCase();
  updateSignalMeta();
  void window.decklink.setAnalysisOptions(currentAnalysisOptions()).catch((error) => setStatus(error.message, "error"));
}

async function refreshDevices() {
  refreshButton.disabled = true;
  deviceSelect.disabled = true;
  modeSelect.disabled = true;
  startButton.disabled = true;
  deviceSelect.replaceChildren(new Option("Searching…", ""));
  modeSelect.replaceChildren(new Option("Select device first", ""));
  try {
    const devices = await window.decklink.listDevices();
    deviceCapabilities = new Map(devices.map((device) => [String(device.id), device]));
    deviceSelect.replaceChildren(new Option("Select Blackmagic input…", ""));
    for (const device of devices) deviceSelect.add(new Option(device.label, device.id));
    deviceSelect.disabled = devices.length === 0;
    setStatus(devices.length ? `Found ${devices.length} Blackmagic capture device${devices.length === 1 ? "" : "s"}. Select a mode to start.` : "No Blackmagic capture device found.");
  } catch (error) {
    deviceSelect.replaceChildren(new Option("No Blackmagic inputs", ""));
    setStatus(error.message, "error");
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadFormats() {
  const device = deviceSelect.value;
  selectedMode = undefined;
  stage.style.aspectRatio = "16 / 9";
  modeSelect.disabled = true;
  startButton.disabled = true;
  modeSelect.replaceChildren(new Option(device ? "Loading modes…" : "Select device first", ""));
  if (!device) return;
  try {
    const formats = await window.decklink.listFormats(device);
    modeSelect.replaceChildren(new Option("Select capture mode…", ""));
    const supportsAuto = deviceCapabilities.get(String(device))?.supportsInputFormatDetection === true;
    if (supportsAuto) {
      const autoOption = new Option("Auto · follow input format", "auto");
      autoOption.dataset.width = String(formats[0].width);
      autoOption.dataset.height = String(formats[0].height);
      modeSelect.add(autoOption);
    }
    for (const format of formats) {
      const option = new Option(format.label, format.key);
      option.dataset.width = String(format.width);
      option.dataset.height = String(format.height);
      modeSelect.add(option);
    }
    modeSelect.disabled = false;
    if (supportsAuto) modeSelect.value = "auto";
    selectMode();
    const deviceLabel = deviceSelect.selectedOptions[0]?.textContent || device;
    setStatus(supportsAuto
      ? `${formats.length} 10-bit mode${formats.length === 1 ? "" : "s"} listed for ${deviceLabel}. Auto follows the detected input format.`
      : `${formats.length} capture mode${formats.length === 1 ? "" : "s"} listed for ${deviceLabel}. This device does not advertise automatic format detection.`);
  } catch (error) {
    modeSelect.replaceChildren(new Option("No modes found", ""));
    setStatus(error.message, "error");
  }
}

function selectMode() {
  const option = modeSelect.selectedOptions[0];
  if (!option?.value) {
    selectedMode = undefined;
    startButton.disabled = true;
    return;
  }
  selectedMode = { width: Number(option.dataset.width), height: Number(option.dataset.height) };
  stage.style.aspectRatio = `${selectedMode.width} / ${selectedMode.height}`;
  startButton.disabled = captureActive;
  videoMeta.textContent = option.value === "auto"
    ? `Auto · waiting for input format · ${selectedMode.width}×${selectedMode.height} fallback`
    : `${selectedMode.width}×${selectedMode.height} · input`;
  drawRegion();
}

async function startCapture() {
  if (!deviceSelect.value || !modeSelect.value) return;
  if (gpuInitPromise) await gpuInitPromise;
  startButton.disabled = true;
  sharedExternalValidated = false;
  try {
    const result = await window.decklink.start({
      device: deviceSelect.value,
      formatKey: modeSelect.value,
      options: currentAnalysisOptions(),
    });
    captureActive = true;
    deviceSelect.disabled = true;
    modeSelect.disabled = true;
    refreshButton.disabled = true;
    stopButton.disabled = false;
    if (result.autoDetect) {
      selectedMode = { width: result.width, height: result.height };
      stage.style.aspectRatio = `${result.width} / ${result.height}`;
      drawRegion();
      videoMeta.textContent = `Auto · waiting for detected format · ${result.width}×${result.height} initial mode`;
    } else {
      videoMeta.textContent = `${result.width}×${result.height} · v210 10-bit`;
    }
    scopeMeta.textContent = "Waiting for video frames…";
    if (gpuReady && result.outputMode !== "v210-ring") {
      await fallbackToCpu("Native v210 frame transport is unavailable.");
    }
  } catch (error) {
    startButton.disabled = false;
    setStatus(error.message, "error");
  }
}

async function stopCapture() {
  await window.decklink.stop();
  captureActive = false;
  updateVITC(undefined);
  deviceSelect.disabled = false;
  modeSelect.disabled = !deviceSelect.value || modeSelect.options.length <= 1;
  refreshButton.disabled = false;
  startButton.disabled = !modeSelect.value;
  stopButton.disabled = true;
  scopeMeta.textContent = "Capture stopped";
}

const roiSelection = createRoiSelectionController({
  getRegion: () => region,
  setRegion(value) { region = value; },
  drawRegion,
  onCommit: updateAnalysisOptions,
});
bindRoiSelection(stage, roiSelection, pointToSource);

document.querySelectorAll("[data-region]").forEach((button) => {
  button.addEventListener("click", () => {
    region = regionForPreset(button.dataset.region);
    drawRegion();
    updateAnalysisOptions();
  });
});

refreshButton.addEventListener("click", refreshDevices);
deviceSelect.addEventListener("change", loadFormats);
modeSelect.addEventListener("change", selectMode);
startButton.addEventListener("click", startCapture);
stopButton.addEventListener("click", () => void stopCapture());
waveformSelect.addEventListener("change", updateAnalysisOptions);
matrixSelect.addEventListener("change", updateAnalysisOptions);
rangeSelect.addEventListener("change", updateAnalysisOptions);
window.addEventListener("resize", () => {
  resizeGpuPreview();
  drawRegion();
});

window.decklink.onStatus(({ message, kind }) => {
  setStatus(message, kind);
  if (/frame ring failed|frame transport unavailable|CPU analysis/i.test(message) && gpuReady) {
    void fallbackToCpu(message);
  }
  if (kind === "error" || /stopped|exited|closing/i.test(message)) {
    updateVITC(undefined);
    captureActive = false;
    deviceSelect.disabled = false;
    modeSelect.disabled = !deviceSelect.value || modeSelect.options.length <= 1;
    refreshButton.disabled = false;
    startButton.disabled = !modeSelect.value;
    stopButton.disabled = true;
  }
});

window.decklink.onPreview(({ width, height, data }) => {
  if (gpuReady) return;
  preview.width = width;
  preview.height = height;
  previewContext.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  drawRegion();
});

window.decklink.onScopes((result) => {
  if (gpuReady) return;
  renderScopes(result, scopeCanvas, { layout: "side-by-side", dither: 0, vectorscopeDither: 0, gain: 0.18 });
  const updateFps = result.stats.performance.updateFps;
  const rate = updateFps > 0 ? `${updateFps.toFixed(1)} updates/s` : "measuring update rate…";
  scopeMeta.textContent = `${result.width}×${result.height} · ${rate} · CPU analysis`;
  updateSignalMeta(result.stats.colorMatrix, result.stats.eotf);
});

window.decklink.onTelemetry((telemetry) => {
  const { width, height, vitc } = telemetry;
  receivedFrames = telemetry.receivedFrames ?? receivedFrames;
  transportDropped = Math.max(transportDropped, Number(telemetry.transportDroppedFrames ?? 0));
  if (!gpuReady && telemetry.colorMatrix) updateSignalMeta(telemetry.colorMatrix, telemetry.eotf, telemetry.colorMatrixSource);
  updateVITC(vitc);
  if (modeSelect.value === "auto") {
    selectedMode = { width, height };
    stage.style.aspectRatio = `${width} / ${height}`;
    drawRegion();
    videoMeta.textContent = `${width}×${height} · Auto · v210 10-bit`;
  } else {
    videoMeta.textContent = `${width}×${height} · v210 10-bit`;
  }
  if (gpuReady) updateGpuCounters();
});

window.decklink.onVITC(updateVITC);

function updateGpuStatus(result) {
  const detail = result?.ready
    ? ` acceleration ${result.hardwareAccelerationEnabled ? "on" : "off"} · compositor ${result.gpuCompositing} · v210 path ${gpuReady ? "WebGPU" : "CPU fallback"}`
    : " status not available yet";
  const label = document.createElement("strong");
  label.textContent = "Electron GPU:";
  gpuStatusLabel.replaceChildren(label, document.createTextNode(detail));
}

window.decklink.onGpuStatus(updateGpuStatus);
window.decklink.onFramePort((port) => {
  if (!port) {
    void fallbackToCpu("Electron did not provide a frame port.");
    return;
  }
  framePort = port;
  const receivePortMessage = (event) => receiveGpuFrame(event?.data ?? event);
  if (typeof port.addEventListener === "function") port.addEventListener("message", receivePortMessage);
  else if (typeof port.on === "function") port.on("message", receivePortMessage);
  else port.onmessage = receivePortMessage;
  if (typeof port.start === "function") port.start();
});
window.decklink.onFrame(receiveGpuFrame);
window.addEventListener("message", (event) => {
  if (event.source === window && event.origin === window.location.origin
    && event.data?.type === "webscopes:shared-v210") receiveSharedRgbaFrame(event.data);
});
void window.decklink.getGpuStatus().then(updateGpuStatus).catch(() => updateGpuStatus(undefined));

updateAnalysisOptions();
drawRegion();
gpuInitPromise = initializeGpu();
void refreshDevices();
