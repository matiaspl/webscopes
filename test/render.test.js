import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrame, renderScopes } from "../src/index.js";

function recordingContext(width, height) {
  const images = [];
  const arcs = [];
  const labels = [];
  const fills = [];
  let fillStyle = "#123456";
  const context = {
    canvas: { width, height },
    images,
    arcs,
    labels,
    fills,
    imageCreates: 0,
    createImageData(imageWidth, imageHeight) {
      context.imageCreates += 1;
      return { width: imageWidth, height: imageHeight, data: new Uint8ClampedArray(imageWidth * imageHeight * 4) };
    },
    putImageData(image, x, y) { images.push({ image, x, y }); },
    fillRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText(text, x, y) { labels.push({ text, x, y, fillStyle, font: context.font, align: context.textAlign ?? "start" }); },
    arc(x, y, radius) { arcs.push({ x, y, radius }); },
    fill() { fills.push(fillStyle); },
  };
  Object.defineProperty(context, "fillStyle", {
    get() { return fillStyle; },
    set(value) {
      if (typeof value === "string" && (/^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|rgba|hsl|hsla)\(/i.test(value))) fillStyle = value;
    },
  });
  return context;
}

function emptyResult(vectorscope) {
  return {
    waveform: {
      width: 1,
      height: 1,
      mode: "luma",
      channelNames: ["Y"],
      channels: [new Uint32Array([0])],
    },
    vectorscope,
    stats: {},
  };
}

function rasterPixels(imageRecord) {
  const { image, x, y } = imageRecord;
  const pixels = [];
  for (let py = 0; py < image.height; py += 1) {
    for (let px = 0; px < image.width; px += 1) {
      const offset = (py * image.width + px) * 4;
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      if (red !== 8 || green !== 13 || blue !== 19) pixels.push({ x: x + px, y: y + py, red, green, blue });
    }
  }
  return pixels;
}

test("reuses display ImageData for stable canvas dimensions", () => {
  const result = emptyResult({ width: 64, height: 64, bins: new Uint32Array(64 * 64), colorMatrix: "bt709" });
  const context = recordingContext(320, 180);
  renderScopes(result, context, { dither: 0, showPerformance: false });
  const firstRenderCreates = context.imageCreates;
  renderScopes(result, context, { dither: 0, showPerformance: false });
  assert.equal(context.imageCreates, firstRenderCreates, "waveform and vectorscope rasters are cached per context");
});

test("max-filters isolated vectorscope bins at small and noninteger raster scales", () => {
  for (const binsSize of [64, 256, 1024]) {
    for (const [fractionX, fractionY] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.8]]) {
      const bins = new Uint32Array(binsSize * binsSize);
      const bx = Math.round(fractionX * (binsSize - 1));
      const by = Math.round(fractionY * (binsSize - 1));
      bins[by * binsSize + bx] = 1;
      const result = emptyResult({ width: binsSize, height: binsSize, bins, colorMatrix: "bt709" });
      const context = recordingContext(320, 180);
      renderScopes(result, context, { dither: 0, showPerformance: false });
      const vectorImage = context.images[1];
      assert.equal(vectorImage.image.width, 117);
      const lit = rasterPixels(vectorImage);
      assert.ok(lit.length > 0, `bin ${binsSize}:${bx},${by} disappeared at 117 pixels`);
      assert.ok(Math.max(...lit.map(({ red, green, blue }) => red + green + blue)) > 45);
      assert.equal(bins.reduce((sum, count) => sum + count, 0), 1, "rendering does not mutate histogram data");
    }
  }
});

test("maps saturated trace bins to target markers with valid canvas colors", () => {
  for (const colorMatrix of ["bt601", "bt709", "bt2020", "bt2100"]) {
    for (const layout of ["side-by-side", "stacked"]) {
      const input = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
      const result = analyzeFrame(input, { colorMatrix, vectorscopeSize: 256, waveformMode: "luma", waveformWidth: 1 });
      const context = recordingContext(640, 360);
      renderScopes(result, context, { colorMatrix, layout, devicePixelRatio: 2, dither: 0, showPerformance: false });
      const vectorImage = context.images[1];
      const lit = rasterPixels(vectorImage);
      assert.ok(lit.length > 0);
      const target = context.arcs[2];
      const averageX = lit.reduce((sum, pixel) => sum + pixel.x, 0) / lit.length;
      const averageY = lit.reduce((sum, pixel) => sum + pixel.y, 0) / lit.length;
      const binTolerance = vectorImage.image.width / 256 + 2;
      assert.ok(Math.hypot(averageX - target.x, averageY - target.y) <= binTolerance,
        `${colorMatrix}/${layout}: trace centroid (${averageX}, ${averageY}) vs red target (${target.x}, ${target.y})`);
      assert.ok(context.fills.includes("rgb(255 62 72)"), "primary target uses a valid CSS fillStyle");
      assert.ok(context.labels.some((label) => label.text === "R" && label.fillStyle === "rgb(255 62 72)"), "parade labels use valid CSS colors");
      assert.ok(context.labels.some((label) => label.font.includes("20px")), "labels scale with DPR");
    }
  }
});

test("draws waveform bit graticule values opposite the percentage scale", () => {
  const expectedByDepth = new Map([
    [8, ["0", "64", "128", "191", "255"]],
    [10, ["0", "256", "512", "767", "1023"]],
    [12, ["0", "1024", "2048", "3071", "4095"]],
  ]);
  for (const [bitDepth, expected] of expectedByDepth) {
    const result = emptyResult({ width: 64, height: 64, bins: new Uint32Array(64 * 64), colorMatrix: "bt709" });
    result.waveform.bitDepth = bitDepth;
    const context = recordingContext(640, 360);
    renderScopes(result, context, { dither: 0, showPerformance: false });

    const percentages = context.labels.filter(({ text }) => text.endsWith("%"));
    const bitLabels = context.labels.filter(({ text, align }) => expected.includes(text) && align === "right");
    assert.deepEqual(percentages.map(({ text }) => text), ["0%", "25%", "50%", "75%", "100%"]);
    assert.deepEqual(bitLabels.map(({ text }) => text), expected);
    assert.ok(bitLabels.every((label, index) => label.x > percentages[index].x), "code values appear opposite the percentage labels");
    assert.deepEqual(bitLabels.map(({ y }) => y), percentages.map(({ y }) => y), "both scales share graticule levels");
  }
});

test("interpolates waveform rows when enlarging the display raster", () => {
  const result = {
    waveform: {
      width: 1,
      height: 2,
      mode: "luma",
      channelNames: ["Y"],
      channels: [new Uint32Array([0, 100])],
    },
    vectorscope: { width: 64, height: 64, bins: new Uint32Array(64 * 64), colorMatrix: "bt709" },
    stats: {},
  };
  const context = recordingContext(320, 180);
  renderScopes(result, context, { dither: 0, showPerformance: false });
  const image = context.images[0].image;
  const centerX = Math.floor(image.width / 2);
  const redRows = Array.from({ length: image.height }, (_, py) => image.data[(py * image.width + centerX) * 4]);

  assert.ok(new Set(redRows).size > 8, "enlarged waveform contains interpolated display levels");
  assert.ok(redRows[0] > redRows.at(-1), "the display keeps the waveform vertical direction");
  assert.equal(result.waveform.channels[0][1], 100, "display interpolation does not mutate histogram data");
});

test("does not invent a signal across an empty waveform level during enlargement", () => {
  const result = {
    waveform: {
      width: 1,
      height: 3,
      mode: "luma",
      channelNames: ["Y"],
      channels: [new Uint32Array([100, 0, 100])],
    },
    vectorscope: { width: 64, height: 64, bins: new Uint32Array(64 * 64), colorMatrix: "bt709" },
    stats: {},
  };
  const context = recordingContext(320, 181);
  renderScopes(result, context, { dither: 0, showPerformance: false });
  const image = context.images[0].image;
  const centerX = Math.floor(image.width / 2);
  const middleRow = Math.floor(image.height / 2);

  assert.equal(image.data[(middleRow * image.width + centerX) * 4], 8, "an empty histogram level stays dark");
  assert.ok(image.data[((middleRow - 8) * image.width + centerX) * 4] > 8, "the upper populated level remains visible");
  assert.ok(image.data[((middleRow + 8) * image.width + centerX) * 4] > 8, "the lower populated level remains visible");
  assert.equal(result.waveform.channels[0][1], 0, "smoothing does not mutate histogram data");
});

test("renders neutral and saturated colors at all supported vectorscope resolutions", () => {
  const colors = [
    [128, 128, 128], [255, 0, 0], [255, 255, 0], [0, 255, 0],
    [0, 255, 255], [0, 0, 255], [255, 0, 255],
  ];
  for (const vectorscopeSize of [64, 256, 1024]) {
    const data = new Uint8Array(colors.flatMap(([r, g, b]) => [r, g, b, 255]));
    const result = analyzeFrame({ width: colors.length, height: 1, data }, { vectorscopeSize });
    const context = recordingContext(320, 180);
    renderScopes(result, context, { dither: 0, showPerformance: false });
    assert.ok(rasterPixels(context.images[1]).length > 0);
    assert.equal(result.vectorscope.bins.reduce((sum, count) => sum + count, 0), colors.length);
  }
});
