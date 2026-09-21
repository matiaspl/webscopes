import { createScopeDisplay, createScopes } from "../src/index.js?video-color-parity-v6";

const query = new URLSearchParams(globalThis.location.search);
const MANIFEST = query.get("source") || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const SEEK_SECONDS = Number(query.get("seek") ?? 30);
const requestedSoakDuration = Number(query.get("soakMs"));
const SOAK_DURATION_MS = Number.isInteger(requestedSoakDuration) && requestedSoakDuration > 0 && requestedSoakDuration <= 120_000
  ? requestedSoakDuration
  : 120_000;
const SOAK_PATH = ["video-source", "canvas-upload", "playback-only"].includes(query.get("soakPath"))
  ? query.get("soakPath")
  : "video-source";
const REQUESTED_VIDEO_TEXTURE_MODE = ["auto", "copy", "external"].includes(query.get("videoTextureMode"))
  ? query.get("videoTextureMode")
  : "auto";
const status = document.querySelector("#status");
const video = document.querySelector("#video");
const runButton = document.querySelector("#run-check");
const options = {
  inputResolutionScaling: 0.25,
  waveformWidth: 96,
  waveformHeight: 256,
  vectorscopeSize: 96,
};

function sum(bins) {
  let total = 0;
  for (const count of bins) total += count;
  return total;
}

function readJsHeap() {
  const memory = globalThis.performance?.memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) return undefined;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

function compareBins(cpu, gpu) {
  let mismatchedBins = 0;
  let totalAbsoluteDifference = 0;
  const compare = (left, right) => {
    if (left.length !== right.length) {
      mismatchedBins += Math.max(left.length, right.length);
      return;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) mismatchedBins += 1;
      totalAbsoluteDifference += Math.abs(left[index] - right[index]);
    }
  };
  cpu.waveform.channels.forEach((channel, index) => compare(channel, gpu.waveform.channels[index]));
  compare(cpu.vectorscope.bins, gpu.vectorscope.bins);
  return { mismatchedBins, totalAbsoluteDifference };
}

async function waitForVideo() {
  if (window.Hls?.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    await new Promise((resolve, reject) => {
      const fail = (event, data) => {
        if (data?.fatal) reject(new Error(`HLS ${data.type}: ${data.details}`));
      };
      hls.on(window.Hls.Events.ERROR, fail);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => resolve(hls));
      hls.attachMedia(video);
      hls.loadSource(MANIFEST);
    });
    return hls;
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = MANIFEST;
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("Native HLS playback failed")), { once: true });
    });
  } else {
    throw new Error("This browser cannot play the HLS video");
  }
  return undefined;
}

async function waitForNextVideoFrame() {
  if (video.requestVideoFrameCallback) {
    await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function probeVideoFrameRgbx(sourceFrame) {
  if (typeof globalThis.VideoFrame !== "function") return { supported: false, reason: "VideoFrame unavailable" };
  const ownsVideoFrame = !sourceFrame;
  const videoFrame = sourceFrame ?? new globalThis.VideoFrame(video, { timestamp: 0 });
  try {
    const width = videoFrame.displayWidth ?? videoFrame.codedWidth;
    const height = videoFrame.displayHeight ?? videoFrame.codedHeight;
    const options = { format: "RGBX", colorSpace: "srgb" };
    const pixels = new Uint8Array(videoFrame.allocationSize(options));
    const layout = await videoFrame.copyTo(pixels, options);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    context.drawImage(videoFrame, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const pixelCount = width * height;
    const packedRgbx = pixels.byteLength === pixelCount * 4
      && layout.length === 1
      && layout[0].offset === 0
      && layout[0].stride === width * 4;
    let mismatchedSamples;
    let maxChannelDifference;
    if (packedRgbx) {
      mismatchedSamples = 0;
      maxChannelDifference = 0;
      const step = Math.max(1, Math.floor(pixelCount / 32));
      for (let pixel = 0; pixel < pixelCount; pixel += step) {
        let differs = false;
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = Math.abs(pixels[pixel * 4 + channel] - rgba[pixel * 4 + channel]);
          maxChannelDifference = Math.max(maxChannelDifference, difference);
          if (difference !== 0) differs = true;
        }
        if (differs) mismatchedSamples += 1;
      }
    }
    return {
      copyToSucceeded: true,
      packedRgbx,
      width,
      height,
      byteLength: pixels.byteLength,
      bytesPerPixel: pixels.byteLength / pixelCount,
      layout,
      mismatchedSamples,
      maxChannelDifference,
    };
  } catch (error) {
    return { copyToSucceeded: false, packedRgbx: false, reason: error?.message ?? String(error) };
  } finally {
    if (ownsVideoFrame) videoFrame.close();
  }
}

try {
  const hls = await waitForVideo();
  runButton.disabled = false;
  runButton.textContent = `Start parity + ${SOAK_DURATION_MS / 1_000}s ${SOAK_PATH} soak (${REQUESTED_VIDEO_TEXTURE_MODE})`;
  status.textContent = `Video ready. Compare four CPU/GPU modes, then run a ${SOAK_DURATION_MS / 1_000}s ${SOAK_PATH} soak.`;
  runButton.addEventListener("click", async () => {
    runButton.disabled = true;
    let cpu;
    let gpu;
    let display;
    let parityFrame;
    try {
      video.loop = true;
      await video.play();
      await waitForNextVideoFrame();
      if (Number.isFinite(SEEK_SECONDS) && SEEK_SECONDS > 0 && Number.isFinite(video.duration)) {
        await new Promise((resolve) => {
          video.addEventListener("seeked", resolve, { once: true });
          video.currentTime = Math.min(SEEK_SECONDS, video.duration * 0.5);
        });
      }
      await waitForNextVideoFrame();
      const source = { width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
      parityFrame = new globalThis.VideoFrame(video, { timestamp: Math.round(video.currentTime * 1_000_000) });
      const rgbxReadback = await probeVideoFrameRgbx(parityFrame);
      cpu = await createScopes({ backend: "cpu", autoRender: false });
      gpu = await createScopes({ backend: "webgpu", autoRender: false, videoTextureMode: REQUESTED_VIDEO_TEXTURE_MODE });
      const displayCanvas = document.createElement("canvas");
      displayCanvas.width = 640;
      displayCanvas.height = 360;
      display = await createScopeDisplay({ canvas: displayCanvas, videoTextureMode: REQUESTED_VIDEO_TEXTURE_MODE });
      const videoTextureMode = gpu.videoTextureMode;
      const cases = [
        ["rgb-parade", "bt709"],
        ["luma", "bt709"],
        ["ycbcr-parade", "bt709"],
        ["rgb-parade", "bt2020"],
      ];
      const failures = [];
      const colorModes = [];
      for (const [waveformMode, colorMatrix] of cases) {
        const caseOptions = { ...options, waveformMode, colorMatrix };
        const cpuResult = await cpu.update(parityFrame, caseOptions);
        const gpuResult = await gpu.update(parityFrame, caseOptions);
        const comparison = compareBins(cpuResult, gpuResult);
        await display.present(parityFrame, caseOptions);
        const displayResult = await display.snapshot();
        const displayComparison = compareBins(cpuResult, displayResult);
        colorModes.push({ waveformMode, analyzer: gpuResult.stats.videoColorMode, display: displayResult.stats.videoColorMode });
        const cpuSamples = cpuResult.waveform.channels.map(sum);
        const gpuSamples = gpuResult.waveform.channels.map(sum);
        const passed = comparison.totalAbsoluteDifference === 0
          && displayComparison.totalAbsoluteDifference === 0
          && cpuResult.sampleCount === gpuResult.sampleCount
          && cpuSamples.every((value) => value === cpuResult.sampleCount)
          && gpuSamples.every((value) => value === gpuResult.sampleCount)
          && sum(cpuResult.vectorscope.bins) === cpuResult.sampleCount
          && sum(gpuResult.vectorscope.bins) === gpuResult.sampleCount;
        const result = { waveformMode, colorMatrix, passed, ...comparison, displayComparison, cpuSampleCount: cpuResult.sampleCount, gpuSampleCount: gpuResult.sampleCount };
        if (!passed) failures.push(result);
      }
      if (query.get("software") === "1") {
        const raw = new Uint8Array(parityFrame.allocationSize());
        const layout = await parityFrame.copyTo(raw);
        const software = new VideoFrame(raw, { format: parityFrame.format, codedWidth: parityFrame.codedWidth,
          codedHeight: parityFrame.codedHeight, visibleRect: parityFrame.visibleRect,
          displayWidth: parityFrame.displayWidth, displayHeight: parityFrame.displayHeight,
          timestamp: 0, colorSpace: parityFrame.colorSpace.toJSON(), layout });
        try {
          // Reuse the same analyzers across hardware -> software -> hardware.
          for (const [label, input] of [["software", software], ["hardware-again", parityFrame]]) {
            const cpuResult = await cpu.update(input, options);
            const gpuResult = await gpu.update(input, options);
            await display.present(input, options);
            const displayResult = await display.snapshot();
            const comparison = compareBins(cpuResult, gpuResult);
            const displayComparison = compareBins(cpuResult, displayResult);
            colorModes.push({label, analyzer: gpuResult.stats.videoColorMode, display: displayResult.stats.videoColorMode});
            if (comparison.totalAbsoluteDifference || displayComparison.totalAbsoluteDifference) failures.push({label, comparison, displayComparison});
          }
        } finally { software.close(); }
      }
      const passed = failures.length === 0;
      parityFrame.close();
      parityFrame = undefined;
      status.textContent = [
        `PASS: ${passed}`,
        `Cases: ${cases.length}; failures: ${failures.length}`,
        `Color paths: ${JSON.stringify(colorModes)}`,
        `Video: ${source.width}×${source.height} at ${source.time.toFixed(3)}s`,
        `RGBX readback: ${JSON.stringify(rgbxReadback)}`,
        `Parity ${passed ? "passed" : "failed"}. Starting a ${SOAK_DURATION_MS / 1_000}s ${SOAK_PATH} soak (video texture mode: ${gpu.videoTextureMode})…`,
        `Source: ${MANIFEST}`,
        failures.map((failure) => JSON.stringify(failure)).join("\n"),
      ].filter(Boolean).join("\n");
      if (video.ended) video.currentTime = 0;
      await video.play();
      const soakStartedAt = performance.now();
      let soakFrames = 0;
      let lastProgressAt = soakStartedAt;
      const heapSamples = [];
      const initialHeap = readJsHeap();
      if (initialHeap) heapSamples.push({ elapsedMs: 0, ...initialHeap });
      const soakOptions = { ...options, waveformMode: "rgb-parade", colorMatrix: "bt709" };
      const soakCanvas = document.createElement("canvas");
      const soakContext = soakPathContext(SOAK_PATH, soakCanvas);
      while (performance.now() - soakStartedAt < SOAK_DURATION_MS) {
        await waitForNextVideoFrame();
        if (SOAK_PATH === "external-texture") {
          await gpu.update(video, soakOptions);
        } else if (SOAK_PATH === "canvas-upload") {
          soakContext.drawImage(video, 0, 0, soakCanvas.width, soakCanvas.height);
          await gpu.update(soakCanvas, soakOptions);
        } else if (SOAK_PATH === "video-source") {
          await gpu.update(video, soakOptions);
        }
        soakFrames += 1;
        const now = performance.now();
        if (now - lastProgressAt >= 10_000) {
          const elapsedSeconds = Math.floor((now - soakStartedAt) / 1_000);
          const heap = readJsHeap();
          if (heap) heapSamples.push({ elapsedMs: Math.round(now - soakStartedAt), ...heap });
          const heapText = heap
            ? `JS heap used: ${(heap.usedJSHeapSize / 1_048_576).toFixed(1)} MiB`
            : "JS heap telemetry unavailable in this browser";
          status.textContent = `Parity: ${passed ? "PASS" : "FAIL"} (${cases.length} modes)\nWebGPU video soak: ${elapsedSeconds}s / ${SOAK_DURATION_MS / 1_000}s; ${soakFrames} frames\nVideo texture mode: ${videoTextureMode}\n${heapText}\nRGBX packed: ${rgbxReadback.packedRgbx}; ${rgbxReadback.bytesPerPixel} bytes/pixel`;
          lastProgressAt = now;
        }
      }
      video.pause();
      const soak = { durationMs: Math.round(performance.now() - soakStartedAt), frames: soakFrames };
      const finalHeap = readJsHeap();
      if (finalHeap) heapSamples.push({ elapsedMs: soak.durationMs, ...finalHeap });
      const heapMemory = {
        available: heapSamples.length > 0,
        source: "performance.memory",
        samples: heapSamples,
        deltaUsedBytes: heapSamples.length > 1
          ? heapSamples.at(-1).usedJSHeapSize - heapSamples[0].usedJSHeapSize
          : undefined,
      };
      const memory = heapMemory.available
        ? `${(heapMemory.deltaUsedBytes / 1_048_576).toFixed(1)} MiB JS-heap delta (${(heapSamples[0].usedJSHeapSize / 1_048_576).toFixed(1)} → ${(heapSamples.at(-1).usedJSHeapSize / 1_048_576).toFixed(1)} MiB)`
        : "JS heap telemetry unavailable";
      window.webscopesVideoParityResult = {
        passed,
        source,
        cpuBackend: cpu.backend,
        gpuBackend: gpu.backend,
        rgbxReadback,
        cases: cases.length,
        colorModes,
        failures,
        soak,
        soakPath: SOAK_PATH,
        requestedVideoTextureMode: REQUESTED_VIDEO_TEXTURE_MODE,
        videoTextureMode,
        heapMemory,
      };
      status.textContent = [
        `PARITY PASS: ${passed}`,
        `Cases: ${cases.length}; failures: ${failures.length}`,
        `Color paths: ${JSON.stringify(colorModes)}`,
        `Backends: CPU=${cpu.backend}; GPU=${gpu.backend}`,
        `Soak: ${SOAK_PATH}; WebGPU video texture mode=${videoTextureMode}; ${soak.durationMs}ms; ${soak.frames} frames`,
        memory,
        `Video: ${source.width}×${source.height} at ${source.time.toFixed(3)}s`,
        `RGBX readback: ${JSON.stringify(rgbxReadback)}`,
        `Source: ${MANIFEST}`,
        failures.map((failure) => JSON.stringify(failure)).join("\n"),
      ].filter(Boolean).join("\n");
    } catch (error) {
      const detail = {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stack: error?.stack,
      };
      window.webscopesVideoParityResult = { passed: false, error: detail };
      status.textContent = `Video CPU/GPU check failed:\n${JSON.stringify(detail, null, 2)}`;
      console.error(error);
    } finally {
      parityFrame?.close();
      video.pause();
      cpu?.destroy();
      gpu?.destroy();
      await display?.destroy();
      hls?.destroy();
      if (window.webscopesVideoParityResult?.heapMemory?.available) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const afterCleanup = readJsHeap();
        if (afterCleanup) {
          const result = window.webscopesVideoParityResult;
          result.heapMemory.afterCleanup = afterCleanup;
          result.heapMemory.afterCleanupDelayMs = 2_000;
          status.textContent += `\nJS heap 2s after analyzer destroy: ${(afterCleanup.usedJSHeapSize / 1_048_576).toFixed(1)} MiB`;
        }
      }
      runButton.disabled = false;
    }
  }, { once: true });
} catch (error) {
  window.webscopesVideoParityResult = { passed: false, error: error?.stack ?? String(error) };
  status.textContent = `Video source setup failed:\n${error?.stack ?? error}`;
  console.error(error);
}

function soakPathContext(path, canvas) {
  if (path !== "canvas-upload") return undefined;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: false });
  if (!context) throw new Error("Could not create a canvas for the canvas-upload soak");
  return context;
}
