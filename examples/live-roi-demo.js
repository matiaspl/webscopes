import { createScopes, generateTestSignalSlate } from "../src/index.js";
import { bindRoiSelection, createFramePacer, createRoiRefreshScheduler, createRoiSelectionController, regionForPreset } from "./roi-controls.js";

const DEMO_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const SAGRADA_VIDEO_API = "https://api-media.ccma.cat/pvideo/media.jsp?media=video&versio=vast&idint=6409478&profile=pc_3cat&format=dm";
const YOUTUBE_SOURCE = "https://www.youtube.com/watch?v=odBWmbca9sc";
const DEMO_RENDER_OPTIONS = Object.freeze({ dither: 0, vectorscopeDither: 0 });
const video = document.querySelector("#video");
const slatePreview = document.querySelector("#slate-preview");
const stage = document.querySelector("#stage");
const roiBox = document.querySelector("#roi-box");
const scopeCanvas = document.querySelector("#scope");
const scopeCanvasHome = scopeCanvas.parentElement;
const scopePanel = scopeCanvas.closest(".panel");
const status = document.querySelector("#status");
const videoMeta = document.querySelector("#video-meta");
const roiMeta = document.querySelector("#roi-meta");
const playButton = document.querySelector("#play");
const backButton = document.querySelector("#back-10");
const forwardButton = document.querySelector("#forward-10");
const muteButton = document.querySelector("#mute");
const seek = document.querySelector("#seek");
const time = document.querySelector("#time");
const cameraButton = document.querySelector("#camera");
const chooseFileButton = document.querySelector("#choose-file");
const shareScreenButton = document.querySelector("#share-screen");
const fileInput = document.querySelector("#file-input");
const backendSelect = document.querySelector("#backend");
const matrixSelect = document.querySelector("#matrix");
const rangeSelect = document.querySelector("#range");
const waveformSelect = document.querySelector("#waveform");
const probeResolutionSelect = document.querySelector("#probe-resolution");
const sourceInput = document.querySelector("#source");
const sourceLabel = document.querySelector("#source-label");
const contentSelect = document.querySelector("#content");
const contentTag = document.querySelector("#content-tag");
const sourceCredit = document.querySelector("#source-credit");
const sourceNote = document.querySelector("#source-note");
const sourceNoteCopy = document.querySelector("#source-note-copy");
const colorLegend = document.querySelector("#color-legend");
const waveformLabel = document.querySelector("#waveform-label");
const popoutButton = document.querySelector("#popout-scopes");

let region = { x: 0, y: 0, width: 1, height: 1 };
let scopes;
let hls;
let dashPlayer;
let videoFrameCallback;
let animationFrame;
let activeAnalysis;
let activeAnalysisRegionRevision;
let activeAnalysisScopes;
let lastFallbackTime = -1;
const framePacer = createFramePacer();
let activeFileUrl;
let activeSlate;
let displayStream;
let nativeSourceAbortController;
let pageIsClosing = false;
let scopeGeneration = 0;
let streamGeneration = 0;
let popoutWindow;
let backend = new URLSearchParams(location.search).get("backend") ?? "auto";
let probeResolution = Number(probeResolutionSelect.value);

if (!["auto", "cpu", "webgpu"].includes(backend)) backend = "auto";
backendSelect.value = backend;
contentSelect.value = "bbb";
sourceInput.value = DEMO_STREAM;

const DEMO_CONTENT = {
  bbb: {
    transport: "hls",
    badge: "HLS · BIG BUCK BUNNY",
    source: DEMO_STREAM,
    sourceLabel: "HLS",
  },
  sagrada: {
    transport: "dash",
    badge: "3CAT DASH · SAGRADA FAMÍLIA · HDR UNKNOWN",
    source: SAGRADA_VIDEO_API,
    sourceLabel: "DASH",
  },
  "slate-smpte": {
    transport: "slate",
    badge: "INTERNAL · SMPTE RP 219-1",
    pattern: "smpte",
    sourceLabel: "SLATE",
  },
  "slate-ebu": {
    transport: "slate",
    badge: "INTERNAL · EBU TECH 3373 HLG",
    pattern: "ebu",
    sourceLabel: "SLATE",
  },
  "slate-arib": {
    transport: "slate",
    badge: "INTERNAL · ARIB STD-B28",
    pattern: "arib",
    sourceLabel: "SLATE",
  },
  "slate-diagnostic": {
    transport: "slate",
    badge: "INTERNAL · CUSTOM DIAGNOSTIC SLATE",
    pattern: "diagnostic",
    sourceLabel: "SLATE",
  },
};

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function playbackWindow() {
  if (Number.isFinite(video.duration) && video.duration > 0) return { start: 0, end: video.duration };
  if (video.seekable?.length) {
    const last = video.seekable.length - 1;
    return { start: video.seekable.start(0), end: video.seekable.end(last) };
  }
  return undefined;
}

function updatePlaybackControls() {
  if (activeSlate) {
    seek.disabled = true;
    backButton.disabled = true;
    forwardButton.disabled = true;
    time.textContent = "STATIC SLATE";
    return;
  }
  const range = playbackWindow();
  const canSeek = range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start;
  seek.disabled = !canSeek;
  backButton.disabled = !canSeek;
  forwardButton.disabled = !canSeek;
  if (canSeek) {
    const current = Math.max(range.start, Math.min(range.end, video.currentTime));
    seek.value = String(Math.round((current - range.start) / (range.end - range.start) * 1000));
    time.textContent = `${formatTime(current)} / ${formatTime(range.end)}`;
  } else {
    time.textContent = video.srcObject
      ? `${formatTime(video.currentTime)} / LIVE`
      : `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }
}

function seekBy(seconds) {
  const range = playbackWindow();
  if (!range) return;
  video.currentTime = Math.max(range.start, Math.min(range.end, video.currentTime + seconds));
}

function releaseCurrentSource() {
  nativeSourceAbortController?.abort();
  nativeSourceAbortController = undefined;
  hls?.destroy();
  hls = undefined;
  dashPlayer?.destroy();
  dashPlayer = undefined;
  displayStream = undefined;
  const stream = video.srcObject;
  if (stream && typeof stream.getTracks === "function") {
    for (const track of stream.getTracks()) track.stop();
  }
  video.pause();
  slatePreview.hidden = true;
  video.hidden = false;
  activeSlate = undefined;
  updateColorLegend();
  playButton.disabled = false;
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
  if (activeFileUrl) URL.revokeObjectURL(activeFileUrl);
  activeFileUrl = undefined;
  framePacer.reset();
  lastFallbackTime = -1;
  shareScreenButton.textContent = "Capture tab / window / screen";
  shareScreenButton.disabled = false;
  updatePlaybackControls();
}

function contentRect() {
  const box = stage.getBoundingClientRect();
  const sourceWidth = activeSlate?.preview.width ?? (video.videoWidth || 16);
  const sourceHeight = activeSlate?.preview.height ?? (video.videoHeight || 9);
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
  const options = { inputResolutionScaling: probeResolution, waveformMode: waveformSelect.value };
  if (matrixSelect.value) options.colorMatrix = matrixSelect.value;
  else if (activeSlate?.nativeColorMatrix) options.colorMatrix = activeSlate.nativeColorMatrix;
  if (rangeSelect.value) options.colorRange = rangeSelect.value;
  else if (activeSlate?.nativeColorRange) options.colorRange = activeSlate.nativeColorRange;
  return options;
}

function probeResolutionLabel() {
  return probeResolution === 1 ? "100% native probe" : `${Math.round(probeResolution * 100)}% sparse probe`;
}

function updateColorLegend() {
  const nativeMatrix = activeSlate?.nativeColorMatrix?.toUpperCase().replace("BT", "BT.");
  const matrix = matrixSelect.value ? matrixSelect.selectedOptions[0].textContent : nativeMatrix ? `${nativeMatrix} NATIVE` : "BT.709 default";
  const range = rangeSelect.value ? rangeSelect.selectedOptions[0].textContent.toUpperCase() : activeSlate?.nativeColorRange?.toUpperCase() ?? "AUTO RANGE";
  waveformLabel.textContent = waveformSelect.selectedOptions[0].textContent.toUpperCase();
  colorLegend.textContent = `${matrix} · ${range} · DISPLAY DITHER 0 · VECTOR DITHER 0`;
}

function resetPopoutState() {
  popoutWindow = undefined;
  popoutButton.textContent = "Pop out scopes";
}

function restoreScopeCanvas() {
  if (scopeCanvas.parentElement !== scopeCanvasHome) scopeCanvasHome.append(scopeCanvas);
  scopePanel.hidden = false;
}

function handlePopoutClosed() {
  restoreScopeCanvas();
  resetPopoutState();
}

function closePopout() {
  const current = popoutWindow;
  restoreScopeCanvas();
  resetPopoutState();
  if (current && !current.closed) current.close();
}

function openPopout() {
  if (popoutWindow && !popoutWindow.closed) {
    popoutWindow.focus();
    return;
  }
  if (popoutWindow?.closed) {
    restoreScopeCanvas();
    resetPopoutState();
  }
  const nextWindow = window.open("", "webscopes-scopes", "popup,width=1200,height=700,resizable=yes");
  if (!nextWindow) {
    setStatus("The scopes pop-out was blocked by the browser. Allow pop-ups for this demo and try again.", "error");
    return;
  }
  nextWindow.document.title = "webscopes · scopes";
  nextWindow.document.body.innerHTML = `
    <style>
      :root { color-scheme: dark; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #080d13; color: #a9bbc9; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #080d13; }
      header { height: 34px; display: flex; align-items: center; padding: 0 12px; color: #77f2c0; letter-spacing: .08em; }
      #scope-host { height: calc(100% - 34px); display: flex; align-items: center; justify-content: center; overflow: hidden; }
      #scope { display: block; width: 100%; height: auto; border-radius: 0; }
    </style>
    <header>WEBSCOPES · LIVE SCOPES · DISPLAY DITHER 0 · VECTOR DITHER 0</header>
    <div id="scope-host" aria-label="Popped out waveform and vectorscope"></div>`;
  nextWindow.document.querySelector("#scope-host").append(scopeCanvas);
  scopePanel.hidden = true;
  nextWindow.addEventListener("pagehide", handlePopoutClosed, { once: true });
  popoutWindow = nextWindow;
  popoutButton.textContent = "Close scopes pop-out";
  popoutWindow.focus();
}

const roiSelection = createRoiSelectionController({
  getRegion: () => region,
  setRegion(value) { region = value; },
  drawRegion,
  onCommit: scheduleRegionRefresh,
});
bindRoiSelection(stage, roiSelection, pointToSource);

document.querySelectorAll("[data-region]").forEach((button) => {
  button.addEventListener("click", () => {
    region = regionForPreset(button.dataset.region);
    drawRegion();
    scheduleRegionRefresh();
  });
});

async function configureScopes(nextBackend) {
  const generation = ++scopeGeneration;
  scopes?.destroy();
  scopes = undefined;
  backend = nextBackend;
  try {
    const nextScopes = await createScopes({
      canvas: scopeCanvas,
      backend,
      waveformMode: waveformSelect.value,
      waveformWidth: 480,
      waveformHeight: 512,
      vectorscopeSize: 256,
      inputResolutionScaling: probeResolution,
      renderOptions: DEMO_RENDER_OPTIONS,
      onWarning(message) {
        if (!pageIsClosing && generation === scopeGeneration) setStatus(message);
      },
    });
    if (generation !== scopeGeneration) {
      nextScopes.destroy();
      return;
    }
    scopes = nextScopes;
    videoMeta.textContent = `${scopes.backend.toUpperCase()} · waiting for video`;
    if (activeSlate || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (roiRefresh.pending) roiRefresh.resume();
      else analyzeCurrentFrame();
    }
  } catch (error) {
    if (generation !== scopeGeneration) return;
    videoMeta.textContent = "Backend unavailable";
    setStatus(`${error.message} — choose Auto or CPU to continue.`, "error");
  }
}

function analyzeCurrentFrame(mediaTime = video.currentTime, frameToken = mediaTime) {
  if (pageIsClosing || !scopes || (!activeSlate && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) return undefined;
  if (activeAnalysis && activeAnalysisScopes === scopes) {
    return { promise: activeAnalysis, regionRevision: activeAnalysisRegionRevision };
  }
  const activeScopes = scopes;
  const usedStreamGeneration = streamGeneration;
  const usedRegionRevision = roiRefresh.revision;
  if (!framePacer.shouldAnalyze(frameToken, usedRegionRevision, activeScopes)) return undefined;
  const usedRegion = { ...region };
  const source = activeSlate?.frame ?? video;
  const tracked = activeScopes.update(source, { ...currentAnalysisOptions(), region: usedRegion }).then((result) => {
    if (pageIsClosing || scopes !== activeScopes || streamGeneration !== usedStreamGeneration) return;
    const perf = result.stats.performance;
    const width = activeSlate?.frame.width ?? video.videoWidth;
    const height = activeSlate?.frame.height ?? video.videoHeight;
    videoMeta.textContent = `${perf.backend.toUpperCase()} · ${width}×${height} · ${probeResolutionLabel()} · ${perf.averageFps.toFixed(0)} scope FPS`;
  }).catch((error) => {
    if (!pageIsClosing && scopes === activeScopes && streamGeneration === usedStreamGeneration) setStatus(`Scope analysis stopped: ${error.message}`, "error");
  }).finally(() => {
    if (activeAnalysis === tracked) {
      activeAnalysis = undefined;
      activeAnalysisScopes = undefined;
      activeAnalysisRegionRevision = undefined;
    }
  });
  activeAnalysis = tracked;
  activeAnalysisScopes = activeScopes;
  activeAnalysisRegionRevision = usedRegionRevision;
  return { promise: tracked, regionRevision: usedRegionRevision };
}

const roiRefresh = createRoiRefreshScheduler({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frame) => cancelAnimationFrame(frame),
  run: analyzeCurrentFrame,
});

function scheduleRegionRefresh() {
  if (!pageIsClosing) roiRefresh.schedule();
}

function scheduleAnalysis() {
  if (pageIsClosing) return;
  if (activeSlate) {
    analyzeCurrentFrame("slate", `slate:${streamGeneration}`);
    return;
  }
  if (video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (video.requestVideoFrameCallback) {
    if (videoFrameCallback !== undefined) return;
    videoFrameCallback = video.requestVideoFrameCallback((_now, metadata) => {
      videoFrameCallback = undefined;
      const mediaTime = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : video.currentTime;
      // Live sources can report a coarse or unchanged mediaTime. presentedFrames
      // identifies each displayed frame and keeps measurements running.
      const frameToken = Number.isFinite(metadata?.presentedFrames) ? metadata.presentedFrames : mediaTime;
      analyzeCurrentFrame(mediaTime, frameToken);
      scheduleAnalysis();
    });
    return;
  }
  if (animationFrame !== undefined) return;
  animationFrame = requestAnimationFrame(() => {
    animationFrame = undefined;
    if (!pageIsClosing && !video.paused && video.currentTime !== lastFallbackTime) {
      lastFallbackTime = video.currentTime;
      analyzeCurrentFrame();
    }
    scheduleAnalysis();
  });
}

function prepareSource(content) {
  sourceLabel.textContent = content.sourceLabel;
  contentTag.textContent = content.badge;
  sourceCredit.hidden = content.transport !== "dash";
  sourceCredit.href = YOUTUBE_SOURCE;
  sourceNote.hidden = content.transport !== "dash";
  sourceNoteCopy.textContent = content.transport === "dash"
    ? "Scopes analyze 3Cat’s browser-readable AVC stream, up to 1080p. Its public MPD has no HDR transfer tag; the linked YouTube upload is 4K HDR, but its embed does not expose frames to the scopes."
    : "";
}

function slateEncodingOptions(content) {
  const nativeMatrix = content?.pattern === "ebu" ? "bt2100" : "bt709";
  return {
    colorMatrix: matrixSelect.value || nativeMatrix,
    colorRange: rangeSelect.value || "limited",
  };
}

function loadTestSlate(content) {
  const generation = ++streamGeneration;
  releaseCurrentSource();
  const slate = generateTestSignalSlate({ pattern: content.pattern, ...slateEncodingOptions(content) });
  if (generation !== streamGeneration || pageIsClosing) return;
  activeSlate = slate;
  updateColorLegend();
  const context = slatePreview.getContext("2d", { alpha: false });
  slatePreview.width = slate.preview.width;
  slatePreview.height = slate.preview.height;
  context.putImageData(new ImageData(slate.preview.data, slate.preview.width, slate.preview.height), 0, 0);
  slatePreview.hidden = false;
  video.hidden = true;
  sourceLabel.textContent = "SLATE";
  contentTag.textContent = content.badge;
  sourceInput.value = `${slate.label} · v210 · ${slate.colorMatrix.toUpperCase()} · ${slate.colorRange.toUpperCase()}`;
  sourceCredit.hidden = true;
  sourceNote.hidden = true;
  cameraButton.textContent = "Use webcam";
  cameraButton.disabled = false;
  muteButton.disabled = true;
  playButton.disabled = true;
  playButton.textContent = "Static";
  videoMeta.textContent = `CPU · ${slate.frame.width}×${slate.frame.height} · waiting for slate`;
  setStatus(`${slate.label} generated internally as 10-bit v210 · ${slate.colorMatrix.toUpperCase()} · ${slate.colorRange.toUpperCase()}.`);
  updatePlaybackControls();
  drawRegion();
  framePacer.reset();
  const initialAnalysis = analyzeCurrentFrame("slate", `slate:${generation}`);
  // A source switch can overlap an in-flight browser-frame readback. The
  // scopes instance intentionally coalesces such updates, so retry once after
  // the old promise settles to guarantee that the static slate is measured.
  if (initialAnalysis) {
    void initialAnalysis.promise.finally(() => {
      if (!pageIsClosing && activeSlate === slate && streamGeneration === generation) {
        framePacer.reset();
        analyzeCurrentFrame("slate", `slate:${generation}:settled`);
      }
    });
  }
}

async function loadDashStream(content, generation) {
  if (!window.dashjs?.MediaPlayer) {
    setStatus("DASH.js did not load. Check network access and reload the demo.", "error");
    return;
  }

  setStatus("Resolving the public 3Cat on-demand DASH stream…");
  sourceInput.value = "Resolving 3Cat playback URL…";
  try {
    const response = await fetch(content.source);
    if (!response.ok) throw new Error(`3Cat playback API returned HTTP ${response.status}`);
    const metadata = await response.json();
    const manifestUrl = metadata.media?.url?.find((entry) => entry.label === "DASH" && entry.active)?.file
      ?? metadata.media?.url?.find((entry) => entry.label === "DASH")?.file;
    if (!manifestUrl) throw new Error("The 3Cat API did not return a DASH manifest");
    if (generation !== streamGeneration) return;

    sourceInput.value = manifestUrl;
    const activeDash = window.dashjs.MediaPlayer().create();
    dashPlayer = activeDash;
    activeDash.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
      if (generation !== streamGeneration || dashPlayer !== activeDash) return;
      setStatus("3Cat DASH ready · adaptive AVC playback; the MPD has no HDR transfer tag. The YouTube 4K HDR upload is linked above.");
      video.play().then(() => { playButton.textContent = "Pause"; }).catch(() => {});
    });
    activeDash.on(window.dashjs.MediaPlayer.events.ERROR, (event) => {
      if (generation !== streamGeneration || dashPlayer !== activeDash) return;
      const detail = event?.error?.message ?? event?.event?.message ?? "manifest or segment request failed";
      setStatus(`3Cat DASH error: ${detail}. Check the network or reload the stream.`, "error");
    });
    activeDash.initialize(video, manifestUrl, true);
  } catch (error) {
    if (generation === streamGeneration) {
      setStatus(`Could not load the 3Cat stream: ${error.message}`, "error");
    }
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Webcam capture needs a browser with camera support on localhost or HTTPS.", "error");
    return;
  }
  const generation = ++streamGeneration;
  cameraButton.disabled = true;
  setStatus("Waiting for webcam permission…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (generation !== streamGeneration || pageIsClosing) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    releaseCurrentSource();
    contentSelect.value = "";
    sourceLabel.textContent = "CAMERA";
    contentTag.textContent = "WEBCAM · LIVE";
    sourceInput.value = "Webcam stream";
    sourceCredit.hidden = true;
    sourceNote.hidden = true;
    cameraButton.textContent = "Stop camera";
    video.muted = true;
    muteButton.textContent = "Muted";
    muteButton.disabled = true;
    video.srcObject = stream;
    setStatus("Webcam connected. Scope updates follow new camera frames.");
    updatePlaybackControls();
    try {
      await video.play();
    } catch (error) {
      setStatus(`Webcam connected, but playback could not start: ${error.message}`, "error");
    }
  } catch (error) {
    if (generation === streamGeneration) setStatus(`Webcam access failed: ${error.message}`, "error");
  } finally {
    if (generation === streamGeneration) cameraButton.disabled = false;
  }
}

async function startDisplayCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Display capture needs Chrome with screen-sharing support on localhost or HTTPS.", "error");
    return;
  }
  const generation = ++streamGeneration;
  shareScreenButton.disabled = true;
  setStatus("Choose a Chrome tab, window, or screen in the browser picker…");
  try {
    // Keep the constraints intentionally open. Chrome's native picker chooses
    // the tab, window, or screen; the returned MediaStream follows the same
    // video element path as a webcam source.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (generation !== streamGeneration || pageIsClosing) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    releaseCurrentSource();
    displayStream = stream;
    contentSelect.value = "";
    sourceLabel.textContent = "DISPLAY";
    contentTag.textContent = "CHROME · TAB / WINDOW / SCREEN";
    sourceInput.value = "Chrome display capture";
    sourceCredit.hidden = true;
    sourceNote.hidden = true;
    cameraButton.textContent = "Use webcam";
    cameraButton.disabled = false;
    shareScreenButton.textContent = "Stop display capture";
    video.muted = true;
    muteButton.textContent = "Muted";
    muteButton.disabled = true;
    video.srcObject = stream;
    const videoTrack = stream.getVideoTracks()[0];
    videoTrack?.addEventListener("ended", () => {
      if (displayStream !== stream || pageIsClosing) return;
      ++streamGeneration;
      releaseCurrentSource();
      contentSelect.value = "";
      sourceLabel.textContent = "SOURCE";
      contentTag.textContent = "SELECT A SOURCE";
      sourceInput.value = "";
      sourceCredit.hidden = true;
      sourceNote.hidden = true;
      cameraButton.textContent = "Use webcam";
      cameraButton.disabled = false;
      muteButton.disabled = false;
      videoMeta.textContent = "Display capture ended";
      setStatus("Chrome display capture ended. Choose another source.");
    }, { once: true });
    setStatus("Chrome display capture connected. Scope updates follow the selected tab, window, or screen.");
    updatePlaybackControls();
    try {
      await video.play();
    } catch (error) {
      if (generation === streamGeneration && displayStream === stream) {
        setStatus(`Display capture connected, but playback could not start: ${error.message}`, "error");
      }
    }
  } catch (error) {
    if (generation === streamGeneration) setStatus(`Display capture failed: ${error.message}`, "error");
  } finally {
    if (generation === streamGeneration) {
      shareScreenButton.disabled = false;
      cameraButton.disabled = false;
    }
  }
}

function stopDisplayCapture() {
  ++streamGeneration;
  releaseCurrentSource();
  contentSelect.value = "";
  sourceLabel.textContent = "SOURCE";
  contentTag.textContent = "SELECT A SOURCE";
  sourceInput.value = "";
  sourceCredit.hidden = true;
  sourceNote.hidden = true;
  cameraButton.textContent = "Use webcam";
  cameraButton.disabled = false;
  muteButton.disabled = false;
  videoMeta.textContent = "Choose a video source";
  setStatus("Display capture stopped. Choose another video source.");
}

function stopCamera() {
  ++streamGeneration;
  releaseCurrentSource();
  cameraButton.textContent = "Use webcam";
  cameraButton.disabled = false;
  sourceLabel.textContent = "SOURCE";
  contentTag.textContent = "SELECT A SOURCE";
  sourceInput.value = "";
  muteButton.disabled = false;
  videoMeta.textContent = "Choose a video source";
  setStatus("Camera stopped. Choose a demo stream or open a video file.");
}

function loadLocalFile(file) {
  if (!file) return;
  ++streamGeneration;
  releaseCurrentSource();
  contentSelect.value = "";
  sourceLabel.textContent = "FILE";
  contentTag.textContent = "LOCAL VIDEO FILE";
  sourceInput.value = file.name;
  sourceCredit.hidden = true;
  sourceNote.hidden = true;
  cameraButton.textContent = "Use webcam";
  cameraButton.disabled = false;
  muteButton.disabled = false;
  activeFileUrl = URL.createObjectURL(file);
  video.src = activeFileUrl;
  video.load();
  setStatus(`Loaded ${file.name}. Press Play to start playback.`);
}

async function loadStream() {
  const generation = ++streamGeneration;
  const content = DEMO_CONTENT[contentSelect.value] ?? DEMO_CONTENT.bbb;
  releaseCurrentSource();
  cameraButton.textContent = "Use webcam";
  cameraButton.disabled = false;
  muteButton.disabled = false;
  prepareSource(content);
  sourceInput.value = content.transport === "hls" ? content.source : content.transport === "slate" ? "Generating internal v210 slate…" : "Resolving 3Cat playback URL…";

  if (content.transport === "slate") {
    loadTestSlate(content);
    return;
  }

  if (content.transport === "dash") {
    await loadDashStream(content, generation);
    return;
  }

  setStatus("Loading Big Buck Bunny HLS manifest…");

  if (window.Hls?.isSupported()) {
    const activeHls = new window.Hls({ enableWorker: true });
    hls = activeHls;
    activeHls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      if (generation === streamGeneration && hls === activeHls) activeHls.loadSource(content.source);
    });
    activeHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (generation !== streamGeneration || hls !== activeHls) return;
      setStatus("HLS ready · adaptive playback. Press play to begin; probe resolution controls scope sampling.");
      video.play().then(() => { playButton.textContent = "Pause"; }).catch(() => {});
    });
    activeHls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (generation === streamGeneration && hls === activeHls && data.fatal) {
        setStatus(`HLS ${data.type}: ${data.details}. Check the network or reload the stream.`, "error");
      }
    });
    activeHls.attachMedia(video);
    return;
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    const abortController = new AbortController();
    nativeSourceAbortController = abortController;
    video.src = content.source;
    video.addEventListener("loadedmetadata", () => {
      if (generation !== streamGeneration) return;
      setStatus("Native HLS ready. Press play to begin.");
      video.play().then(() => { playButton.textContent = "Pause"; }).catch(() => {});
    }, { once: true, signal: abortController.signal });
    video.addEventListener("error", () => {
      if (generation === streamGeneration) setStatus("Native HLS could not load this stream. Try the demo from localhost or HTTPS.", "error");
    }, { once: true, signal: abortController.signal });
    video.load();
    return;
  }
  setStatus("This browser has no HLS playback support. Try Safari or a browser with Media Source Extensions.", "error");
}

playButton.addEventListener("click", async () => {
  if (activeSlate) return;
  if (video.paused) {
    try { await video.play(); } catch (error) { setStatus(`Playback could not start: ${error.message}`, "error"); }
  } else {
    video.pause();
  }
});

video.addEventListener("play", () => {
  playButton.textContent = "Pause";
  scheduleAnalysis();
});
video.addEventListener("pause", () => {
  playButton.textContent = "Play";
  if (videoFrameCallback !== undefined && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameCallback);
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  videoFrameCallback = undefined;
  animationFrame = undefined;
});
backButton.addEventListener("click", () => seekBy(-10));
forwardButton.addEventListener("click", () => seekBy(10));
muteButton.addEventListener("click", () => {
  video.muted = !video.muted;
  muteButton.textContent = video.muted ? "Muted" : "Sound on";
});
backendSelect.addEventListener("change", () => void configureScopes(backendSelect.value));
probeResolutionSelect.addEventListener("change", () => {
  probeResolution = Number(probeResolutionSelect.value);
  setStatus(`${probeResolutionLabel()} selected; playback quality stays adaptive.`);
  scheduleRegionRefresh();
});
matrixSelect.addEventListener("change", () => {
  updateColorLegend();
  if (activeSlate) loadTestSlate(DEMO_CONTENT[contentSelect.value]);
  else scheduleRegionRefresh();
});
rangeSelect.addEventListener("change", () => {
  updateColorLegend();
  if (activeSlate) loadTestSlate(DEMO_CONTENT[contentSelect.value]);
  else scheduleRegionRefresh();
});
waveformSelect.addEventListener("change", () => {
  updateColorLegend();
  scheduleRegionRefresh();
});
popoutButton.addEventListener("click", () => {
  if (popoutWindow && !popoutWindow.closed) closePopout();
  else openPopout();
});
contentSelect.addEventListener("change", () => {
  if (DEMO_CONTENT[contentSelect.value]) void loadStream();
});
cameraButton.addEventListener("click", () => {
  if (displayStream) void startCamera();
  else if (video.srcObject) stopCamera();
  else void startCamera();
});
shareScreenButton.addEventListener("click", () => {
  if (displayStream) stopDisplayCapture();
  else void startDisplayCapture();
});
chooseFileButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) loadLocalFile(file);
});
document.querySelector("#reload").addEventListener("click", () => void loadStream());

video.addEventListener("loadedmetadata", () => {
  if (activeSlate) return;
  drawRegion();
  videoMeta.textContent = `${video.videoWidth}×${video.videoHeight} · ${scopes?.backend.toUpperCase() ?? "…"}`;
  updatePlaybackControls();
});
video.addEventListener("loadeddata", () => {
  if (activeSlate) return;
  if (roiRefresh.pending) roiRefresh.resume();
  else analyzeCurrentFrame();
  scheduleAnalysis();
});
video.addEventListener("seeked", () => analyzeCurrentFrame());
video.addEventListener("timeupdate", () => {
  updatePlaybackControls();
});
video.addEventListener("durationchange", updatePlaybackControls);
video.addEventListener("progress", updatePlaybackControls);
seek.addEventListener("input", () => {
  const range = playbackWindow();
  if (!range) return;
  video.currentTime = range.start + Number(seek.value) / 1000 * (range.end - range.start);
});
window.addEventListener("resize", drawRegion);
window.addEventListener("pagehide", () => {
  pageIsClosing = true;
  scopeGeneration += 1;
  streamGeneration += 1;
  if (videoFrameCallback !== undefined && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameCallback);
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  roiRefresh.destroy();
  videoFrameCallback = undefined;
  animationFrame = undefined;
  closePopout();
  releaseCurrentSource();
  scopes?.destroy();
});

updateColorLegend();
drawRegion();
await configureScopes(backend);
await loadStream();
