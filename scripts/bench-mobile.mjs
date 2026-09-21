// Desktop JS microbenchmark, not a browser/mobile/GPU benchmark.
// Canvas calls are no-ops; raster loops and ImageData buffers are real.
// Run: node scripts/bench-mobile.mjs
import os from 'node:os';
import { analyzeFrame, renderScopes } from '../src/index.js';

const width = 1920, height = 1080;
const data = new Uint8Array(width * height * 4);
let seed = 12345;
for (let i = 0; i < data.length; i += 4) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  data[i] = seed & 255;
  data[i + 1] = (seed >>> 8) & 255;
  data[i + 2] = (seed >>> 16) & 255;
  data[i + 3] = 255;
}
const frame = { width, height, data };
function context(width, height) {
  return {
    canvas: { width, height },
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {}, fillRect() {}, save() {}, restore() {}, setLineDash() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, arc() {}, fill() {},
  };
}
function distribution(values) {
  values.sort((a, b) => a - b);
  return { median: +values[Math.floor(values.length / 2)].toFixed(2), p95: +values[Math.ceil(values.length * .95) - 1].toFixed(2) };
}
console.log(JSON.stringify({ node: process.version, cpu: os.cpus()[0].model, input: [width, height], warmup: 5, iterations: 20, excludes: ['capture', 'GPU', 'canvas upload', 'compositing', 'mobile thermals'] }));
for (const variant of [
  { name: 'demo', scale: 1, canvas: [960, 520], bins: [480, 512, 256] },
  { name: 'quarter-sampling', scale: .25, canvas: [960, 520], bins: [480, 512, 256] },
  { name: 'smaller-display', scale: .25, canvas: [480, 260], bins: [480, 512, 256] },
  { name: 'smaller-display-and-bins', scale: .25, canvas: [480, 260], bins: [240, 256, 128] },
]) {
  const ctx = context(...variant.canvas);
  const analysis = [], render = [];
  let result;
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    result = analyzeFrame(frame, {
      waveformMode: 'rgb-parade', inputResolutionScaling: variant.scale,
      waveformWidth: variant.bins[0], waveformHeight: variant.bins[1], vectorscopeSize: variant.bins[2],
    });
    const analyzed = performance.now();
    renderScopes(result, ctx, { devicePixelRatio: 1, dither: 0, vectorscopeDither: 0, showPerformance: false });
    const rendered = performance.now();
    if (i >= 5) { analysis.push(analyzed - start); render.push(rendered - analyzed); }
  }
  console.log(JSON.stringify({ ...variant, analysisMs: distribution(analysis), renderJsMs: distribution(render), samples: result.sampleCount, histogramBytes: result.vectorscope.bins.byteLength + result.waveform.channels.reduce((n, channel) => n + channel.byteLength, 0) }));
}
