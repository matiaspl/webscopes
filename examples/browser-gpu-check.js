import { analyzeFrame, createScopes, renderScopes } from "../src/index.js";
import { runRoiBrowserChecks } from "./roi-browser-check.js";

const status = document.querySelector("#status");
const DEMO_RENDER_OPTIONS = Object.freeze({ dither: 0, vectorscopeDither: 0 });
const modes = ["rgb", "rgb-parade", "luma", "ycbcr-parade", "composite"];
const matrices = ["bt601", "bt709", "bt2020", "bt2100"];

function makeFixture(name, width, height, pixel, analysis = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const offset = (y * width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return { name, canvas, imageData: context.getImageData(0, 0, width, height), ...analysis };
}

const bars = [
  [235, 235, 235], [235, 235, 16], [16, 235, 235], [16, 235, 16],
  [235, 16, 235], [235, 16, 16], [16, 16, 235],
];
const fixtures = [
  makeFixture("bars-640x360", 640, 360, (x, y) => y < 250
    ? bars[Math.min(bars.length - 1, Math.floor(x * bars.length / 640))]
    : [Math.round(x * 255 / 639), Math.round(x * 255 / 639), Math.round(x * 255 / 639)],
  { options: { inputResolutionScaling: 0.5 } }),
  makeFixture("odd-half-tie-roi-9x7", 9, 7, (x, y) => [
    (x * 31 + y * 17) % 256,
    (x * 7 + y * 43) % 256,
    (x * 59 + y * 13) % 256,
  ], { options: { region: { x: 1 / 9, y: 1 / 7, width: 6 / 9, height: 5 / 7 }, inputResolutionScaling: 0.5 } }),
  makeFixture("neutral-odd-5x3", 5, 3, (x, y) => {
    const value = [0, 32, 128, 235, 255][(x + y * 2) % 5];
    return [value, value, value];
  }),
];

function compareBins(cpu, gpu) {
  let mismatchedBins = 0;
  let totalAbsoluteDifference = 0;
  const details = [];
  const compare = (label, left, right) => {
    if (left.length !== right.length) {
      mismatchedBins += Math.max(left.length, right.length);
      details.push(`${label} length ${left.length} != ${right.length}`);
      return;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) {
        mismatchedBins += 1;
        if (details.length < 12) details.push(`${label}[${i}]: ${left[i]} → ${right[i]}`);
      }
      totalAbsoluteDifference += Math.abs(left[i] - right[i]);
    }
  };
  cpu.waveform.channels.forEach((channel, index) => compare(`wave${index}`, channel, gpu.waveform.channels[index]));
  compare("vector", cpu.vectorscope.bins, gpu.vectorscope.bins);
  return { mismatchedBins, totalAbsoluteDifference, details };
}

function sum(bins) {
  let total = 0;
  for (const count of bins) total += count;
  return total;
}

function histogramBytes(result) {
  return result.waveform.channels.reduce((bytes, channel) => bytes + channel.byteLength, result.vectorscope.bins.byteLength);
}

function summarizeTimes(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

async function benchmark(callback, warmups = 4, samples = 20) {
  let result;
  for (let index = 0; index < warmups; index += 1) result = await callback();
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    result = await callback();
    timings.push(performance.now() - started);
  }
  return { ...summarizeTimes(timings), samples, histogramBytes: histogramBytes(result), result };
}

function checkHighBitDepth(bitDepth) {
  const codeMax = 2 ** bitDepth - 1;
  const result = analyzeFrame({
    data: new Uint16Array([0, 0, 0, codeMax, codeMax, codeMax, codeMax, codeMax]),
    width: 1,
    height: 2,
  }, { bitDepth });
  const red = result.waveform.channels[0];
  return {
    bitDepth,
    passed: result.waveform.height === codeMax + 1 && red[0] === 1 && red[codeMax] === 1,
    waveformLevels: result.waveform.height,
  };
}

function checkCanvasTargetColor(canvas, colorMatrix) {
  const [kr, kb] = colorMatrix === "bt601" ? [0.299, 0.114]
    : colorMatrix === "bt2020" || colorMatrix === "bt2100" ? [0.2627, 0.0593] : [0.2126, 0.0722];
  const width = canvas.width;
  const height = canvas.height;
  const inset = 16;
  const gap = 10;
  const chartWidth = Math.floor((width - inset * 2 - gap) * 0.58);
  const vectorX = inset + chartWidth + gap;
  const vectorY = inset + 22;
  const vectorWidth = width - inset * 2 - chartWidth - gap;
  const vectorHeight = height - inset * 2 - 22;
  const size = Math.min(vectorWidth, vectorHeight);
  const left = vectorX + Math.floor((vectorWidth - size) / 2);
  const top = vectorY + Math.floor((vectorHeight - size) / 2);
  const center = (size - 1) / 2;
  const radius = size * 0.44;
  const redY = kr;
  const cb = (0 - redY) / (2 * (1 - kb));
  const cr = (1 - redY) / (2 * (1 - kr));
  const targetX = left + center + cb * 2 * radius;
  const targetY = top + center - cr * 2 * radius;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let y = Math.floor(targetY) - 2; y <= Math.floor(targetY) + 2; y += 1) {
    for (let x = Math.floor(targetX) - 2; x <= Math.floor(targetX) + 2; x += 1) {
      const pixel = context.getImageData(x, y, 1, 1).data;
      if (pixel[0] === 255 && pixel[1] === 62 && pixel[2] === 72) return true;
    }
  }
  return false;
}

function makePerformanceFixture() {
  return makeFixture("performance-1920x1080", 1920, 1080, (x, y) => [
    (x * 13 + y * 7) % 256,
    (x * 3 + y * 19) % 256,
    (x * 23 + y * 5) % 256,
  ]);
}

async function runBrowserPerformance(cpuScopes, gpuScopes) {
  const fixture = makePerformanceFixture();
  const options = { waveformMode: "rgb-parade", colorMatrix: "bt709", waveformWidth: 1024, waveformHeight: 256, vectorscopeSize: 256 };
  const cpuCanvas = document.createElement("canvas");
  const gpuCanvas = document.createElement("canvas");
  for (const canvas of [cpuCanvas, gpuCanvas]) {
    canvas.width = 960;
    canvas.height = 540;
  }
  cpuScopes.canvas = cpuCanvas;
  gpuScopes.canvas = gpuCanvas;

  const nativeOffscreenCanvas = globalThis.OffscreenCanvas;
  let captureCanvasCreations = 0;
  let captureCanvasCounterAvailable = false;
  try {
    if (typeof nativeOffscreenCanvas === "function") {
      try {
        globalThis.OffscreenCanvas = class CountedOffscreenCanvas extends nativeOffscreenCanvas {
          constructor(...args) {
            super(...args);
            captureCanvasCreations += 1;
          }
        };
        captureCanvasCounterAvailable = true;
      } catch {}
    }
    const cpuAnalysis = await benchmark(() => cpuScopes.update(fixture.canvas, options));
    const gpuAnalysis = await benchmark(() => gpuScopes.update(fixture.canvas, options));
    const cpuRender = await benchmark(() => renderScopes(cpuAnalysis.result, cpuCanvas, DEMO_RENDER_OPTIONS));
    const gpuRender = await benchmark(() => renderScopes(gpuAnalysis.result, gpuCanvas, DEMO_RENDER_OPTIONS));
    const cpuTotal = await benchmark(async () => {
      const result = await cpuScopes.update(fixture.canvas, options);
      cpuScopes.render();
      return result;
    });
    const gpuTotal = await benchmark(async () => {
      const result = await gpuScopes.update(fixture.canvas, options);
      gpuScopes.render();
      return result;
    });
    return {
      input: [fixture.canvas.width, fixture.canvas.height],
      output: [cpuCanvas.width, cpuCanvas.height],
      warmups: 4,
      timedSamples: 20,
      cpu: { analysis: { medianMs: cpuAnalysis.medianMs, p95Ms: cpuAnalysis.p95Ms }, render: { medianMs: cpuRender.medianMs, p95Ms: cpuRender.p95Ms }, total: { medianMs: cpuTotal.medianMs, p95Ms: cpuTotal.p95Ms } },
      webgpu: { analysis: { medianMs: gpuAnalysis.medianMs, p95Ms: gpuAnalysis.p95Ms }, render: { medianMs: gpuRender.medianMs, p95Ms: gpuRender.p95Ms }, total: { medianMs: gpuTotal.medianMs, p95Ms: gpuTotal.p95Ms } },
      cpuHistogramBytes: cpuAnalysis.histogramBytes,
      gpuHistogramBytes: gpuAnalysis.histogramBytes,
      cpuCaptureCanvasCreations: captureCanvasCreations,
      cpuCaptureCanvasCounterAvailable: captureCanvasCounterAvailable,
      notes: ["current implementation only", "browser wall time includes WebGPU readback", "histogramBytes is retained result storage"],
    };
  } finally {
    if (nativeOffscreenCanvas) globalThis.OffscreenCanvas = nativeOffscreenCanvas;
  }
}

let cpuScopes;
let gpuScopes;
try {
  status.textContent = `Browser: ${navigator.userAgent}\nSecure context: ${isSecureContext}\nWebGPU exposed: ${Boolean(navigator.gpu)}\nRunning CPU/WebGPU parity matrix…`;
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter is available");
  const adapterInfo = adapter.info;
  cpuScopes = await createScopes({ backend: "cpu", autoRender: false });
  gpuScopes = await createScopes({ backend: "webgpu", adapter, autoRender: false });

  const cases = [];
  const failures = [];
  for (const fixture of fixtures) {
    for (const waveformMode of modes) {
      for (const colorMatrix of matrices) {
        const options = {
          waveformMode,
          colorMatrix,
          waveformWidth: 31,
          waveformHeight: 64,
          vectorscopeSize: 64,
          ...fixture.options,
        };
        const cpu = await cpuScopes.update(fixture.imageData, options);
        const gpu = await gpuScopes.update(fixture.canvas, options);
        const comparison = compareBins(cpu, gpu);
        const cpuSums = cpu.waveform.channels.map(sum);
        const gpuSums = gpu.waveform.channels.map(sum);
        const cpuVectorSum = sum(cpu.vectorscope.bins);
        const gpuVectorSum = sum(gpu.vectorscope.bins);
        const passed = cpu.sampleCount === gpu.sampleCount
          && comparison.totalAbsoluteDifference === 0
          && cpuSums.every((value) => value === cpu.sampleCount)
          && gpuSums.every((value) => value === gpu.sampleCount)
          && cpuVectorSum === cpu.sampleCount
          && gpuVectorSum === gpu.sampleCount;
        const entry = {
          fixture: fixture.name,
          waveformMode,
          colorMatrix,
          passed,
          sampleCount: cpu.sampleCount,
          mismatchedBins: comparison.mismatchedBins,
          totalAbsoluteDifference: comparison.totalAbsoluteDifference,
          cpuSums,
          gpuSums,
          cpuVectorSum,
          gpuVectorSum,
          details: comparison.details,
        };
        cases.push(entry);
        if (!passed) failures.push(entry);
      }
    }
  }

  const highBitChecks = [checkHighBitDepth(10), checkHighBitDepth(12)];
  const passed = failures.length === 0 && highBitChecks.every((check) => check.passed);
  const barsCpu = await cpuScopes.update(fixtures[0].imageData, { waveformMode: "rgb-parade", waveformWidth: 640, waveformHeight: 256, inputResolutionScaling: 0.5 });
  const barsGpu = await gpuScopes.update(fixtures[0].canvas, { waveformMode: "rgb-parade", waveformWidth: 640, waveformHeight: 256, inputResolutionScaling: 0.5 });
  renderScopes(barsCpu, document.querySelector("#cpu"), { ...DEMO_RENDER_OPTIONS, devicePixelRatio: 1 });
  renderScopes(barsGpu, document.querySelector("#gpu"), { ...DEMO_RENDER_OPTIONS, devicePixelRatio: 1 });
  const renderChecks = {
    cpuTargetColor: checkCanvasTargetColor(document.querySelector("#cpu"), "bt709"),
    gpuTargetColor: checkCanvasTargetColor(document.querySelector("#gpu"), "bt709"),
  };
  const roiChecks = await runRoiBrowserChecks();
  const browserPerformance = await runBrowserPerformance(cpuScopes, gpuScopes);

  const allPassed = passed && Object.values(renderChecks).every(Boolean) && roiChecks.passed;
  window.webscopesParityResult = { passed: allPassed, caseCount: cases.length, failures, highBitChecks, renderChecks, roiChecks, browserPerformance };
  status.textContent = [
    `PASS: ${allPassed}`,
    `Cases: ${cases.length}; failures: ${failures.length}`,
    `Fixture coverage: ${fixtures.map((fixture) => fixture.name).join(", ")}`,
    `Modes: ${modes.join(", ")}`,
    `Matrices: ${matrices.join(", ")}`,
    `High-bit-depth CPU: ${highBitChecks.map((check) => `${check.bitDepth}-bit ${check.passed ? "PASS" : "FAIL"}`).join(", ")}`,
    `Real-canvas target colors: CPU ${renderChecks.cpuTargetColor ? "PASS" : "FAIL"}; GPU ${renderChecks.gpuTargetColor ? "PASS" : "FAIL"}`,
    `Browser ROI interactions: ${roiChecks.passed ? "PASS" : "FAIL"} · ${Object.keys(roiChecks.checks).length} cases`,
    `Browser performance (20 samples, 4 warmups): CPU analysis ${browserPerformance.cpu.analysis.medianMs.toFixed(1)}/${browserPerformance.cpu.analysis.p95Ms.toFixed(1)} ms median/p95; WebGPU ${browserPerformance.webgpu.analysis.medianMs.toFixed(1)}/${browserPerformance.webgpu.analysis.p95Ms.toFixed(1)} ms`,
    `Render CPU ${browserPerformance.cpu.render.medianMs.toFixed(1)}/${browserPerformance.cpu.render.p95Ms.toFixed(1)} ms; GPU result ${browserPerformance.webgpu.render.medianMs.toFixed(1)}/${browserPerformance.webgpu.render.p95Ms.toFixed(1)} ms`,
    `Total update+render CPU ${browserPerformance.cpu.total.medianMs.toFixed(1)}/${browserPerformance.cpu.total.p95Ms.toFixed(1)} ms; GPU ${browserPerformance.webgpu.total.medianMs.toFixed(1)}/${browserPerformance.webgpu.total.p95Ms.toFixed(1)} ms`,
    `Histogram bytes CPU/GPU: ${browserPerformance.cpuHistogramBytes}/${browserPerformance.gpuHistogramBytes}; CPU capture canvases: ${browserPerformance.cpuCaptureCanvasCounterAvailable ? browserPerformance.cpuCaptureCanvasCreations : "counter unavailable"}`,
    `Secure context: ${isSecureContext}`,
    `GPU adapter: ${[adapterInfo?.vendor, adapterInfo?.architecture, adapterInfo?.description].filter(Boolean).join(" / ") || "details hidden by browser"}`,
    failures.slice(0, 5).map((failure) => `${failure.fixture}/${failure.waveformMode}/${failure.colorMatrix}: ${JSON.stringify(failure)}`).join("\n"),
    `Display dither: ${DEMO_RENDER_OPTIONS.dither}; vectorscope dither: ${DEMO_RENDER_OPTIONS.vectorscopeDither} output code values`,
  ].filter(Boolean).join("\n");
  cpuScopes.destroy();
  gpuScopes.destroy();
} catch (error) {
  window.webscopesParityResult = { passed: false, error: error?.stack ?? String(error) };
  status.textContent += `\n\nGPU/CPU check failed:\n${error?.stack ?? error}`;
  console.error(error);
  cpuScopes?.destroy();
  gpuScopes?.destroy();
}
