import { analyzeCapturedPixels, analyzeFrame, captureFrameToCanvas, getSourceSize, isRawPixelFrame, isV210Frame, normalizeAnalysisOptions, readFramePixelsAsync } from "./analyze.js";
import { renderScopes } from "./render.js";
import { generateTestSignalSlate, TEST_SIGNAL_COLOR_MATRICES, TEST_SIGNAL_COLOR_RANGES, TEST_SIGNAL_PATTERNS } from "./slates.js";
import { createWebGpuAnalyzer } from "./webgpu.js";
import { createCpuWorkerClient } from "./cpu-worker-client.js";

export { createScopeDisplay } from "./webgpu.js";

const VIDEO_TEXTURE_MODES = new Set(["auto", "copy", "external"]);

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function elapsedSince(startedAt) {
  return Math.max(0, monotonicNow() - startedAt);
}

export {
  analyzeFrame,
  generateTestSignalSlate,
  renderScopes,
  TEST_SIGNAL_COLOR_MATRICES,
  TEST_SIGNAL_COLOR_RANGES,
  TEST_SIGNAL_PATTERNS,
};

/** Create a real-time analyzer. WebGPU is preferred when available; CPU is universal. */
export async function createScopes(options = {}) {
  const requestedBackend = options.backend ?? "auto";
  if (!["auto", "webgpu", "cpu"].includes(requestedBackend)) {
    throw new RangeError(`Unsupported backend: ${requestedBackend}`);
  }
  const videoTextureMode = options.videoTextureMode ?? "auto";
  if (!VIDEO_TEXTURE_MODES.has(videoTextureMode)) {
    throw new RangeError(`Unsupported video texture mode: ${videoTextureMode}`);
  }

  let gpuAnalyzer;
  let backend = "cpu";
  if (requestedBackend !== "cpu") {
    try {
      // Browser external-video imports can apply a different color conversion
      // from CPU readback. Normalize through an sRGB canvas unless opted in.
      const useExternalVideoTextures = videoTextureMode === "external";
      gpuAnalyzer = await createWebGpuAnalyzer({ ...options, useExternalVideoTextures });
      backend = "webgpu";
    } catch (error) {
      if (requestedBackend === "webgpu") throw error;
      options.onWarning?.(`WebGPU unavailable; using CPU analysis. ${error.message}`);
    }
  }

  let destroyed = false;
  let currentResult;
  let currentUpdate;
  let averageFrameTimeMs;
  let canvas = options.canvas;
  let renderingDisabled = false;
  let renderWarningReported = false;
  const cpuCapture = {};
  const browserSourceCapture = {};
  const cpuWorker = createCpuWorkerClient();
  let workerWarningReported = false;

  function releaseCpuCapture() {
    cpuCapture.canvas = undefined;
    cpuCapture.context = undefined;
    cpuCapture.data = undefined;
    cpuCapture.videoFrameReadback = undefined;
    cpuCapture.videoFramePixelFormat = undefined;
    cpuCapture.videoFrameRoiCapture = undefined;
    browserSourceCapture.canvas = undefined;
    browserSourceCapture.context = undefined;
  }

  function update(frame, analysisOptions = {}) {
    if (destroyed) return Promise.reject(new Error("Scope analyzer has been destroyed"));
    // Live monitoring should show the newest frame, not build a queue of stale frames.
    if (currentUpdate) return currentUpdate;
    const task = (async () => {
      const startedAt = monotonicNow();
      const timing = { captureTimeMs: 0, analysisTimeMs: 0 };
      const measureSync = (stage, operation) => {
        const stageStartedAt = monotonicNow();
        try {
          return operation();
        } finally {
          timing[stage] += elapsedSince(stageStartedAt);
        }
      };
      const measureAsync = async (stage, operation) => {
        const stageStartedAt = monotonicNow();
        try {
          return await operation();
        } finally {
          timing[stage] += elapsedSince(stageStartedAt);
        }
      };
      const mergedOptions = { ...options, ...analysisOptions };
      const rawPixels = isRawPixelFrame(frame);
      const useGpu = backend === "webgpu" && (!rawPixels || isV210Frame(frame));
      const frameOptions = rawPixels
        ? {
          ...mergedOptions,
          bitDepth: isV210Frame(frame) ? (mergedOptions.bitDepth ?? 10) : mergedOptions.bitDepth,
          colorMatrix: mergedOptions.colorMatrix ?? frame.colorMatrix,
          colorRange: mergedOptions.colorRange ?? frame.colorRange,
        }
        : { ...mergedOptions, bitDepth: mergedOptions.bitDepth ?? 8 };
      const { width, height } = rawPixels ? frame : getSourceSize(frame);
      normalizeAnalysisOptions(width, height, frameOptions);
      let frameBackend = useGpu ? "webgpu" : "cpu";
      let nextResult;
      let captureBytes;
      let captureUsedRoi;
      let analysisSource = frame;
      let ownsAnalysisSource = false;
      let sharedCanvasCapture;
      const isVideoFrame = typeof globalThis.VideoFrame === "function" && frame instanceof globalThis.VideoFrame;
      const isVideoSource = (typeof globalThis.HTMLVideoElement === "function" && frame instanceof globalThis.HTMLVideoElement)
        || frame?.nodeName === "VIDEO"
        || frame?.tagName === "VIDEO"
        || (Number.isFinite(frame?.videoWidth) && Number.isFinite(frame?.videoHeight) && Number.isFinite(frame?.currentTime));
      const isVideoInput = isVideoFrame || isVideoSource;
      const copyVideoToReusableCanvas = useGpu && gpuAnalyzer.videoTextureMode === "copy" && isVideoInput;
      if (!rawPixels && copyVideoToReusableCanvas) {
        try {
          const browserSource = measureSync("captureTimeMs", () => captureFrameToCanvas(frame, browserSourceCapture, { willReadFrequently: false, colorSpace: "srgb" }));
          analysisSource = browserSource.canvas;
        } catch {
          // Keep the browser source when a canvas snapshot is unavailable.
        }
      } else if (!rawPixels && typeof globalThis.VideoFrame === "function" && !isVideoFrame
        && !(cpuWorker.available && !useGpu)) {
        try {
          analysisSource = measureSync("captureTimeMs", () => new globalThis.VideoFrame(frame, { timestamp: 0 }));
          ownsAnalysisSource = true;
        } catch {
          // Keep the original source when this browser cannot snapshot it as a VideoFrame.
        }
      }
      if (!rawPixels && !copyVideoToReusableCanvas && !ownsAnalysisSource && !isVideoFrame && !(useGpu && isVideoSource)
        && !(cpuWorker.available && !useGpu)) {
        try {
          const browserSource = measureSync("captureTimeMs", () => captureFrameToCanvas(frame, browserSourceCapture, { willReadFrequently: false, colorSpace: "srgb" }));
          sharedCanvasCapture = measureSync("captureTimeMs", () => captureFrameToCanvas(browserSource.canvas, cpuCapture, { willReadFrequently: false, colorSpace: "srgb" }));
          analysisSource = sharedCanvasCapture.canvas;
        } catch {
          // Keep the original source when the browser cannot capture it to a canvas.
        }
      }
      const analyzeCpu = async (source) => {
        if (!rawPixels && cpuWorker.available) {
          try {
            const response = await cpuWorker.analyze(source, frameOptions);
            timing.captureTimeMs += (response.snapshotTimeMs ?? 0) + (response.captureTimeMs ?? 0);
            timing.analysisTimeMs += response.analysisTimeMs ?? 0;
            captureBytes = response.captureBytes;
            captureUsedRoi = response.captureUsedRoi;
            return response.result;
          } catch (error) {
            if (destroyed) throw new Error("Scope analyzer has been destroyed");
            cpuWorker.disable(error);
            if (!workerWarningReported) {
              workerWarningReported = true;
              options.onWarning?.(`CPU VideoFrame worker unavailable; using main-thread analysis. ${error.message}`);
            }
          }
        }
        const pixels = sharedCanvasCapture
          ? measureSync("captureTimeMs", () => sharedCanvasCapture.context.getImageData(0, 0, sharedCanvasCapture.width, sharedCanvasCapture.height))
          : await measureAsync("captureTimeMs", () => readFramePixelsAsync(source, cpuCapture, frameOptions));
        if (!rawPixels) {
          captureBytes = pixels.capturedByteLength ?? pixels.data?.byteLength;
          captureUsedRoi = pixels.captureUsedRoi ?? false;
        }
        return measureSync("analysisTimeMs", () => analyzeCapturedPixels(pixels, frameOptions));
      };
      try {
        if (useGpu) {
          try {
            nextResult = await measureAsync("analysisTimeMs", () => isV210Frame(frame)
              ? gpuAnalyzer.analyzeV210(frame, frameOptions)
              : isVideoInput
                ? gpuAnalyzer.analyzeVideo(analysisSource, frameOptions)
                : gpuAnalyzer.analyze(analysisSource, frameOptions));
          } catch (error) {
            if (destroyed) throw new Error("Scope analyzer has been destroyed");
            if (requestedBackend !== "auto" || backend !== "webgpu") throw error;
            options.onWarning?.(`WebGPU frame analysis failed; switching to CPU. ${error.message}`);
            gpuAnalyzer.destroy();
            gpuAnalyzer = undefined;
            backend = "cpu";
            frameBackend = "cpu";
            nextResult = await analyzeCpu(analysisSource);
          }
        } else {
          nextResult = await analyzeCpu(analysisSource);
        }
      } finally {
        if (ownsAnalysisSource) analysisSource.close();
      }
      if (destroyed) throw new Error("Scope analyzer has been destroyed");
      // Legacy frame timing intentionally ends after capture and analysis, before rendering.
      const frameTimeMs = elapsedSince(startedAt);
      averageFrameTimeMs = averageFrameTimeMs === undefined
        ? frameTimeMs
        : averageFrameTimeMs + (frameTimeMs - averageFrameTimeMs) * 0.2;
      const fps = frameTimeMs > 0 ? 1000 / frameTimeMs : 0;
      const averageFps = averageFrameTimeMs > 0 ? 1000 / averageFrameTimeMs : 0;
      nextResult = {
        ...nextResult,
        stats: {
          ...nextResult.stats,
          ...(isVideoInput && frameBackend === "webgpu" ? { videoColorMode: nextResult.stats.videoColorMode ?? "canvas" } : {}),
          performance: {
            backend: frameBackend,
            frameTimeMs,
            fps,
            averageFrameTimeMs,
            averageFps,
            captureTimeMs: timing.captureTimeMs,
            analysisTimeMs: timing.analysisTimeMs,
            renderTimeMs: 0,
            updateTimeMs: 0,
            captureBytes,
            captureUsedRoi,
          },
        },
      };
      if (destroyed) throw new Error("Scope analyzer has been destroyed");
      let renderTimeMs = 0;
      if (canvas && (options.autoRender ?? true) && !renderingDisabled) {
        const renderStartedAt = monotonicNow();
        try {
          renderScopes(nextResult, canvas, options.renderOptions);
        } catch (error) {
          // A browser can fail a large ImageData allocation after a long live
          // run even though the histogram result is still valid. Keep analysis
          // alive and report the display failure once instead of stopping the
          // stream on a rendering-only allocation error.
          if (!/array buffer allocation failed|memory allocation|out of memory/i.test(error?.message ?? "")) throw error;
          renderingDisabled = true;
          if (!renderWarningReported) {
            renderWarningReported = true;
            options.onWarning?.(`Scope display disabled after a canvas allocation failure; analysis continues. ${error.message}`);
          }
        } finally {
          renderTimeMs = elapsedSince(renderStartedAt);
        }
      }
      if (destroyed) throw new Error("Scope analyzer has been destroyed");
      nextResult = {
        ...nextResult,
        stats: {
          ...nextResult.stats,
          performance: {
            ...nextResult.stats.performance,
            renderTimeMs,
            updateTimeMs: elapsedSince(startedAt),
          },
        },
      };
      currentResult = nextResult;
      return nextResult;
    })();
    currentUpdate = task.finally(() => { currentUpdate = undefined; });
    return currentUpdate;
  }

  return {
    get backend() { return backend; },
    get videoTextureMode() { return gpuAnalyzer?.videoTextureMode; },
    get result() { return currentResult; },
    get canvas() { return canvas; },
    set canvas(value) { canvas = value; },
    update,
    render(renderOptions = {}) {
      if (!currentResult) throw new Error("Analyze a frame before rendering scopes");
      if (!canvas) throw new Error("No canvas was supplied");
      return renderScopes(currentResult, canvas, { ...options.renderOptions, ...renderOptions });
    },
    renderFrame(frame, analysisOptions) {
      return update(frame, analysisOptions);
    },
    destroy() {
      destroyed = true;
      cpuWorker.destroy();
      gpuAnalyzer?.destroy();
      gpuAnalyzer = undefined;
      currentResult = undefined;
      canvas = undefined;
      releaseCpuCapture();
      if (currentUpdate) void currentUpdate.then(releaseCpuCapture, releaseCpuCapture);
    },
  };
}

export const createVideoScopes = createScopes;

export const WaveformMode = Object.freeze({
  RGB: "rgb",
  RGB_PARADE: "rgb-parade",
  LUMA: "luma",
  YCBCR_PARADE: "ycbcr-parade",
  COMPOSITE: "composite",
});

export const ColorMatrix = Object.freeze({
  BT601: "bt601",
  BT709: "bt709",
  BT2020: "bt2020",
  BT2100: "bt2100",
});

export function getDefaultScopesConfig() {
  return {
    backend: "auto",
    waveformMode: WaveformMode.RGB_PARADE,
    vectorscopeSize: 256,
    colorMatrix: ColorMatrix.BT709,
    inputResolutionScaling: 1,
    region: { x: 0, y: 0, width: 1, height: 1 },
  };
}
