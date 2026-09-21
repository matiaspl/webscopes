# WebScopes mobile implementation plan for Luna

Implement mobile performance improvements in dependency order, preserving analysis correctness and the existing public API. This is an implementation handoff, not evidence that mobile performance has been achieved.

## Execution instructions

Work in `/Users/mstarzak/work/webscopes`. Read applicable AGENTS.md files and inspect Git status before editing. Preserve unrelated changes and the existing `scripts/bench-mobile.mjs`. Do not publish, deploy, or install software on devices as part of this plan.

Implement milestones 1–3 first and validate them before starting milestone 4. Milestones 5–6 are subsequent performance work with their own acceptance gates. Keep each milestone reviewable; do not combine the GPU renderer and capture redesign into one change. Do not introduce dependencies unless the existing browser APIs cannot do the job.

If real phones are unavailable, finish implementation and local validation, provide a reproducible phone test page, and explicitly mark physical-device acceptance pending. Do not substitute desktop viewport emulation for phone measurements.

## Evidence and intended improvements

The baseline benchmark uses Node v24.12.0 on Apple M1 Pro, deterministic synthetic 1920×1080 RGBA input, five warmups and twenty measured iterations. Canvas drawing methods are no-ops; JavaScript raster loops and image buffers execute. It excludes capture, GPU execution, canvas upload, compositing, and mobile thermals.

| Configuration | Analysis median | Raster JS median | Histogram bytes |
| --- | ---: | ---: | ---: |
| Demo: native samples, 960×520 canvas, 480×512 waveform, 256 vectorscope | 71.95 ms | 14.54 ms | 3,211,264 |
| 25% sampling per axis | 5.71 ms | 16.42 ms | 3,211,264 |
| Also 480×260 canvas | 5.44 ms | 7.04 ms | 3,211,264 |
| Also 240×256 waveform and 128 vectorscope | 5.14 ms | 3.57 ms | 802,816 |

Evidence → finding → implementation path:

- `src/index.js` records frame timing before `renderScopes`: displayed FPS excludes rendering → milestone 1.
- `examples/live-roi-demo.html` fixes the canvas at 960×520; `configureScopes` fixes histogram dimensions → milestone 2.
- `createFramePacer` only deduplicates tokens; the demo schedules on each presented video frame → milestone 3.
- `src/webgpu.js` copies and maps all histogram bins on every update; `src/render.js` rasterizes on CPU → milestone 5.
- `readFramePixelsAsync` captures full frames before sparse analysis → milestone 6.

Re-run `node scripts/bench-mobile.mjs` after relevant changes. These single-run desktop numbers are directional evidence, not a promised speedup or phone FPS.

## Boundaries that must remain intact

- `createScopes().update()` and `renderFrame()` continue returning complete `ScopeResult` histograms. Previously returned arrays must remain unchanged after subsequent updates.
- Preserve CPU raw RGBA, Float32/Float64, Uint16 10/12-bit, and v210 handling; matrix/range precedence; ROI coordinate mapping; and fixed-point CPU/GPU histogram parity.
- Keep library defaults unchanged. Mobile quality settings belong to the demo and are explicitly selectable.
- Preserve the existing Safari copy route and explicit `videoTextureMode` overrides until browser tests justify a separate change.
- Never destroy caller-owned GPU devices. Preserve device-loss handling, validation scopes, and deferred resource cleanup.
- Keep video playback resolution independent of scope sampling. Do not resize the visible source video to save analysis work.
- Preserve border-only ROI, tap/cancel restoring the previous ROI, paused-frame refresh, one scope canvas during pop-out, and zero default dither.
- Do not silently turn off waveform antialiasing or vectorscope peak preservation. Sparse sampling and smaller bins must be identified as reduced analysis detail.

## Milestone 1: Measure completed work accurately

Files: `src/index.js`, `src/render.js`, `types/index.d.ts`, `examples/live-roi-demo.js`, focused tests in `test/`.

1. Preserve legacy `frameTimeMs`, `fps`, and their averages as processing estimates for compatibility; document that boundary. Add optional `captureTimeMs`, `analysisTimeMs`, `renderTimeMs`, and `updateTimeMs` fields. Measure wall-clock stages with a consistent monotonic clock. Analysis timing includes GPU submission/readback wait, not just shader execution. Do not label it GPU execution time.
2. End update timing after automatic rendering. With autoRender disabled, render time is zero. Account for fallback attempts in total update time; do not hide failed GPU work. Standalone `render()` must not mutate the timing of an earlier update.
3. Compute completed scope updates per second in the demo from completion timestamps over a rolling window. Use this for the demo FPS label; reciprocals of processing time are not delivered FPS. Reset on source/analyzer changes and visibility transitions.
4. Avoid showing stale timing as the current frame's complete render cost. The canvas overlay may show the last completed update with an explicit label; the DOM status can show the just-completed update.

Acceptance: deterministic clock tests prove render time is included in total time; autoRender false works; delayed asynchronous analysis is included; adding a render delay lowers completed throughput. Update packed types and avoid timing assertions dependent on machine speed.

## Milestone 2: Add an explicit mobile quality profile

Files: `examples/live-roi-demo.html`, `examples/live-roi-demo.js`, new `examples/mobile-performance.js` for pure profile/sizing helpers, corresponding tests.

Add Standard and Mobile profile selection. Keep Standard as the initial default and retain existing settings. Persist neither profile nor probe choice unless existing UI conventions already support persistence. Automatic device classification is outside this milestone.

Mobile starting settings:

- Probe scale 0.25 on each axis: 129,600 samples for a full 1080p frame, not 25% of all pixels.
- Waveform 240×256; vectorscope 128×128.
- Scope drawing buffer at most 480×260, fit proportionally within the visible canvas width with pixel ratio 1. This is a display budget; do not allocate a devicePixelRatio 3 buffer behind a small phone view.
- Target 20 completed scope updates/sec through milestone 3 scheduling.

Use ResizeObserver on the scope container and coalesce resize work. Skip zero-sized containers. Only resize when integer dimensions actually change. Keep canvas CSS and intrinsic dimensions consistent, without observer feedback loops. Move observation with the existing canvas during pop-out and restore it on close. Disconnect on teardown.

Selecting a profile applies its probe value; a later manual Probe change overrides it until another profile selection. Keep the select and status synchronized. Color, mode, ROI, and source selections survive profile changes. Do not recreate the analyzer solely for a canvas resize. Pass histogram options per update if practical; retain existing configuration generation protection when recreation is required.

Acceptance: profile dimensions and scale are deterministic; switching profiles while paused refreshes; repeated resize/pop-out/restore does not allocate indefinitely or create another renderer. Touch ROI still works. Display reduced detail honestly; 256 waveform bins do not retain distinct 10-bit code levels even when the input remains 10-bit.

## Milestone 3: Bound scheduling and background work

Files: `examples/roi-controls.js`, `examples/live-roi-demo.js`, `test/roi-controls.test.js`.

Extend pacing with an optional maximum refresh rate and injected clock. Preserve unlimited behavior when unset. Throttle before `scopes.update()` so skipped updates incur no capture cost. Preserve one in-flight update and do not queue stale frames or catch up missed deadlines.

Throttled tokens must not be recorded as analyzed. ROI edits, mode/matrix/probe/profile changes, seeks, and analyzer/source changes may bypass the normal deadline once. If an update is already running, coalesce changes and perform a refresh with the newest settings when it finishes. Paused input still refreshes on user changes.

Suspend scope scheduling while the owning document is hidden. If a visible pop-out owns the canvas, allow that document to drive scheduling; use only one scheduler. Handle visibility restoration without a burst. Do not stop media tracks or change playback as a side effect. Track callback ownership and cancel callbacks on the window/video that created them.

Acceptance: fake-clock tests cover 60 Hz input with a 20 Hz budget, slow updates, duplicate tokens, forced refreshes, hidden/visible transitions, pop-out ownership, and teardown. A 30 fps source must not produce more than the chosen cap, except explicit user refreshes. Observe actual cadence rather than assuming exact 20 Hz alignment with every source rate.

## Milestone 4: Establish real-browser and phone measurements

Add `examples/mobile-performance-check.html` and `.js`, using current source imports. Provide a local-file input and deterministic synthetic source, backend/profile selectors, warmup and run controls, and JSON export. Do not depend on remote stream availability for the benchmark.

Record browser/OS, user-supplied device model, source dimensions/rate, backend and texture mode, profile, drawing buffer dimensions, sample count, histogram bytes, completed update rate, and p50/p95 stage/update times. Where available, record long tasks and video playback quality counters; mark unsupported metrics unavailable. Avoid retaining per-frame images or histogram results in telemetry.

Run a 30-second warmup followed by a five-minute playback run on one available iPhone/Safari and one available Android/Chrome. Use HTTPS or a suitable secure development origin for device access. Test Auto plus CPU; record actual WebGPU availability rather than assuming support. Exercise rotation, touch ROI, seek/pause, source replacement, background/foreground, and cleanup. Unsupported capture/pop-out capabilities should degrade gracefully.

Provisional mobile acceptance target: for a local 1080p30 file in Mobile mode, at least 18 completed scope updates/sec over the steady interval and p95 update duration at most 50 ms, no crashes or unbounded retained resources, and responsive ROI controls. Compare early and late intervals for sustained slowdown. Report video dropped-frame deltas against playback without scopes on the same phone. These targets are goals to test, not claimed capabilities; record failures rather than lowering targets silently.

Milestones 1–3 can be locally complete while this physical acceptance remains pending.

## Milestone 5: Add an opt-in GPU display path without per-frame bin readback

Start only after baseline correctness and instrumentation work passes. This is a separate architectural change.

Files: `src/webgpu.js`, new `src/webgpu-render.js`, `src/index.js`, `types/index.d.ts`, browser parity tests and demo integration.

Refactor GPU histogram submission so a shared internal path can either read bins back for the existing analyzer or render directly. Avoid duplicating shader calculations. Add a separate opt-in `createScopeDisplay()` API rather than making existing `ScopeResult` histograms optional:

- `present(source, analysisOptions)` resolves after submission with metadata and clearly defined timings, without mandatory histogram readback. It returns no fabricated CPU bins. Serialize updates; retain at most one pending newest request.
- `snapshot()` explicitly reads back the last successfully submitted histogram. Order snapshots against submissions so returned metadata and bins describe the same frame. Preserve snapshot ownership across subsequent presentations.
- `destroy()` follows existing ownership and in-flight cleanup guarantees.
- Existing `createScopes` continues working unchanged.

For sustained backpressure, bound GPU submissions to at most two outstanding frames and use queue completion for admission when needed. Submission timing must not be reported as display completion or compared directly with milestone 1 CPU completion metrics. Document separate submitted/completed counters. Use timestamp queries only when supported and needed, without requiring the feature.

Draw histogram density on WebGPU; preserve waveform area filtering/row interpolation, vectorscope peak filtering, gain, mode colors, graticules, labels and layout. A cached transparent 2D overlay for labels is acceptable; a second full histogram analysis/render pipeline is not. Rebuild overlays only when relevant settings or dimensions change.

A canvas with a 2D context cannot simply be switched to WebGPU. The opt-in demo path must manage a replaceable display canvas or an explicit renderer-owned surface, preserving pop-out and fallback. Probe initialization before swapping visible surfaces. On failure, transition to the existing CPU/2D display without using an incompatible canvas context. Preserve existing raw high-bit-depth behavior through the old path until a separate implementation proves parity.

Acceptance: old API tests pass; browser tests compare snapshot bins exactly with the existing analyzer; rendered reference signals retain isolated traces and labels with an explicitly recorded pixel tolerance; steady GPU presentation performs zero histogram map/readback operations; queue/resource counts stay bounded; device loss and fallback work. Re-run milestone 4 before selecting this path by default.

## Milestone 6: Optimize CPU capture only where measurements justify it

Use stage timings to select the bottleneck. Worker offload improves main-thread responsiveness but does not guarantee lower total time. Start with a worker-owned CPU analyzer and transferable VideoFrame when supported, with one in-flight frame and deterministic close/cleanup. Do not detach caller-owned raw arrays. Keep synchronous `analyzeFrame` intact and preserve the public update contract.

Evaluate ROI-only VideoFrame copy or canvas capture to reduce readback. Preserve original source dimensions, absolute sampled coordinates, ROI rounding, and composite mode's source-X phase. Validate coordinate mapping before adopting the path. Full-frame sparse sampling still needs a separate gather strategy; do not claim cropping solves it.

Do not replace sparse point samples with bilinear canvas resizing. That changes histogram values. Any approximate downsampling must be an explicit future quality option. If exact reduced capture is unsupported, retain full capture and report that limitation.

Acceptance: exact histogram equality for supported optimized paths versus baseline, including edge ROIs, one-pixel regions, composite phase, padded layouts and color metadata. Raw 10/12-bit and v210 regressions remain covered. Record capture bytes/time and main-thread responsiveness before and after.

## Verification and final handoff

From the repository root:

```sh
npm test
npm run check:types
node scripts/bench-mobile.mjs
git diff --check
```

Use existing browser GPU checks for real GPU parity; mocked Node GPU tests cannot establish shader execution or mobile compatibility. Add focused tests for changed behavior, not broad implementation-mirroring tests. Avoid brittle absolute timing thresholds in automated Node tests.

Update README with implemented profile controls, timing definitions, new APIs only when they exist, and exact validation limits. Final implementation report must list completed milestones, changed files, measured results, commands run, physical devices actually tested, and remaining gates. Do not claim mobile-ready status from Node tests alone.
