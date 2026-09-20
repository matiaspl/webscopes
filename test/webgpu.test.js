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
  };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16 };
  globalThis.GPUMapMode = { READ: 1 };
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
  };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16 };
  globalThis.GPUMapMode = { READ: 1 };

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

test("analyzes video through an sRGB external texture without copying the frame to CPU", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const analyzer = await createWebGpuAnalyzer({ device });
    const firstFrame = { displayWidth: 2, displayHeight: 1 };
    const secondFrame = { displayWidth: 2, displayHeight: 1 };
    const options = { waveformWidth: 2, waveformHeight: 16, vectorscopeSize: 64 };

    const first = await analyzer.analyzeVideo(firstFrame, options);
    const second = await analyzer.analyzeVideo(secondFrame, options);

    assert.equal(first.sampleCount, 2);
    assert.equal(second.sampleCount, 2);
    assert.deepEqual(device.state.externalTextureImports, [
      { source: firstFrame, colorSpace: "srgb" },
      { source: secondFrame, colorSpace: "srgb" },
    ]);
    assert.equal(device.state.copyCalls, 0);
    assert.equal(device.state.writeTextureCalls, 0);
    assert.equal(device.state.textureCreates, 0);
    assert.equal(device.state.shaderCodes.length, 2, "the external-texture compute pipeline is created once");
    assert.match(device.state.shaderCodes[1], /var inputTexture: texture_external;/);
    assert.match(device.state.shaderCodes[1], /textureLoad\(inputTexture, vec2<i32>\(i32\(sourceX\), i32\(sourceY\)\)\)/);
    assert.equal(device.state.bindGroupCreates, 2, "each per-frame external texture gets a fresh bind group");
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
      this.closed = false;
      snapshots.push(this);
    }

    close() { this.closed = true; }
  }
  globalThis.VideoFrame = FakeVideoFrame;
  try {
    const device = mockDevice();
    const scopes = await createScopes({ backend: "webgpu", device, autoRender: false });
    const result = await scopes.update({ videoWidth: 2, videoHeight: 1, currentTime: 0 }, {
      waveformWidth: 2,
      waveformHeight: 16,
      vectorscopeSize: 64,
    });

    assert.equal(result.stats.performance.backend, "webgpu");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].closed, true, "the snapshot remains alive through GPU readback and is then closed");
    assert.equal(device.state.externalTextureImports.length, 1);
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

test("createScopes uses reusable texture copies for Safari video inputs by default", async () => {
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
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" },
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
    assert.equal(snapshots.length, 0, "Safari's copy path does not create per-frame VideoFrame snapshots");
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

test("Auto switches to CPU once when external video textures are unavailable", async () => {
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
    const scopes = await createScopes({ backend: "auto", device, autoRender: false, onWarning: (message) => warnings.push(message) });
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
    assert.match(warnings[0], /switching to CPU.*external-texture import error/);
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
