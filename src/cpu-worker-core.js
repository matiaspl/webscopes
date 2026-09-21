import { analyzeCapturedPixels, readFramePixelsAsync } from "./analyze.js";

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/** Read back and analyze a worker-owned VideoFrame, then close it on every path. */
export async function analyzeTransferredVideoFrame(frame, options = {}, reusableCapture = {}) {
  const captureStartedAt = now();
  try {
    const pixels = await readFramePixelsAsync(frame, reusableCapture, options);
    const captureTimeMs = Math.max(0, now() - captureStartedAt);
    const analysisStartedAt = now();
    const result = analyzeCapturedPixels(pixels, options);
    const analysisTimeMs = Math.max(0, now() - analysisStartedAt);
    return {
      result,
      captureTimeMs,
      analysisTimeMs,
      captureBytes: pixels.capturedByteLength ?? pixels.data?.byteLength ?? 0,
      captureUsedRoi: pixels.captureUsedRoi ?? false,
    };
  } finally {
    try { frame?.close?.(); } catch {}
  }
}
