// The browser can hide BT709_APPLE behind public "bt709" metadata. Never choose
// the inverse from the user agent or metadata alone: qualify the actual frame.
export const VIDEO_TRANSFER_SHADER = /* wgsl */ `
fn undoAppleTransfer(value: vec3f) -> vec3f {
  let c = clamp(value, vec3f(0.0), vec3f(1.0));
  let linear = select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
  return pow(linear, vec3f(1.0 / 1.961));
}
`;

export function canQualifyVideo(frame) {
  const cs = frame?.colorSpace;
  return frame?.format === "NV12" && cs?.primaries === "bt709" && cs?.matrix === "bt709"
    && ["bt709", "iec61966-2-1"].includes(cs.transfer) && typeof cs.fullRange === "boolean";
}

// Each GPU sample contains the unmodified and inverse-Apple candidates as two
// vec4f values. Bounds include float/UNORM rounding tolerance, not a gamma fit.
export function selectVideoTransfer(reference, samples) {
  if (!reference.length || reference.length % 4 || samples.length !== reference.length * 2) return null;
  const scores = [0, 0], maxima = [0, 0];
  for (let i = 0; i < reference.length / 4; i++) {
    if (reference[i * 4 + 3] !== 255) return null;
    for (let c = 0; c < 3; c++) {
      for (let mode = 0; mode < 2; mode++) {
        const v = samples[i * 8 + mode * 4 + c];
        if (!Number.isFinite(v)) return null;
        const error = Math.abs(Math.min(1, Math.max(0, v)) * 255 - reference[i * 4 + c]);
        scores[mode] += error;
        maxima[mode] = Math.max(maxima[mode], error);
      }
    }
  }
  const count = reference.length / 4 * 3;
  scores[0] /= count; scores[1] /= count;
  const best = scores[0] <= scores[1] ? 0 : 1;
  // Flat black/white does not distinguish the curves. Stay on canvas until a
  // frame contains enough evidence. Recheck every frame, including failures.
  if (maxima[best] > 0.55 || scores[best] > 0.35 || scores[1 - best] - scores[best] < 0.5) return null;
  return best;
}

const GRID = 8, COUNT = GRID * GRID, BYTES = COUNT * 32;
const PROBE_SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<storage, read_write> samples: array<vec4f>;
${VIDEO_TRANSFER_SHADER}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(source);
  let pixel = min(size - vec2u(1), vec2u(floor((vec2f(id.xy) + 0.5) * vec2f(size) / 8.0)));
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let rgb = textureSampleBaseClampToEdge(source, linearSampler, uv);
  let i = (id.y * 8u + id.x) * 2u;
  samples[i] = rgb;
  samples[i + 1u] = vec4f(undoAppleTransfer(rgb.rgb), rgb.a);
}`;

/** Serial use only; the owning analyzer/display drains its work before destroy. */
export function createVideoColorQualifier(device) {
  let canvas, context, pipeline, output, staging, sampler;
  let lost = false, rejectMapping;
  const onLost = () => {
    lost = true;
    rejectMapping?.(new Error("Device lost during video color qualification"));
  };
  // One listener per qualifier, not a permanently pending loss reaction per frame.
  device.lost?.then(onLost, onLost);
  function destroy() {
    output?.destroy(); staging?.destroy();
    output = staging = pipeline = sampler = undefined;
    if (canvas) canvas.width = canvas.height = 1;
    canvas = context = undefined;
  }
  return {
    async qualify(frame) {
      if (lost || !canQualifyVideo(frame) || typeof device.importExternalTexture !== "function") return null;
      let mapped = false, scope = false;
      try {
        if (!canvas) {
          canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(COUNT, 1)
            : globalThis.document?.createElement("canvas");
          if (!canvas) return null;
          canvas.width = COUNT; canvas.height = 1;
          context = canvas.getContext("2d", {colorSpace: "srgb", willReadFrequently: false});
          if (!context) return null;
        }
        const w = frame.displayWidth, h = frame.displayHeight;
        // Request GPU backing so each crop can sample the video without
        // triggering a full software conversion/readback. One 64-pixel read
        // follows all crops. Native-size crops preserve chroma reconstruction;
        // scaling the whole frame to 8x8 would instead average unrelated pixels.
        for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
          const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / GRID));
          const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / GRID));
          context.drawImage(frame, sx, sy, 1, 1, y * GRID + x, 0, 1, 1);
        }
        const reference = context.getImageData(0, 0, COUNT, 1).data;
        device.pushErrorScope("validation"); scope = true;
        if (!pipeline) {
          pipeline = device.createComputePipeline({layout: "auto", compute: {
            module: device.createShaderModule({code: PROBE_SHADER, label: "webscopes video color probe"}), entryPoint: "main"}});
          sampler = device.createSampler({minFilter: "linear", magFilter: "linear"});
          output = device.createBuffer({size: BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
          staging = device.createBuffer({size: BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        }
        const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
          {binding: 0, resource: device.importExternalTexture({source: frame, colorSpace: "srgb"})},
          {binding: 1, resource: sampler}, {binding: 2, resource: {buffer: output}},
        ]});
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1); pass.end();
        encoder.copyBufferToBuffer(output, 0, staging, 0, BYTES);
        device.queue.submit([encoder.finish()]);
        const validation = device.popErrorScope(); scope = false;
        if (await validation) { destroy(); return null; }
        await new Promise((resolve, reject) => {
          rejectMapping = reject;
          staging.mapAsync(GPUMapMode.READ).then(resolve, reject);
          if (lost) onLost();
        });
        mapped = true;
        return selectVideoTransfer(reference, new Float32Array(staging.getMappedRange()));
      } catch {
        // Reset partial initialization or failed mapping before the next frame.
        destroy();
        // An unavailable probe is not evidence for either transfer function.
        return null;
      } finally {
        rejectMapping = undefined;
        if (scope) { try { await device.popErrorScope(); } catch {} }
        if (mapped) { try { staging.unmap(); } catch {} }
      }
    },
    destroy,
  };
}
