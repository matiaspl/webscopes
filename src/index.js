import { analyzeFrame, captureFrameToCanvas, getSourceSize, isRawPixelFrame, normalizeAnalysisOptions, readFramePixelsAsync } from "./analyze.js";
import { renderScopes } from "./render.js";
import { generateTestSignalSlate, TEST_SIGNAL_COLOR_MATRICES, TEST_SIGNAL_COLOR_RANGES, TEST_SIGNAL_PATTERNS } from "./slates.js";
import { createWebGpuAnalyzer } from "./webgpu.js";

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

  let gpuAnalyzer;
  let backend = "cpu";
  if (requestedBackend !== "cpu") {
    try {
      gpuAnalyzer = await createWebGpuAnalyzer(options);
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

  function releaseCpuCapture() {
    cpuCapture.canvas = undefined;
    cpuCapture.context = undefined;
    cpuCapture.data = undefined;
    cpuCapture.videoFrameReadback = undefined;
    browserSourceCapture.canvas = undefined;
    browserSourceCapture.context = undefined;
  }

  function update(frame, analysisOptions = {}) {
    if (destroyed) return Promise.reject(new Error("Scope analyzer has been destroyed"));
    // Live monitoring should show the newest frame, not build a queue of stale frames.
    if (currentUpdate) return currentUpdate;
    const task = (async () => {
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const mergedOptions = { ...options, ...analysisOptions };
      const rawPixels = isRawPixelFrame(frame);
      const useGpu = backend === "webgpu" && !rawPixels;
      const frameOptions = rawPixels ? mergedOptions : { ...mergedOptions, bitDepth: mergedOptions.bitDepth ?? 8 };
      const { width, height } = rawPixels ? frame : getSourceSize(frame);
      normalizeAnalysisOptions(width, height, frameOptions);
      let frameBackend = useGpu ? "webgpu" : "cpu";
      let nextResult;
      let analysisSource = frame;
      let ownsAnalysisSource = false;
      let sharedCanvasCapture;
      let sharedPixelSource;
      const isVideoFrame = typeof globalThis.VideoFrame === "function" && frame instanceof globalThis.VideoFrame;
      const isVideoSource = (typeof globalThis.HTMLVideoElement === "function" && frame instanceof globalThis.HTMLVideoElement)
        || frame?.nodeName === "VIDEO"
        || frame?.tagName === "VIDEO"
        || (Number.isFinite(frame?.videoWidth) && Number.isFinite(frame?.videoHeight) && Number.isFinite(frame?.currentTime));
      if (!rawPixels && useGpu && isVideoSource) {
        try {
          sharedPixelSource = await readFramePixelsAsync(frame, cpuCapture);
          analysisSource = sharedPixelSource;
        } catch {
          // Keep the browser source when a video cannot be read back as RGBA.
        }
      }
      if (!rawPixels && !sharedPixelSource && typeof globalThis.VideoFrame === "function" && !isVideoFrame) {
        try {
          analysisSource = new globalThis.VideoFrame(frame, { timestamp: 0 });
          ownsAnalysisSource = true;
        } catch {
          // Keep the original source when this browser cannot snapshot it as a VideoFrame.
        }
      }
      if (!rawPixels && !sharedPixelSource && !ownsAnalysisSource && !isVideoFrame) {
        try {
          const browserSource = captureFrameToCanvas(frame, browserSourceCapture, { willReadFrequently: false, colorSpace: "srgb" });
          sharedCanvasCapture = captureFrameToCanvas(browserSource.canvas, cpuCapture, { willReadFrequently: false, colorSpace: "srgb" });
          analysisSource = sharedCanvasCapture.canvas;
        } catch {
          // Keep the original source when the browser cannot capture it to a canvas.
        }
      }
      try {
        if (useGpu) {
          try {
            nextResult = await gpuAnalyzer.analyze(analysisSource, frameOptions);
          } catch (error) {
            if (destroyed) throw new Error("Scope analyzer has been destroyed");
            if (requestedBackend !== "auto" || backend !== "webgpu") throw error;
            options.onWarning?.(`WebGPU frame analysis failed; switching to CPU. ${error.message}`);
            gpuAnalyzer.destroy();
            gpuAnalyzer = undefined;
            backend = "cpu";
            frameBackend = "cpu";
            nextResult = analyzeFrame(
              sharedPixelSource
                ?? (sharedCanvasCapture
                  ? sharedCanvasCapture.context.getImageData(0, 0, sharedCanvasCapture.width, sharedCanvasCapture.height)
                  : await readFramePixelsAsync(analysisSource, cpuCapture)),
              frameOptions,
            );
          }
        } else {
          nextResult = analyzeFrame(
            sharedPixelSource
              ?? (sharedCanvasCapture
                ? sharedCanvasCapture.context.getImageData(0, 0, sharedCanvasCapture.width, sharedCanvasCapture.height)
                : await readFramePixelsAsync(analysisSource, cpuCapture)),
            frameOptions,
          );
        }
      } finally {
        if (ownsAnalysisSource) analysisSource.close();
      }
      if (destroyed) throw new Error("Scope analyzer has been destroyed");
      const frameTimeMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
      averageFrameTimeMs = averageFrameTimeMs === undefined
        ? frameTimeMs
        : averageFrameTimeMs + (frameTimeMs - averageFrameTimeMs) * 0.2;
      const fps = frameTimeMs > 0 ? 1000 / frameTimeMs : 0;
      const averageFps = averageFrameTimeMs > 0 ? 1000 / averageFrameTimeMs : 0;
      nextResult = {
        ...nextResult,
        stats: {
          ...nextResult.stats,
          performance: { backend: frameBackend, frameTimeMs, fps, averageFrameTimeMs, averageFps },
        },
      };
      if (destroyed) throw new Error("Scope analyzer has been destroyed");
      currentResult = nextResult;
      if (canvas && (options.autoRender ?? true) && !renderingDisabled) {
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
        }
      }
      return nextResult;
    })();
    currentUpdate = task.finally(() => { currentUpdate = undefined; });
    return currentUpdate;
  }

  return {
    get backend() { return backend; },
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
