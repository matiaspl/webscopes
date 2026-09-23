import { captureFrameToCanvas, getColorMatrix, getSourceSize, normalizeAnalysisOptions } from "./analyze.js";
import { createVideoColorQualifier, VIDEO_TRANSFER_SHADER } from "./video-color.js";
import { createWebGpuScopeRenderer } from "./webgpu-render.js";

const COMPUTE_SHADER = /* wgsl */ `
struct Params {
  dims: vec4<u32>,       // input width, input height, waveform width, waveform height
  crop: vec4<u32>,       // mode, crop x, crop y, crop width
  extra: vec4<u32>,      // crop height, vectorscope size, sampled width, sampled height
  coeff: vec4<u32>,      // fixed-point Kr, Kb, fixed-point scale, inverse Apple transfer
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn roundRatio(numerator: u32, denominator: u32) -> u32 {
  let whole = numerator / denominator;
  let remainder = numerator % denominator;
  return whole + select(0u, 1u, remainder * 2u >= denominator);
}

fn roundProductRatio(value: u32, scale: u32, denominator: u32) -> u32 {
  return (value * scale + denominator / 2u) / denominator;
}

fn compositeWaveformValue(yValue: u32, cbValue: u32, crValue: u32, scale: u32, sourceX: u32) -> u32 {
  let center = f32(scale) * 0.5;
  var modulation = f32(crValue) - center;
  switch (sourceX & 3u) {
    case 1u: { modulation = f32(cbValue) - center; }
    case 2u: { modulation = center - f32(crValue); }
    case 3u: { modulation = center - f32(cbValue); }
    default: {}
  }
  return u32(clamp(floor(f32(yValue) + modulation * 0.5 + 0.5), 0.0, f32(scale)));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cropWidth = params.crop.w;
  let cropHeight = params.extra.x;
  let sampleWidth = params.extra.z;
  let sampleHeight = params.extra.w;
  if (id.x >= sampleWidth || id.y >= sampleHeight) { return; }

  var localX = 0u;
  var localY = 0u;
  if (sampleWidth > 1u) { localX = roundRatio(id.x * (cropWidth - 1u), sampleWidth - 1u); }
  if (sampleHeight > 1u) { localY = roundRatio(id.y * (cropHeight - 1u), sampleHeight - 1u); }
  let sourceX = params.crop.y + localX;
  let sourceY = params.crop.z + localY;
  let rgb = textureLoad(inputTexture, vec2<i32>(i32(sourceX), i32(sourceY)), 0).rgb;
  let red = min(255u, u32(rgb.r * 255.0 + 0.5));
  let green = min(255u, u32(rgb.g * 255.0 + 0.5));
  let blue = min(255u, u32(rgb.b * 255.0 + 0.5));
  let fixedScale = params.coeff.z;
  let kr = params.coeff.x;
  let kb = params.coeff.y;
  let kg = fixedScale - kr - kb;
  let yNumerator = kr * red + kg * green + kb * blue;
  let yDenominator = 255u * fixedScale;
  let cbDenominator = 510u * (fixedScale - kb);
  let crDenominator = 510u * (fixedScale - kr);
  let cbNumerator = 255u * (fixedScale - kb) + blue * fixedScale - yNumerator;
  let crNumerator = 255u * (fixedScale - kr) + red * fixedScale - yNumerator;

  let vectorSize = params.extra.y;
  let vectorscopeArea = vectorSize * vectorSize;
  let vectorX = min(vectorSize - 1u, roundProductRatio(cbNumerator, vectorSize - 1u, cbDenominator));
  let vectorY = min(vectorSize - 1u, roundProductRatio(crDenominator - crNumerator, vectorSize - 1u, crDenominator));
  atomicAdd(&bins[vectorY * vectorSize + vectorX], 1u);

  let waveformWidth = params.dims.z;
  let waveformHeight = params.dims.w;
  let column = min(waveformWidth - 1u, id.x * waveformWidth / sampleWidth);
  let channelCount = waveformWidth * waveformHeight;
  var values = vec3<u32>(
    0u,
    0u,
    0u,
  );
  let yValue = roundProductRatio(yNumerator, waveformHeight - 1u, yDenominator);
  let cbValue = roundProductRatio(cbNumerator, waveformHeight - 1u, cbDenominator);
  let crValue = roundProductRatio(crNumerator, waveformHeight - 1u, crDenominator);
  if (params.crop.x == 0u) {
    values = vec3<u32>(
      roundProductRatio(red, waveformHeight - 1u, 255u),
      roundProductRatio(green, waveformHeight - 1u, 255u),
      roundProductRatio(blue, waveformHeight - 1u, 255u),
    );
  } else if (params.crop.x == 1u) {
    values = vec3<u32>(yValue, 0u, 0u);
  } else if (params.crop.x == 2u) {
    values = vec3<u32>(yValue, cbValue, crValue);
  } else if (params.crop.x == 3u) {
    values = vec3<u32>(compositeWaveformValue(yValue, cbValue, crValue, waveformHeight - 1u, sourceX), 0u, 0u);
  }
  for (var channel = 0u; channel < 3u; channel += 1u) {
    if ((params.crop.x == 1u || params.crop.x == 3u) && channel > 0u) { continue; }
    let value = min(waveformHeight - 1u, values[channel]);
    let offset = vectorscopeArea + channel * channelCount + value * waveformWidth + column;
    atomicAdd(&bins[offset], 1u);
  }
}
`;

// Packed v210 is kept as 10-bit code values until the histogram placement is
// complete. This avoids an intermediate 8-bit RGBA conversion and preserves
// the native 4:2:2 chroma samples for Y/Cb/Cr and vectorscope analysis.
const V210_COMPUTE_SHADER = /* wgsl */ `
struct Params {
  dims: vec4<u32>,       // input width, input height, waveform width, waveform height
  crop: vec4<u32>,       // mode, crop x, crop y, crop width
  extra: vec4<u32>,      // crop height, vectorscope size, sampled width, sampled height
  coeff: vec4<f32>,      // row words, Kr, Kb, full-range flag
};

@group(0) @binding(0) var<storage, read> packed: array<u32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn roundRatio(numerator: u32, denominator: u32) -> u32 {
  let whole = numerator / denominator;
  let remainder = numerator % denominator;
  return whole + select(0u, 1u, remainder * 2u >= denominator);
}

fn roundFloat(value: f32) -> u32 {
  return u32(max(0.0, floor(value + 0.5)));
}

fn compositeWaveformValue(yValue: u32, cbValue: u32, crValue: u32, scale: u32, sourceX: u32) -> u32 {
  let center = f32(scale) * 0.5;
  var modulation = f32(crValue) - center;
  switch (sourceX & 3u) {
    case 1u: { modulation = f32(cbValue) - center; }
    case 2u: { modulation = center - f32(crValue); }
    case 3u: { modulation = center - f32(cbValue); }
    default: {}
  }
  return min(scale, roundFloat(f32(yValue) + modulation * 0.5));
}

fn decodePixel(sourceY: u32, sourceX: u32) -> vec3<u32> {
  let group = sourceX / 6u;
  let pixel = sourceX % 6u;
  let offset = sourceY * u32(params.coeff.x) + group * 4u;
  let word0 = packed[offset];
  let word1 = packed[offset + 1u];
  let word2 = packed[offset + 2u];
  let word3 = packed[offset + 3u];
  var y = 0u;
  var cb = 0u;
  var cr = 0u;
  switch (pixel) {
    case 0u: { y = (word0 >> 10u) & 1023u; cb = word0 & 1023u; cr = (word0 >> 20u) & 1023u; }
    case 1u: { y = word1 & 1023u; cb = word0 & 1023u; cr = (word0 >> 20u) & 1023u; }
    case 2u: { y = (word1 >> 20u) & 1023u; cb = (word1 >> 10u) & 1023u; cr = word2 & 1023u; }
    case 3u: { y = (word2 >> 10u) & 1023u; cb = (word1 >> 10u) & 1023u; cr = word2 & 1023u; }
    case 4u: { y = word3 & 1023u; cb = (word2 >> 20u) & 1023u; cr = (word3 >> 10u) & 1023u; }
    default: { y = (word3 >> 20u) & 1023u; cb = (word2 >> 20u) & 1023u; cr = (word3 >> 10u) & 1023u; }
  }
  return vec3<u32>(y, cb, cr);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cropWidth = params.crop.w;
  let cropHeight = params.extra.x;
  let sampleWidth = params.extra.z;
  let sampleHeight = params.extra.w;
  if (id.x >= sampleWidth || id.y >= sampleHeight) { return; }

  var localX = 0u;
  var localY = 0u;
  if (sampleWidth > 1u) { localX = roundRatio(id.x * (cropWidth - 1u), sampleWidth - 1u); }
  if (sampleHeight > 1u) { localY = roundRatio(id.y * (cropHeight - 1u), sampleHeight - 1u); }
  let sourceX = params.crop.y + localX;
  let sourceY = params.crop.z + localY;
  let codes = decodePixel(sourceY, sourceX);
  let yCode = codes.x;
  let cbCode = codes.y;
  let crCode = codes.z;
  let fullRange = params.coeff.w > 0.5;
  let yOffset = select(64.0, 0.0, fullRange);
  let yRange = select(876.0, 1023.0, fullRange);
  let chromaRange = select(896.0, 1023.0, fullRange);
  let kr = params.coeff.y;
  let kb = params.coeff.z;
  let y = (f32(yCode) - yOffset) / yRange;
  let cb = (f32(cbCode) - 512.0) / chromaRange;
  let cr = (f32(crCode) - 512.0) / chromaRange;
  let red = clamp(y + cr * 2.0 * (1.0 - kr), 0.0, 1.0);
  let blue = clamp(y + cb * 2.0 * (1.0 - kb), 0.0, 1.0);
  let green = clamp((y - kr * red - kb * blue) / (1.0 - kr - kb), 0.0, 1.0);

  let vectorSize = params.extra.y;
  let vectorscopeArea = vectorSize * vectorSize;
  let vectorScale = f32(vectorSize - 1u);
  let vectorX = min(vectorSize - 1u, roundFloat((cb + 0.5) * vectorScale));
  let vectorY = min(vectorSize - 1u, roundFloat((0.5 - cr) * vectorScale));
  atomicAdd(&bins[vectorY * vectorSize + vectorX], 1u);

  let waveformWidth = params.dims.z;
  let waveformHeight = params.dims.w;
  let waveformScale = waveformHeight - 1u;
  let column = min(waveformWidth - 1u, id.x * waveformWidth / sampleWidth);
  let channelCount = waveformWidth * waveformHeight;
  let yValue = min(waveformScale, roundFloat(f32(yCode) * f32(waveformScale) / 1023.0));
  let cbValue = min(waveformScale, roundFloat(f32(cbCode) * f32(waveformScale) / 1023.0));
  let crValue = min(waveformScale, roundFloat(f32(crCode) * f32(waveformScale) / 1023.0));
  var values = vec3<u32>(
    min(waveformScale, roundFloat((yOffset + red * yRange) * f32(waveformScale) / 1023.0)),
    min(waveformScale, roundFloat((yOffset + green * yRange) * f32(waveformScale) / 1023.0)),
    min(waveformScale, roundFloat((yOffset + blue * yRange) * f32(waveformScale) / 1023.0)),
  );
  if (params.crop.x == 1u) {
    values = vec3<u32>(yValue, 0u, 0u);
  } else if (params.crop.x == 2u) {
    values = vec3<u32>(yValue, cbValue, crValue);
  } else if (params.crop.x == 3u) {
    values = vec3<u32>(compositeWaveformValue(yValue, cbValue, crValue, waveformScale, sourceX), 0u, 0u);
  }
  for (var channel = 0u; channel < 3u; channel += 1u) {
    if ((params.crop.x == 1u || params.crop.x == 3u) && channel > 0u) { continue; }
    atomicAdd(&bins[vectorscopeArea + channel * channelCount + values[channel] * waveformWidth + column], 1u);
  }
}
`;

const V210_PREVIEW_SHADER = /* wgsl */ `
struct Params {
  dims: vec4<u32>,
  coeff: vec4<f32>, // row words, Kr, Kb, full-range flag
};

@group(0) @binding(0) var<storage, read> packed: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

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

fn decodePixel(sourceY: u32, sourceX: u32) -> vec3<u32> {
  let group = sourceX / 6u;
  let pixel = sourceX % 6u;
  let offset = sourceY * u32(params.coeff.x) + group * 4u;
  let word0 = packed[offset];
  let word1 = packed[offset + 1u];
  let word2 = packed[offset + 2u];
  let word3 = packed[offset + 3u];
  switch (pixel) {
    case 0u: { return vec3<u32>((word0 >> 10u) & 1023u, word0 & 1023u, (word0 >> 20u) & 1023u); }
    case 1u: { return vec3<u32>(word1 & 1023u, word0 & 1023u, (word0 >> 20u) & 1023u); }
    case 2u: { return vec3<u32>((word1 >> 20u) & 1023u, (word1 >> 10u) & 1023u, word2 & 1023u); }
    case 3u: { return vec3<u32>((word2 >> 10u) & 1023u, (word1 >> 10u) & 1023u, word2 & 1023u); }
    case 4u: { return vec3<u32>(word3 & 1023u, (word2 >> 20u) & 1023u, (word3 >> 10u) & 1023u); }
    default: { return vec3<u32>((word3 >> 20u) & 1023u, (word2 >> 20u) & 1023u, (word3 >> 10u) & 1023u); }
  }
}

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let sourceWidth = params.dims.x;
  let sourceHeight = params.dims.y;
  let outputWidth = params.dims.z;
  let outputHeight = params.dims.w;
  let sourceX = min(sourceWidth - 1u, u32(floor((position.x + 0.5) * f32(sourceWidth) / f32(outputWidth))));
  let sourceY = min(sourceHeight - 1u, u32(floor((position.y + 0.5) * f32(sourceHeight) / f32(outputHeight))));
  let codes = decodePixel(sourceY, sourceX);
  let fullRange = params.coeff.w > 0.5;
  let yOffset = select(64.0, 0.0, fullRange);
  let yRange = select(876.0, 1023.0, fullRange);
  let chromaRange = select(896.0, 1023.0, fullRange);
  let kr = params.coeff.y;
  let kb = params.coeff.z;
  let y = (f32(codes.x) - yOffset) / yRange;
  let cb = (f32(codes.y) - 512.0) / chromaRange;
  let cr = (f32(codes.z) - 512.0) / chromaRange;
  let red = clamp(y + cr * 2.0 * (1.0 - kr), 0.0, 1.0);
  let blue = clamp(y + cb * 2.0 * (1.0 - kb), 0.0, 1.0);
  let green = clamp((y - kr * red - kb * blue) / (1.0 - kr - kb), 0.0, 1.0);
  return vec4<f32>(red, green, blue, 1.0);
}
`;

// The Electron sample stores three opaque v210 bytes in each RGBA texel. Read
// two adjacent texels to reconstruct a little-endian v210 word without a CPU
// VideoFrame.copyTo() or a second upload to WebGPU.
function externalPackedV210Shader(shader) {
  return shader.replace("@group(0) @binding(0) var<storage, read> packed: array<u32>;", /* wgsl */ `
@group(0) @binding(0) var packed: texture_external;

fn readWord(index: u32) -> u32 {
  let rowWords = u32(params.coeff.x);
  let y = index / rowWords;
  let byteX = (index % rowWords) * 4u;
  let texelX = byteX / 3u;
  let phase = byteX % 3u;
  let first = vec3<u32>(clamp(floor(textureLoad(packed, vec2<i32>(i32(texelX), i32(y))).rgb * 255.0 + 0.5), vec3<f32>(0.0), vec3<f32>(255.0)));
  let second = vec3<u32>(clamp(floor(textureLoad(packed, vec2<i32>(i32(texelX + 1u), i32(y))).rgb * 255.0 + 0.5), vec3<f32>(0.0), vec3<f32>(255.0)));
  var bytes: vec4<u32>;
  switch (phase) {
    case 0u: { bytes = vec4<u32>(first.r, first.g, first.b, second.r); }
    case 1u: { bytes = vec4<u32>(first.g, first.b, second.r, second.g); }
    default: { bytes = vec4<u32>(first.b, second.r, second.g, second.b); }
  }
  return bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);
}
`).replace(/packed\[(offset(?: \+ [1-3]u)?)\]/g, "readWord($1)");
}

const V210_EXTERNAL_COMPUTE_SHADER = externalPackedV210Shader(V210_COMPUTE_SHADER);
const V210_EXTERNAL_PREVIEW_SHADER = externalPackedV210Shader(V210_PREVIEW_SHADER);
const V210_EXTERNAL_PARITY_SHADER = externalPackedV210Shader(/* wgsl */ `
struct Params { coeff: vec4<f32> };
@group(0) @binding(0) var<storage, read> packed: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let rowWords = u32(params.coeff.x);
  if (id.x >= rowWords) { return; }
  let offset = id.y * rowWords + id.x;
  output[offset] = packed[offset];
}
`);

const EXTERNAL_COMPUTE_SHADER = COMPUTE_SHADER
  .replace("var inputTexture: texture_2d<f32>;", `var inputTexture: texture_external;
@group(0) @binding(3) var videoSampler: sampler;
${VIDEO_TRANSFER_SHADER}`)
  .replace(
    "let rgb = textureLoad(inputTexture, vec2<i32>(i32(sourceX), i32(sourceY)), 0).rgb;",
    `let uv = (vec2f(f32(sourceX), f32(sourceY)) + 0.5) / vec2f(params.dims.xy);
  var rgb = textureSampleBaseClampToEdge(inputTexture, videoSampler, uv).rgb;
  if (params.coeff.w == 1u) { rgb = undoAppleTransfer(rgb); }
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));`,
  );

function gpuMode(mode) {
  if (mode === "luma") return 1;
  if (mode === "ycbcr-parade") return 2;
  if (mode === "composite") return 3;
  return 0;
}

export async function createWebGpuAnalyzer(options = {}) {
  let device = options.device;
  const useExternalVideoTextures = options.useExternalVideoTextures ?? true;
  const videoCapture = {};
  let ownsDevice = false;
  let texture;
  let textureView;
  let textureWidth = 0;
  let textureHeight = 0;
  let binsBuffer;
  let stagingBuffer;
  let paramsBuffer;
  let bufferSize = 0;
  let bindGroup;
  let v210Buffer;
  let v210BufferSize = 0;
  let v210BindGroup;
  let v210Pipeline;
  let destroyed = false;
  let resourcesReleased = false;
  let inFlight = Promise.resolve();
  let lossState;
  let videoQualifier;
  let videoSampler;

  async function withValidationScope(operation) {
    let scopeOpen = false;
    try {
      device.pushErrorScope("validation");
      scopeOpen = true;
      const value = operation();
      const validationError = await device.popErrorScope();
      scopeOpen = false;
      if (validationError) throw new Error(`WebGPU validation failed: ${validationError.message}`);
      return value;
    } catch (error) {
      if (scopeOpen) {
        try { await device.popErrorScope(); } catch {}
      }
      throw error;
    }
  }

  function throwIfDeviceLost() {
    if (!lossState) return;
    const detail = lossState.info?.message ?? lossState.error?.message ?? "device was lost";
    throw new Error(`WebGPU device lost: ${detail}`);
  }

  function releaseResources() {
    if (resourcesReleased) return;
    resourcesReleased = true;
    videoQualifier?.destroy();
    if (videoCapture.canvas) videoCapture.canvas.width = videoCapture.canvas.height = 1;
    for (const resource of [texture, binsBuffer, stagingBuffer, paramsBuffer, v210Buffer]) {
      try { resource?.destroy(); } catch {}
    }
    if (ownsDevice) {
      try { device?.destroy(); } catch {}
    }
  }

  function limit(limits, name) {
    const value = limits?.[name];
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  function validateLimits(width, height, config, byteLength) {
    const limits = device.limits ?? {};
    const maxTextureDimension = limit(limits, "maxTextureDimension2D");
    if (width > maxTextureDimension || height > maxTextureDimension) {
      throw new RangeError(`Frame exceeds the GPU texture limit (${maxTextureDimension}px)`);
    }
    const workgroupsX = Math.ceil(config.sampleWidth / 8);
    const workgroupsY = Math.ceil(config.sampleHeight / 8);
    const maxWorkgroups = limit(limits, "maxComputeWorkgroupsPerDimension");
    if (workgroupsX > maxWorkgroups || workgroupsY > maxWorkgroups) {
      throw new RangeError(`Frame exceeds the GPU dispatch limit (${maxWorkgroups} workgroups per dimension)`);
    }
    if (limit(limits, "maxComputeWorkgroupSizeX") < 8 || limit(limits, "maxComputeWorkgroupSizeY") < 8
      || limit(limits, "maxComputeInvocationsPerWorkgroup") < 64) {
      throw new RangeError("GPU device does not support the required 8 × 8 compute workgroup");
    }
    if (limit(limits, "maxBindingsPerBindGroup") < 3 || limit(limits, "maxStorageBuffersPerShaderStage") < 1
      || limit(limits, "maxSampledTexturesPerShaderStage") < 1 || limit(limits, "maxUniformBuffersPerShaderStage") < 1) {
      throw new RangeError("GPU device does not support the required histogram bindings");
    }
    if (byteLength > limit(limits, "maxBufferSize") || byteLength > limit(limits, "maxStorageBufferBindingSize")) {
      throw new RangeError("Histogram buffers exceed the GPU device limits");
    }
    if (64 > limit(limits, "maxBufferSize") || 64 > limit(limits, "maxUniformBufferBindingSize")) {
      throw new RangeError("GPU device cannot allocate the analysis parameter buffer");
    }
  }

  function ensureTexture(width, height) {
    if (textureWidth === width && textureHeight === height) return;
    texture?.destroy();
    texture = device.createTexture({
      label: "webscopes input frame",
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    textureView = texture.createView();
    bindGroup = undefined;
    textureWidth = width;
    textureHeight = height;
  }

  function ensureBuffers(byteLength) {
    if (bufferSize === byteLength) return;
    const nextBinsBuffer = device.createBuffer({
      label: "webscopes atomic histograms",
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    let nextStagingBuffer;
    try {
      nextStagingBuffer = device.createBuffer({
        label: "webscopes histogram readback",
        size: byteLength,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    } catch (error) {
      try { nextBinsBuffer.destroy(); } catch {}
      throw error;
    }
    binsBuffer?.destroy();
    stagingBuffer?.destroy();
    binsBuffer = nextBinsBuffer;
    stagingBuffer = nextStagingBuffer;
    bufferSize = byteLength;
    bindGroup = undefined;
    v210BindGroup = undefined;
  }

  function ensureV210Buffer(byteLength) {
    if (v210BufferSize === byteLength) return;
    v210Buffer?.destroy();
    v210Buffer = device.createBuffer({
      label: "webscopes packed v210 frame",
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    v210BufferSize = byteLength;
    v210BindGroup = undefined;
  }

  function isRgbaPixelSource(source) {
    return source?.data != null
      && Number.isInteger(source.width)
      && Number.isInteger(source.height)
      && source.format !== "v210"
      && ArrayBuffer.isView(source.data)
      && source.data.BYTES_PER_ELEMENT === 1
      && (source.pixelStride ?? 4) === 4
      && (source.bytesPerRow ?? source.width * 4) === source.width * 4;
  }

  try {
    if (!device) {
      let adapter = options.adapter;
      if (!adapter) {
        const gpu = options.gpu ?? globalThis.navigator?.gpu;
        if (!gpu) throw new Error("WebGPU is not available in this browser");
        adapter = await gpu.requestAdapter(options.adapterOptions);
      }
      if (!adapter) throw new Error("No WebGPU adapter is available");
      device = await adapter.requestDevice();
      ownsDevice = true;
    }

    videoQualifier = createVideoColorQualifier(device);
    const lostPromise = device.lost && typeof device.lost.then === "function"
      ? device.lost.then((info) => { lossState = { info }; return lossState; }, (error) => { lossState = { error }; return lossState; })
      : new Promise(() => {});
    const { pipeline } = await withValidationScope(() => {
      const shaderModule = device.createShaderModule({ code: COMPUTE_SHADER, label: "webscopes histogram compute" });
      const computePipeline = device.createComputePipeline({
        label: "webscopes histogram pipeline",
        layout: "auto",
        compute: { module: shaderModule, entryPoint: "main" },
      });
      paramsBuffer = device.createBuffer({
        label: "webscopes compute parameters",
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      return { pipeline: computePipeline };
    });
    const bindGroupLayout = pipeline.getBindGroupLayout(0);
    const parameterBytes = new ArrayBuffer(64);
    const parameterView = new DataView(parameterBytes);
    let externalPipeline;
    throwIfDeviceLost();

    async function ensureExternalPipeline() {
      if (externalPipeline) return externalPipeline;
      const { pipeline: nextPipeline } = await withValidationScope(() => {
        const shaderModule = device.createShaderModule({
          code: EXTERNAL_COMPUTE_SHADER,
          label: "webscopes external-video histogram compute",
        });
        return {
          pipeline: device.createComputePipeline({
            label: "webscopes external-video histogram pipeline",
            layout: "auto",
            compute: { module: shaderModule, entryPoint: "main" },
          }),
        };
      });
      externalPipeline = nextPipeline;
      return externalPipeline;
    }

    async function analyze(source, analysisOptions = {}, externalVideo = false) {
      const task = inFlight.then(async () => {
        if (destroyed) throw new Error("WebGPU analyzer has been destroyed");
        throwIfDeviceLost();
        const videoInput = isVideoSource(source);
        const transfer = externalVideo ? await videoQualifier.qualify(source) : null;
        externalVideo = transfer !== null;
        throwIfDeviceLost();
        if (videoInput && !externalVideo) {
          source = captureFrameToCanvas(source, videoCapture, { willReadFrequently: false, colorSpace: "srgb" }).canvas;
        }
        const { width, height } = getSourceSize(source);
        const config = normalizeAnalysisOptions(width, height, analysisOptions);
        const {
          x0, y0, cropWidth, cropHeight, sampleWidth, sampleHeight, waveformWidth, waveformHeight,
          vectorscopeSize, waveformMode, colorMatrix, bitDepth,
        } = config;
        const channelCount = waveformMode === "luma" || waveformMode === "composite" ? 1 : 3;
        const vectorArea = vectorscopeSize * vectorscopeSize;
        const channelArea = waveformWidth * waveformHeight;
        const binCount = vectorArea + channelArea * channelCount;
        const byteLength = binCount * Uint32Array.BYTES_PER_ELEMENT;
        validateLimits(width, height, config, byteLength);
        if (externalVideo) {
          if (typeof device.importExternalTexture !== "function") {
            throw new Error("This WebGPU device does not support external video textures");
          }
          if (limit(device.limits, "maxSampledTexturesPerShaderStage") < 4
            || limit(device.limits, "maxSamplersPerShaderStage") < 2
            || limit(device.limits, "maxUniformBuffersPerShaderStage") < 2
            || limit(device.limits, "maxBindingsPerBindGroup") < 4) {
            throw new RangeError("GPU device limits do not support external video textures in the histogram shader");
          }
        }
        const activePipeline = externalVideo ? await ensureExternalPipeline() : pipeline;
        if (externalVideo) videoSampler ??= device.createSampler({ minFilter: "linear", magFilter: "linear" });

        const matrix = getColorMatrix(colorMatrix);
        const words = [width, height, waveformWidth, waveformHeight, gpuMode(waveformMode), x0, y0, cropWidth, cropHeight, vectorscopeSize, sampleWidth, sampleHeight];
        words.forEach((word, index) => parameterView.setUint32(index * 4, word, true));
        parameterView.setUint32(48, matrix.krFixed, true);
        parameterView.setUint32(52, matrix.kbFixed, true);
        parameterView.setUint32(56, 1024, true);
        parameterView.setUint32(60, transfer ?? 0, true);

        await withValidationScope(() => {
          let activeBindGroup;
          if (externalVideo) {
            ensureBuffers(byteLength);
            device.queue.writeBuffer(paramsBuffer, 0, parameterBytes);
            const externalTexture = device.importExternalTexture({ source, colorSpace: "srgb" });
            activeBindGroup = device.createBindGroup({
              layout: activePipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: externalTexture },
                { binding: 1, resource: { buffer: binsBuffer } },
                { binding: 2, resource: { buffer: paramsBuffer } },
                { binding: 3, resource: videoSampler },
              ],
            });
          } else {
            ensureTexture(width, height);
            if (isRgbaPixelSource(source)) {
              device.queue.writeTexture(
                { texture },
                source.data,
                { bytesPerRow: width * 4, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 },
              );
            } else {
              device.queue.copyExternalImageToTexture(
                { source },
                { texture, colorSpace: "srgb", premultipliedAlpha: false },
                { width, height },
              );
            }
            ensureBuffers(byteLength);
            device.queue.writeBuffer(paramsBuffer, 0, parameterBytes);
            if (!bindGroup) bindGroup = device.createBindGroup({
              layout: bindGroupLayout,
              entries: [
                { binding: 0, resource: textureView },
                { binding: 1, resource: { buffer: binsBuffer } },
                { binding: 2, resource: { buffer: paramsBuffer } },
              ],
            });
            activeBindGroup = bindGroup;
          }
          const encoder = device.createCommandEncoder({ label: "webscopes analyze frame" });
          encoder.clearBuffer(binsBuffer);
          const pass = encoder.beginComputePass();
          pass.setPipeline(activePipeline);
          pass.setBindGroup(0, activeBindGroup);
          pass.dispatchWorkgroups(Math.ceil(sampleWidth / 8), Math.ceil(sampleHeight / 8));
          pass.end();
          encoder.copyBufferToBuffer(binsBuffer, 0, stagingBuffer, 0, byteLength);
          device.queue.submit([encoder.finish()]);
        });
        throwIfDeviceLost();

        let mapped = false;
        let primaryError;
        let allBins;
        try {
          const mapPromise = stagingBuffer.mapAsync(GPUMapMode.READ);
          void mapPromise.catch(() => {});
          const mapState = await Promise.race([
            mapPromise.then(() => "mapped"),
            lostPromise.then(() => "lost"),
          ]);
          if (mapState === "lost") {
            throwIfDeviceLost();
            throw new Error("WebGPU device was lost during histogram readback");
          }
          mapped = true;
          throwIfDeviceLost();
          allBins = new Uint32Array(stagingBuffer.getMappedRange()).slice();
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          if (mapped) {
            try { stagingBuffer.unmap(); } catch (error) { if (!primaryError) throw error; }
          }
        }

        const channels = Array.from({ length: channelCount }, (_, index) => allBins.subarray(
          vectorArea + index * channelArea,
          vectorArea + (index + 1) * channelArea,
        ));
        const channelNames = waveformMode === "luma" ? ["Y"]
          : waveformMode === "ycbcr-parade" ? ["Y", "Cb", "Cr"]
            : waveformMode === "composite" ? ["Composite"] : ["R", "G", "B"];
        return {
          width,
          height,
          sampleCount: sampleWidth * sampleHeight,
          waveform: { width: waveformWidth, height: waveformHeight, bitDepth, mode: waveformMode, channelNames, channels },
          vectorscope: { width: vectorscopeSize, height: vectorscopeSize, bins: allBins.subarray(0, vectorArea), colorMatrix },
          stats: { colorMatrix, bitDepth, ...(videoInput ? { videoColorMode: externalVideo ? (transfer === 1 ? "external-apple" : "external-identity") : "canvas" } : {}) },
        };
      });
      // Do not keep the previous result alive through the serialization gate;
      // createScopes owns only the latest published result.
      inFlight = task.then(() => undefined, () => undefined);
      return task;
    }

    async function analyzeV210(source, analysisOptions = {}) {
      const task = inFlight.then(async () => {
        if (destroyed) throw new Error("WebGPU analyzer has been destroyed");
        throwIfDeviceLost();
        if (source?.format !== "v210" || !ArrayBuffer.isView(source?.data)) {
          throw new TypeError("WebGPU v210 analysis requires a packed v210 frame");
        }
        const { width, height } = getSourceSize(source);
        const bytesPerRow = source.bytesPerRow ?? Math.ceil(width / 48) * 128;
        const minimumRowBytes = Math.ceil(width / 6) * 16;
        if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow < minimumRowBytes
          || bytesPerRow % 4 !== 0 || source.data.byteLength % 4 !== 0
          || !Number.isSafeInteger(bytesPerRow * height) || source.data.byteLength < bytesPerRow * height) {
          throw new RangeError("Packed v210 data is truncated or has an invalid row stride");
        }
        const config = normalizeAnalysisOptions(width, height, {
          ...analysisOptions,
          bitDepth: analysisOptions.bitDepth ?? 10,
          colorMatrix: analysisOptions.colorMatrix ?? source.colorMatrix,
          colorRange: analysisOptions.colorRange ?? source.colorRange,
        });
        if (config.bitDepth !== 10) throw new RangeError("v210 frames have a fixed bit depth of 10");
        const channelCount = config.waveformMode === "luma" || config.waveformMode === "composite" ? 1 : 3;
        const vectorArea = config.vectorscopeSize * config.vectorscopeSize;
        const channelArea = config.waveformWidth * config.waveformHeight;
        const binCount = vectorArea + channelArea * channelCount;
        const byteLength = binCount * Uint32Array.BYTES_PER_ELEMENT;
        validateLimits(width, height, config, byteLength);
        if (source.data.byteLength > limit(device.limits, "maxBufferSize")) {
          throw new RangeError("Packed v210 frame exceeds the GPU buffer limit");
        }

        if (!v210Pipeline) {
          v210Pipeline = await withValidationScope(() => {
            const shaderModule = device.createShaderModule({ code: V210_COMPUTE_SHADER, label: "webscopes v210 histogram compute" });
            return device.createComputePipeline({
              label: "webscopes v210 histogram pipeline",
              layout: "auto",
              compute: { module: shaderModule, entryPoint: "main" },
            });
          });
        }
        ensureV210Buffer(source.data.byteLength);
        ensureBuffers(byteLength);
        const matrix = getColorMatrix(config.colorMatrix);
        const words = [width, height, config.waveformWidth, config.waveformHeight, gpuMode(config.waveformMode), config.x0, config.y0,
          config.cropWidth, config.cropHeight, config.vectorscopeSize, config.sampleWidth, config.sampleHeight];
        words.forEach((word, index) => parameterView.setUint32(index * 4, word, true));
        parameterView.setFloat32(48, bytesPerRow / 4, true);
        parameterView.setFloat32(52, matrix.kr, true);
        parameterView.setFloat32(56, matrix.kb, true);
        parameterView.setFloat32(60, config.colorRange === "full" ? 1 : 0, true);
        const data = new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);

        await withValidationScope(() => {
          device.queue.writeBuffer(v210Buffer, 0, data);
          device.queue.writeBuffer(paramsBuffer, 0, parameterBytes);
          if (!v210BindGroup) {
            v210BindGroup = device.createBindGroup({
              layout: v210Pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: v210Buffer } },
                { binding: 1, resource: { buffer: binsBuffer } },
                { binding: 2, resource: { buffer: paramsBuffer } },
              ],
            });
          }
          const encoder = device.createCommandEncoder({ label: "webscopes analyze packed v210" });
          encoder.clearBuffer(binsBuffer);
          const pass = encoder.beginComputePass();
          pass.setPipeline(v210Pipeline);
          pass.setBindGroup(0, v210BindGroup);
          pass.dispatchWorkgroups(Math.ceil(config.sampleWidth / 8), Math.ceil(config.sampleHeight / 8));
          pass.end();
          encoder.copyBufferToBuffer(binsBuffer, 0, stagingBuffer, 0, byteLength);
          device.queue.submit([encoder.finish()]);
        });
        throwIfDeviceLost();

        let mapped = false;
        let primaryError;
        let allBins;
        try {
          const mapPromise = stagingBuffer.mapAsync(GPUMapMode.READ);
          void mapPromise.catch(() => {});
          const mapState = await Promise.race([
            mapPromise.then(() => "mapped"),
            lostPromise.then(() => "lost"),
          ]);
          if (mapState === "lost") {
            throwIfDeviceLost();
            throw new Error("WebGPU device was lost during v210 histogram readback");
          }
          mapped = true;
          throwIfDeviceLost();
          allBins = new Uint32Array(stagingBuffer.getMappedRange()).slice();
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          if (mapped) {
            try { stagingBuffer.unmap(); } catch (error) { if (!primaryError) throw error; }
          }
        }

        const channels = Array.from({ length: channelCount }, (_, index) => allBins.subarray(
          vectorArea + index * channelArea,
          vectorArea + (index + 1) * channelArea,
        ));
        const channelNames = config.waveformMode === "luma" ? ["Y"]
          : config.waveformMode === "ycbcr-parade" ? ["Y", "Cb", "Cr"]
            : config.waveformMode === "composite" ? ["Composite"] : ["R", "G", "B"];
        return {
          width,
          height,
          sampleCount: config.sampleWidth * config.sampleHeight,
          waveform: { width: config.waveformWidth, height: config.waveformHeight, bitDepth: 10, mode: config.waveformMode, channelNames, channels },
          vectorscope: { width: config.vectorscopeSize, height: config.vectorscopeSize, bins: allBins.subarray(0, vectorArea), colorMatrix: config.colorMatrix },
          stats: { colorMatrix: config.colorMatrix, colorRange: config.colorRange, bitDepth: 10 },
        };
      });
      inFlight = task.then(() => undefined, () => undefined);
      return task;
    }

    return {
      device,
      videoTextureMode: useExternalVideoTextures ? "external" : "copy",
      analyze: (source, analysisOptions) => analyze(source, analysisOptions, false),
      analyzeVideo: (source, analysisOptions) => analyze(source, analysisOptions, useExternalVideoTextures),
      analyzeV210,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        // Wait for active readback to settle before releasing owned resources.
        void inFlight.then(releaseResources, releaseResources);
      },
    };
  } catch (error) {
    releaseResources();
    throw error;
  }
}

function displayNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function displayChannelNames(mode) {
  return mode === "luma" ? ["Y"]
    : mode === "ycbcr-parade" ? ["Y", "Cb", "Cr"]
      : mode === "composite" ? ["Composite"] : ["R", "G", "B"];
}

function isVideoSource(source) {
  return (typeof globalThis.VideoFrame === "function" && source instanceof globalThis.VideoFrame)
    || source?.nodeName === "VIDEO"
    || source?.tagName === "VIDEO"
    || (Number.isFinite(source?.videoWidth) && Number.isFinite(source?.videoHeight));
}

function isV210Source(source) {
  return source?.format === "v210"
    && ArrayBuffer.isView(source.data)
    && Number.isInteger(source.width)
    && Number.isInteger(source.height);
}

function isExternalPackedV210Source(source) {
  return source?.format === "v210-rgba-external"
    && typeof globalThis.VideoFrame === "function"
    && source.frame instanceof globalThis.VideoFrame
    && Number.isInteger(source.width)
    && Number.isInteger(source.height);
}

/** Create an opt-in WebGPU display which keeps histograms on the GPU between snapshots. */
export async function createScopeDisplay(options = {}) {
  const canvas = options.canvas;
  if (!canvas || typeof canvas.getContext !== "function") throw new TypeError("createScopeDisplay requires an HTML canvas");
  let context;
  try { context = canvas.getContext("webgpu"); } catch (error) {
    throw new Error(`Could not acquire a fresh WebGPU canvas context: ${error.message}`);
  }
  if (!context) throw new Error("createScopeDisplay requires a fresh canvas without a previously acquired 2D context");
  const previewCanvas = options.previewCanvas;
  if (previewCanvas === canvas) throw new TypeError("previewCanvas must be different from the scope canvas");
  let previewContext;
  if (previewCanvas !== undefined) {
    if (!previewCanvas || typeof previewCanvas.getContext !== "function") {
      throw new TypeError("previewCanvas must be an HTML canvas");
    }
    try { previewContext = previewCanvas.getContext("webgpu"); } catch (error) {
      throw new Error(`Could not acquire a fresh WebGPU preview canvas context: ${error.message}`);
    }
    if (!previewContext) throw new Error("previewCanvas requires a fresh canvas without a previously acquired 2D context");
  }

  let device = options.device;
  let ownsDevice = false;
  let format;
  let pipeline;
  let packedPipeline;
  let externalPackedPipeline;
  let externalPackedPreviewPipeline;
  let externalPackedParityPipeline;
  let previewPipeline;
  let previewFormat;
  let renderer;
  let destroyed = false;
  let resourcesReleased = false;
  let lossState;
  let lostPromise;
  let externalPipeline;
  let videoQualifier;
  let videoSampler;
  let pendingRequest;
  let pumpRunning = false;
  let frameId = 0;
  let submittedFrames = 0;
  let queueCompletedFrames = 0;
  let latestFrame;
  let destroyPromise;
  let resolveDestroy;
  const slots = [makeSlot(), makeSlot()];
  const completionTasks = new Set();
  const snapshotTasks = new Set();
  const commandTasks = new Set();
  const useExternalVideoTextures = options.videoTextureMode === "external";
  const videoCapture = {};

  function makeSlot() {
    return {
      binsBuffer: undefined,
      computeParamsBuffer: undefined,
      renderParamsBuffer: undefined,
      previewParamsBuffer: undefined,
      v210Buffer: undefined,
      v210BufferSize: 0,
      v210BindGroup: undefined,
      bufferSize: 0,
      texture: undefined,
      textureView: undefined,
      textureWidth: 0,
      textureHeight: 0,
      busy: false,
      outstanding: false,
      snapshotRefs: 0,
      frame: undefined,
    };
  }

  async function withValidationScope(operation) {
    let scopeOpen = false;
    try {
      device.pushErrorScope("validation");
      scopeOpen = true;
      const value = operation();
      const error = await device.popErrorScope();
      scopeOpen = false;
      if (error) throw new Error(`WebGPU validation failed: ${error.message}`);
      return value;
    } catch (error) {
      if (scopeOpen) {
        try { await device.popErrorScope(); } catch {}
      }
      throw error;
    }
  }

  function throwIfUnavailable() {
    if (destroyed) throw new Error("Scope display has been destroyed");
    if (lossState) {
      const detail = lossState.info?.message ?? lossState.error?.message ?? "device was lost";
      throw new Error(`WebGPU device lost: ${detail}`);
    }
  }

  function emitDeviceLoss(state) {
    if (lossState) return;
    lossState = state;
    const detail = state.info?.message ?? state.error?.message ?? "device was lost";
    try { options.onDeviceLost?.(new Error(`WebGPU device lost: ${detail}`)); } catch {}
    if (pendingRequest) {
      pendingRequest.reject(new Error(`WebGPU device lost: ${detail}`));
      pendingRequest = undefined;
    }
    void pump();
    maybeRelease();
  }

  function releaseResources() {
    if (resourcesReleased) return;
    resourcesReleased = true;
    videoQualifier?.destroy();
    if (videoCapture.canvas) {
      videoCapture.canvas.width = 1;
      videoCapture.canvas.height = 1;
      videoCapture.canvas = undefined;
      videoCapture.context = undefined;
    }
    try { renderer?.destroy(); } catch {}
    for (const slot of slots) {
      for (const resource of [slot.texture, slot.binsBuffer, slot.computeParamsBuffer, slot.renderParamsBuffer,
        slot.previewParamsBuffer, slot.v210Buffer]) {
        try { resource?.destroy(); } catch {}
      }
    }
    try { context.unconfigure?.(); } catch {}
    if (ownsDevice) {
      try { device?.destroy(); } catch {}
    }
  }

  function maybeRelease() {
    if (!destroyed || pumpRunning || commandTasks.size || completionTasks.size || snapshotTasks.size) return;
    releaseResources();
    resolveDestroy?.();
    resolveDestroy = undefined;
  }

  function validLimits(width, height, config, byteLength, externalVideo, renderOptions) {
    const limits = device.limits ?? {};
    const max = (name) => Number.isFinite(limits[name]) ? limits[name] : Number.POSITIVE_INFINITY;
    const pixelRatio = renderOptions.devicePixelRatio ?? 1;
    const outputWidth = renderOptions.width && renderOptions.height
      ? Math.round(renderOptions.width * pixelRatio) : canvas.width;
    const outputHeight = renderOptions.width && renderOptions.height
      ? Math.round(renderOptions.height * pixelRatio) : canvas.height;
    if (width > max("maxTextureDimension2D") || height > max("maxTextureDimension2D")
      || outputWidth > max("maxTextureDimension2D") || outputHeight > max("maxTextureDimension2D")) {
      throw new RangeError(`Frame exceeds the GPU texture limit (${max("maxTextureDimension2D")}px)`);
    }
    if (Math.ceil(config.sampleWidth / 8) > max("maxComputeWorkgroupsPerDimension")
      || Math.ceil(config.sampleHeight / 8) > max("maxComputeWorkgroupsPerDimension")) {
      throw new RangeError("Frame exceeds the GPU dispatch limit");
    }
    if (max("maxComputeWorkgroupSizeX") < 8 || max("maxComputeWorkgroupSizeY") < 8
      || max("maxComputeInvocationsPerWorkgroup") < 64) {
      throw new RangeError("GPU device does not support the required 8 × 8 compute workgroup");
    }
    if (byteLength > max("maxBufferSize") || byteLength > max("maxStorageBufferBindingSize")) {
      throw new RangeError("Histogram buffers exceed the GPU device limits");
    }
    if (128 > max("maxBufferSize") || 128 > max("maxUniformBufferBindingSize")) {
      throw new RangeError("GPU device cannot allocate the display parameter buffers");
    }
    if (max("maxBindingsPerBindGroup") < 4 || max("maxStorageBuffersPerShaderStage") < 1
      || max("maxUniformBuffersPerShaderStage") < (externalVideo ? 2 : 1)
      || max("maxSampledTexturesPerShaderStage") < (externalVideo ? 4 : 2)
      || (externalVideo && max("maxSamplersPerShaderStage") < 2)) {
      throw new RangeError("GPU device limits do not support external video textures in the histogram shader");
    }
  }

  function ensureSlotBuffers(slot, byteLength) {
    if (slot.bufferSize === byteLength) return;
    const nextBins = device.createBuffer({
      label: "webscopes direct display histograms",
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    let nextComputeParams;
    let nextRenderParams;
    let nextPreviewParams;
    try {
      nextComputeParams = device.createBuffer({
        label: "webscopes direct display analysis parameters",
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      nextRenderParams = device.createBuffer({
        label: "webscopes direct display render parameters",
        size: 128,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      if (previewCanvas) {
        nextPreviewParams = device.createBuffer({
          label: "webscopes direct display preview parameters",
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
    } catch (error) {
      for (const resource of [nextBins, nextComputeParams, nextRenderParams, nextPreviewParams]) {
        try { resource?.destroy(); } catch {}
      }
      throw error;
    }
    for (const resource of [slot.binsBuffer, slot.computeParamsBuffer, slot.renderParamsBuffer, slot.previewParamsBuffer]) {
      try { resource?.destroy(); } catch {}
    }
    slot.binsBuffer = nextBins;
    slot.computeParamsBuffer = nextComputeParams;
    slot.renderParamsBuffer = nextRenderParams;
    slot.previewParamsBuffer = nextPreviewParams;
    slot.v210BindGroup = undefined;
    slot.bufferSize = byteLength;
  }

  function ensureSlotV210Buffer(slot, byteLength) {
    if (slot.v210BufferSize === byteLength) return;
    slot.v210Buffer?.destroy();
    slot.v210Buffer = device.createBuffer({
      label: "webscopes direct display packed v210 frame",
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    slot.v210BufferSize = byteLength;
    slot.v210BindGroup = undefined;
  }

  function ensureSlotTexture(slot, width, height) {
    if (slot.textureWidth === width && slot.textureHeight === height) return;
    slot.texture?.destroy();
    slot.texture = device.createTexture({
      label: "webscopes direct display source frame",
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    slot.textureView = slot.texture.createView();
    slot.textureWidth = width;
    slot.textureHeight = height;
  }

  async function getExternalPipeline() {
    if (externalPipeline) return externalPipeline;
    const created = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: EXTERNAL_COMPUTE_SHADER, label: "webscopes display external-video compute" });
      return device.createComputePipeline({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
    });
    externalPipeline = created;
    return created;
  }

  async function getPackedPipeline() {
    if (packedPipeline) return packedPipeline;
    const created = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: V210_COMPUTE_SHADER, label: "webscopes display packed-v210 compute" });
      return device.createComputePipeline({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
    });
    packedPipeline = created;
    return created;
  }

  async function getExternalPackedPipeline() {
    if (externalPackedPipeline) return externalPackedPipeline;
    externalPackedPipeline = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: V210_EXTERNAL_COMPUTE_SHADER, label: "webscopes external packed-v210 compute" });
      return device.createComputePipeline({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
    });
    return externalPackedPipeline;
  }

  async function getExternalPackedPreviewPipeline() {
    if (externalPackedPreviewPipeline) return externalPackedPreviewPipeline;
    externalPackedPreviewPipeline = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: V210_EXTERNAL_PREVIEW_SHADER, label: "webscopes external packed-v210 preview" });
      return device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vertex" },
        fragment: { module: shader, entryPoint: "fragment", targets: [{ format: previewFormat }] },
        primitive: { topology: "triangle-list" },
      });
    });
    return externalPackedPreviewPipeline;
  }

  async function getExternalPackedParityPipeline() {
    if (externalPackedParityPipeline) return externalPackedParityPipeline;
    externalPackedParityPipeline = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: V210_EXTERNAL_PARITY_SHADER, label: "webscopes external v210 byte parity" });
      return device.createComputePipeline({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
    });
    return externalPackedParityPipeline;
  }

  async function getPreviewPipeline() {
    if (previewPipeline) return previewPipeline;
    const created = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: V210_PREVIEW_SHADER, label: "webscopes display packed-v210 preview" });
      return device.createRenderPipeline({
        label: "webscopes packed-v210 preview pipeline",
        layout: "auto",
        vertex: { module: shader, entryPoint: "vertex" },
        fragment: { module: shader, entryPoint: "fragment", targets: [{ format: previewFormat }] },
        primitive: { topology: "triangle-list" },
      });
    });
    previewPipeline = created;
    return created;
  }

  function availableSlot() {
    return slots.find((slot) => !slot.busy && !slot.outstanding && slot.snapshotRefs === 0 && slot !== latestFrame?.slot);
  }

  function trackQueueCompletion(slot, completedFrameId) {
    slot.outstanding = true;
    let queueWork;
    try {
      queueWork = device.queue.onSubmittedWorkDone?.();
    } catch (error) {
      queueWork = Promise.reject(error);
    }
    const lostWork = lostPromise.then(() => { throwIfUnavailable(); });
    const completion = Promise.race([Promise.resolve(queueWork), lostWork]).then(() => {
      slot.outstanding = false;
      if (completedFrameId === undefined) return;
      queueCompletedFrames = Math.max(queueCompletedFrames, completedFrameId);
      try { options.onQueueCompleted?.({ frameId: completedFrameId, submittedFrames, queueCompletedFrames }); } catch {}
    }, (error) => {
      slot.outstanding = false;
      if (lossState) emitDeviceLoss(lossState);
      else {
        try { options.onError?.(error); } catch {}
      }
    }).finally(() => {
      completionTasks.delete(completion);
      void pump();
      maybeRelease();
    });
    completionTasks.add(completion);
    return completion;
  }

  function buildFrameMetadata(sourceWidth, sourceHeight, config, frameNumber) {
    const channelCount = config.waveformMode === "luma" || config.waveformMode === "composite" ? 1 : 3;
    const metadata = {
      frameId: frameNumber,
      width: sourceWidth,
      height: sourceHeight,
      sampleCount: config.sampleWidth * config.sampleHeight,
      waveform: {
        width: config.waveformWidth,
        height: config.waveformHeight,
        bitDepth: config.bitDepth,
        mode: config.waveformMode,
        channelNames: displayChannelNames(config.waveformMode),
        channelCount,
      },
      vectorscope: { width: config.vectorscopeSize, height: config.vectorscopeSize, colorMatrix: config.colorMatrix },
      stats: { colorMatrix: config.colorMatrix, colorRange: config.colorRange, bitDepth: config.bitDepth },
    };
    return metadata;
  }

  async function submitRequest(slot, request) {
    throwIfUnavailable();
    const { analysisOptions, resolve, reject } = request;
      let source = request.source;
      let ownedFrame;
    const startedAt = displayNow();
    let queueSubmitted = false;
    try {
      const externalPackedVideo = isExternalPackedV210Source(source);
      const packedVideo = isV210Source(source) || externalPackedVideo;
      if (source && typeof source === "object" && "data" in source && !packedVideo) {
        throw new TypeError("ScopeDisplay accepts decoded browser image/video sources; use createScopes for raw pixel frames");
      }
      let packedBytesPerRow;
      if (packedVideo) {
        packedBytesPerRow = source.bytesPerRow ?? Math.ceil(source.width / 48) * 128;
        const minimumRowBytes = Math.ceil(source.width / 6) * 16;
        if (!Number.isSafeInteger(packedBytesPerRow) || packedBytesPerRow < minimumRowBytes
          || packedBytesPerRow % 4 !== 0 || !Number.isSafeInteger(packedBytesPerRow * source.height)
          || (externalPackedVideo
            ? source.rgbaWidth !== Math.ceil(packedBytesPerRow / 3)
              || source.frame.codedWidth !== source.rgbaWidth || source.frame.codedHeight !== source.height
            : source.data.byteLength % 4 !== 0 || source.data.byteLength < packedBytesPerRow * source.height)) {
          throw new RangeError("Packed v210 data is truncated or has an invalid row stride");
        }
      }
      if (!packedVideo && useExternalVideoTextures && isVideoSource(source) && typeof globalThis.VideoFrame === "function"
        && !(source instanceof globalThis.VideoFrame)) {
        try { source = ownedFrame = new globalThis.VideoFrame(source); } catch {}
      }
      const { width, height } = getSourceSize(source);
      const merged = { ...options, ...analysisOptions };
      const config = normalizeAnalysisOptions(width, height, {
          ...merged,
          bitDepth: packedVideo ? (merged.bitDepth ?? 10) : (merged.bitDepth ?? 8),
        colorMatrix: packedVideo ? (merged.colorMatrix ?? source.colorMatrix) : merged.colorMatrix,
        colorRange: packedVideo ? (merged.colorRange ?? source.colorRange) : merged.colorRange,
      });
      if (packedVideo && config.bitDepth !== 10) throw new RangeError("v210 frames have a fixed bit depth of 10");
      const channelCount = config.waveformMode === "luma" || config.waveformMode === "composite" ? 1 : 3;
      const vectorArea = config.vectorscopeSize * config.vectorscopeSize;
      const channelArea = config.waveformWidth * config.waveformHeight;
      const binCount = vectorArea + channelArea * channelCount;
      const byteLength = binCount * Uint32Array.BYTES_PER_ELEMENT;
      const transfer = !packedVideo && useExternalVideoTextures && isVideoSource(source) ? await videoQualifier.qualify(source) : null;
      const externalVideo = transfer !== null;
      throwIfUnavailable();
      if (externalVideo) videoSampler ??= device.createSampler({ minFilter: "linear", magFilter: "linear" });
      const renderOptions = { ...options.renderOptions, ...analysisOptions.renderOptions };
      validLimits(width, height, config, byteLength, externalVideo || externalPackedVideo, renderOptions);
      if (externalVideo && typeof device.importExternalTexture !== "function") {
        throw new Error("This WebGPU device does not support external video textures");
      }
      if (packedVideo && !externalPackedVideo && (source.data.byteLength > (device.limits?.maxBufferSize ?? Number.POSITIVE_INFINITY)
        || source.data.byteLength > (device.limits?.maxStorageBufferBindingSize ?? Number.POSITIVE_INFINITY))) {
        throw new RangeError("Packed v210 frame exceeds the GPU storage-buffer limit");
      }
      ensureSlotBuffers(slot, byteLength);
      if (packedVideo && !externalPackedVideo) ensureSlotV210Buffer(slot, source.data.byteLength);
      else if (!externalVideo) ensureSlotTexture(slot, width, height);

      const matrix = getColorMatrix(config.colorMatrix);
      const computeParams = new ArrayBuffer(64);
      const computeView = new DataView(computeParams);
      const words = [width, height, config.waveformWidth, config.waveformHeight, gpuMode(config.waveformMode), config.x0, config.y0, config.cropWidth,
        config.cropHeight, config.vectorscopeSize, config.sampleWidth, config.sampleHeight];
      words.forEach((word, index) => computeView.setUint32(index * 4, word, true));
      if (packedVideo) {
        computeView.setFloat32(48, packedBytesPerRow / 4, true);
        computeView.setFloat32(52, matrix.kr, true);
        computeView.setFloat32(56, matrix.kb, true);
        computeView.setFloat32(60, config.colorRange === "full" ? 1 : 0, true);
      } else {
        computeView.setUint32(48, matrix.krFixed, true);
        computeView.setUint32(52, matrix.kbFixed, true);
        computeView.setUint32(56, 1024, true);
        computeView.setUint32(60, transfer ?? 0, true);
      }
      const activePipeline = externalPackedVideo ? await getExternalPackedPipeline()
        : packedVideo ? await getPackedPipeline() : (externalVideo ? await getExternalPipeline() : pipeline);
      let previewPipelineForFrame;
      if (packedVideo && previewCanvas) previewPipelineForFrame = externalPackedVideo
        ? await getExternalPackedPreviewPipeline() : await getPreviewPipeline();
      const parityPipeline = externalPackedVideo && source.validateBytes ? await getExternalPackedParityPipeline() : undefined;
      let parityOutput;
      let parityReadback;
      let parityParams;
      await withValidationScope(() => {
        let sourceResource;
        if (externalPackedVideo) {
          sourceResource = device.importExternalTexture({ source: source.frame, colorSpace: "srgb" });
          device.queue.writeBuffer(slot.computeParamsBuffer, 0, computeParams);
        } else if (packedVideo) {
          const data = new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);
          device.queue.writeBuffer(slot.v210Buffer, 0, data);
          device.queue.writeBuffer(slot.computeParamsBuffer, 0, computeParams);
          slot.v210BindGroup ??= device.createBindGroup({
            layout: activePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: slot.v210Buffer } },
              { binding: 1, resource: { buffer: slot.binsBuffer } },
              { binding: 2, resource: { buffer: slot.computeParamsBuffer } },
            ],
          });
          sourceResource = slot.v210BindGroup;
        } else if (externalVideo) {
          sourceResource = device.importExternalTexture({ source, colorSpace: "srgb" });
        } else {
          // Match createScopes: direct video uploads can take the same browser
          // conversion path as external textures, so normalize via sRGB first.
          const uploadSource = isVideoSource(source)
            ? captureFrameToCanvas(source, videoCapture, { willReadFrequently: false, colorSpace: "srgb" }).canvas
            : source;
          device.queue.copyExternalImageToTexture(
            { source: uploadSource },
            { texture: slot.texture, colorSpace: "srgb", premultipliedAlpha: false },
            { width, height },
          );
          sourceResource = slot.textureView;
        }
        const computeBindGroup = packedVideo && !externalPackedVideo ? sourceResource : (() => {
          device.queue.writeBuffer(slot.computeParamsBuffer, 0, computeParams);
          return device.createBindGroup({
            layout: activePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: sourceResource },
              { binding: 1, resource: { buffer: slot.binsBuffer } },
              { binding: 2, resource: { buffer: slot.computeParamsBuffer } },
              ...(externalVideo ? [{ binding: 3, resource: videoSampler }] : []),
            ],
          });
        })();
        const resultMetadata = buildFrameMetadata(width, height, config, frameId + 1);
        const encoder = device.createCommandEncoder({ label: "webscopes direct display frame" });
        encoder.clearBuffer(slot.binsBuffer);
        const computePass = encoder.beginComputePass({ label: "webscopes histogram computation" });
        computePass.setPipeline(activePipeline);
        computePass.setBindGroup(0, computeBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(config.sampleWidth / 8), Math.ceil(config.sampleHeight / 8));
        computePass.end();
        if (parityPipeline) {
          const packedByteLength = packedBytesPerRow * height;
          parityOutput = device.createBuffer({
            label: "webscopes external v210 byte parity output",
            size: packedByteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          });
          parityReadback = device.createBuffer({
            label: "webscopes external v210 byte parity readback",
            size: packedByteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          parityParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          const parityValues = new Float32Array([packedBytesPerRow / 4, 0, 0, 0]);
          device.queue.writeBuffer(parityParams, 0, parityValues);
          const parityBindGroup = device.createBindGroup({
            layout: parityPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: sourceResource },
              { binding: 1, resource: { buffer: parityOutput } },
              { binding: 2, resource: { buffer: parityParams } },
            ],
          });
          const parityPass = encoder.beginComputePass({ label: "webscopes external v210 byte parity" });
          parityPass.setPipeline(parityPipeline);
          parityPass.setBindGroup(0, parityBindGroup);
          parityPass.dispatchWorkgroups(Math.ceil((packedBytesPerRow / 4) / 64), height);
          parityPass.end();
          encoder.copyBufferToBuffer(parityOutput, 0, parityReadback, 0, packedByteLength);
        }
        renderer.encode(encoder, { binsBuffer: slot.binsBuffer, renderParamsBuffer: slot.renderParamsBuffer, result: resultMetadata, renderOptions });
        if (packedVideo && previewPipelineForFrame) {
          const previewWidth = Math.max(1, previewCanvas.width);
          const previewHeight = Math.max(1, previewCanvas.height);
          const previewParams = new ArrayBuffer(32);
          const previewView = new DataView(previewParams);
          previewView.setUint32(0, width, true);
          previewView.setUint32(4, height, true);
          previewView.setUint32(8, previewWidth, true);
          previewView.setUint32(12, previewHeight, true);
          previewView.setFloat32(16, packedBytesPerRow / 4, true);
          previewView.setFloat32(20, matrix.kr, true);
          previewView.setFloat32(24, matrix.kb, true);
          previewView.setFloat32(28, config.colorRange === "full" ? 1 : 0, true);
          device.queue.writeBuffer(slot.previewParamsBuffer, 0, previewParams);
          const previewBindGroup = device.createBindGroup({
            layout: previewPipelineForFrame.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: externalPackedVideo ? sourceResource : { buffer: slot.v210Buffer } },
              { binding: 1, resource: { buffer: slot.previewParamsBuffer } },
            ],
          });
          const previewPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: previewContext.getCurrentTexture().createView(),
              loadOp: "clear",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              storeOp: "store",
            }],
          });
          previewPass.setPipeline(previewPipelineForFrame);
          previewPass.setBindGroup(0, previewBindGroup);
          previewPass.draw(3, 1, 0, 0);
          previewPass.end();
        }
        device.queue.submit([encoder.finish()]);
        queueSubmitted = true;
      });
      throwIfUnavailable();
      const id = ++frameId;
      const metadata = buildFrameMetadata(width, height, config, id);
      if (isVideoSource(source)) metadata.stats.videoColorMode = externalVideo ? (transfer === 1 ? "external-apple" : "external-identity") : "canvas";
      slot.frame = { metadata, vectorArea, channelArea, channelCount, byteLength, frameId: id };
      slot.outstanding = true;
      slot.busy = false;
      submittedFrames += 1;
      latestFrame = { slot, ...slot.frame };
      const submissionTimeMs = Math.max(0, displayNow() - startedAt);
      trackQueueCompletion(slot, id);
      let validationBytes;
      if (parityReadback) {
        validationBytes = parityReadback.mapAsync(GPUMapMode.READ).then(() => {
          const bytes = new Uint8Array(parityReadback.getMappedRange()).slice();
          parityReadback.unmap();
          return bytes;
        }).finally(() => {
          parityReadback.destroy();
          parityOutput.destroy();
          parityParams.destroy();
        });
      }
      resolve({
        status: "submitted",
        frameId: id,
        submittedFrames,
        queueCompletedFrames,
        metadata,
        submissionTimeMs,
        ...(validationBytes ? { validationBytes } : {}),
      });
    } catch (error) {
      slot.busy = false;
      // queue.submit can precede an asynchronous validation-scope or device
      // loss error. Keep this slot and its buffers alive until queued work has
      // drained even when the request itself rejects.
      if (queueSubmitted) trackQueueCompletion(slot, undefined);
      else { parityReadback?.destroy(); parityOutput?.destroy(); parityParams?.destroy(); }
      reject(error);
    } finally {
      ownedFrame?.close();
    }
  }

  async function pump() {
    if (pumpRunning) return;
    pumpRunning = true;
    try {
      while (!destroyed && pendingRequest) {
        const slot = availableSlot();
        if (!slot) break;
        const request = pendingRequest;
        pendingRequest = undefined;
        slot.busy = true;
        const task = submitRequest(slot, request);
        commandTasks.add(task);
        void task.finally(() => {
          commandTasks.delete(task);
          maybeRelease();
        });
        await task;
      }
    } finally {
      pumpRunning = false;
      maybeRelease();
      if (!destroyed && pendingRequest && availableSlot()) void pump();
    }
  }

  try {
    if (!device) {
      let adapter = options.adapter;
      if (!adapter) {
        const gpu = options.gpu ?? globalThis.navigator?.gpu;
        if (!gpu) throw new Error("WebGPU is not available in this browser");
        adapter = await gpu.requestAdapter(options.adapterOptions);
      }
      if (!adapter) throw new Error("No WebGPU adapter is available");
      device = await adapter.requestDevice();
      ownsDevice = true;
    }
    videoQualifier = createVideoColorQualifier(device);
    lostPromise = device.lost && typeof device.lost.then === "function"
      ? device.lost.then((info) => { emitDeviceLoss({ info }); return { info }; }, (error) => { emitDeviceLoss({ error }); return { error }; })
      : new Promise(() => {});
    format = options.format ?? (options.gpu ?? globalThis.navigator?.gpu)?.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    context.configure({
      device,
      format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    if (previewContext) {
      previewFormat = options.previewFormat ?? format;
      previewContext.configure({
        device,
        format: previewFormat,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const compute = await withValidationScope(() => {
      const shader = device.createShaderModule({ code: COMPUTE_SHADER, label: "webscopes shared histogram compute" });
      return device.createComputePipeline({ layout: "auto", compute: { module: shader, entryPoint: "main" } });
    });
    pipeline = compute;
    renderer = await withValidationScope(() => createWebGpuScopeRenderer({ device, canvas, context, format }));
    throwIfUnavailable();
  } catch (error) {
    destroyed = true;
    releaseResources();
    throw error;
  }

  return {
    get submittedFrames() { return submittedFrames; },
    /** Number of submitted frame queues completed by WebGPU; this is not compositor presentation. */
    get queueCompletedFrames() { return queueCompletedFrames; },
    get canvas() { return canvas; },
    present(source, analysisOptions = {}) {
      if (destroyed) return Promise.reject(new Error("Scope display has been destroyed"));
      if (lossState) return Promise.reject(new Error(`WebGPU device lost: ${lossState.info?.message ?? lossState.error?.message ?? "device was lost"}`));
      return new Promise((resolve, reject) => {
        if (pendingRequest) pendingRequest.resolve({ status: "superseded" });
        pendingRequest = { source, analysisOptions, resolve, reject };
        void pump();
      });
    },
    async snapshot() {
      if (destroyed) throw new Error("Scope display has been destroyed");
      throwIfUnavailable();
      const frame = latestFrame;
      if (!frame) throw new Error("No frame has been submitted yet");
      const slot = frame.slot;
      slot.snapshotRefs += 1;
      const task = (async () => {
        let staging;
        let mapped = false;
        try {
          throwIfUnavailable();
          staging = device.createBuffer({
            label: `webscopes snapshot frame ${frame.frameId}`,
            size: frame.byteLength,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          const encoder = device.createCommandEncoder({ label: `webscopes histogram snapshot frame ${frame.frameId}` });
          encoder.copyBufferToBuffer(slot.binsBuffer, 0, staging, 0, frame.byteLength);
          device.queue.submit([encoder.finish()]);
          const mapPromise = staging.mapAsync(GPUMapMode.READ);
          void mapPromise.catch(() => {});
          await Promise.race([mapPromise, lostPromise.then(() => { throwIfUnavailable(); })]);
          mapped = true;
          throwIfUnavailable();
          const allBins = new Uint32Array(staging.getMappedRange()).slice();
          const channels = Array.from({ length: frame.channelCount }, (_, index) => new Uint32Array(allBins.subarray(
            frame.vectorArea + index * frame.channelArea,
            frame.vectorArea + (index + 1) * frame.channelArea,
          )));
          const vectorscopeBins = new Uint32Array(allBins.subarray(0, frame.vectorArea));
          return {
            width: frame.metadata.width,
            height: frame.metadata.height,
            sampleCount: frame.metadata.sampleCount,
            waveform: {
              width: frame.metadata.waveform.width,
              height: frame.metadata.waveform.height,
              bitDepth: frame.metadata.waveform.bitDepth,
              mode: frame.metadata.waveform.mode,
              channelNames: [...frame.metadata.waveform.channelNames],
              channels,
            },
            vectorscope: {
              width: frame.metadata.vectorscope.width,
              height: frame.metadata.vectorscope.height,
              bins: vectorscopeBins,
              colorMatrix: frame.metadata.vectorscope.colorMatrix,
            },
            stats: { ...frame.metadata.stats },
          };
        } finally {
          if (mapped) {
            try { staging.unmap(); } catch {}
          }
          try { staging?.destroy(); } catch {}
          slot.snapshotRefs -= 1;
          void pump();
          maybeRelease();
        }
      })();
      snapshotTasks.add(task);
      try { return await task; }
      finally {
        snapshotTasks.delete(task);
        maybeRelease();
      }
    },
    destroy() {
      if (!destroyed) {
        destroyed = true;
        if (pendingRequest) {
          pendingRequest.reject(new Error("Scope display has been destroyed"));
          pendingRequest = undefined;
        }
      }
      if (!destroyPromise) destroyPromise = new Promise((resolve) => { resolveDestroy = resolve; });
      maybeRelease();
      return destroyPromise;
    },
  };
}
