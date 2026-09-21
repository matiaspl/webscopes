import test from "node:test";
import assert from "node:assert/strict";
import { createWebGpuAnalyzer } from "../src/webgpu.js";
import { createScopes } from "../src/index.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function installGpuConstants() {
  const original = {
    GPUTextureUsage: globalThis.GPUTextureUsage,
    GPUBufferUsage: globalThis.GPUBufferUsage,
    GPUMapMode: globalThis.GPUMapMode,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16 };
  globalThis.GPUMapMode = { READ: 1 };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(Array.from({length: this.width * this.height * 4}, (_, i) => i % 4 === 3 ? 255 : 128)) }) }; }
  };
  return () => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  };
}

function mockDevice(overrides = {}) {
  const state = {
    pushes: 0,
    pops: 0,
    deviceDestroyCalls: 0,
    textureCreates: 0,
    bufferCreates: 0,
    unmaps: 0,
    copyCalls: 0,
    writeTextureCalls: 0,
    bindGroupCreates: 0,
    externalTextureImports: [],
    bindGroupEntries: [],
    shaderCodes: [],
  };
  const limits = {
    maxTextureDimension2D: 8192,
    maxComputeWorkgroupsPerDimension: 65535,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeInvocationsPerWorkgroup: 256,
    maxBindingsPerBindGroup: 8,
    maxStorageBuffersPerShaderStage: 8,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12,
    maxBufferSize: 1 << 28,
    maxStorageBufferBindingSize: 1 << 27,
    maxUniformBufferBindingSize: 65536,
    ...overrides.limits,
  };
  const device = {
    state,
    limits,
    lost: overrides.lost,
    queue: {
      copyExternalImageToTexture() {
        state.copyCalls += 1;
        if (overrides.copyThrows) throw new Error("synthetic copy error");
      },
      writeTexture() {
        state.writeTextureCalls += 1;
      },
      writeBuffer() {},
      submit() {},
    },
    createShaderModule({ code }) {
      if (overrides.initializationThrows) throw new Error("synthetic initialization error");
      state.shaderCodes.push(code);
      return { code };
    },
    createSampler() { return {}; },
    createComputePipeline() { return { getBindGroupLayout() { return {}; } }; },
    createTexture() {
      state.textureCreates += 1;
      return { createView() { return {}; }, destroy() {} };
    },
    createBuffer({ size, usage }) {
      state.bufferCreates += 1;
      return {
        destroy() {},
        async mapAsync() {
          if (usage & globalThis.GPUBufferUsage.MAP_READ) {
            overrides.mapStarted?.resolve();
            if (overrides.mapGate) await overrides.mapGate.promise;
          }
          if (overrides.mapThrows) throw new Error("synthetic map error");
        },
        getMappedRange() {
          if (overrides.rangeThrows) throw new Error("synthetic mapped range error");
          if (size === 2048) {
            return (overrides.probeSamples?.() ?? new Float32Array(Array.from({length: 512}, (_, i) => i % 8 < 4 ? 140 / 255 : 128 / 255))).buffer;
          }
          return new ArrayBuffer(size);
        },
        unmap() { state.unmaps += 1; },
      };
    },
    createBindGroup({ entries }) {
      state.bindGroupCreates += 1;
      state.bindGroupEntries.push(entries);
      return {};
    },
    importExternalTexture(descriptor) {
      if (overrides.importExternalTextureThrows) throw new Error("synthetic external-texture import error");
      state.externalTextureImports.push(descriptor);
      return { descriptor };
    },
    createCommandEncoder() {
      return {
        clearBuffer() {},
        beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; },
        copyBufferToBuffer() {},
        finish() { return {}; },
      };
    },
    pushErrorScope() { state.pushes += 1; },
    async popErrorScope() { state.pops += 1; return null; },
    destroy() { state.deviceDestroyCalls += 1; },
  };
  return device;
}

test("defers WebGPU resource destruction until an in-flight readback is unmapped", async () => {
  const originalConstants = {
    GPUTextureUsage: globalThis.GPUTextureUsage,
    GPUBufferUsage: globalThis.GPUBufferUsage,
    GPUMapMode: globalThis.GPUMapMode,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16 };
  globalThis.GPUMapMode = { READ: 1 };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(Array.from({length: this.width * this.height * 4}, (_, i) => i % 4 === 3 ? 255 : 128)) }) }; }
  };

  const mapStarted = deferred();
  const releaseMap = deferred();
  let readbackBuffer;
  let deviceDestroyed = false;

  const device = {
    limits: { maxTextureDimension2D: 8192 },
    queue: {
      copyExternalImageToTexture() {},
      writeBuffer() {},
      submit() {},
    },
    createShaderModule() { return {}; },
    createComputePipeline() { return { getBindGroupLayout() { return {}; } }; },
    createTexture() { return { createView() { return {}; }, destroy() {} }; },
    createBuffer({ size, usage }) {
      const buffer = {
        size,
        destroyed: false,
        destroy() { this.destroyed = true; },
        async mapAsync() {
          mapStarted.resolve();
          await releaseMap.promise;
          if (this.destroyed) throw new Error("buffer destroyed during mapAsync");
        },
        getMappedRange() { return new ArrayBuffer(size); },
        unmap() {},
      };
      if (usage & globalThis.GPUBufferUsage.MAP_READ) readbackBuffer = buffer;
      return buffer;
    },
    createBindGroup() { return {}; },
    createCommandEncoder() {
      return {
        clearBuffer() {},
        beginComputePass() {
          return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        copyBufferToBuffer() {},
        finish() { return {}; },
      };
    },
    pushErrorScope() {},
    async popErrorScope() { return null; },
    destroy() { deviceDestroyed = true; },
  };

  try {
    const analyzer = await createWebGpuAnalyzer({ gpu: {}, adapter: {}, device });
    const pending = analyzer.analyze({ width: 2, height: 2 }, {
      waveformWidth: 2,
      waveformHeight: 16,
      vectorscopeSize: 64,
    });
    await mapStarted.promise;

    analyzer.destroy();
    assert.equal(readbackBuffer.destroyed, false);
    assert.equal(deviceDestroyed, false);

    releaseMap.resolve();
    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.sampleCount, 4);
    assert.equal(readbackBuffer.destroyed, true);
    assert.equal(deviceDestroyed, false, "caller-owned devices must remain alive");
  } finally {
    releaseMap.resolve();
    for (const [name, value] of Object.entries(originalConstants)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

test("uses a supplied device without requiring navigator.gpu or an adapter", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const analyzer = await createWebGpuAnalyzer({ device });
    const result = await analyzer.analyze({ width: 1, height: 1 }, { waveformWidth: 1, waveformHeight: 16, vectorscopeSize: 64 });
    assert.equal(result.sampleCount, 1);
    assert.equal(device.state.copyCalls, 1);
    analyzer.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(device.state.deviceDestroyCalls, 0);
  } finally {
    restore();
  }
});

test("uploads canonical RGBA pixel sources instead of using external-image conversion", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const analyzer = await createWebGpuAnalyzer({ device });
    const result = await analyzer.analyze({
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
    }, { waveformWidth: 2, waveformHeight: 16, vectorscopeSize: 64 });
    assert.equal(result.sampleCount, 2);
    assert.equal(device.state.writeTextureCalls, 1);
    assert.equal(device.state.copyCalls, 0);
    analyzer.destroy();
  } finally {
    restore();
  }
});

test("qualifies every external video frame and binds the corrected linear sampler", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const analyzer = await createWebGpuAnalyzer({ device });
    const firstFrame = { displayWidth: 2, displayHeight: 1, format: "NV12", colorSpace: {primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: false} };
    const secondFrame = { ...firstFrame };
    const options = { waveformWidth: 2, waveformHeight: 16, vectorscopeSize: 64 };

    const first = await analyzer.analyzeVideo(firstFrame, options);
    const second = await analyzer.analyzeVideo(secondFrame, options);

    assert.equal(first.sampleCount, 2);
    assert.equal(second.sampleCount, 2);
    assert.deepEqual(device.state.externalTextureImports, [
      { source: firstFrame, colorSpace: "srgb" },
      { source: firstFrame, colorSpace: "srgb" },
      { source: secondFrame, colorSpace: "srgb" },
      { source: secondFrame, colorSpace: "srgb" },
    ]);
    assert.equal(device.state.copyCalls, 0);
    assert.equal(device.state.writeTextureCalls, 0);
    assert.equal(device.state.textureCreates, 0);
    assert.equal(device.state.shaderCodes.length, 3, "probe and histogram pipelines are each created once");
    assert.match(device.state.shaderCodes[2], /var inputTexture: texture_external;/);
    assert.match(device.state.shaderCodes[2], /textureSampleBaseClampToEdge/);
    assert.match(device.state.shaderCodes[2], /undoAppleTransfer/);
    assert.equal(device.state.bindGroupCreates, 4, "each frame gets fresh probe and histogram bindings");
    analyzer.destroy();
  } finally {
    restore();
  }
});

test("createScopes sends a VideoFrame snapshot to the WebGPU external-texture path", async () => {
  const restore = installGpuConstants();
  const previousVideoFrame = globalThis.VideoFrame;
  const snapshots = [];
  class FakeVideoFrame {
    constructor(source) {
      this.displayWidth = source.videoWidth;
      this.displayHeight = source.videoHeight;
      this.format = "NV12";
      this.colorSpace = {primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: false};
      this.closed = false;
      snapshots.push(this);
    }

    close() { this.closed = true; }
  }
  globalThis.VideoFrame = FakeVideoFrame;
  try {
    const device = mockDevice();
    const scopes = await createScopes({ backend: "webgpu", device, autoRender: false, videoTextureMode: "external" });
    const result = await scopes.update({ videoWidth: 2, videoHeight: 1, currentTime: 0 }, {
      waveformWidth: 2,
      waveformHeight: 16,
      vectorscopeSize: 64,
    });

    assert.equal(result.stats.performance.backend, "webgpu");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].closed, true, "the snapshot remains alive through GPU readback and is then closed");
    assert.equal(device.state.externalTextureImports.length, 2);
    assert.strictEqual(device.state.externalTextureImports[0].source, snapshots[0]);
    assert.equal(device.state.copyCalls, 0);
    assert.equal(device.state.writeTextureCalls, 0);
    scopes.destroy();
  } finally {
    if (previousVideoFrame === undefined) delete globalThis.VideoFrame;
    else globalThis.VideoFrame = previousVideoFrame;
    restore();
  }
});

test("createScopes separates asynchronous analysis, automatic rendering, and total update timing", async () => {
  const restoreGpu = installGpuConstants();
  const originalPerformance = globalThis.performance;
  let now = 0;
  globalThis.performance = { now: () => now };
  const mapStarted = deferred();
  const mapGate = deferred();
  let renderCalls = 0;
  const context = {
    canvas: { width: 320, height: 180 },
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() { renderCalls += 1; now += 5; },
    fillRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText() {}, arc() {}, fill() {},
  };
  try {
    const device = mockDevice({ mapStarted, mapGate });
    const scopes = await createScopes({ backend: "webgpu", device, canvas: context });
    const pending = scopes.update({ width: 1, height: 1 }, {
      waveformWidth: 1,
      waveformHeight: 16,
      vectorscopeSize: 64,
    });
    await mapStarted.promise;
    now = 23;
    mapGate.resolve();
    const result = await pending;
    const performanceStats = result.stats.performance;
    assert.equal(performanceStats.frameTimeMs, 23, "legacy timing ends after analysis and before rendering");
    assert.equal(performanceStats.analysisTimeMs, 23, "analysis timing includes the asynchronous histogram readback wait");
    assert.equal(performanceStats.captureTimeMs, 0);
    assert.equal(performanceStats.renderTimeMs, renderCalls * 5);
    assert.equal(performanceStats.updateTimeMs, 23 + renderCalls * 5);

    const previousTiming = { ...performanceStats };
    scopes.render();
    assert.deepEqual(result.stats.performance, previousTiming, "standalone render does not rewrite update timing");
    scopes.destroy();

    const noRenderScopes = await createScopes({ backend: "cpu", autoRender: false });
    const noRenderResult = await noRenderScopes.update({
      width: 1,
      height: 1,
      data: new Uint8Array([0, 0, 0, 255]),
    });
    assert.equal(noRenderResult.stats.performance.renderTimeMs, 0);
    noRenderScopes.destroy();
  } finally {
    globalThis.performance = originalPerformance;
    restoreGpu();
  }
});

test("createScopes times source capture and keeps failed GPU work in the CPU fallback update", async () => {
  const restoreConstants = installGpuConstants();
  const originalPerformance = globalThis.performance;
  const originalVideoFrame = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
  let now = 0;
  globalThis.performance = { now: () => now };
  class FakeVideoFrame {
    constructor(source) {
      this.displayWidth = source.videoWidth;
      this.displayHeight = source.videoHeight;
      now += 4;
    }
    async copyTo(destination) {
      now += 9;
      destination.set([32, 64, 96, 255]);
    }
    close() {}
  }
  globalThis.VideoFrame = FakeVideoFrame;
  const mapStarted = deferred();
  const mapGate = deferred();
  let scopes;
  try {
    scopes = await createScopes({
      backend: "auto",
      device: mockDevice({ mapStarted, mapGate, mapThrows: true }),
      videoTextureMode: "external",
      autoRender: false,
    });
    const pending = scopes.update({ videoWidth: 1, videoHeight: 1, currentTime: 0 });
    await mapStarted.promise;
    now = 20;
    mapGate.resolve();
    const result = await pending;
    const performanceStats = result.stats.performance;

    assert.equal(performanceStats.backend, "cpu");
    assert.equal(performanceStats.captureTimeMs, 13, "VideoFrame snapshot and fallback pixel readback are capture work");
    assert.equal(performanceStats.analysisTimeMs, 16, "failed asynchronous GPU work remains in analysis time");
    assert.equal(performanceStats.frameTimeMs, 29, "legacy processing time includes GPU failure and CPU fallback");
    assert.equal(performanceStats.renderTimeMs, 0);
    assert.equal(performanceStats.updateTimeMs, 29, "the full fallback path remains in total update time");
  } finally {
    scopes?.destroy();
    globalThis.performance = originalPerformance;
    if (originalVideoFrame === undefined) delete globalThis.VideoFrame;
    else Object.defineProperty(globalThis, "VideoFrame", originalVideoFrame);
    restoreConstants();
  }
});

for (const browser of ["Safari/605.1.15", "Chrome/140.0.0.0 Safari/537.36"]) {
  test(`createScopes defaults to reusable texture copies for ${browser}`, async () => {
    const restore = installGpuConstants();
    const previousVideoFrame = globalThis.VideoFrame;
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const snapshots = [];
    class FakeVideoFrame {
      constructor(source) {
        this.displayWidth = source.videoWidth;
        this.displayHeight = source.videoHeight;
        snapshots.push(this);
      }

      close() {}
    }
    globalThis.VideoFrame = FakeVideoFrame;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: browser },
    });
    try {
      const device = mockDevice();
      const scopes = await createScopes({ backend: "webgpu", device, autoRender: false });
      const result = await scopes.update({ videoWidth: 2, videoHeight: 1, currentTime: 0 }, {
        waveformWidth: 2,
        waveformHeight: 16,
        vectorscopeSize: 64,
      });

      assert.equal(scopes.videoTextureMode, "copy");
      assert.equal(result.stats.performance.backend, "webgpu");
      assert.equal(snapshots.length, 0, "the copy path does not create per-frame VideoFrame snapshots");
      assert.equal(device.state.copyCalls, 1);
      assert.equal(device.state.externalTextureImports.length, 0);
      assert.equal(device.state.textureCreates, 1);
      scopes.destroy();
    } finally {
      if (previousVideoFrame === undefined) delete globalThis.VideoFrame;
      else globalThis.VideoFrame = previousVideoFrame;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      else delete globalThis.navigator;
      restore();
    }
  });
}

test("Auto switches to CPU once when a video fallback cannot be captured", async () => {
  const restore = installGpuConstants();
  const previousVideoFrame = globalThis.VideoFrame;
  const warnings = [];
  class PixelVideoFrame {
    constructor() {
      this.displayWidth = 1;
      this.displayHeight = 1;
      this.width = 1;
      this.height = 1;
      this.data = new Uint8Array([255, 0, 0, 255]);
    }

    close() {}
  }
  globalThis.VideoFrame = PixelVideoFrame;
  try {
    const device = mockDevice({ importExternalTextureThrows: true });
    const scopes = await createScopes({ backend: "auto", device, autoRender: false, videoTextureMode: "external", onWarning: (message) => warnings.push(message) });
    const result = await scopes.update({ videoWidth: 1, videoHeight: 1, currentTime: 0 }, {
      waveformWidth: 1,
      waveformHeight: 16,
      vectorscopeSize: 64,
    });

    assert.equal(scopes.backend, "cpu");
    assert.equal(result.stats.performance.backend, "cpu");
    assert.equal(result.sampleCount, 1);
    assert.equal(device.state.externalTextureImports.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /switching to CPU.*Raw pixel frames/);
    scopes.destroy();
  } finally {
    if (previousVideoFrame === undefined) delete globalThis.VideoFrame;
    else globalThis.VideoFrame = previousVideoFrame;
    restore();
  }
});

test("reuses the GPU texture view, bind group, and histogram buffers for stable frame shapes", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const analyzer = await createWebGpuAnalyzer({ device });
    const options = { waveformMode: "rgb-parade", waveformWidth: 8, waveformHeight: 16, vectorscopeSize: 8 };
    await analyzer.analyze({ width: 4, height: 4 }, options);
    await analyzer.analyze({ width: 4, height: 4 }, options);
    assert.equal(device.state.textureCreates, 1);
    assert.equal(device.state.bindGroupCreates, 1);
    assert.equal(device.state.bufferCreates, 3, "parameter, histogram, and staging buffers are allocated once");

    await analyzer.analyze({ width: 4, height: 4 }, { ...options, waveformMode: "luma" });
    assert.equal(device.state.bindGroupCreates, 2, "a changed histogram layout gets a new bind group");
    assert.equal(device.state.bufferCreates, 5, "only the histogram and staging buffers change with the layout");
    analyzer.destroy();
  } finally {
    restore();
  }
});

test("balances validation scopes after synchronous GPU failures", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice({ copyThrows: true });
    const analyzer = await createWebGpuAnalyzer({ device });
    await assert.rejects(analyzer.analyze({ width: 1, height: 1 }), /synthetic copy error/);
    assert.equal(device.state.pushes, device.state.pops);
    analyzer.destroy();
  } finally {
    restore();
  }
});

test("destroys an internally acquired device when initialization fails", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice({ initializationThrows: true });
    const adapter = { async requestDevice() { return device; } };
    await assert.rejects(createWebGpuAnalyzer({ adapter }), /synthetic initialization error/);
    assert.equal(device.state.pushes, device.state.pops);
    assert.equal(device.state.deviceDestroyCalls, 1);
  } finally {
    restore();
  }
});

test("unmaps after mapped-range access fails and validates limits before allocation", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice({ rangeThrows: true });
    const analyzer = await createWebGpuAnalyzer({ device });
    await assert.rejects(analyzer.analyze({ width: 1, height: 1 }, { waveformWidth: 1, waveformHeight: 16, vectorscopeSize: 64 }), /mapped range/);
    assert.equal(device.state.unmaps, 1);
    analyzer.destroy();

    const limited = mockDevice({ limits: { maxStorageBufferBindingSize: 64 } });
    const limitedAnalyzer = await createWebGpuAnalyzer({ device: limited });
    await assert.rejects(limitedAnalyzer.analyze({ width: 1, height: 1 }), /limits/);
    assert.equal(limited.state.textureCreates, 0);
    limitedAnalyzer.destroy();
  } finally {
    restore();
  }
});

test("device loss rejects pending readback without waiting for mapping", async () => {
  const restore = installGpuConstants();
  try {
    const lost = deferred();
    const mapStarted = deferred();
    const mapGate = deferred();
    const device = mockDevice({ lost: lost.promise, mapStarted, mapGate });
    const analyzer = await createWebGpuAnalyzer({ device });
    const pending = analyzer.analyze({ width: 1, height: 1 }, { waveformWidth: 1, waveformHeight: 16, vectorscopeSize: 64 });
    await mapStarted.promise;
    lost.resolve({ message: "synthetic device loss" });
    await assert.rejects(pending, /synthetic device loss/);
    analyzer.destroy();
    mapGate.resolve();
  } finally {
    restore();
  }
});

test("caller input validation does not demote Auto WebGPU", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const warnings = [];
    const scopes = await createScopes({ backend: "auto", device, onWarning: (message) => warnings.push(message) });
    await assert.rejects(scopes.update({ width: 1, height: 1, data: new Uint8Array(1) }), /truncated/);
    assert.equal(scopes.backend, "webgpu");
    await assert.rejects(scopes.update({ width: 1, height: 1 }, { region: { x: 0.9, y: 0, width: 0.2, height: 1 } }), /region/);
    assert.equal(scopes.backend, "webgpu");
    assert.equal(device.state.copyCalls, 0);
    assert.deepEqual(warnings, []);
    scopes.destroy();
  } finally {
    restore();
  }
});

test("Auto falls back once on GPU failure while explicit WebGPU rejects", async () => {
  const restore = installGpuConstants();
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({ width: this.width, height: this.height, data: new Uint8Array([20, 30, 40, 255]) }),
      };
    }
  };
  try {
    const autoDevice = mockDevice({ copyThrows: true });
    const warnings = [];
    const auto = await createScopes({ backend: "auto", device: autoDevice, onWarning: (message) => warnings.push(message) });
    const result = await auto.update({ width: 1, height: 1 });
    assert.equal(result.sampleCount, 1);
    assert.equal(auto.backend, "cpu");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /frame analysis failed/);
    auto.destroy();

    const explicit = await createScopes({ backend: "webgpu", device: mockDevice({ copyThrows: true }) });
    await assert.rejects(explicit.update({ width: 1, height: 1 }), /synthetic copy error/);
    assert.equal(explicit.backend, "webgpu");
    explicit.destroy();
  } finally {
    if (originalOffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = originalOffscreenCanvas;
    restore();
  }
});

test("destroying during pending analysis never publishes or renders the result", async () => {
  const restore = installGpuConstants();
  try {
    const mapStarted = deferred();
    const mapGate = deferred();
    const device = mockDevice({ mapStarted, mapGate });
    let renders = 0;
    const context = {
      canvas: { width: 320, height: 180 },
      createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData() { renders += 1; }, fillRect() {}, save() {}, restore() {}, setLineDash() {},
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, arc() {}, fill() {},
    };
    const scopes = await createScopes({ backend: "webgpu", device, canvas: context });
    const first = scopes.update({ width: 1, height: 1 });
    const second = scopes.update({ width: 2, height: 2 });
    assert.equal(first, second, "overlapping calls share the pending update promise");
    await mapStarted.promise;
    scopes.destroy();
    mapGate.resolve();
    await assert.rejects(first, /destroyed/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scopes.result, undefined);
    assert.equal(renders, 0);
    scopes.destroy();
  } finally {
    restore();
  }
});


test("external qualification failure uses the canvas path without demoting WebGPU", async () => {
  const restore = installGpuConstants();
  let analyzer;
  try {
    const device = mockDevice({probeSamples: () => new Float32Array(512)});
    analyzer = await createWebGpuAnalyzer({device});
    const source = {nodeName: "VIDEO", displayWidth: 2, displayHeight: 1, format: "NV12",
      colorSpace: {primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: false}};
    const result = await analyzer.analyzeVideo(source, {waveformWidth: 2, waveformHeight: 16, vectorscopeSize: 64});
    assert.equal(result.stats.videoColorMode, "canvas");
    assert.equal(device.state.externalTextureImports.length, 1, "only the probe imports externally");
    assert.equal(device.state.copyCalls, 1);
    assert.equal(device.state.textureCreates, 1);
  } finally { analyzer?.destroy(); restore(); }
});
