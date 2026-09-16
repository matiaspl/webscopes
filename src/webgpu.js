import { getColorMatrix, getSourceSize, normalizeAnalysisOptions } from "./analyze.js";

const COMPUTE_SHADER = /* wgsl */ `
struct Params {
  dims: vec4<u32>,       // input width, input height, waveform width, waveform height
  crop: vec4<u32>,       // mode, crop x, crop y, crop width
  extra: vec4<u32>,      // crop height, vectorscope size, sampled width, sampled height
  coeff: vec4<u32>,      // fixed-point Kr, Kb, fixed-point scale, unused
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

function gpuMode(mode) {
  if (mode === "luma") return 1;
  if (mode === "ycbcr-parade") return 2;
  if (mode === "composite") return 3;
  return 0;
}

export async function createWebGpuAnalyzer(options = {}) {
  let device = options.device;
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
  let destroyed = false;
  let resourcesReleased = false;
  let inFlight = Promise.resolve();
  let lossState;

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
    for (const resource of [texture, binsBuffer, stagingBuffer, paramsBuffer]) {
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
    throwIfDeviceLost();

    async function analyze(source, analysisOptions = {}) {
      const task = inFlight.then(async () => {
        if (destroyed) throw new Error("WebGPU analyzer has been destroyed");
        throwIfDeviceLost();
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

        const matrix = getColorMatrix(colorMatrix);
        const words = [width, height, waveformWidth, waveformHeight, gpuMode(waveformMode), x0, y0, cropWidth, cropHeight, vectorscopeSize, sampleWidth, sampleHeight];
        words.forEach((word, index) => parameterView.setUint32(index * 4, word, true));
        parameterView.setUint32(48, matrix.krFixed, true);
        parameterView.setUint32(52, matrix.kbFixed, true);
        parameterView.setUint32(56, 1024, true);

        await withValidationScope(() => {
          ensureTexture(width, height);
          device.queue.copyExternalImageToTexture(
            { source },
            { texture, colorSpace: "srgb", premultipliedAlpha: false },
            { width, height },
          );
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
          const encoder = device.createCommandEncoder({ label: "webscopes analyze frame" });
          encoder.clearBuffer(binsBuffer);
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
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
          stats: { colorMatrix, bitDepth },
        };
      });
      // Do not keep the previous result alive through the serialization gate;
      // createScopes owns only the latest published result.
      inFlight = task.then(() => undefined, () => undefined);
      return task;
    }

    return {
      device,
      analyze,
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
