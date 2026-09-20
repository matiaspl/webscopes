import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrame, createScopes, getDefaultScopesConfig, renderScopes } from "../src/index.js";
import { readFramePixelsAsync } from "../src/analyze.js";

function frame(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.flat().forEach((rgb, index) => {
    data.set([...rgb, 255], index * 4);
  });
  return { data, width, height };
}

function packV210(y, cb, cr) {
  const words = [
    cb[0] | (y[0] << 10) | (cr[0] << 20),
    y[1] | (cb[1] << 10) | (y[2] << 20),
    cr[1] | (y[3] << 10) | (cb[2] << 20),
    y[4] | (cr[2] << 10) | (y[5] << 20),
  ];
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word >>> 0, true));
  return data;
}

test("analyzes waveform channels and vectorscope sample counts", () => {
  const input = frame([[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [255, 255, 255]]]);
  const result = analyzeFrame(input, { waveformWidth: 2, waveformHeight: 256, vectorscopeSize: 64 });
  assert.equal(result.sampleCount, 4);
  assert.equal(result.waveform.channels.length, 3);
  assert.equal(result.waveform.channelNames.join(""), "RGB");
  assert.equal(result.waveform.channels.reduce((sum, bins) => sum + bins.reduce((a, b) => a + b, 0), 0), 12);
  assert.equal(result.vectorscope.bins.reduce((a, b) => a + b, 0), 4);
  assert.equal(result.stats.clippedHigh, 1);
  assert.equal(result.stats.clippedLow, 0);
});

test("luma mode produces a single channel and honors the selected region", () => {
  const input = frame([[[0, 0, 0], [255, 255, 255]], [[255, 0, 0], [0, 0, 255]]]);
  const result = analyzeFrame(input, {
    waveformMode: "luma",
    waveformWidth: 1,
    region: { x: 0, y: 0, width: 0.5, height: 1 },
  });
  assert.equal(result.sampleCount, 2);
  assert.deepEqual(result.waveform.channelNames, ["Y"]);
  assert.equal(result.waveform.channels[0].reduce((a, b) => a + b, 0), 2);
});

test("YCbCr and composite modes expose the expected waveform planes", () => {
  const rgb = frame([[[255, 0, 0], [0, 255, 0], [0, 0, 255]], [[32, 32, 32], [235, 235, 235], [128, 64, 16]]]);
  const v210 = {
    format: "v210",
    data: packV210([64, 512, 940, 100, 200, 300], [512, 64, 960], [512, 960, 64]),
    width: 6,
    height: 1,
    bytesPerRow: 16,
  };

  for (const input of [rgb, v210]) {
    const ycbcr = analyzeFrame(input, { waveformMode: "ycbcr-parade", waveformWidth: 6, waveformHeight: 64 });
    assert.deepEqual(ycbcr.waveform.channelNames, ["Y", "Cb", "Cr"]);
    assert.equal(ycbcr.waveform.channels.length, 3);
    assert.ok(ycbcr.waveform.channels.every((channel) => channel.reduce((sum, count) => sum + count, 0) === ycbcr.sampleCount));

    const composite = analyzeFrame(input, { waveformMode: "composite", waveformWidth: 6, waveformHeight: 64 });
    assert.deepEqual(composite.waveform.channelNames, ["Composite"]);
    assert.equal(composite.waveform.channels.length, 1);
    assert.equal(composite.waveform.channels[0].reduce((sum, count) => sum + count, 0), composite.sampleCount);
  }
});

test("input resolution scaling reduces samples in both dimensions", () => {
  const input = frame(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => [128, 64, 32])));
  const result = analyzeFrame(input, { inputResolutionScaling: 0.5 });
  assert.equal(result.sampleCount, 16);
  assert.equal(result.vectorscope.bins.reduce((sum, count) => sum + count, 0), 16);
});

test("createScopes applies per-frame input resolution scaling", async () => {
  const input = frame(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => [128, 64, 32])));
  const scopes = await createScopes({ backend: "cpu" });
  const full = await scopes.update(input, { inputResolutionScaling: 1 });
  const sparse = await scopes.update(input, { inputResolutionScaling: 0.5 });
  assert.equal(full.sampleCount, 64);
  assert.equal(sparse.sampleCount, 16);
  scopes.destroy();
});

test("real-time analysis reuses an opaque WebCodecs RGBX buffer", async () => {
  const previousVideoFrame = globalThis.VideoFrame;
  const destinations = [];
  class FakeVideoFrame {
    constructor() {
      this.displayWidth = 2;
      this.displayHeight = 1;
    }

    allocationSize(options) {
      assert.equal(options.format, "RGBX");
      assert.equal(Object.hasOwn(options, "layout"), false);
      return 8;
    }

    async copyTo(destination, options) {
      assert.equal(options.format, "RGBX");
      destinations.push(destination);
      destination.set([255, 0, 0, 0, 0, 255, 0, 0]);
    }

    close() {}
  }
  globalThis.VideoFrame = FakeVideoFrame;
  try {
    const capture = {};
    const first = await readFramePixelsAsync({ videoWidth: 2, videoHeight: 1 }, capture);
    const second = await readFramePixelsAsync({ videoWidth: 2, videoHeight: 1 }, capture);
    assert.equal(first.width, 2);
    assert.equal(first.height, 1);
    assert.strictEqual(first.data, second.data);
    assert.strictEqual(destinations[0], destinations[1]);
    assert.equal(capture.videoFramePixelFormat, "RGBX");
  } finally {
    if (previousVideoFrame === undefined) delete globalThis.VideoFrame;
    else globalThis.VideoFrame = previousVideoFrame;
  }
});

test("falls back to opaque RGBA when WebCodecs does not support RGBX", async () => {
  const previousVideoFrame = globalThis.VideoFrame;
  const attemptedFormats = [];
  class RgbaOnlyVideoFrame {
    constructor() {
      this.displayWidth = 1;
      this.displayHeight = 1;
    }

    allocationSize({ format }) {
      attemptedFormats.push(format);
      return 4;
    }

    async copyTo(destination, { format }) {
      if (format === "RGBX") throw new TypeError("Unsupported pixel format");
      destination.set([12, 34, 56, 255]);
    }

    close() {}
  }
  globalThis.VideoFrame = RgbaOnlyVideoFrame;
  try {
    const capture = {};
    const result = await readFramePixelsAsync({ videoWidth: 1, videoHeight: 1 }, capture);
    assert.deepEqual([...result.data], [12, 34, 56, 255]);
    assert.deepEqual(attemptedFormats, ["RGBX", "RGBA"]);
    assert.equal(capture.videoFramePixelFormat, "RGBA");
  } finally {
    if (previousVideoFrame === undefined) delete globalThis.VideoFrame;
    else globalThis.VideoFrame = previousVideoFrame;
  }
});

test("falls back when VideoFrame RGBA readback is malformed", async () => {
  const previousVideoFrame = globalThis.VideoFrame;
  const previousOffscreenCanvas = globalThis.OffscreenCanvas;
  class BrokenVideoFrame {
    constructor() {
      this.displayWidth = 2;
      this.displayHeight = 1;
    }

    async copyTo(destination, { format }) {
      if (format === "RGBX") throw new TypeError("Unsupported pixel format");
      destination.set([10, 20, 30, 0, 40, 50, 60, 0]);
    }

    close() {}
  }
  class FakeCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      return {
        drawImage() {},
        getImageData() {
          return { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) };
        },
      };
    }
  }
  globalThis.VideoFrame = BrokenVideoFrame;
  globalThis.OffscreenCanvas = FakeCanvas;
  try {
    const capture = {};
    const result = await readFramePixelsAsync({ videoWidth: 2, videoHeight: 1 }, capture);
    assert.deepEqual([...result.data], [1, 2, 3, 255, 4, 5, 6, 255]);
    assert.equal(capture.videoFrameReadback, false);
  } finally {
    if (previousVideoFrame === undefined) delete globalThis.VideoFrame;
    else globalThis.VideoFrame = previousVideoFrame;
    if (previousOffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousOffscreenCanvas;
  }
});

test("keeps neutral chroma values on the vectorscope center axis", () => {
  const grays = frame([[[0, 0, 0], [32, 32, 32], [128, 128, 128], [235, 235, 235], [255, 255, 255]]]);
  const result = analyzeFrame(grays, { vectorscopeSize: 256, waveformWidth: 5 });
  assert.equal(result.vectorscope.bins[128 * 256 + 128], 5);
  assert.equal(result.vectorscope.bins.reduce((sum, count) => sum + count, 0), 5);
});

test("applies color-matrix overrides to decoded RGB calculations", () => {
  const input = frame([[[255, 0, 0]]]);
  const results = ["bt601", "bt709", "bt2020", "bt2100"].map((colorMatrix) => analyzeFrame(input, {
    waveformMode: "luma",
    waveformWidth: 1,
    waveformHeight: 256,
    colorMatrix,
  }));
  assert.deepEqual(results.map((result) => result.waveform.channels[0].findIndex(Boolean)), [76, 54, 67, 67]);
  assert.deepEqual(results.map((result) => result.stats.colorMatrix), ["bt601", "bt709", "bt2020", "bt2100"]);
});

test("preserves 10-bit and 12-bit Uint16 code values at their native waveform resolution", () => {
  for (const bitDepth of [10, 12]) {
    const codeMax = 2 ** bitDepth - 1;
    const input = {
      data: new Uint16Array([0, 0, 0, codeMax, codeMax, codeMax, codeMax, codeMax]),
      width: 1,
      height: 2,
    };
    const result = bitDepth === 10
      ? analyzeFrame({ ...input, bitDepth })
      : analyzeFrame(input, { bitDepth });
    const red = result.waveform.channels[0];
    assert.equal(result.waveform.bitDepth, bitDepth);
    assert.equal(result.waveform.height, codeMax + 1);
    assert.equal(red[0], 1);
    assert.equal(red[codeMax], 1);
    assert.equal(red.reduce((sum, count) => sum + count, 0), 2);
  }
});

test("unpacks v210 into native 10-bit luma/chroma scopes and 4:2:2 vectorscope samples", () => {
  const data = packV210([64, 512, 940, 100, 200, 300], [512, 64, 960], [512, 960, 64]);
  const result = analyzeFrame({ format: "v210", data, width: 6, height: 1, bytesPerRow: 16 }, {
    waveformMode: "ycbcr-parade",
    waveformWidth: 6,
    vectorscopeSize: 64,
  });

  assert.equal(result.waveform.bitDepth, 10);
  assert.equal(result.waveform.height, 1024);
  assert.equal(result.sampleCount, 6);
  for (const [x, value] of [64, 512, 940, 100, 200, 300].entries()) {
    assert.equal(result.waveform.channels[0][value * 6 + x], 1);
  }
  assert.equal(result.waveform.channels[1][512 * 6], 1);
  assert.equal(result.waveform.channels[1][64 * 6 + 2], 1);
  assert.equal(result.waveform.channels[1][960 * 6 + 4], 1);
  assert.equal(result.waveform.channels[2][512 * 6], 1);
  assert.equal(result.waveform.channels[2][960 * 6 + 2], 1);
  assert.equal(result.waveform.channels[2][64 * 6 + 4], 1);
  assert.equal(result.vectorscope.bins[32 * 64 + 32], 2);
  assert.equal(result.vectorscope.bins[0], 2);
  assert.equal(result.vectorscope.bins[63 * 64 + 63], 2);
  assert.equal(result.vectorscope.bins.reduce((sum, count) => sum + count, 0), 6);
  assert.equal(result.stats.colorRange, "limited");
});

test("converts limited and full-range v210 to RGB while preserving encoded luma bins", () => {
  const limited = packV210([64, 940, 64, 940, 64, 940], [512, 512, 512], [512, 512, 512]);
  const limitedResult = analyzeFrame({ format: "v210", data: limited, width: 6, height: 1, bytesPerRow: 16 }, {
    waveformMode: "rgb",
    waveformWidth: 6,
  });
  for (const channel of limitedResult.waveform.channels) {
    assert.equal(channel[0 * 6], 1);
    assert.equal(channel[1023 * 6 + 1], 1);
  }

  const full = packV210([0, 1023, 0, 1023, 0, 1023], [512, 512, 512], [512, 512, 512]);
  const fullResult = analyzeFrame({ format: "v210", data: full, width: 6, height: 1, bytesPerRow: 16 }, {
    waveformMode: "ycbcr-parade",
    waveformWidth: 6,
    colorRange: "full",
  });
  assert.equal(fullResult.stats.colorRange, "full");
  assert.equal(fullResult.waveform.channels[0][0], 1);
  assert.equal(fullResult.waveform.channels[0][1023 * 6 + 1], 1);
});

test("supports v210 row padding, typed-array views, ROI sampling, and createScopes", async () => {
  const storage = new Uint8Array(160).fill(0xee);
  const view = new Uint8Array(storage.buffer, 4, 144);
  view.set(packV210([64, 64, 64, 64, 64, 64], [512, 512, 512], [512, 512, 512]), 0);
  view.set(packV210([940, 940, 940, 940, 940, 940], [512, 512, 512], [512, 512, 512]), 128);
  const input = { format: "v210", data: view, width: 6, height: 2 };
  const cropped = analyzeFrame(input, { waveformMode: "luma", waveformWidth: 1, region: { x: 0, y: 0.5, width: 1, height: 0.5 } });
  assert.equal(cropped.sampleCount, 6);
  assert.equal(cropped.waveform.channels[0][940], 6);

  const scopes = await createScopes({ backend: "cpu" });
  const live = await scopes.update(input, { waveformMode: "luma", waveformWidth: 1 });
  assert.equal(live.waveform.bitDepth, 10);
  assert.equal(live.waveform.channels[0][64], 6);
  assert.equal(live.waveform.channels[0][940], 6);
  assert.equal(live.stats.performance.backend, "cpu");
  scopes.destroy();
});

test("rejects malformed v210 frames and bit-depth overrides", () => {
  const validData = packV210([64, 64, 64, 64, 64, 64], [512, 512, 512], [512, 512, 512]);
  assert.throws(() => analyzeFrame({ format: "v210", data: validData, width: 6, height: 2 }), /truncated/);
  assert.throws(() => analyzeFrame({ format: "v210", data: validData, width: 6, height: 1, bytesPerRow: 15 }), /bytesPerRow/);
  assert.throws(() => analyzeFrame({ format: "v210", data: new Uint16Array(8), width: 6, height: 1, bytesPerRow: 16 }), /Uint8Array/);
  assert.throws(() => analyzeFrame({ format: "v210", data: validData, width: 6, height: 1, bytesPerRow: 16 }, { bitDepth: 8 }), /fixed bit depth/);
  assert.throws(() => analyzeFrame({ format: "v210", data: validData, width: 6, height: 1, bytesPerRow: 16 }, { colorRange: "broadcast" }), /colorRange/);
});

test("requires an explicit bit depth for high-bit-depth RGBA samples", () => {
  const input = { data: new Uint16Array([512, 512, 512, 1023]), width: 1, height: 1 };
  assert.throws(() => analyzeFrame(input), /bitDepth is required/);
  assert.throws(() => analyzeFrame(frame([[[255, 255, 255]]]), { bitDepth: 10 }), /Uint16Array/);
  assert.throws(() => analyzeFrame(frame([[[255, 255, 255]]]), { bitDepth: 11 }), /bitDepth must be 8, 10, or 12/);
});

test("uses half-up integer source sampling for halfway positions", () => {
  const input = {
    width: 6,
    height: 1,
    data: new Uint8Array([
      0, 0, 0, 255,
      30, 0, 0, 255,
      60, 0, 0, 255,
      90, 0, 0, 255,
      120, 0, 0, 255,
      150, 0, 0, 255,
    ]),
  };
  const result = analyzeFrame(input, {
    waveformMode: "rgb",
    waveformWidth: 3,
    waveformHeight: 256,
    inputResolutionScaling: 0.5,
  });
  assert.equal(result.sampleCount, 3);
  assert.equal(result.waveform.channels[0][0 * 3], 1);
  assert.equal(result.waveform.channels[0][90 * 3 + 1], 1);
  assert.equal(result.waveform.channels[0][150 * 3 + 2], 1);
});

test("accepts padded rows, padded pixels, and typed-array views", () => {
  const storage = new Uint8Array(40).fill(0xee);
  const view = new Uint8Array(storage.buffer, 4, 32);
  view.set([255, 0, 0, 255, 0xaa, 0, 255, 0, 255, 255, 0xaa], 0);
  view.set([0, 0, 255, 255, 0xaa, 255, 255, 255, 255, 0xaa], 16);
  const result = analyzeFrame({ width: 2, height: 2, data: view, pixelStride: 5, bytesPerRow: 16 }, {
    waveformMode: "rgb",
    waveformWidth: 2,
    waveformHeight: 256,
  });
  assert.equal(result.sampleCount, 4);
  assert.ok(result.waveform.channels.every((channel) => channel.reduce((sum, count) => sum + count, 0) === 4));
  assert.equal(result.vectorscope.bins.reduce((sum, count) => sum + count, 0), 4);

  const words = new Uint16Array(24).fill(0xffff);
  words.set([0, 0, 0, 1023, 1023, 0, 0, 1023], 0);
  words.set([0, 1023, 0, 1023, 1023, 1023, 1023, 1023], 12);
  const highDepth = analyzeFrame({ width: 2, height: 2, data: words, pixelStride: 4, bytesPerRow: 24, bitDepth: 10 });
  assert.equal(highDepth.sampleCount, 4);
  assert.equal(highDepth.waveform.height, 1024);
  assert.equal(highDepth.waveform.channels[0].reduce((sum, count) => sum + count, 0), 4);
});

test("accepts clamped-byte and Float64Array input", () => {
  const clamped = analyzeFrame({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) });
  const floating = analyzeFrame({ width: 1, height: 1, data: new Float64Array([0.25, 0.5, 0.75, 1]) });
  assert.equal(clamped.sampleCount, 1);
  assert.equal(floating.sampleCount, 1);
  assert.equal(clamped.vectorscope.bins.reduce((sum, count) => sum + count, 0), 1);
  assert.equal(floating.waveform.channels[0].reduce((sum, count) => sum + count, 0), 1);
});

test("rejects malformed row and pixel layouts before histogram allocation", () => {
  const data = new Uint8Array(32);
  for (const pixels of [
    { width: 2, height: 2, data, pixelStride: 4.5, bytesPerRow: 16 },
    { width: 2, height: 2, data, pixelStride: Number.NaN, bytesPerRow: 16 },
    { width: 2, height: 2, data, pixelStride: 4, bytesPerRow: Number.POSITIVE_INFINITY },
    { width: 2, height: 2, data, pixelStride: 4, bytesPerRow: 7 },
    { width: 2, height: 2, data: new Uint8Array(16), pixelStride: 4, bytesPerRow: 16 },
    { width: 2, height: 2, data, pixelStride: 3, bytesPerRow: 16 },
    { width: 0, height: 2, data },
  ]) {
    assert.throws(() => analyzeFrame(pixels));
  }
  assert.throws(() => analyzeFrame({ width: 1, height: 1, data: [0, 0, 0, 255] }), /typed array/);
});

test("rejects non-finite sampled values and preserves finite clipping", () => {
  assert.throws(() => analyzeFrame({ width: 1, height: 1, data: new Float32Array([Number.NaN, 0, 0, 1]) }), /finite/);
  const clipped = analyzeFrame({ width: 1, height: 1, data: new Float32Array([-0.5, 0.5, 1.5, 1]) });
  assert.equal(clipped.sampleCount, 1);
  assert.ok(clipped.waveform.channels.every((channel) => channel.reduce((sum, count) => sum + count, 0) === 1));
  assert.equal(clipped.vectorscope.bins.reduce((sum, count) => sum + count, 0), 1);
});

test("rejects non-finite sampled RGB before allocating histogram buffers", () => {
  const NativeUint32Array = globalThis.Uint32Array;
  let histogramAllocations = 0;
  globalThis.Uint32Array = new Proxy(NativeUint32Array, {
    construct(target, argumentsList, newTarget) {
      histogramAllocations += 1;
      return Reflect.construct(target, argumentsList, newTarget);
    },
  });
  try {
    assert.throws(() => analyzeFrame({
      width: 3,
      height: 1,
      data: new Float32Array([0, 0, 0, 1, 0.5, 0.5, 0.5, 1, Number.POSITIVE_INFINITY, 0, 0, 1]),
    }, { inputResolutionScaling: 0.5 }), /finite/);
    assert.equal(histogramAllocations, 0);
  } finally {
    globalThis.Uint32Array = NativeUint32Array;
  }
});

test("only accepts own color-matrix names", () => {
  assert.throws(() => analyzeFrame(frame([[[0, 0, 0]]]), { colorMatrix: "toString" }), /Unsupported color matrix/);
  assert.throws(() => analyzeFrame(frame([[[0, 0, 0]]]), { colorMatrix: "constructor" }), /Unsupported color matrix/);
});

test("keeps helper defaults equivalent for source-derived input precision", () => {
  const defaults = getDefaultScopesConfig();
  assert.equal(defaults.bitDepth, undefined);
  assert.equal(defaults.waveformWidth, undefined);
  assert.equal(defaults.waveformHeight, undefined);
  for (const bitDepth of [8, 10, 12]) {
    const max = 2 ** bitDepth - 1;
    const data = bitDepth === 8
      ? new Uint8Array([0, 0, 0, 255, 127, 127, 127, 255, 255, 255, 255, 255])
      : new Uint16Array([0, 0, 0, max, Math.floor(max / 2), Math.floor(max / 2), Math.floor(max / 2), max, max, max, max, max]);
    const input = { width: 1, height: 3, data, ...(bitDepth === 8 ? {} : { bitDepth }) };
    const ordinary = analyzeFrame(input);
    const helper = analyzeFrame(input, defaults);
    assert.equal(helper.waveform.bitDepth, bitDepth);
    assert.equal(helper.waveform.height, 2 ** bitDepth);
    assert.deepEqual(helper.waveform.channels, ordinary.waveform.channels);
    assert.deepEqual(helper.vectorscope.bins, ordinary.vectorscope.bins);
  }
  const overridden = analyzeFrame({ width: 1, height: 1, bitDepth: 10, data: new Uint16Array([512, 512, 512, 1023]) }, {
    ...defaults,
    bitDepth: 10,
    waveformWidth: 1,
    waveformHeight: 16,
  });
  assert.equal(overridden.waveform.height, 16);
});

test("per-call and instance precision options override frame metadata", async () => {
  const input = {
    width: 1,
    height: 1,
    bitDepth: 12,
    data: new Uint16Array([2048, 2048, 2048, 4095]),
  };
  const direct = analyzeFrame(input, { bitDepth: 10, waveformHeight: 64 });
  assert.equal(direct.waveform.bitDepth, 10);
  assert.equal(direct.waveform.height, 64);

  const scopes = await createScopes({ backend: "cpu", bitDepth: 10, waveformHeight: 128 });
  const instanceResult = await scopes.update(input);
  assert.equal(instanceResult.waveform.bitDepth, 10);
  assert.equal(instanceResult.waveform.height, 128);
  const callResult = await scopes.update(input, { bitDepth: 8, waveformHeight: 32 });
  assert.equal(callResult.waveform.bitDepth, 8);
  assert.equal(callResult.waveform.height, 32);
  scopes.destroy();
});

test("rejects malformed input and invalid analysis settings", () => {
  assert.throws(() => analyzeFrame({ width: 1, height: 1, data: new Uint8Array(3) }), /RGBA pixel frame/);
  assert.throws(() => analyzeFrame(frame([[[0, 0, 0]]]), { colorMatrix: "mystery" }), /Unsupported color matrix/);
  assert.throws(() => analyzeFrame(frame([[[0, 0, 0]]]), { region: { x: 0.8, y: 0, width: 0.4, height: 1 } }), /region/);
  assert.throws(() => analyzeFrame(frame([[[0, 0, 0]]]), { waveformWidth: Number.NaN }), /waveformWidth/);
  assert.throws(() => analyzeFrame(frame([[[0, 0, 0]]]), { inputResolutionScaling: 1.1 }), /inputResolutionScaling/);
});

test("creates a CPU analyzer and releases it cleanly", async () => {
  const scopes = await createScopes({ backend: "cpu" });
  assert.equal(scopes.backend, "cpu");
  const result = await scopes.update(frame([[[255, 255, 255]]]));
  assert.equal(result.sampleCount, 1);
  assert.equal(result.stats.performance.backend, "cpu");
  assert.ok(result.stats.performance.frameTimeMs >= 0);
  assert.ok(result.stats.performance.fps >= 0);
  assert.ok(result.stats.performance.averageFps >= 0);
  scopes.destroy();
  await assert.rejects(scopes.update(frame([[[0, 0, 0]]])), /destroyed/);
});

test("keeps analysis alive when canvas raster allocation fails", async () => {
  const warnings = [];
  const context = {
    canvas: { width: 320, height: 180 },
    createImageData() { throw new Error("Array buffer allocation failed"); },
    putImageData() {}, fillRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText() {}, arc() {}, fill() {},
  };
  const scopes = await createScopes({ backend: "cpu", canvas: context, onWarning: (message) => warnings.push(message) });
  assert.equal((await scopes.update(frame([[[255, 0, 0]]]))).sampleCount, 1);
  assert.equal((await scopes.update(frame([[[0, 255, 0]]]))).sampleCount, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /analysis continues/);
  scopes.destroy();
  assert.equal(scopes.canvas, undefined);
});

test("createScopes analyzes high-bit-depth raw frames and reports their precision", async () => {
  const scopes = await createScopes({ backend: "cpu" });
  const result = await scopes.update({
    data: new Uint16Array([0, 0, 0, 4095, 4095, 4095, 4095, 4095]),
    width: 1,
    height: 2,
    bitDepth: 12,
  });
  assert.equal(result.waveform.bitDepth, 12);
  assert.equal(result.stats.bitDepth, 12);
  assert.equal(result.waveform.height, 4096);
  assert.equal(result.stats.performance.backend, "cpu");
  scopes.destroy();
});

test("provides conventional defaults", () => {
  const config = getDefaultScopesConfig();
  assert.equal(config.waveformMode, "rgb-parade");
  assert.equal(config.colorMatrix, "bt709");
});

test("renders waveform and vectorscope rasters to a 2D drawing context", () => {
  const result = analyzeFrame(frame([[[255, 0, 0], [0, 0, 255]], [[0, 255, 0], [255, 255, 255]]]), {
    waveformWidth: 2,
    vectorscopeSize: 64,
  });
  const painted = [];
  const labels = [];
  const context = {
    canvas: { width: 320, height: 180 },
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData(image) { painted.push(image); },
    fillRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText(text, x, y) { labels.push({ text, x, y, baseline: context.textBaseline }); }, arc() {}, fill() {},
  };
  assert.equal(renderScopes(result, context), result);
  assert.equal(painted.length, 2);
  assert.ok(painted.every((image) => image.data.some((value) => value !== 0)));
  const performanceLabel = labels.find(({ text }) => text.includes("FPS") && text.includes("ms"));
  assert.ok(performanceLabel);
  assert.ok(performanceLabel.y > context.canvas.height - 22, "performance badge sits at the bottom edge");
  assert.equal(performanceLabel.baseline, "middle");
});

test("area-filters waveform bins when rendering and supports nearest-bin opt-out", () => {
  const waveformWidth = 100;
  const waveformHeight = 16;
  const red = new Uint32Array(waveformWidth * waveformHeight);
  for (let row = 0; row < waveformHeight; row += 1) red[row * waveformWidth + 1] = 10;
  const result = {
    waveform: { width: waveformWidth, height: waveformHeight, mode: "rgb-parade", channelNames: ["R", "G", "B"], channels: [red, new Uint32Array(red.length), new Uint32Array(red.length)] },
    vectorscope: { width: 64, height: 64, bins: new Uint32Array(64 * 64), colorMatrix: "bt709" },
    stats: {},
  };
  const renderAndReadFirstPixel = (waveformAntialias) => {
    const images = [];
    const context = {
      canvas: { width: 300, height: 200 },
      createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData(image) { images.push(image); },
      fillRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      fillText() {}, arc() {}, fill() {},
    };
    renderScopes(result, context, { waveformAntialias });
    return images[0].data[0];
  };
  const filtered = renderAndReadFirstPixel(true);
  const nearest = renderAndReadFirstPixel(false);
  assert.ok(filtered > 0 && filtered < 100, `expected an averaged edge intensity, got ${filtered}`);
  assert.ok(nearest > 100, `expected the unfiltered bin intensity, got ${nearest}`);
});

test("dithers scope display pixels before 8-bit quantization without changing histograms", () => {
  const waveformWidth = 1;
  const waveformHeight = 16;
  const red = new Uint32Array(waveformWidth * waveformHeight).fill(4);
  const waveform = {
    width: waveformWidth,
    height: waveformHeight,
    mode: "rgb-parade",
    channelNames: ["R", "G", "B"],
    channels: [red, new Uint32Array(red.length), new Uint32Array(red.length)],
  };
  const vectorBins = new Uint32Array(4 * 4);
  vectorBins[0] = 4;
  const result = {
    waveform,
    vectorscope: { width: 4, height: 4, bins: vectorBins, colorMatrix: "bt709" },
    stats: {},
  };
  const renderRasters = (dither, vectorscopeDither = 0) => {
    const images = [];
    const context = {
      canvas: { width: 300, height: 200 },
      createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData(image) { images.push(image); },
      fillRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      fillText() {}, arc() {}, fill() {},
    };
    renderScopes(result, context, { dither, vectorscopeDither });
    return images;
  };
  const collectRedLevels = (image) => {
    const levels = new Set();
    for (let pixel = 0; pixel < image.data.length / 4; pixel += 1) {
      if (image.data[pixel * 4] > 8) levels.add(image.data[pixel * 4]);
    }
    return levels;
  };

  const dithered = renderRasters(0.75);
  const defaults = renderRasters(undefined);
  const clean = renderRasters(0);
  for (let scope = 0; scope < 2; scope += 1) {
    const ditheredLevels = collectRedLevels(dithered[scope]);
    const cleanLevels = collectRedLevels(clean[scope]);
    if (scope === 0) assert.ok(ditheredLevels.size > 1, "explicit waveform dither should break up flat contours");
    else assert.equal(ditheredLevels.size, 1, "vectorscope dither is disabled by default");
    assert.equal(cleanLevels.size, 1, `dither: 0 should preserve flat levels in raster ${scope}`);
    assert.ok([...ditheredLevels].every((level) => Math.abs(level - [...cleanLevels][0]) <= 1));
    assert.deepEqual(defaults[scope].data, clean[scope].data, "display dither defaults to 0");
  }

  const vectorDitheredLevels = collectRedLevels(renderRasters(0, 1)[1]);
  assert.ok(vectorDitheredLevels.size > 1, "vectorscope dither can be enabled explicitly");

  const fullDitheredWaveform = renderRasters(1)[0];
  let redSum = 0;
  let redSamples = 0;
  for (let offset = 0; offset < fullDitheredWaveform.data.length; offset += 4) {
    const value = fullDitheredWaveform.data[offset];
    if (value > 8) {
      redSum += value;
      redSamples += 1;
    }
  }
  const idealRed = 8 + 255 * Math.log1p(4 * 0.18) / 2.2;
  assert.ok(redSamples > 100, "fixture should contain enough active waveform pixels");
  assert.ok(Math.abs(redSum / redSamples - idealRed) < 0.12,
    "pre-quantization dither should preserve the fractional mean intensity");
  assert.equal(red.reduce((sum, count) => sum + count, 0), waveformHeight * 4, "display rendering must not alter histogram bins");
});
