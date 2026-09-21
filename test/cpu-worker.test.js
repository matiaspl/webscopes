import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCapturedPixels, analyzeFrame, normalizeAnalysisOptions, readFramePixelsAsync } from "../src/analyze.js";
import { analyzeTransferredVideoFrame } from "../src/cpu-worker-core.js";
import { createCpuWorkerClient } from "../src/cpu-worker-client.js";
import { createScopes } from "../src/index.js";

function withGlobals(values, run) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, values);
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
}

function makePixels(width = 9, height = 7, padding = 12) {
  const bytesPerRow = width * 4 + padding;
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      data[offset] = (x * 41 + y * 17) & 255;
      data[offset + 1] = (x * 13 + y * 59) & 255;
      data[offset + 2] = (x * 71 + y * 23) & 255;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data, bytesPerRow, colorMatrix: "bt601" };
}

function cropPixels(frame, options) {
  const config = normalizeAnalysisOptions(frame.width, frame.height, options);
  const data = new Uint8Array(config.cropWidth * config.cropHeight * 4);
  for (let y = 0; y < config.cropHeight; y += 1) {
    const source = (config.y0 + y) * frame.bytesPerRow + config.x0 * 4;
    data.set(frame.data.subarray(source, source + config.cropWidth * 4), y * config.cropWidth * 4);
  }
  return {
    width: config.cropWidth,
    height: config.cropHeight,
    data,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    originX: config.x0,
    originY: config.y0,
    colorMatrix: frame.colorMatrix,
  };
}

function assertSameHistograms(left, right) {
  assert.equal(right.width, left.width);
  assert.equal(right.height, left.height);
  assert.equal(right.sampleCount, left.sampleCount);
  assert.deepEqual(right.waveform.channelNames, left.waveform.channelNames);
  assert.equal(right.waveform.channels.length, left.waveform.channels.length);
  right.waveform.channels.forEach((bins, index) => assert.deepEqual(bins, left.waveform.channels[index]));
  assert.deepEqual(right.vectorscope.bins, left.vectorscope.bins);
  assert.equal(right.vectorscope.colorMatrix, left.vectorscope.colorMatrix);
}

class CopyableVideoFrame {
  constructor(source) {
    this.width = source.displayWidth ?? source.width ?? source.videoWidth;
    this.height = source.displayHeight ?? source.height ?? source.videoHeight;
    this.displayWidth = this.width;
    this.displayHeight = this.height;
    this.colorMatrix = source.colorMatrix;
    this.colorRange = source.colorRange;
    this.rgba = source.rgba ?? source.data;
    this.bytesPerRow = source.bytesPerRow ?? this.width * 4;
    this.failRect = source.failRect ?? false;
    this.closed = false;
    this.timestamp = source.timestamp ?? 0;
    this.frameSource = source;
  }

  allocationSize({ rect } = {}) {
    const width = rect?.width ?? this.width;
    const height = rect?.height ?? this.height;
    return width * height * 4;
  }

  async copyTo(destination, options = {}) {
    const rect = options.rect;
    if (rect && this.failRect) throw new Error("rect copy unsupported");
    const x0 = rect?.x ?? 0;
    const y0 = rect?.y ?? 0;
    const width = rect?.width ?? this.width;
    const height = rect?.height ?? this.height;
    const stride = width * 4;
    const format = options.format;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const input = (y0 + y) * this.bytesPerRow + (x0 + x) * 4;
        const output = y * stride + x * 4;
        destination[output] = this.rgba[input];
        destination[output + 1] = this.rgba[input + 1];
        destination[output + 2] = this.rgba[input + 2];
        destination[output + 3] = format === "RGBA" ? this.rgba[input + 3] : 255;
      }
    }
    return [{ offset: 0, stride }];
  }

  close() { this.closed = true; }
}

test("cropped CPU analysis exactly preserves edge ROI, sample mapping and composite phase", () => {
  const frame = makePixels();
  const cases = [
    { region: { x: 0, y: 0, width: 1 / 9, height: 1 / 7 }, inputResolutionScaling: 1, waveformMode: "rgb" },
    { region: { x: 8 / 9, y: 6 / 7, width: 1 / 9, height: 1 / 7 }, inputResolutionScaling: 1, waveformMode: "luma" },
    { region: { x: 2 / 9, y: 1 / 7, width: 5 / 9, height: 4 / 7 }, inputResolutionScaling: 0.5, waveformMode: "composite" },
    { region: { x: 1 / 9, y: 0, width: 7 / 9, height: 1 }, inputResolutionScaling: 0.75, waveformMode: "ycbcr-parade" },
  ];
  for (const colorMatrix of ["bt601", "bt709", "bt2020", "bt2100"]) {
    for (const analysisOptions of cases) {
      const options = { ...analysisOptions, colorMatrix, waveformWidth: 31, waveformHeight: 64, vectorscopeSize: 64 };
      const full = analyzeFrame(frame, options);
      const cropped = analyzeCapturedPixels(cropPixels(frame, options), options);
      assertSameHistograms(full, cropped);
    }
  }
});

test("VideoFrame ROI copy uses exact integer bounds and falls back to full capture if unsupported", async () => {
  const frame = makePixels();
  const options = {
    region: { x: 2 / 9, y: 1 / 7, width: 5 / 9, height: 4 / 7 },
    inputResolutionScaling: 0.5,
    waveformMode: "composite",
    waveformWidth: 31,
    waveformHeight: 64,
    vectorscopeSize: 64,
  };
  await withGlobals({ VideoFrame: CopyableVideoFrame }, async () => {
    const exact = new CopyableVideoFrame({ ...frame, rgba: frame.data });
    const cropped = await readFramePixelsAsync(exact, {}, options);
    assert.deepEqual([cropped.width, cropped.height, cropped.originX, cropped.originY], [5, 4, 2, 1]);
    assert.equal(cropped.captureUsedRoi, true);
    assert.equal(cropped.capturedByteLength, 5 * 4 * 4);
    assert.equal(cropped.colorMatrix, "bt601");
    assertSameHistograms(analyzeFrame(frame, options), analyzeCapturedPixels(cropped, options));

    const unsupported = new CopyableVideoFrame({ ...frame, rgba: frame.data, failRect: true });
    const full = await readFramePixelsAsync(unsupported, {}, options);
    assert.deepEqual([full.width, full.height, full.originX, full.originY], [9, 7, 0, 0]);
    assert.equal(full.captureUsedRoi, false);
    assertSameHistograms(analyzeFrame(frame, options), analyzeCapturedPixels(full, options));
  });
});

test("worker analysis closes transferred VideoFrames after success and failure", async () => {
  await withGlobals({ VideoFrame: CopyableVideoFrame }, async () => {
    const frame = new CopyableVideoFrame({ ...makePixels(3, 2, 0), rgba: makePixels(3, 2, 0).data });
    const analyzed = await analyzeTransferredVideoFrame(frame, { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 });
    assert.equal(frame.closed, true);
    assert.equal(analyzed.result.sampleCount, 6);
    assert.equal(analyzed.captureBytes, 24);

    const bad = new CopyableVideoFrame({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
    await assert.rejects(analyzeTransferredVideoFrame(bad, { waveformMode: "unsupported" }), /Unsupported waveformMode/);
    assert.equal(bad.closed, true);
  });
});

test("CPU worker transfers only an owned VideoFrame and sends analysis-only options", async () => {
  class FakeWorker {
    static instance;
    constructor() {
      FakeWorker.instance = this;
      this.listeners = new Map();
      this.terminated = false;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
    reply(data) { this.listeners.get("message")({ data }); }
    terminate() { this.terminated = true; }
  }
  const source = { width: 9, height: 7, nodeName: "VIDEO" };
  const client = createCpuWorkerClient({ WorkerClass: FakeWorker, VideoFrameClass: CopyableVideoFrame });
  const pending = client.analyze(source, {
    waveformMode: "composite",
    region: { x: 0, y: 0, width: 1, height: 1 },
    gpu: { notCloneable: true },
    onWarning() {},
    renderOptions: { dither: 0 },
  });
  const worker = FakeWorker.instance;
  assert.notStrictEqual(worker.message.frame, source);
  assert.deepEqual(worker.transfer, [worker.message.frame]);
  assert.deepEqual(worker.message.options, { waveformMode: "composite", region: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(source.closed, undefined, "caller-owned source remains untouched");
  worker.message.frame.close();
  worker.reply({ id: 1, analysis: { result: { sampleCount: 63 }, snapshotTimeMs: 0.1, captureTimeMs: 2, analysisTimeMs: 3 } });
  const response = await pending;
  assert.equal(response.result.sampleCount, 63);
  assert.equal(response.captureTimeMs, 2);
  client.destroy();
  assert.equal(worker.terminated, true);
});

test("worker transfer failure disables the worker and closes only its owned snapshot", async () => {
  class ThrowingWorker {
    constructor() { ThrowingWorker.instance = this; }
    postMessage() { throw new Error("transfer not supported"); }
    terminate() { this.terminated = true; }
  }
  const source = { width: 2, height: 2 };
  const client = createCpuWorkerClient({ WorkerClass: ThrowingWorker, VideoFrameClass: CopyableVideoFrame });
  await assert.rejects(client.analyze(source), /transfer not supported/);
  assert.equal(source.closed, undefined);
  assert.equal(ThrowingWorker.instance.terminated, true);
  assert.equal(client.available, false);
});

test("raw pixel arrays stay on the synchronous path and remain attached", async () => {
  class NeverWorker {
    constructor() { throw new Error("raw data must not create a worker"); }
  }
  const data = new Uint8Array([10, 20, 30, 255]);
  const buffer = data.buffer;
  await withGlobals({ Worker: NeverWorker, VideoFrame: CopyableVideoFrame }, async () => {
    const scopes = await createScopes({ backend: "cpu", autoRender: false });
    const result = await scopes.update({ data, width: 1, height: 1 }, { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 });
    assert.equal(result.sampleCount, 1);
    assert.strictEqual(data.buffer, buffer);
    assert.equal(data.byteLength, 4);
    scopes.destroy();
  });
});

test("createScopes automatically uses the worker and reports exact cropped capture work", async () => {
  class AnalyzingWorker {
    static instance;
    constructor() {
      AnalyzingWorker.instance = this;
      this.listeners = new Map();
      this.terminated = false;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    postMessage(message, transfer) {
      this.message = message;
      this.transfer = transfer;
      queueMicrotask(async () => {
        try {
          const analysis = await analyzeTransferredVideoFrame(message.frame, message.options);
          this.listeners.get("message")({ data: { id: message.id, analysis } });
        } catch (error) {
          this.listeners.get("message")({ data: { id: message.id, error: { name: error.name, message: error.message } } });
        }
      });
    }
    terminate() { this.terminated = true; }
  }

  const pixels = makePixels();
  const source = {
    videoWidth: pixels.width,
    videoHeight: pixels.height,
    rgba: pixels.data,
    bytesPerRow: pixels.bytesPerRow,
    colorMatrix: pixels.colorMatrix,
    nodeName: "VIDEO",
  };
  const options = {
    waveformMode: "composite",
    colorMatrix: "bt601",
    region: { x: 2 / 9, y: 1 / 7, width: 5 / 9, height: 4 / 7 },
    inputResolutionScaling: 0.5,
    waveformWidth: 31,
    waveformHeight: 64,
    vectorscopeSize: 64,
  };
  const expected = analyzeFrame(pixels, options);

  await withGlobals({ Worker: AnalyzingWorker, VideoFrame: CopyableVideoFrame }, async () => {
    const scopes = await createScopes({ backend: "cpu", autoRender: false });
    const result = await scopes.update(source, options);
    assertSameHistograms(expected, result);
    assert.equal(result.stats.performance.captureUsedRoi, true);
    assert.equal(result.stats.performance.captureBytes, 5 * 4 * 4);
    assert.strictEqual(AnalyzingWorker.instance.transfer[0], AnalyzingWorker.instance.message.frame);
    assert.equal(source.closed, undefined, "worker snapshot never closes the caller's video source");
    scopes.destroy();
    assert.equal(AnalyzingWorker.instance.terminated, true);
  });
});

test("createScopes falls back to exact main-thread CPU analysis when worker transfer fails", async () => {
  class UnsupportedWorker {
    static instance;
    constructor() { UnsupportedWorker.instance = this; }
    postMessage() { throw new Error("VideoFrame transfer unsupported"); }
    terminate() { this.terminated = true; }
  }

  const pixels = makePixels();
  const source = {
    videoWidth: pixels.width,
    videoHeight: pixels.height,
    rgba: pixels.data,
    bytesPerRow: pixels.bytesPerRow,
    colorMatrix: pixels.colorMatrix,
    nodeName: "VIDEO",
  };
  const options = {
    waveformMode: "ycbcr-parade",
    colorMatrix: "bt2020",
    region: { x: 8 / 9, y: 6 / 7, width: 1 / 9, height: 1 / 7 },
    waveformWidth: 31,
    waveformHeight: 64,
    vectorscopeSize: 64,
  };
  const warnings = [];

  await withGlobals({ Worker: UnsupportedWorker, VideoFrame: CopyableVideoFrame }, async () => {
    const scopes = await createScopes({ backend: "cpu", autoRender: false, onWarning: (message) => warnings.push(message) });
    const result = await scopes.update(source, options);
    assertSameHistograms(analyzeFrame(pixels, options), result);
    assert.equal(result.stats.performance.captureUsedRoi, true);
    assert.ok(warnings.some((message) => message.includes("using main-thread analysis")));
    assert.equal(UnsupportedWorker.instance.terminated, true);
    scopes.destroy();
  });
});

test("worker client teardown rejects pending work and terminates the worker", async () => {
  class WaitingWorker {
    static instance;
    constructor() {
      WaitingWorker.instance = this;
      this.listeners = new Map();
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    postMessage(message) { this.message = message; }
    terminate() {
      this.terminated = true;
      this.message?.frame.close();
    }
  }

  await withGlobals({ VideoFrame: CopyableVideoFrame }, async () => {
    const client = createCpuWorkerClient({ WorkerClass: WaitingWorker, VideoFrameClass: CopyableVideoFrame });
    const pending = client.analyze({ width: 2, height: 2 });
    const worker = WaitingWorker.instance;
    const ownedFrame = worker.message.frame;
    client.destroy();
    await assert.rejects(pending, /destroyed/);
    assert.equal(worker.terminated, true);
    assert.equal(ownedFrame.closed, true, "worker termination releases its transferred frame");
  });
});
