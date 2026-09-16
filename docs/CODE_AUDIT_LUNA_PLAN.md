**Code audit and fix plan — 12–13 September 2026**

Target executor: **Codex Luna, very high reasoning effort** (`gpt-5.6-luna`, `xhigh`).

The audit found two high-priority measurement defects and several validation, lifecycle, and packaging defects. The existing tests do not cover these cases. This document defines the fixes and their acceptance criteria. The audit changes only files under `docs/`.

**Scope and evidence**

The audit covered all four source modules, both test files, the public declarations, both browser examples, and the package manifest. The workspace has no Git repository. The audit used an isolated copy because another task was active in the same directory. Source hashes matched that copy before this plan was written.

Evidence is in [audit-2026-09-12](/Users/mstarzak/work/webscopes/docs/audit-2026-09-12/baseline.sha256):

- Existing Node suite: **14 tests passed** on Node **24.12.0**.
- JavaScript syntax checks: all source, example, and test files passed.
- Existing browser smoke page: **PASS**, with zero histogram differences for its fixture.
- Audit browser: Chrome **152**, macOS, Apple **metal-3** adapter.
- Strict declaration check: TypeScript **5.9.3**, ES2022 and DOM libraries, four missing WebGPU names.
- Package dry run: passed, with eight published files.
- Audit probes: real CPU calculations, real browser GPU calculations, and explicitly identified GPU mocks.

The audit does not establish compatibility with every browser or Node 20. It does not qualify HDR, wide-gamut video, or decoded video precision. GPU mock results establish control flow, not physical GPU behavior. The performance measurements exclude real canvas upload and browser compositing.

**Execution instructions for Luna**

1. Read this plan and the applicable `AGENTS.md` instructions.
2. Compare the current files with the recorded hashes.
3. If files differ, inspect those changes before applying a finding.
4. Preserve concurrent work and the current public API where possible.
5. Implement tasks 1–10 in order.
6. Add focused regression tests for each corrected behavior.
7. Complete the correctness checks before task 11.
8. Keep the CPU path, high-bit-depth input, waveform antialiasing, display dither, and caller-owned GPU devices functional.
9. Keep raw high-bit-depth input on CPU unless a separate request expands GPU support.
10. Report changed files, test results, browser evidence, and remaining limitations.

The original audit request authorizes this plan. Implementation starts when the user requests execution of the plan.

**1. P1 — Make CPU and WebGPU sampling and bin placement consistent**

Locations: [CPU sampling](/Users/mstarzak/work/webscopes/src/analyze.js:140), [GPU sampling](/Users/mstarzak/work/webscopes/src/webgpu.js:25), [GPU bin quantization](/Users/mstarzak/work/webscopes/src/webgpu.js:55).

CPU uses `Math.round`, while WGSL `round` resolves exact ties to the even integer. This changes the selected source pixel before color analysis. Floating-point precision also changes bin placement near thresholds. The vectorscope epsilon addresses only a narrow neutral-axis case. The WGSL rounding rule is defined in the [W3C specification](https://www.w3.org/TR/WGSL/#round-builtin).

Browser reproductions:

- A six-pixel row, scaled by `0.5`, has sample positions `0`, `2.5`, and `5`. CPU selects `0,3,5`. GPU selects `0,2,5`.
- With red only at source column 2, the first fixture produces two different red waveform bins and two different vector bins.
- A neutral pixel with `waveformMode: "ycbcr-parade"` and `waveformHeight: 18` produces two differing bins per chroma channel.
- A deterministic 256 × 256 RGB fixture produces 18 Y, 142 Cb, and 64 Cr differing bins with default waveform height.

Implementation:

1. Define one sampling and quantization contract before changing either backend.
2. Use identical integer arithmetic for source coordinates where practical.
3. Preserve native code values for 10-bit and 12-bit CPU input.
4. Implement deterministic color-bin arithmetic for decoded 8-bit input on both backends.
5. Prefer bounded integer arithmetic where exact parity is required.
6. Do not rely on `Math.fround` alone to guarantee identical GPU arithmetic.
7. Do not hide these failures with a general comparison tolerance or another arbitrary epsilon.

Acceptance: The supplied fixtures produce identical histograms. Cover every waveform mode and color matrix. Include odd sizes, nonzero ROI origins, half-way sampling positions, and neutral chroma. Each channel sum and vector sum equals `sampleCount`. Preserve exact high-bit-depth ramp bins on CPU. A broader numerical contract requires an explicit documented bound if exact parity proves impractical.

**2. P1 — Preserve vectorscope signals during downscaling**

Location: [vectorscope raster sampling](/Users/mstarzak/work/webscopes/src/render.js:204).

The renderer selects one histogram bin per destination pixel. When the raster is smaller than the histogram, this skips populated bins. A one-pixel neutral gray frame has one vector sample. At a 320 × 180 canvas with DPR 1, its vector raster is 117 × 117 and contains zero lit pixels.

Implementation:

1. Replace nearest-bin downsampling with a filter that includes every contributing source bin.
2. Define the filter response for isolated peaks and dense traces.
3. Keep the histogram data unchanged.
4. Apply dither after the signal filter.
5. Preserve visible signal energy at supported small chart sizes.

Acceptance: Render neutral gray, six saturated colors, and isolated bins at different bin positions. Cover vectorscope sizes 64, 256, and 1024. Include 117-pixel and other noninteger scale ratios. The strong isolated signals remain visible. Validate the raster separately from grid lines, which can conceal a missing trace.

**3. P2 — Align vectorscope targets with the trace and use valid canvas colors**

Locations: [trace coordinates](/Users/mstarzak/work/webscopes/src/render.js:205), [graticule scale](/Users/mstarzak/work/webscopes/src/render.js:224), [target fill color](/Users/mstarzak/work/webscopes/src/render.js:255), [parade labels](/Users/mstarzak/work/webscopes/src/render.js:182).

The trace maps the full chroma range across the raster. Target markers use `radius = size * 0.44`. Thus, the target coordinate span is only 88% of the trace span. In a 386-pixel vector raster, pure red appears at canvas y 88–89, but its marker is at y 111.16.

`colorFor()` returns numeric arrays. Canvas `fillStyle` requires a valid color or paint object. Assigning `[255, 62, 72]` leaves the previous color unchanged in the browser. This affects target markers and parade labels.

Implementation:

1. Define one chroma-to-canvas transform for the trace, targets, center, and skin line.
2. Reserve label space without changing the target scale independently.
3. Convert numeric colors to valid CSS values for vector drawing operations.
4. Keep numeric colors for direct raster writes.
5. Make grid and label sizing consistent with DPR.

Acceptance: Pure RGB and CMY traces align with their corresponding targets within bin quantization and raster resolution. Cover all three matrices and both layouts. Verify target and label colors in a real canvas. A mock context that accepts arbitrary `fillStyle` values is insufficient.

**4. P2 — Validate the complete raw pixel layout before analysis**

Locations: [minimum buffer length](/Users/mstarzak/work/webscopes/src/analyze.js:102), [stride handling](/Users/mstarzak/work/webscopes/src/analyze.js:118), [matrix lookup](/Users/mstarzak/work/webscopes/src/analyze.js:7), [stride declarations](/Users/mstarzak/work/webscopes/types/index.d.ts:11).

The initial length check assumes tightly packed RGBA. Later reads use `bytesPerRow` and `pixelStride` without checking the final accessible element. Fractional and nonfinite strides also pass. Reads return `undefined`, calculations become NaN, and histogram increments disappear while `sampleCount` increases.

Confirmed examples:

- Width 1, height 2, eight byte elements, `bytesPerRow: 8`: two reported samples, one sample in each histogram.
- `pixelStride: NaN`: two reported samples, no histogram samples.
- A floating-point NaN sample: inconsistent channel and vector sums.
- `colorMatrix: "toString"`: inherited object property accepted, followed by NaN color arithmetic.

Implementation:

1. Validate supported array types and positive integer dimensions before histogram allocation.
2. Require finite integer strides and byte alignment for the selected element type.
3. Define the default row stride consistently with `pixelStride`.
4. Validate the last required RGBA element against `data.length`.
5. Permit valid padding without requiring unused padding after the last pixel.
6. Reject NaN RGB samples or define a consistent exclusion policy and matching sample count.
7. Preserve the documented treatment of finite out-of-range samples.
8. Restrict matrix names to own entries in the supported matrix table.
9. Correct the `bytesPerRow` documentation for Uint16 and floating-point arrays.

Acceptance: Cover tight and padded rows, pixel padding, typed-array views, 8/10/12-bit input, and floating-point input. Reject truncated layouts, fractional strides, nonfinite strides, and misaligned byte strides. Validate channel and vector conservation for every accepted frame.

**5. P2 — Preserve GPU availability after input validation errors**

Location: [Auto fallback catch block](/Users/mstarzak/work/webscopes/src/index.js:47).

The catch block checks the instance backend, but does not distinguish GPU failure from caller input failure. A malformed raw frame uses CPU, yet permanently demotes an Auto instance from GPU to CPU. An invalid ROI on a browser canvas causes the same demotion. The real browser confirmed this case.

Implementation:

1. Validate shared frame options before GPU submission.
2. Keep the backend unchanged after caller input errors.
3. Restrict permanent fallback to failures from an actual GPU operation that require fallback.
4. Preserve explicit `backend: "webgpu"` error reporting.
5. Keep warning messages specific to the failed operation.

Acceptance: Invalid raw buffers and invalid ROI values reject without destroying GPU resources. The next valid canvas frame still uses GPU. Injected GPU execution failure causes one warning and successful CPU fallback in Auto mode. An explicit GPU instance rejects the same execution failure.

**6. P2 — Make GPU initialization and resource cleanup exception-safe**

Locations: [device selection](/Users/mstarzak/work/webscopes/src/webgpu.js:68), [initialization](/Users/mstarzak/work/webscopes/src/webgpu.js:75), [error scope](/Users/mstarzak/work/webscopes/src/webgpu.js:148), [readback](/Users/mstarzak/work/webscopes/src/webgpu.js:183).

GPU mocks reproduced three defects. A supplied device still requires an unrelated navigator GPU and adapter path. A synchronous external-copy failure leaves one pushed error scope without a matching pop. A synchronous setup failure leaves an internally acquired device alive.

Implementation:

1. Use a supplied device directly.
2. Request an adapter only when device creation requires one.
3. Release an internally acquired device after initialization failure.
4. Balance each pushed error scope on every exit path.
5. Unmap a successfully mapped buffer in a `finally` block.
6. Preserve the original error if cleanup also fails.
7. Handle device loss without waiting indefinitely for usable results.
8. Validate relevant texture, buffer, binding, and dispatch limits before resource creation.
9. Keep caller-owned devices alive.

Acceptance: Add fault injection at setup, copy, allocation, submission, mapping, and mapped-range access. Track push/pop balance, unmap calls, and resource ownership. Retain the existing test for destruction during pending readback. Verify normal analysis and device-loss behavior in a real browser where available.

**7. P2 — Prevent results from reappearing after destruction**

Location: [result assignment before destruction check](/Users/mstarzak/work/webscopes/src/index.js:44).

`destroy()` clears `currentResult`. An outstanding GPU promise then assigns its result to that variable before the destruction check rejects. The public `result` getter becomes populated again. A deferred-readback mock reproduced this behavior.

Implementation:

1. Keep the pending result in a local variable.
2. Check destruction before publishing the result or rendering it.
3. Keep `result` undefined after destruction.
4. Preserve safe, idempotent resource cleanup.

Acceptance: Destroy an instance during pending GPU work. The update rejects, no render occurs, and `result` stays undefined after settlement. Repeated destruction remains safe. Cover overlapping update calls and their documented shared promise.

**8. P2 — Preserve input precision when callers use the default configuration helper**

Locations: [bit-depth precedence](/Users/mstarzak/work/webscopes/src/analyze.js:105), [default configuration helper](/Users/mstarzak/work/webscopes/src/index.js:112).

`getDefaultScopesConfig()` emits `bitDepth: 8`, `waveformHeight: 256`, and `waveformWidth: 1024`. Those explicit values replace source-dependent defaults. With that helper, a frame tagged as 10-bit normalizes sample 512 by 255 and clips it to full scale. With ordinary defaults, the same frame retains code 512 in a 1024-level waveform.

Implementation:

1. Keep input-derived defaults implicit in the helper, or represent their automatic state explicitly.
2. Preserve deliberate per-call overrides.
3. Document the precedence between instance options, frame metadata, and per-call options.
4. Keep the helper equivalent to ordinary defaults for supported input types.

Acceptance: Compare `{}` with `getDefaultScopesConfig()` for 8-bit, tagged 10-bit, and tagged 12-bit frames. Include a one-pixel ROI and native-resolution ramps. Explicit waveform sizes and deliberate bit-depth overrides still behave as documented.

**9. P2 — Make the published TypeScript declarations usable without hidden dependencies**

Locations: [public GPU types](/Users/mstarzak/work/webscopes/types/index.d.ts:39), [package manifest](/Users/mstarzak/work/webscopes/package.json:1).

TypeScript 5.9.3 with DOM and ES2022 libraries reports missing `GPU`, `GPUAdapter`, `GPUDevice`, and `GPURequestAdapterOptions`. The package does not declare or reference a provider for these names. The error affects CPU-only consumers too.

Implementation:

1. Select an explicit WebGPU type strategy compatible with the public API.
2. Include and reference the required declaration dependency in the published package.
3. Alternatively, define narrow compatible public interfaces without global namespace pollution.
4. Do not require `skipLibCheck` to conceal declaration errors.
5. Add a strict consumer typecheck through the package export.

Acceptance: Install the packed package into an isolated consumer. Compile CPU-only and caller-device examples with `skipLibCheck: false`. Verify the runtime ESM import and declaration resolution. Include the declared minimum Node version when that runtime is available.

**10. P2 — Keep demo ROI changes valid and refresh paused frames**

Locations: [ROI pointer initialization](/Users/mstarzak/work/webscopes/examples/live-roi-demo.js:81), [minimum selection size](/Users/mstarzak/work/webscopes/examples/live-roi-demo.js:95), [ROI presets](/Users/mstarzak/work/webscopes/examples/live-roi-demo.js:114), [frame scheduling](/Users/mstarzak/work/webscopes/examples/live-roi-demo.js:172).

Pointer-down at the right or bottom edge creates a rectangle outside the valid normalized range. Pointer-move can clamp the width or height to zero. These rectangles reach the analyzer and trigger task 5. ROI changes also update only the overlay. With paused playback, no new video frame necessarily arrives to refresh the scopes. The demo findings come from source control flow and reproduced analyzer validation, not live HLS interaction.

Implementation:

1. Clamp selection origins and dimensions as one valid rectangle.
2. Define click-without-drag and zero-area behavior.
3. Reanalyze the current frame after ROI changes during paused playback.
4. Coalesce rapid changes without losing the final selected region.
5. Track and cancel the animation-frame fallback during page cleanup.

Acceptance: Drag at all four edges and outside the letterboxed picture. Test a click without movement and pointer cancellation. While paused, change every preset and drag a new ROI. The histogram changes to the final selection without playback. The backend remains unchanged after valid interactions.

**11. P3 — Reduce recurring allocation and rendering cost after correctness fixes**

Locations: [CPU canvas allocation](/Users/mstarzak/work/webscopes/src/analyze.js:78), [coverage construction](/Users/mstarzak/work/webscopes/src/render.js:103), [per-bin intensity](/Users/mstarzak/work/webscopes/src/render.js:80), [GPU histogram allocation](/Users/mstarzak/work/webscopes/src/webgpu.js:151), [readback copies](/Users/mstarzak/work/webscopes/src/webgpu.js:185).

Twenty same-size CPU browser-source updates create twenty canvases. The waveform renderer constructs coverage objects each frame and repeatedly calculates logarithms. GPU luma mode allocates and reads three waveform planes although it returns one. GPU readback copies the mapped data, then copies each result plane again.

A Node microbenchmark used 1920 × 1080 synthetic pixels and a 960 × 520 mock canvas. Five measured iterations followed three warm-up iterations. RGB parade averaged 56.3 ms analysis and 39.4 ms raster JavaScript. Luma averaged 30.3 ms analysis and 32.4 ms raster JavaScript. These values are local observations, not browser throughput guarantees.

Implementation:

1. Measure the corrected browser path before optimizing it.
2. Reuse a per-instance CPU capture canvas and context.
3. Cache bounded coverage maps by dimensions and mode.
4. Evaluate a per-render intensity table or equivalent repeated-work reduction.
5. Allocate only the required GPU waveform planes.
6. Consider typed-array views over one owned readback copy.
7. Preserve previous result objects across later updates.
8. Measure analysis, rendering, total update time, and allocation separately.
9. Preserve the documented meaning of the analysis FPS badge.

Acceptance: Compare identical fixtures before and after optimization. Histogram arrays and deterministic raster output remain unchanged unless a documented correctness fix requires differences. Previous results remain stable. Report median and p95 browser timing after warm-up. Do not claim a speedup from mock-only timing.

**Reproduction commands**

Run these commands from `/Users/mstarzak/work/webscopes`. The inherited instructions require the `rtk` prefix.

```sh
rtk npm test
rtk proxy node docs/audit-2026-09-12/audit-node.mjs
rtk proxy node docs/audit-2026-09-12/audit-bench.mjs
rtk proxy shasum -a 256 -c docs/audit-2026-09-12/baseline.sha256
rtk proxy node /Users/mstarzak/work/intercom/intercom-frontend/node_modules/typescript/bin/tsc -p docs/audit-2026-09-12/audit-tsconfig.json
rtk proxy npm --cache /private/tmp/webscopes-audit-npm-cache pack --dry-run
rtk proxy python3 -m http.server 8784 --bind 127.0.0.1
```

The TypeScript path identifies the existing compiler used for this audit. A future test setup must provide its own compiler dependency.

Browser pages:

- [Audit fixtures](http://127.0.0.1:8784/docs/audit-2026-09-12/audit-browser.html)
- [Original smoke test](http://127.0.0.1:8784/examples/browser-gpu-check.html)
- [ROI demo](http://127.0.0.1:8784/examples/live-roi-demo.html)

The audit probes print observations. They are not regression tests and do not use a failing exit code for detected defects. Convert the relevant fixtures into assertions for corrected behavior. The saved result files describe the audited baseline.

**Completion criteria**

All existing and new regression tests pass. Both browser histogram checks pass for the expanded fixture matrix. Renderer checks establish visible peaks and aligned targets. Error and lifecycle checks establish correct backend state and resource ownership. The packed consumer passes strict TypeScript compilation. The paused ROI demo refreshes correctly. The final report distinguishes browser observations, mock results, and untested platforms.
