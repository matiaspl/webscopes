import { renderScopes } from "../../src/render.js";
import { bindRoiSelection, createRoiSelectionController, regionForPreset } from "../roi-controls.js";

const deviceSelect = document.querySelector("#device");
const modeSelect = document.querySelector("#mode");
const refreshButton = document.querySelector("#refresh");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const stage = document.querySelector("#stage");
const preview = document.querySelector("#preview");
const previewContext = preview.getContext("2d", { alpha: false, desynchronized: true });
const roiBox = document.querySelector("#roi-box");
const roiMeta = document.querySelector("#roi-meta");
const videoMeta = document.querySelector("#video-meta");
const scopeMeta = document.querySelector("#scope-meta");
const scopeCanvas = document.querySelector("#scope");
const status = document.querySelector("#status");
const waveformSelect = document.querySelector("#waveform");
const matrixSelect = document.querySelector("#matrix");
const rangeSelect = document.querySelector("#range");
const waveformLabel = document.querySelector("#waveform-label");
const signalMeta = document.querySelector("#signal-meta");
const gpuStatusLabel = document.querySelector("#gpu-status");

let region = regionForPreset("full");
let selectedMode;
let captureActive = false;
let deviceCapabilities = new Map();

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
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

function updateAnalysisOptions() {
  const matrix = matrixSelect.value.toUpperCase().replace("BT", "BT.");
  waveformLabel.textContent = waveformSelect.selectedOptions[0].textContent.toUpperCase();
  signalMeta.textContent = `${matrix} · ${rangeSelect.value.toUpperCase()} · 10-BIT`;
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
    deviceCapabilities = new Map(devices.map((device) => [String(device.id), device.supportsInputFormatDetection === true]));
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
    const supportsAuto = deviceCapabilities.get(String(device)) === true;
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
  startButton.disabled = true;
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
  } catch (error) {
    startButton.disabled = false;
    setStatus(error.message, "error");
  }
}

async function stopCapture() {
  await window.decklink.stop();
  captureActive = false;
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
window.addEventListener("resize", drawRegion);

window.decklink.onStatus(({ message, kind }) => {
  setStatus(message, kind);
  if (kind === "error" || /stopped|exited|closing/i.test(message)) {
    captureActive = false;
    deviceSelect.disabled = false;
    modeSelect.disabled = !deviceSelect.value || modeSelect.options.length <= 1;
    refreshButton.disabled = false;
    startButton.disabled = !modeSelect.value;
    stopButton.disabled = true;
  }
});

window.decklink.onPreview(({ width, height, data }) => {
  preview.width = width;
  preview.height = height;
  previewContext.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  drawRegion();
});

window.decklink.onScopes((result) => {
  renderScopes(result, scopeCanvas, { layout: "side-by-side", dither: 0, vectorscopeDither: 0, gain: 0.18 });
  const updateFps = result.stats.performance.updateFps;
  const rate = updateFps > 0 ? `${updateFps.toFixed(1)} updates/s` : "measuring update rate…";
  scopeMeta.textContent = `${result.width}×${result.height} · ${rate} · CPU analysis`;
});

window.decklink.onTelemetry(({ width, height }) => {
  if (modeSelect.value === "auto") {
    selectedMode = { width, height };
    stage.style.aspectRatio = `${width} / ${height}`;
    drawRegion();
    videoMeta.textContent = `${width}×${height} · Auto · v210 10-bit`;
  } else {
    videoMeta.textContent = `${width}×${height} · v210 10-bit`;
  }
});

function updateGpuStatus(result) {
  const detail = result?.ready
    ? ` acceleration ${result.hardwareAccelerationEnabled ? "on" : "off"} · compositor ${result.gpuCompositing} · v210 analysis CPU`
    : " status not available yet";
  const label = document.createElement("strong");
  label.textContent = "Electron GPU:";
  gpuStatusLabel.replaceChildren(label, document.createTextNode(detail));
}

window.decklink.onGpuStatus(updateGpuStatus);
void window.decklink.getGpuStatus().then(updateGpuStatus).catch(() => updateGpuStatus(undefined));

updateAnalysisOptions();
drawRegion();
void refreshDevices();
