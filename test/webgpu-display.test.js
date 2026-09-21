import test from "node:test";
import assert from "node:assert/strict";
import { createScopeDisplay } from "../src/index.js";

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
  globalThis.GPUBufferUsage = { STORAGE: 1, MAP_READ: 2, COPY_DST: 4, COPY_SRC: 8, UNIFORM: 16 };
  globalThis.GPUMapMode = { READ: 1 };
  return () => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  };
}

function mock2dCanvas(width, height) {
  const canvas = { width, height };
  const context = {
    canvas,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "10px monospace",
    textAlign: "left",
    textBaseline: "top",
    save() {}, restore() {}, clearRect() {}, fillRect() {}, fillText() {}, stroke() {}, beginPath() {},
    moveTo() {}, lineTo() {}, arc() {}, fill() {}, setLineDash() {},
    getImageData(_x, _y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
  };
  canvas.getContext = (kind) => kind === "2d" ? context : null;
  return canvas;
}

function makeCanvas() {
  const context = {
    configureCalls: 0,
    unconfigureCalls: 0,
    configure() { this.configureCalls += 1; },
    unconfigure() { this.unconfigureCalls += 1; },
    getCurrentTexture() { return { createView() { return {}; } }; },
  };
  const ownerDocument = { createElement: () => mock2dCanvas(1, 1) };
  const canvas = {
    width: 160,
    height: 100,
    ownerDocument,
    getContext(kind) { return kind === "webgpu" ? context : null; },
  };
  return { canvas, context };
}

function mockDevice(options = {}) {
  const state = {
    buffers: [],
    mapCalls: 0,
    submissions: 0,
    deviceDestroyCalls: 0,
    textures: [],
    shaders: [],
    submittedWork: [],
    validationPops: 0,
    uploads: [],
  };
  const limits = {
    maxTextureDimension2D: 8192,
    maxComputeWorkgroupsPerDimension: 65535,
    maxBufferSize: 1 << 28,
    maxStorageBufferBindingSize: 1 << 27,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 8,
  };
  const queue = {
    copyExternalImageToTexture(source) { state.uploads.push(source); },
    writeTexture() {},
    writeBuffer(buffer, offset, bytes) {
      if (buffer?.memory && bytes?.byteLength) new Uint8Array(buffer.memory, offset, bytes.byteLength).set(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength));
    },
    submit(commands) {
      state.submissions += 1;
      for (const command of commands) command?.run?.();
    },
    onSubmittedWorkDone() {
      const gate = options.workGates?.[state.submittedWork.length];
      if (gate) {
        state.submittedWork.push(gate);
        return gate.promise;
      }
      return Promise.resolve();
    },
  };
  const device = {
    limits,
    lost: options.lost ?? new Promise(() => {}),
    queue,
    createShaderModule({ code }) { state.shaders.push(code); return { code }; },
    createComputePipeline() { return { getBindGroupLayout() { return {}; } }; },
    createRenderPipeline() { return { getBindGroupLayout() { return {}; } }; },
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroy() { texture.destroyed = true; },
        createView() { return { texture }; },
      };
      state.textures.push(texture);
      return texture;
    },
    createBuffer({ size, usage }) {
      const buffer = {
        size,
        usage,
        memory: new ArrayBuffer(size),
        destroy() { buffer.destroyed = true; },
        async mapAsync() { if (usage & globalThis.GPUBufferUsage.MAP_READ) state.mapCalls += 1; },
        getMappedRange() { return buffer.memory; },
        unmap() {},
      };
      state.buffers.push(buffer);
      return buffer;
    },
    createBindGroup() { return {}; },
    importExternalTexture({ source }) { return { source }; },
    createCommandEncoder() {
      const commands = [];
      return {
        clearBuffer(buffer) { commands.push(() => new Uint8Array(buffer.memory).fill(0)); },
        beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; },
        beginRenderPass() { return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }; },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
          commands.push(() => new Uint8Array(destination.memory, destinationOffset, size).set(new Uint8Array(source.memory, sourceOffset, size)));
        },
        finish() { return { run() { for (const command of commands) command(); } }; },
      };
    },
    pushErrorScope() {},
    async popErrorScope() {
      const gate = options.validationGates?.[state.validationPops++];
      return gate ? gate.promise : null;
    },
    destroy() { state.deviceDestroyCalls += 1; },
  };
  device.state = state;
  return device;
}

function fixture() {
  return { width: 4, height: 3, nodeName: "IMG" };
}

test("ScopeDisplay normalizes default video uploads through a reusable sRGB canvas", async () => {
  const restore = installGpuConstants();
  const previousCanvas = globalThis.OffscreenCanvas;
  const captures = [];
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext(kind, options) {
      assert.equal(kind, "2d");
      assert.equal(options.colorSpace, "srgb");
      const context = mock2dCanvas(this.width, this.height).getContext("2d");
      context.drawImage = (source) => captures.push(source);
      return context;
    }
  };
  let display;
  try {
    const device = mockDevice();
    display = await createScopeDisplay({ canvas: makeCanvas().canvas, device });
    const video = { videoWidth: 4, videoHeight: 2, nodeName: "VIDEO" };
    for (let i = 0; i < 2; i += 1) {
      await display.present(video, { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(captures, [video, video]);
    const videoUploads = device.state.uploads.filter(({ source }) => source.width === 4);
    assert.equal(videoUploads.length, 2);
    assert.ok(videoUploads[0].source instanceof globalThis.OffscreenCanvas);
    assert.strictEqual(videoUploads[0].source, videoUploads[1].source);
  } finally {
    await display?.destroy();
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousCanvas;
    restore();
  }
});

test("ScopeDisplay requires a canvas with a fresh WebGPU context", async () => {
  const restore = installGpuConstants();
  try {
    await assert.rejects(createScopeDisplay({ canvas: { getContext: () => null }, device: mockDevice() }), /fresh canvas/);
  } finally {
    restore();
  }
});

test("present submits without mapping bins and snapshot reads an owned result on demand", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const { canvas, context } = makeCanvas();
    const display = await createScopeDisplay({ canvas, device, videoTextureMode: "copy" });
    const presented = await display.present(fixture(), { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64, waveformMode: "luma" });
    assert.equal(presented.status, "submitted");
    assert.equal(presented.metadata.sampleCount, 12);
    assert.equal("channels" in presented.metadata.waveform, false);
    assert.equal(device.state.mapCalls, 0, "ordinary presentations must not map histogram data");
    assert.equal(display.submittedFrames, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(display.queueCompletedFrames, 1);

    const first = await display.snapshot();
    assert.equal(device.state.mapCalls, 1);
    assert.equal(first.sampleCount, 12);
    assert.equal(first.waveform.channels.length, 1);
    assert.equal(first.waveform.channels[0].length, 16 * 16);
    const second = await display.snapshot();
    assert.notStrictEqual(first.waveform.channels[0], second.waveform.channels[0]);
    first.waveform.channels[0][0] = 777;
    assert.equal(second.waveform.channels[0][0], 0, "snapshots own independent histogram arrays");
    assert.match(device.state.shaders[0], /atomicAdd/);
    await display.destroy();
    assert.equal(device.state.deviceDestroyCalls, 0, "caller-owned device remains alive");
    assert.equal(context.unconfigureCalls, 1);
  } finally {
    restore();
  }
});

test("ScopeDisplay bounds in-flight frames to two and settles the newest pending request", async () => {
  const restore = installGpuConstants();
  try {
    const gates = [deferred(), deferred(), deferred()];
    const device = mockDevice({ workGates: gates });
    const { canvas } = makeCanvas();
    const display = await createScopeDisplay({ canvas, device, videoTextureMode: "copy" });
    const options = { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 };
    const first = await display.present(fixture(), options);
    const second = await display.present(fixture(), options);
    assert.equal(device.state.submissions, 2);
    const replaced = display.present(fixture(), options);
    const newest = display.present(fixture(), options);
    assert.deepEqual(await replaced, { status: "superseded" });
    assert.equal(device.state.submissions, 2, "one pending replacement waits for a GPU slot");
    gates[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const latest = await newest;
    assert.equal(latest.status, "submitted");
    assert.equal(latest.frameId, 3);
    assert.equal(display.submittedFrames, 3);
    assert.equal(first.frameId, 1);
    assert.equal(second.frameId, 2);
    gates[1].resolve();
    gates[2].resolve();
    await display.destroy();
  } finally {
    restore();
  }
});

test("destroy waits for submitted queue work and never destroys a caller-owned device", async () => {
  const restore = installGpuConstants();
  try {
    const gate = deferred();
    const device = mockDevice({ workGates: [gate] });
    const { canvas } = makeCanvas();
    const display = await createScopeDisplay({ canvas, device, videoTextureMode: "copy" });
    await display.present(fixture(), { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 });
    const destroyed = display.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(device.state.deviceDestroyCalls, 0);
    gate.resolve();
    await destroyed;
    assert.equal(device.state.deviceDestroyCalls, 0);
  } finally {
    restore();
  }
});

test("destroy retains resources when submission is followed by an asynchronous validation error", async () => {
  const restore = installGpuConstants();
  try {
    const validationGate = deferred();
    const workGate = deferred();
    const device = mockDevice({
      validationGates: [undefined, undefined, validationGate],
      workGates: [workGate],
    });
    const { canvas } = makeCanvas();
    const display = await createScopeDisplay({ canvas, device, videoTextureMode: "copy" });
    const submitted = display.present(fixture(), { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(device.state.submissions, 1);
    const destroyed = display.destroy();
    validationGate.resolve(null);
    await assert.rejects(submitted, /destroyed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(device.state.buffers.some((buffer) => buffer.destroyed), false, "queued buffers stay alive until their queue fence settles");
    workGate.resolve();
    await destroyed;
    assert.equal(device.state.buffers.every((buffer) => buffer.destroyed), true);
  } finally {
    restore();
  }
});

test("device loss rejects new work and allows teardown to finish", async () => {
  const restore = installGpuConstants();
  try {
    const lost = deferred();
    const workGate = deferred();
    const lossEvents = [];
    const device = mockDevice({ lost: lost.promise, workGates: [workGate] });
    const { canvas } = makeCanvas();
    const display = await createScopeDisplay({
      canvas,
      device,
      videoTextureMode: "copy",
      onDeviceLost: (error) => lossEvents.push(error.message),
    });
    await display.present(fixture(), { waveformWidth: 16, waveformHeight: 16, vectorscopeSize: 64 });
    lost.resolve({ message: "test device loss" });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(display.present(fixture()), /device lost/);
    assert.match(lossEvents[0], /test device loss/);
    await display.destroy();
    assert.equal(device.state.deviceDestroyCalls, 0, "caller-owned lost device stays caller-owned");
  } finally {
    restore();
  }
});

test("destroy releases a display-owned device", async () => {
  const restore = installGpuConstants();
  try {
    const device = mockDevice();
    const { canvas } = makeCanvas();
    const display = await createScopeDisplay({ canvas, adapter: { requestDevice: async () => device } });
    await display.destroy();
    assert.equal(device.state.deviceDestroyCalls, 1);
  } finally {
    restore();
  }
});
