import test from "node:test";
import assert from "node:assert/strict";
import { canQualifyVideo, selectVideoTransfer, createVideoColorQualifier } from "../src/video-color.js";

const frame = { format: "NV12", displayWidth: 64, displayHeight: 64,
  colorSpace: { primaries: "bt709", matrix: "bt709", transfer: "bt709", fullRange: false } };
const reference = new Uint8Array([8, 32, 128, 255, 224, 64, 160, 255]);
function candidates(best) {
  return new Float32Array(Array.from({length: 16}, (_, i) => {
    const pixel = Math.floor(i / 8), component = i % 4;
    const code = reference[pixel * 4 + component];
    return (code + (Math.floor(i / 4) % 2 === best ? 0 : -4)) / 255;
  }));
}

test("selects identity or Apple inverse from actual samples, not metadata", () => {
  assert.equal(selectVideoTransfer(reference, candidates(0)), 0);
  assert.equal(selectVideoTransfer(reference, candidates(1)), 1);
});

test("fails closed for ambiguity, isolated mismatches, nonfinite samples and alpha", () => {
  assert.equal(selectVideoTransfer(new Uint8Array([0, 0, 0, 255]), new Float32Array(8)), null);
  const close = candidates(0); close[4] = close[0]; close[5] = close[1]; close[6] = close[2];
  close[12] = close[8]; close[13] = close[9]; close[14] = close[10];
  assert.equal(selectVideoTransfer(reference, close), null);
  const bad = candidates(1); bad[4] += 2 / 255;
  assert.equal(selectVideoTransfer(reference, bad), null);
  bad[4] = NaN;
  assert.equal(selectVideoTransfer(reference, bad), null);
  const alpha = reference.slice(); alpha[3] = 128;
  assert.equal(selectVideoTransfer(alpha, candidates(0)), null);
  assert.equal(selectVideoTransfer(reference, new Float32Array(0)), null);
});

test("only considers known SDR NV12 color spaces", () => {
  assert.equal(canQualifyVideo(frame), true);
  assert.equal(canQualifyVideo({...frame, colorSpace: {...frame.colorSpace, transfer: "iec61966-2-1"}}), true);
  for (const change of [{format: "I420"}, {colorSpace: {}}, {colorSpace: {...frame.colorSpace, transfer: "pq"}},
    {colorSpace: {...frame.colorSpace, matrix: "bt2020-ncl"}}, {colorSpace: {...frame.colorSpace, fullRange: null}}]) {
    assert.equal(canQualifyVideo({...frame, ...change}), false);
  }
});

test("probe failure resets partially allocated resources and retries safely", async () => {
  const saved = { OffscreenCanvas: globalThis.OffscreenCanvas, GPUBufferUsage: globalThis.GPUBufferUsage };
  let buffers = 0, destroyed = 0, scopes = 0;
  globalThis.OffscreenCanvas = class { getContext() { return {drawImage() {}, getImageData() { return {data: new Uint8Array(256)}; }}; } };
  globalThis.GPUBufferUsage = {STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8};
  const device = {
    importExternalTexture() {}, pushErrorScope() { scopes++; }, async popErrorScope() { scopes--; },
    createComputePipeline() { return {}; }, createShaderModule() {}, createSampler() {},
    createBuffer() { if (++buffers % 2 === 0) throw new Error("allocation failed"); return {destroy() { destroyed++; }}; },
  };
  const qualifier = createVideoColorQualifier(device);
  try {
    assert.equal(await qualifier.qualify(frame), null);
    assert.equal(await qualifier.qualify(frame), null);
    assert.equal(buffers, 4);
    assert.equal(destroyed, 2);
    assert.equal(scopes, 0);
  } finally {
    qualifier.destroy();
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete globalThis[key] : globalThis[key] = value;
  }
});

test("device loss settles a pending probe map and releases its buffers", async () => {
  const saved = { OffscreenCanvas: globalThis.OffscreenCanvas, GPUBufferUsage: globalThis.GPUBufferUsage, GPUMapMode: globalThis.GPUMapMode };
  let lose, started, destroyed = 0;
  const mapStarted = new Promise(resolve => { started = resolve; });
  globalThis.OffscreenCanvas = class { getContext() { return {drawImage() {}, getImageData() { return {data: new Uint8Array(256)}; }}; } };
  globalThis.GPUBufferUsage = {STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8};
  globalThis.GPUMapMode = {READ: 1};
  const device = {
    lost: new Promise(resolve => { lose = resolve; }),
    importExternalTexture() {}, pushErrorScope() {}, async popErrorScope() {},
    createComputePipeline() { return {getBindGroupLayout() {}}; }, createShaderModule() {}, createSampler() {},
    createBindGroup() {}, queue: {submit() {}},
    createCommandEncoder() { return {beginComputePass() {return {setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {}};}, copyBufferToBuffer() {}, finish() {}}; },
    createBuffer() { return {destroy() { destroyed++; }, mapAsync() {started(); return new Promise(() => {});}}; },
  };
  const qualifier = createVideoColorQualifier(device);
  try {
    const pending = qualifier.qualify(frame);
    await mapStarted; lose({});
    assert.equal(await pending, null);
    assert.equal(destroyed, 2);
    assert.equal(await qualifier.qualify(frame), null);
    qualifier.destroy();
    assert.equal(destroyed, 2, "buffers are released only once");
  } finally {
    qualifier.destroy();
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete globalThis[key] : globalThis[key] = value;
  }
});
