import { getScopeRenderGeometry, renderScopesOverlay } from "./render.js";

const SCOPE_BACKGROUND = [8 / 255, 13 / 255, 19 / 255];
const DITHER_SIZE = 256;

const DISPLAY_SHADER = /* wgsl */ `
struct Params {
  dims: vec4<u32>,       // canvas width, canvas height, waveform width, waveform height
  scope: vec4<u32>,      // vectorscope size, channel count, waveform mode, flags
  waveRect: vec4<f32>,
  vectorRect: vec4<f32>,
  vectorSquare: vec4<f32>,
  render: vec4<f32>,     // gain, waveform dither, vectorscope dither, unused
  color: vec4<f32>,      // Kr, Kb, Kg, unused
  background: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> bins: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var overlayTexture: texture_2d<f32>;
@group(0) @binding(3) var ditherTexture: texture_2d<f32>;

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  return output;
}

fn intensity(count: u32) -> f32 {
  if (count == 0u) { return 0.0; }
  return min(1.0, log(1.0 + f32(count) * params.render.x) / 2.2);
}

fn clampedPoint(fraction: f32, sourceLength: u32) -> u32 {
  return min(sourceLength - 1u, u32(max(0.0, floor(fraction * f32(sourceLength)))));
}

fn filteredWaveform(channelOffset: u32, localX: u32, localY: u32, paneWidth: f32, parade: bool) -> f32 {
  let sourceWidth = params.dims.z;
  let sourceHeight = params.dims.w;
  let targetWidth = u32(params.waveRect.z);
  let targetHeight = u32(params.waveRect.w);
  let antialias = (params.scope.w & 1u) != 0u;

  var xStart: f32;
  var xEnd: f32;
  if (parade) {
    let pane = min(2.0, floor((f32(localX) + 0.5) / paneWidth));
    let paneLeft = pane * paneWidth;
    let paneRight = paneLeft + paneWidth;
    let pixelLeft = max(f32(localX), paneLeft);
    let pixelRight = min(f32(localX + 1u), paneRight);
    xStart = ((pixelLeft - paneLeft) / paneWidth) * f32(sourceWidth);
    xEnd = ((pixelRight - paneLeft) / paneWidth) * f32(sourceWidth);
  } else {
    xStart = f32(localX) * f32(sourceWidth) / f32(targetWidth);
    xEnd = f32(localX + 1u) * f32(sourceWidth) / f32(targetWidth);
  }
  var xCoverage = xEnd - xStart;
  if (!antialias) {
    var fraction = (f32(localX) + 0.5) / f32(targetWidth);
    if (parade) {
      let pane = min(2.0, floor((f32(localX) + 0.5) / paneWidth));
      fraction = ((f32(localX) + 0.5) - pane * paneWidth) / paneWidth;
    }
    let bx = clampedPoint(fraction, sourceWidth);
    let by = clampedPoint(f32(targetHeight - 1u - localY) / f32(targetHeight), sourceHeight);
    return intensity(bins[channelOffset + by * sourceWidth + bx]);
  }

  var yFirst: u32;
  var ySecond: u32;
  var yFraction = 0.0;
  var yAreaStart = 0.0;
  var yAreaEnd = 0.0;
  var yAreaMode = true;
  if (targetHeight > sourceHeight) {
    let sourceFraction = 1.0 - (f32(localY) + 0.5) / f32(targetHeight);
    let position = clamp(sourceFraction * f32(sourceHeight) - 0.5, 0.0, f32(sourceHeight - 1u));
    yFirst = u32(floor(position));
    ySecond = min(sourceHeight - 1u, yFirst + 1u);
    yFraction = position - f32(yFirst);
    yAreaMode = false;
  } else {
    yAreaStart = f32(localY) * f32(sourceHeight) / f32(targetHeight);
    yAreaEnd = f32(localY + 1u) * f32(sourceHeight) / f32(targetHeight);
    let reversedStart = f32(sourceHeight) - yAreaEnd;
    yAreaEnd = f32(sourceHeight) - yAreaStart;
    yAreaStart = reversedStart;
  }
  if (xCoverage <= 0.0) { return 0.0; }
  var weighted = 0.0;
  if (!yAreaMode) {
    let xFirst = u32(max(0.0, floor(xStart)));
    let xLast = min(sourceWidth - 1u, u32(max(0.0, ceil(xEnd) - 1.0)));
    var firstRow = 0.0;
    var secondRow = 0.0;
    for (var bx = xFirst; bx <= xLast; bx += 1u) {
      let xWeight = max(0.0, min(xEnd, f32(bx + 1u)) - max(xStart, f32(bx)));
      firstRow += intensity(bins[channelOffset + yFirst * sourceWidth + bx]) * xWeight;
      secondRow += intensity(bins[channelOffset + ySecond * sourceWidth + bx]) * xWeight;
    }
    if (yFirst == ySecond) {
      return firstRow / xCoverage;
    }
    return (firstRow * (1.0 - yFraction) + secondRow * yFraction) / xCoverage;
  }

  let xFirst = u32(max(0.0, floor(xStart)));
  let xLast = min(sourceWidth - 1u, u32(max(0.0, ceil(xEnd) - 1.0)));
  let yFirstArea = u32(max(0.0, floor(yAreaStart)));
  let yLastArea = min(sourceHeight - 1u, u32(max(0.0, ceil(yAreaEnd) - 1.0)));
  for (var by = yFirstArea; by <= yLastArea; by += 1u) {
    let yWeight = max(0.0, min(yAreaEnd, f32(by + 1u)) - max(yAreaStart, f32(by)));
    if (yWeight <= 0.0) { continue; }
    for (var bx = xFirst; bx <= xLast; bx += 1u) {
      let xWeight = max(0.0, min(xEnd, f32(bx + 1u)) - max(xStart, f32(bx)));
      if (xWeight <= 0.0) { continue; }
      let count = bins[channelOffset + by * sourceWidth + bx];
      weighted += intensity(count) * xWeight * yWeight;
    }
  }
  return weighted / (xCoverage * (yAreaEnd - yAreaStart));
}

fn waveformColor(name: u32, mode: u32) -> vec3<f32> {
  if (mode == 2u) {
    if (name == 0u) { return vec3<f32>(1.0, 222.0 / 255.0, 92.0 / 255.0); }
    if (name == 1u) { return vec3<f32>(66.0 / 255.0, 195.0 / 255.0, 1.0); }
    return vec3<f32>(1.0, 101.0 / 255.0, 119.0 / 255.0);
  }
  if (mode == 3u || mode == 4u) { return vec3<f32>(1.0, 222.0 / 255.0, 92.0 / 255.0); }
  if (name == 0u) { return vec3<f32>(1.0, 62.0 / 255.0, 72.0 / 255.0); }
  if (name == 1u) { return vec3<f32>(62.0 / 255.0, 238.0 / 255.0, 133.0 / 255.0); }
  return vec3<f32>(72.0 / 255.0, 146.0 / 255.0, 1.0);
}

fn waveformPixel(x: u32, y: u32) -> vec3<f32> {
  let base = vec3<f32>(8.0 / 255.0, 13.0 / 255.0, 19.0 / 255.0);
  let waveX = u32(params.waveRect.x);
  let waveY = u32(params.waveRect.y);
  let waveWidth = u32(params.waveRect.z);
  let waveHeight = u32(params.waveRect.w);
  if (x < waveX || y < waveY || x >= waveX + waveWidth || y >= waveY + waveHeight) { return params.background.rgb; }
  let localX = x - waveX;
  let localY = y - waveY;
  let vectorArea = params.scope.x * params.scope.x;
  let channelArea = params.dims.z * params.dims.w;
  let mode = params.scope.z;
  let parade = mode == 1u || mode == 2u;
  let paneWidth = f32(waveWidth) / 3.0;
  var color = base;
  if (parade) {
    let pane = min(2u, u32(floor((f32(localX) + 0.5) / paneWidth)));
    let amount = filteredWaveform(vectorArea + pane * channelArea, localX, localY, paneWidth, true);
    color += waveformColor(pane, mode) * amount;
  } else if (mode == 3u || mode == 4u) {
    let amount = filteredWaveform(vectorArea, localX, localY, f32(waveWidth), false);
    color += waveformColor(0u, mode) * amount;
  } else {
    for (var channel = 0u; channel < 3u; channel += 1u) {
      let amount = filteredWaveform(vectorArea + channel * channelArea, localX, localY, f32(waveWidth), false);
      color += waveformColor(channel, mode) * amount;
    }
  }
  let noise = (textureLoad(ditherTexture, vec2<i32>(i32(localX & 255u), i32(localY & 255u)), 0).r * 2.0 - 1.0) * params.render.y / 255.0;
  if (color.r != base.r) { color.r += noise; }
  if (color.g != base.g) { color.g += noise; }
  if (color.b != base.b) { color.b += noise; }
  return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn vectorscopePixel(x: u32, y: u32) -> vec3<f32> {
  let base = vec3<f32>(8.0 / 255.0, 13.0 / 255.0, 19.0 / 255.0);
  let left = u32(params.vectorSquare.x);
  let top = u32(params.vectorSquare.y);
  let size = u32(params.vectorSquare.z);
  if (x < left || y < top || x >= left + size || y >= top + size) { return params.background.rgb; }
  let binsWidth = params.scope.x;
  let binsHeight = params.scope.x;
  let localX = f32(x - left);
  let localY = f32(y - top);
  let center = (f32(size) - 1.0) * 0.5;
  let radius = f32(size) * 0.44;
  let plotStart = center - radius;
  let plotExtent = radius * 2.0;
  let pixelLeft = max(localX, plotStart);
  let pixelRight = min(localX + 1.0, plotStart + plotExtent);
  let pixelTop = max(localY, plotStart);
  let pixelBottom = min(localY + 1.0, plotStart + plotExtent);
  if (pixelRight <= pixelLeft || pixelBottom <= pixelTop) { return base; }
  let firstX = u32(max(0.0, floor((pixelLeft - plotStart) / plotExtent * f32(binsWidth - 1u))));
  let lastX = min(binsWidth - 1u, u32(max(0.0, ceil((pixelRight - plotStart) / plotExtent * f32(binsWidth - 1u)))));
  let firstY = u32(max(0.0, floor((pixelTop - plotStart) / plotExtent * f32(binsHeight - 1u))));
  let lastY = min(binsHeight - 1u, u32(max(0.0, ceil((pixelBottom - plotStart) / plotExtent * f32(binsHeight - 1u)))));
  var peak = 0u;
  var peakX = 0u;
  var peakY = 0u;
  let vectorArea = binsWidth * binsHeight;
  for (var by = firstY; by <= lastY; by += 1u) {
    for (var bx = firstX; bx <= lastX; bx += 1u) {
      let count = bins[by * binsWidth + bx];
      if (count > peak) {
        peak = count;
        peakX = bx;
        peakY = by;
      }
    }
  }
  if (peak == 0u) { return base; }
  let kr = params.color.x;
  let kb = params.color.y;
  let kg = params.color.z;
  let cb = f32(peakX) / f32(binsWidth - 1u) - 0.5;
  let cr = 0.5 - f32(peakY) / f32(binsHeight - 1u);
  let red = clamp(0.5 + 2.0 * (1.0 - kr) * cr, 0.0, 1.0);
  let blue = clamp(0.5 + 2.0 * (1.0 - kb) * cb, 0.0, 1.0);
  let green = clamp((0.5 - kr * red - kb * blue) / kg, 0.0, 1.0);
  let amount = intensity(peak);
  var color = base + vec3<f32>(red, green, blue) * amount;
  let noise = (textureLoad(ditherTexture, vec2<i32>(i32(u32(localX) & 255u), i32(u32(localY) & 255u)), 0).r * 2.0 - 1.0) * params.render.z / 255.0;
  if (color.r != base.r) { color.r += noise; }
  if (color.g != base.g) { color.g += noise; }
  if (color.b != base.b) { color.b += noise; }
  return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let x = u32(position.x);
  let y = u32(position.y);
  let wave = waveformPixel(x, y);
  let vector = vectorscopePixel(x, y);
  let vectorLeft = u32(params.vectorSquare.x);
  let vectorTop = u32(params.vectorSquare.y);
  let vectorSize = u32(params.vectorSquare.z);
  let inVector = x >= vectorLeft && y >= vectorTop && x < vectorLeft + vectorSize && y < vectorTop + vectorSize;
  var color = wave;
  if (inVector) { color = vector; }
  let overlay = textureLoad(overlayTexture, vec2<i32>(i32(x), i32(y)), 0);
  color = mix(color, overlay.rgb, overlay.a);
  return vec4<f32>(color, 1.0);
}
`;

function clampDither(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function channelNames(mode) {
  if (mode === "luma") return ["Y"];
  if (mode === "ycbcr-parade") return ["Y", "Cb", "Cr"];
  if (mode === "composite") return ["Composite"];
  return ["R", "G", "B"];
}

function modeValue(mode) {
  if (mode === "rgb-parade") return 1;
  if (mode === "ycbcr-parade") return 2;
  if (mode === "luma") return 3;
  if (mode === "composite") return 4;
  return 0;
}

function colorCoefficients(name) {
  if (name === "bt601") return [0.299, 0.114];
  if (name === "bt2020" || name === "bt2100") return [0.2627, 0.0593];
  return [0.2126, 0.0722];
}

function colorFromCanvas(context, cssColor) {
  context.save();
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  const rgba = context.getImageData(0, 0, 1, 1).data;
  context.clearRect(0, 0, 1, 1);
  context.restore();
  return [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
}

function makeDitherTile() {
  const values = new Float32Array(DITHER_SIZE * DITHER_SIZE);
  let state = 0x6d2b79f5;
  for (let index = 0; index < values.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values[index] = (state >>> 0) / 0xffffffff * 2 - 1;
  }
  return values;
}

function makeOverlayCanvas(canvas, width, height) {
  const owner = canvas.ownerDocument ?? globalThis.document;
  const overlay = typeof globalThis.OffscreenCanvas === "function"
    ? new globalThis.OffscreenCanvas(width, height)
    : owner?.createElement?.("canvas");
  if (!overlay) throw new Error("A 2D canvas is required to draw scope labels and graticules");
  overlay.width = width;
  overlay.height = height;
  const context = overlay.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!context) throw new Error("Could not create the scope annotation canvas");
  return { canvas: overlay, context };
}

export async function createWebGpuScopeRenderer({ device, canvas, context, format }) {
  const overlayState = { canvas: undefined, context: undefined, texture: undefined, width: 0, height: 0, key: undefined };
  const noiseTexture = device.createTexture({
    label: "webscopes display dither tile",
    size: { width: DITHER_SIZE, height: DITHER_SIZE },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const noiseValues = makeDitherTile();
  const noise = new Uint8Array(noiseValues.length * 4);
  for (let index = 0; index < noiseValues.length; index += 1) {
    const value = Math.round((noiseValues[index] + 1) * 127.5);
    noise[index * 4] = value;
    noise[index * 4 + 1] = value;
    noise[index * 4 + 2] = value;
    noise[index * 4 + 3] = 255;
  }
  device.queue.writeTexture({ texture: noiseTexture }, noise, { bytesPerRow: DITHER_SIZE * 4, rowsPerImage: DITHER_SIZE }, { width: DITHER_SIZE, height: DITHER_SIZE });
  const module = device.createShaderModule({ code: DISPLAY_SHADER, label: "webscopes histogram display" });
  const pipeline = device.createRenderPipeline({
    label: "webscopes histogram display pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "vertex" },
    fragment: { module, entryPoint: "fragment", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  function ensureOverlay(result, renderOptions) {
    const width = canvas.width;
    const height = canvas.height;
    if (!overlayState.canvas || overlayState.width !== width || overlayState.height !== height) {
      overlayState.texture?.destroy();
      const next = makeOverlayCanvas(canvas, width, height);
      overlayState.canvas = next.canvas;
      overlayState.context = next.context;
      overlayState.texture = device.createTexture({
        label: "webscopes cached display annotations",
        size: { width, height },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      overlayState.width = width;
      overlayState.height = height;
      overlayState.key = undefined;
    }
    const mode = result.waveform.mode;
    const perf = result.stats?.performance;
    const key = JSON.stringify([
      width, height, result.waveform.width, result.waveform.height, result.waveform.bitDepth, mode,
      result.waveform.channelNames, result.vectorscope.width, result.vectorscope.colorMatrix,
      renderOptions.layout, renderOptions.gap, renderOptions.inset, renderOptions.textColor,
      renderOptions.performanceColor, renderOptions.showPerformance,
      renderOptions.devicePixelRatio, perf?.backend, perf?.fps, perf?.averageFps, perf?.frameTimeMs,
    ]);
    if (overlayState.key !== key) {
      renderScopesOverlay(result, overlayState.context, {
        ...renderOptions,
        devicePixelRatio: renderOptions.devicePixelRatio ?? 1,
        showPerformance: renderOptions.showPerformance ?? false,
      });
      const image = overlayState.context.getImageData(0, 0, width, height);
      device.queue.writeTexture(
        { texture: overlayState.texture },
        image.data,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      overlayState.key = key;
    }
    return overlayState.texture.createView();
  }

  function parameterBytes(result, renderOptions, width, height) {
    const pixelRatio = renderOptions.devicePixelRatio ?? 1;
    const geometry = getScopeRenderGeometry(width, height, { ...renderOptions, devicePixelRatio: pixelRatio });
    const wave = geometry.waveformRect;
    const vector = geometry.vectorRect;
    const waveRect = [Math.floor(wave.x), Math.floor(wave.y), Math.max(1, Math.floor(wave.width)), Math.max(1, Math.floor(wave.height))];
    const vectorRect = [Math.floor(vector.x), Math.floor(vector.y), Math.max(1, Math.floor(vector.width)), Math.max(1, Math.floor(vector.height))];
    const squareSize = Math.min(vectorRect[2], vectorRect[3]);
    const vectorSquare = [vectorRect[0] + Math.floor((vectorRect[2] - squareSize) / 2), vectorRect[1] + Math.floor((vectorRect[3] - squareSize) / 2), squareSize];
    const [kr, kb] = colorCoefficients(result.vectorscope.colorMatrix);
    const kg = 1 - kr - kb;
    const background = colorFromCanvas(overlayState.context, renderOptions.background ?? "#080d13");
    const clearValue = { r: background[0], g: background[1], b: background[2], a: 1 };
    const bytes = new ArrayBuffer(128);
    const view = new DataView(bytes);
    const u32 = (base, values) => values.forEach((value, index) => view.setUint32(base + index * 4, value, true));
    const f32 = (base, values) => values.forEach((value, index) => view.setFloat32(base + index * 4, value, true));
    u32(0, [width, height, result.waveform.width, result.waveform.height]);
    u32(16, [result.vectorscope.width, result.waveform.channelCount ?? result.waveform.channels.length, modeValue(result.waveform.mode), renderOptions.waveformAntialias === false ? 0 : 1]);
    f32(32, waveRect);
    f32(48, vectorRect);
    f32(64, [...vectorSquare, 0]);
    f32(80, [renderOptions.gain ?? 0.18, clampDither(renderOptions.dither ?? 0), clampDither(renderOptions.vectorscopeDither ?? 0), 0]);
    f32(96, [kr, kb, kg, 0]);
    f32(112, [...background, 1]);
    return { bytes, clearValue };
  }

  function encode(encoder, { binsBuffer, renderParamsBuffer, result, renderOptions = {} }) {
    const width = canvas.width;
    const height = canvas.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
      throw new TypeError("WebGPU canvas needs a positive drawing-buffer size");
    }
    if (renderOptions.width && renderOptions.height) {
      const ratio = renderOptions.devicePixelRatio ?? 1;
      const targetWidth = Math.round(renderOptions.width * ratio);
      const targetHeight = Math.round(renderOptions.height * ratio);
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
    }
    const overlayView = ensureOverlay(result, renderOptions);
    const { bytes, clearValue } = parameterBytes(result, renderOptions, canvas.width, canvas.height);
    device.queue.writeBuffer(renderParamsBuffer, 0, bytes);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: binsBuffer } },
        { binding: 1, resource: { buffer: renderParamsBuffer } },
        { binding: 2, resource: overlayView },
        { binding: 3, resource: noiseTexture.createView() },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue,
        storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  return {
    encode,
    destroy() {
      overlayState.texture?.destroy();
      noiseTexture.destroy();
      overlayState.canvas = undefined;
      overlayState.context = undefined;
    },
  };
}
