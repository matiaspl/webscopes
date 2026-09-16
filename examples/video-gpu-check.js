import { createScopes } from "../src/index.js";

const MANIFEST = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const status = document.querySelector("#status");
const video = document.querySelector("#video");
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
    await new Promise((resolve, reject) => {
      const hls = new window.Hls({ enableWorker: true });
      const fail = (event, data) => {
        if (data?.fatal) reject(new Error(`HLS ${data.type}: ${data.details}`));
      };
      hls.on(window.Hls.Events.ERROR, fail);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => resolve(hls));
      hls.attachMedia(video);
      hls.loadSource(MANIFEST);
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = MANIFEST;
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("Native HLS playback failed")), { once: true });
    });
  } else {
    throw new Error("This browser cannot play the HLS video");
  }

  await video.play();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  video.pause();
  const range = video.seekable.length
    ? { start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1) }
    : { start: 0, end: video.duration };
  const target = Math.min(range.end, Math.max(range.start, range.start + 42));
  if (Number.isFinite(target) && target > range.start) {
    video.currentTime = target;
    await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
  }
  return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
}

try {
  const source = await waitForVideo();
  const cpu = await createScopes({ backend: "cpu", autoRender: false });
  const gpu = await createScopes({ backend: "webgpu", autoRender: false });
  const cases = [
    ["rgb-parade", "bt709"],
    ["luma", "bt709"],
    ["ycbcr-parade", "bt709"],
    ["rgb-parade", "bt2020"],
  ];
  const failures = [];
  for (const [waveformMode, colorMatrix] of cases) {
    const caseOptions = { ...options, waveformMode, colorMatrix };
    const cpuResult = await cpu.update(video, caseOptions);
    const gpuResult = await gpu.update(video, caseOptions);
    const comparison = compareBins(cpuResult, gpuResult);
    const cpuSamples = cpuResult.waveform.channels.map(sum);
    const gpuSamples = gpuResult.waveform.channels.map(sum);
    const passed = comparison.totalAbsoluteDifference === 0
      && cpuResult.sampleCount === gpuResult.sampleCount
      && cpuSamples.every((value) => value === cpuResult.sampleCount)
      && gpuSamples.every((value) => value === gpuResult.sampleCount)
      && sum(cpuResult.vectorscope.bins) === cpuResult.sampleCount
      && sum(gpuResult.vectorscope.bins) === gpuResult.sampleCount;
    const result = { waveformMode, colorMatrix, passed, ...comparison, cpuSampleCount: cpuResult.sampleCount, gpuSampleCount: gpuResult.sampleCount };
    if (!passed) failures.push(result);
  }
  const passed = failures.length === 0;
  window.webscopesVideoParityResult = { passed, source, cases: cases.length, failures };
  status.textContent = [
    `PASS: ${passed}`,
    `Cases: ${cases.length}; failures: ${failures.length}`,
    `Video: ${source.width}×${source.height} at ${source.time.toFixed(3)}s`,
    `Source: ${MANIFEST}`,
    failures.map((failure) => JSON.stringify(failure)).join("\n"),
  ].filter(Boolean).join("\n");
  cpu.destroy();
  gpu.destroy();
} catch (error) {
  window.webscopesVideoParityResult = { passed: false, error: error?.stack ?? String(error) };
  status.textContent = `Video CPU/GPU check failed:\n${error?.stack ?? error}`;
  console.error(error);
}
