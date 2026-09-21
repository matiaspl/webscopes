# Why external video textures disagree with CPU scopes

The measured macOS Chromium HLS path has two differences: an Apple-specific transfer conversion and nearest-neighbor chroma reconstruction. An inverse transfer function plus linear external-texture sampling recovers the Canvas2D values in WGSL. The production canvas-copy default remains unchanged: public frame metadata cannot reliably select this correction.

## Scope and reproduction

This investigation follows the CPU/WebGPU parity fix and tests the feasibility of removing its canvas copy. It includes diagnostic pages and the subsequent opt-in production correction described below; the canvas default is retained. Tests ran on 2026-09-21 in the connected macOS Chrome browser, whose user agent reported `Chrome/152.0.0.0`. Upstream source inspection supports the measured mechanism; the exact running browser binary was not audited.

From the repository root:

```sh
rtk proxy python3 -m http.server 8001 --bind 127.0.0.1
```

Open [the probe at 30 seconds](http://localhost:8001/examples/video-transfer-probe.html?seek=30), press **Measure frozen HLS frame**, then repeat with `?seek=120`. The optional `source` query parameter accepts a CORS-enabled HLS URL. The page needs WebGPU, WebCodecs, hls.js, and a browser capable of playing that source.

The [probe](../../examples/video-transfer-probe.js) freezes one decoded `VideoFrame`, then measures a 256 × 144 spatial grid with three channels per point: 110,592 channel samples. It reads the external texture into float buffers before histogram quantization. Canvas2D sRGB readback is the reference. It compares:

- `textureLoad`, nearest sampling, and linear sampling at exact luma pixel centers;
- identity, range, sRGB, BT.709, and power-law transfer hypotheses;
- the inverse Apple conversion calculated both in JavaScript and in WGSL;
- an additional software frame reconstructed from the decoded frame's copied YUV planes and public metadata.

Source: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`. Both recorded decoded frames were 1920 × 1080 NV12, with public metadata `{ fullRange: false, matrix: "bt709", primaries: "bt709", transfer: "bt709" }`.

## Evidence and findings

| Evidence | Observation | Finding |
|---|---|---|
| E1: frozen HLS pixel measurements | The inverse Apple curve removes the average level bias; standard BT.709, sRGB-only, range, and gamma 2.2/2.4 alternatives do not. | F1: the broad difference is the Apple transfer conversion. |
| E2: nearest versus linear samples | `textureLoad` matches nearest sampling. After transfer correction, linear sampling removes large edge errors. | F2: chroma reconstruction is a second, independent difference. |
| E3: software-plane control | A software NV12 frame reports the same metadata, but the Apple correction increases its mean error from about 1.2 to 8.7 codes. | F3: public color metadata alone cannot select the correction. |
| E4: Chromium source below | Source defines gamma 1.961, a compatibility mapping to sRGB, and distinct external-texture paths. | Independently supports F1 and F3. |

Errors below are in 8-bit code units. MAE compares corrected floating-point values with the integer reference; about 0.25 MAE is expected from rounding alone. Exact percentage compares the rounded result with the integer reference.

| Frozen time | Path | MAE | Largest error before rounding | Exact after rounding |
|---|---|---:|---:|---:|
| 30.063381 s | Original `textureLoad` | 7.9559 | 47.6400 | 1.2026% |
| 30.063381 s | Inverse transfer only | 0.7757 | 36.9794 | 59.5604% |
| 30.063381 s | Linear sampling + inverse in WGSL | 0.2495 | about 0.5000 | 99.9955% |
| 120.047368 s | Original `textureLoad` | 7.9228 | 34.148703 | 1.3798% |
| 120.047368 s | Inverse transfer only | 0.7071 | 32.552775 | 67.9380% |
| 120.047368 s | Linear sampling + inverse in WGSL | 0.2477 | 0.499987 | 100% |

The first scene had five differing channel values at the rounding boundary; the second had none. This establishes the mechanism and a working shader correction on these frames, not universal bit-exact parity across browsers, decoders, codecs, and HDR sources.

## Conversion path

Let `v` be the normalized nonlinear RGB value after YUV matrix/range conversion and chroma reconstruction. For the measured accelerated macOS path, the observed external-texture value is:

```text
external = sRGB_encode(v ^ 1.961)
```

The compatible Canvas2D reference retains `v` for this Rec.709 source, then quantizes to eight bits. Recover it before histogram accumulation:

```text
v = sRGB_decode(external) ^ (1 / 1.961)
```

This is a two-stage transfer operation, not a single gamma power. Its dark toe explains the reported darker blacks even though much of the midrange becomes brighter:

| Reference code | Predicted external code |
|---:|---:|
| 4 | 0.953 |
| 8 | 3.711 |
| 16 | 13.985 |
| 32 | 35.324 |
| 64 | 72.921 |
| 128 | 139.160 |
| 192 | 199.327 |

These are curve predictions, not individual sampled pixel pairs.

The tested WGSL function, used with `textureSampleBaseClampToEdge` and a linear sampler, is:

```wgsl
fn undoAppleTransfer(value: vec3f) -> vec3f {
  let c = clamp(value, vec3f(0.0), vec3f(1.0));
  let linear = select(
    pow((c + 0.055) / 1.055, vec3f(2.4)),
    c / 12.92,
    c <= vec3f(0.04045)
  );
  return pow(linear, vec3f(1.0 / 1.961));
}
```

For a source pixel `(x, y)`, sample at `uv = (vec2f(x, y) + 0.5) / sourceDimensions`. Linear sampling reconstructs subsampled chroma while sampling luma at its pixel center. Apply the inverse before RGB integer conversion and before luma/chroma histogram calculations. Retain the normal clipping and rounding afterward.

### Source correspondence

1. Chromium defines the macOS accelerated Rec.709 interpretation as a pure gamma **1.961** in [skcolorspace_trfn.h](https://chromium.googlesource.com/chromium/src.git/+/refs/tags/138.0.7185.0/skia/ext/skcolorspace_trfn.h). Its [VideoToolbox tests](https://chromium.googlesource.com/chromium/src/media/+/6d248d8910d3ca4eb6cb4d9948f53aa14113125f/gpu/mac/vt_config_util_unittest.mm) expect `BT709_APPLE` for the macOS Rec.709 image-buffer color space.
2. The [external-texture helper](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webgpu/external_texture_helper.cc) passes YUV matrix, source transfer, destination transfer, and gamut conversion to Dawn on the zero-copy NV12 path. Its fallback can instead use the compatibility RGB color space. Thus `colorSpace: "srgb"` specifies the destination encoding; it does not disable source transfer conversion.
3. [`CompatRGBColorSpace`](https://chromium.googlesource.com/chromium/src/+/refs/tags/132.0.6834.54/media/base/video_frame.cc) maps the Apple transfer to sRGB. The same [compatibility method was moved from the canvas video renderer into VideoFrame](https://chromium.googlesource.com/chromium/src/+/63aab357d61b1e64b5ccd165b2d71caf65f1bdfb%5E%21/).
4. The [video color-space mapping](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/video_color_space.cc) represents both internal `BT709` and `BT709_APPLE` as the public BT.709 transfer identifier. The software-plane control demonstrates why that loss of distinction matters here.

The measured behavior is consistent with the accelerated import following the original Apple transfer while Canvas2D uses the compatibility interpretation. Source inspection was of the linked upstream versions, not a trace inside the running browser.

## Requirements for a qualified direct path

The shader arithmetic is feasible and validated above. Automatic selection remains necessary:

1. Measure a small, spatially varied sample from the actual decoded source against the CPU/canvas reference. A separately generated software slate cannot establish the accelerated decoder's behavior.
2. Compare identity and inverse-Apple candidates with linear sampling. Enable the correction only when the evidence clearly selects it within the chosen error tolerance.
3. Retain canvas capture when the sample is ambiguous, such as an all-black opening frame, or the residual error is excessive. Revalidate after source, color configuration, decoder path, or stream rendition changes; public metadata may stay unchanged across a decoder-path change.
4. Limit this candidate to qualified SDR Rec.709 behavior. Wide-gamut, HDR, and tone-mapped sources need separate handling; clipping/tone mapping may be irreversible.

A one-time browser-name or `transfer === "bt709"` switch is insufficient. The software-frame control is a concrete counterexample. The implementation below follows these requirements, rechecking every frame. It avoids the explicit full-frame canvas upload when qualified, but canvas probes and GPU synchronization have a cost; it is not advertised as a performance improvement.

## Controlled encoded-slate confirmation

The subsequent controlled test independently confirmed both causes. Generate the fixtures with:

```sh
rtk proxy python3 scripts/generate-video-transfer-slate.py
```

The [generator](../../scripts/generate-video-transfer-slate.py) writes two H.264 High-profile, 8-bit 4:2:0 MP4/HLS fixtures to `dist/video-transfer-slate/`. They have identical YUV pixels and BT.709 primaries/matrix/limited range. One declares a BT.709 transfer and the other declares sRGB. The generator checks the encoded metadata and fails if decoding changes any source byte. Generated artifacts and SHA-256 hashes are listed in `dist/video-transfer-slate/manifest.json`.

The 512 × 256 raster has four unlabelled, numerical panels:

1. Neutral Y code sweep from 0 through 255, including nominal black/white and footroom/headroom.
2. Neutral shadow staircase, Y=16…47.
3. Constant Y/Cr with vertical Cb edges at several spatial frequencies.
4. Constant Y/Cb with horizontal Cr edges at several spatial frequencies.

![Generated numerical slate](../../dist/video-transfer-slate/preview.png)

The first two panels isolate the transfer function without chroma variation. The last two isolate chroma reconstruction at fixed luma. The probe visits **every pixel** when `slate=1`. Interior-panel statistics exclude four rows at each boundary, but the whole-frame comparison includes all boundaries.

Open the [BT.709 fixture](http://localhost:8001/examples/video-transfer-probe.html?slate=1&source=/dist/video-transfer-slate/bt709.m3u8) and the [sRGB control](http://localhost:8001/examples/video-transfer-probe.html?slate=1&source=/dist/video-transfer-slate/srgb.m3u8), pressing **Measure frozen HLS frame** for each. The browser returned NV12 for both, and its copied YUV planes matched all **196,608 original source bytes**, with zero changed bytes. FFmpeg's software decode also matched exactly. Thus the observed differences did not originate in compression or altered source pixels.

Whole-slate results, measured in the same macOS Chrome 152 session:

| Transfer tag | GPU path | Differing RGB channel values / 393,216 | Largest rounded code error |
|---|---|---:|---:|
| BT.709 | Original `textureLoad` | 367,501 | 57 |
| BT.709 | Inverse transfer only | 55,028 | 50 |
| BT.709 | Linear sampling only | 367,392 | 12 |
| BT.709 | Linear sampling + inverse in WGSL | **0** | **0** |
| sRGB | Original `textureLoad` | 55,028 | 50 |
| sRGB | Linear sampling only | **0** | **0** |
| sRGB | Linear sampling + inappropriate inverse | 354,148 | 12 |

On the BT.709 fixture, the transfer-only correction gave exact rounded parity in both neutral panels; chroma-edge errors remained as large as 50 codes. Linear sampling removed those errors. On the sRGB control, the neutral panels already matched and only chroma interpolation was required. This separates F1 and F2, rather than fitting a single arbitrary transform to natural footage.

The neutral sweep also matches the predicted transfer numerically before rounding. For Y=24, the expected normalized RGB expressed in 8-bit units is 9.3151: the BT.709 external texture measured 5.0021, matching the Apple-curve prediction of 5.0021, and the corrected shader returned 9.3151. For Y=126, those values are 128.0822 → 139.2400 → 128.0823. The sRGB-tagged fixture directly measured 9.3151 and 128.0823, respectively.

The [saved measurement summary](2026-09-21_video-transfer-slate-results.json) records these results and fixture hashes. Software-backed controls still demonstrate that `transfer: "bt709"` alone cannot select the Apple inverse. The slate experiment itself did not change production behavior; the subsequent integration is described below.

## Validation boundary

- Executed the inverse inside WGSL on two real HLS scenes and compared 110,592 channels per scene.
- Verified a negative control with software-backed NV12 planes and identical public color metadata.
- Confirmed both causes with two pixel-identical encoded slates differing only in transfer metadata; appropriate shader processing matched all 393,216 channels per fixture.
- Checked diagnostic JavaScript syntax and whitespace with `node --check` and `git diff --check`.
- The opt-in production external shader now uses the validated sampling and transfer functions. The default remains canvas.
- Safari, Windows/Linux GPU imports, HDR, other codecs, and long-run decoder changes remain unqualified. Exact whole-frame histogram parity is not guaranteed on the opt-in external path.


## Integrated correction and fallback

`src/video-color.js` now qualifies each supported SDR NV12 frame using 64 native-size canvas pixel crops on an 8 × 8 spatial grid. The gather canvas requests `willReadFrequently: false` so the browser can batch GPU crops before one 256-byte pixel readback; a software-backed gather caused repeated expensive full-frame conversion in testing. A GPU probe compares linear-sampled identity and inverse-Apple candidates. Qualification requires maximum error ≤0.55 code, mean error ≤0.35 code, and a mean-error advantage of at least 0.5 code over the other candidate. These tolerances include UNORM rounding; they do not constitute an all-pixel comparison. Black/white ambiguity, unknown color metadata, unsupported formats, probe errors, and unmatched conversions fall back to the reusable sRGB canvas.

Both `createScopes` and `createScopeDisplay` share the corrected histogram shader and qualifier. The display freezes live HTML video before qualification and releases only snapshots it owns. Qualification is repeated even when public metadata is unchanged. Probe buffers are reused and released during teardown; partial allocation failures reset the probe, and device loss settles pending mapping. `stats.videoColorMode` reports the actual path. `videoTextureMode` continues to describe the configured import policy.

The existing `auto`/`copy` canvas default is retained. `external` is the opt-in qualified path. The additional canvas probes and GPU readback can be slower than copying, and should be measured for the intended workload.

Integrated macOS Chrome 152 browser checks:

- BT.709 encoded slate: all four histogram comparisons exactly matched CPU in both APIs, selecting `external-apple`.
- Pixel-identical sRGB slate: all four comparisons exactly matched, selecting `external-identity`.
- Default `auto` on natural HLS near 30 seconds: all four histogram comparisons exactly matched CPU in both APIs.
- Reused the same analyzer/display across BT.709 hardware → same-plane software → hardware frames: selected `external-apple` → `canvas` → `external-apple`; all comparisons exactly matched CPU.
- Natural HLS at approximately 30 seconds, 1920 × 1080, 129,600 sampled pixels: both APIs selected `external-apple`. Strict equality still failed at a small number of bins: RGB/709 30 bins with L1 difference 36; luma 12/14; YCbCr 20/22; RGB/2020 28/34. Software fallback matched exactly. This is consistent with the earlier float rounding-boundary residuals, and is why sampled qualification does not promise exact histogram equality.

Reproduce the transition check with `examples/video-gpu-check.html?source=/dist/video-transfer-slate/bt709.m3u8&seek=1&soakMs=1000&videoTextureMode=external&software=1`. The harness displays the actual path for every comparison and preserves strict failure reporting. Short slates now loop during the soak so playback ending cannot stall it.

A second natural scene near 120 seconds also selected `external-apple`, with small strict-parity residuals (RGB/709: 22 differing bins, L1 difference 22). The final short video-source soak completed 19 updates in 1,016 ms for external qualification. The default path completed 42 updates in 1,075 ms near 30 seconds. These different-scene, short runs are indicative overhead checks, not a controlled throughput benchmark or a memory-stability qualification. The default remains preferable for exact bins and throughput on this machine.

Validation: 32 focused WebGPU/color tests passed, including ambiguous samples, software fallback, partial allocation failure, device loss, and resource lifecycle. Packed-package TypeScript/ESM checks passed. The full suite had 109 passing tests and one pre-existing module-load failure: `examples/electron-decklink/ffmpeg-utils.js` is absent. Two additional focused tests were subsequently added and passed.
