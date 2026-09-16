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
    bindGroupCreates: 0,
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
      writeBuffer() {},
      submit() {},
    },
    createShaderModule() {
      if (overrides.initializationThrows) throw new Error("synthetic initialization error");
      return {};
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
    createBindGroup() {
      state.bindGroupCreates += 1;
      return {};
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
