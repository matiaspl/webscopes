# webscopes

`webscopes` is a JavaScript library for waveform and vectorscope monitoring in browsers and Electron renderer processes. It analyzes browser video frames, canvas images, `VideoFrame` objects, raw RGBA pixels, and packed v210 frames. WebGPU compute accelerates browser image sources when available; raw pixel and v210 frames use the CPU path.

## Quick start

```js
import { createScopes } from "webscopes";

const scopes = await createScopes({
  canvas: document.querySelector("canvas"),
  backend: "auto",             // "auto", "webgpu", or "cpu"
waveformMode: "rgb-parade", // "rgb", "rgb-parade", "luma", "ycbcr-parade", "composite"
  colorMatrix: "bt709",        // "bt601", "bt709", "bt2020", or "bt2100"
  waveformWidth: 1280,
  waveformHeight: 256,
  vectorscopeSize: 256,
});

const video = document.querySelector("video");
function tick() {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    void scopes.update(video).catch(console.error).finally(() => requestAnimationFrame(tick));
    return;
  }
  requestAnimationFrame(tick);
}
tick();

// When the monitor is removed:
scopes.destroy();
```

Pass `autoRender: false` to update the analysis without painting the canvas. Then call `scopes.render()` when the UI needs a redraw. `scopes.result` exposes the most recent histogram data. An `OffscreenCanvas` or 2D context can be passed in place of an HTML canvas.

The canvas includes an FPS and frame-time badge. It shows smoothed analysis throughput and the latest analysis time; `result.stats.performance` exposes both values. This measures scope processing, including WebGPU readback, rather than the source video's frame rate. Set `renderOptions: { showPerformance: false }` to hide the badge.

## Standalone analysis

The pure analyzer accepts an `ImageData` value or an object with RGBA `data`, `width`, and `height` fields. Byte arrays use 0–255 components; `Float32Array` and `Float64Array` use normalized 0–1 components. It is useful for tests, workers, custom renderers, and non-browser pipelines.

```js
import { analyzeFrame, renderScopes } from "webscopes";

const result = analyzeFrame({ data: rgbaBytes, width: 1920, height: 1080 }, {
  waveformMode: "luma",
  region: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
});

renderScopes(result, document.querySelector("canvas"), {
  layout: "side-by-side", // or "stacked"
  gain: 0.18,
});
```

The result contains row-major `Uint32Array` histograms. Waveform output has one channel for luma or composite, and three for RGB or YCbCr. Composite is a deterministic active-picture quadrature view with a four-sample subcarrier phase and no invented sync or blanking. Vectorscope bins use Cb horizontally and Cr vertically, with positive Cr toward the top. Values are gamma-coded video components, as expected for conventional broadcast scopes. Waveform rendering uses area filtering when shrinking the raster and display-pixel-centered linear interpolation when enlarging it; set `renderOptions: { waveformAntialias: false }` to use nearest-bin rendering. Display-only waveform and vectorscope dithering are disabled by default. Set `renderOptions: { dither: 0.75, vectorscopeDither: 0 }` to enable subtle waveform dithering, or choose strengths from 0 to 1. Dithering changes rendered pixels by at most one 8-bit code value; histogram bins and analysis results are unchanged.

For `Uint8Array`, `Uint8ClampedArray`, and decoded browser sources, the CPU and WebGPU paths use the same integer source-coordinate rounding and fixed-point color arithmetic. Their 8-bit histograms are expected to match exactly. `Uint16Array` 10-bit and 12-bit frames use the native-precision CPU path. Floating-point inputs use normalized RGB values; sampled RGB components must be finite. Finite values outside the supported range are clipped before analysis.

## Input region and canvas sizing

`region` uses normalized source coordinates: `{ x, y, width, height }`. For compatibility with `web-color-meters`, the equivalent `inputRegionX0`, `inputRegionY0`, `inputRegionX1`, and `inputRegionY1` options are also accepted. Width and height of waveform and vectorscope bins can be selected independently. Defaults are 1024 waveform columns (capped to the input region width), 256 waveform levels, and a 256 × 256 vectorscope. Set `inputResolutionScaling` in `(0, 1]` to reduce the number of samples in both dimensions; `0.5` processes about one quarter of the pixels. Lower values are a point-sampling performance tradeoff and can alias fine image detail; use `1` for full spatial sampling.

Analysis options use this precedence: per-call options override instance options, instance options override frame metadata, and input-derived defaults apply when none of those provide a value. `getDefaultScopesConfig()` returns stable API choices and omits frame-derived `bitDepth`, `waveformWidth`, and `waveformHeight`, so it does not override a raw frame's precision or dimensions.

Raw frames use interleaved RGBA typed arrays. `pixelStride` counts array elements between adjacent pixels; `bytesPerRow` counts bytes between rows. Both tight and padded layouts are supported, including typed-array views. Truncated buffers, invalid strides, unsupported array types, and non-finite sampled RGB values are rejected before histogram allocation.

## Packed v210 and Electron

`analyzeFrame` and `createScopes.update` accept packed little-endian v210 4:2:2 frames. v210 stores six pixels in 16 bytes; rows use the standard 128-byte alignment (48 pixels) unless `bytesPerRow` is provided. Pass the decoder or capture API's actual row stride when available. Node `Buffer` values work as `Uint8Array` views.

```js
const scopes = await createScopes({
  canvas: document.querySelector("canvas"),
  backend: "cpu",
  waveformMode: "ycbcr-parade",
  colorMatrix: "bt709",
});

// Call from the Electron renderer when the decoder provides a v210 frame.
await scopes.update({
  format: "v210",
  data: frameBytes,        // Uint8Array, Uint8ClampedArray, or Node Buffer
  width: frameWidth,
  height: frameHeight,
  bytesPerRow: rowStride, // use the decoder's line size
  colorRange: "limited", // default; use "full" for full-range samples
});
```

The analyzer reads source Y, Cb, and Cr code values directly for luma and YCbCr waveforms, and preserves the shared 4:2:2 chroma samples on the vectorscope. RGB waveforms are derived using `colorMatrix` and `colorRange`; `colorRange` defaults to broadcast limited range and can be set to `"full"`. `bt2100` uses BT.2100's non-constant-luminance coefficients, which are the BT.2020 coefficients used here; it does not apply PQ or HLG transfer functions. The frame is fixed at 10-bit, so `bitDepth` overrides other than 10 are rejected. This is a frame analyzer, not a media-file decoder: your Electron decoder or capture pipeline must supply v210 bytes and their dimensions/stride. Import `webscopes` in the renderer bundle and expose only the narrow frame-transfer API needed by the renderer from your preload script.

For a runnable Electron example with DeckLink SDI capture, ROI controls, and a separate v210 analysis path, see [examples/electron-decklink](examples/electron-decklink/README.md).

## Internal test signal slates

`generateTestSignalSlate()` creates deterministic 10-bit v210 4:2:2 frames and decoded previews for the published [SMPTE RP 219-1:2014](https://pub.smpte.org/latest/rp219-1/rp0219-1-2014.pdf) and [ARIB STD-B28:2000](https://www.arib.or.jp/kikaku/kikaku_hoso/desc/std-b28.html) multiformat layouts, the [EBU Tech 3373:2020](https://tech.ebu.ch/publications/tech3373) HLG HDR UHDTV chart, and one explicitly non-standard analyzer diagnostic pattern. The standard patterns use their published nominal geometry and code-value tables in their native modes: SMPTE/ARIB are BT.709 limited-range, while EBU Tech 3373 is BT.2100 HLG limited-range. The generator accepts every supported matrix (`bt601`, `bt709`, `bt2020`, `bt2100`) and range (`limited`, `full`) to exercise alternate interpretation paths as well.

```js
import { analyzeFrame, generateTestSignalSlate } from "webscopes";

const slate = generateTestSignalSlate({
  pattern: "ebu",
  colorMatrix: "bt2020",
  colorRange: "full",
});
const result = analyzeFrame(slate.frame, {
  waveformMode: "ycbcr-parade",
  colorMatrix: slate.colorMatrix,
  colorRange: slate.colorRange,
});
```

The live ROI demo exposes all four slates under **Content → Internal**. Matrix and range changes regenerate the selected slate as an encoded v210 signal; the preview is decoded from that signal, so the displayed image and measured data share the same conversion path. The SMPTE RP 219-1 and ARIB STD-B28 layouts use the 1920×1080 HD geometry; EBU Tech 3373 uses its HD geometry and its published BT.2100 HLG tables. Non-native matrix/range combinations are deliberate analyzer test variants, not claims of standard conformance. The diagnostic slate is intentionally custom and is labeled as such.

The SMPTE selectable subpatterns use the standard defaults shown in RP 219-1: 75% white in *2, 0% black in *3, 15% gray in *4, and the normal PLUGE sequence.

## High-bit-depth raw pixels

`analyzeFrame` and `createScopes.update` accept unpacked RGBA `Uint16Array` frames with right-aligned 10-bit or 12-bit integer code values. Set `bitDepth: 10` or `bitDepth: 12` on the frame or analysis options. The waveform uses `2 ** bitDepth` vertical bins by default, so each code value has its own bin; set `waveformHeight` lower to trade code-value detail for memory and processing speed. Eight-bit `Uint8Array`/`ImageData` and normalized floating-point input remain supported. Raw `Uint16Array` frames use the CPU analyzer. Canvas, video, and `VideoFrame` inputs are analyzed at the decoded precision exposed by the browser, typically 8-bit RGBA; the high-bit-depth option applies to raw pixel arrays.

The renderer uses the canvas drawing-buffer size. Set the canvas CSS size in your app. If `width` and `height` are passed to `renderScopes`, they are treated as logical pixels and set the drawing buffer to those dimensions multiplied by `devicePixelRatio`.

## Performance and lifecycle

WebGPU accelerates histogram accumulation for canvas sources and video frames. Canvas and other external-image sources use one sRGB-tagged external-image upload; browser video sources are first read as canonical RGBA pixels and uploaded with `writeTexture` so CPU and GPU do not apply different decoder/gamma conversions. Both paths then use one compute dispatch and one asynchronous histogram readback; stable frame shapes reuse the GPU texture view, bind group, parameter buffer, histogram buffers, and staging buffer. The histogram readback is asynchronous, so `update()` returns a promise; await it when frame ordering matters. While an update is in flight, additional frame calls share that update result and are dropped to prevent a stale-frame backlog. Raw RGBA pixel frames use the CPU analyzer. Display rasters reuse bounded per-context `ImageData` buffers. If automatic GPU setup or analysis fails, the instance reports a warning through `onWarning` and continues on CPU; a canvas allocation failure disables only automatic display painting so analysis can continue.

The CPU path reads browser image sources through WebCodecs into one reusable RGBA buffer when `VideoFrame.copyTo()` is available, avoiding a new full-frame `ImageData` allocation on every live update. It falls back to a 2D canvas readback and therefore needs a same-origin or CORS-enabled source when WebCodecs is unavailable. Raw RGBA and v210 frames do not use canvas readback. Call `destroy()` when finished to release GPU resources. A supplied `GPUDevice` remains owned by the caller.

## Development

```sh
npm test
npm run check:types
```

The type check packs the package, then compiles a separate CPU-only and caller-owned-device consumer against the package export with `skipLibCheck: false`. It also imports the packed ESM entry at runtime.

For a real-browser CPU/WebGPU check, serve the repository with `python3 -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765/examples/browser-gpu-check.html` in a WebGPU-enabled browser. The page compares exact histograms across waveform modes, color matrices, odd-sized/ROI fixtures, and neutral chroma; it also checks high-bit-depth ramps, target marker colors, ROI interactions, and warmed analysis/render/update timing. Open `http://127.0.0.1:8765/examples/video-gpu-check.html` to compare CPU and WebGPU on a decoded 1920×1080 HLS video frame across RGB, luma, YCbCr, and BT.2020 cases.

For a live ROI demo, serve the repository the same way and open `http://127.0.0.1:8765/examples/live-roi-demo.html`. Choose either [Mux's public Big Buck Bunny HLS test stream](https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8) or the public 3Cat on-demand DASH stream of the [Sagrada Família light-and-drone show](https://www.3cat.cat/3cat/lespectacle-de-llum-musica-i-drons-que-tanca-la-benediccio-de-la-torre-de-jesus-de-la-sagrada-familia/video/6409478/), use a webcam, capture a Chrome tab/window/screen, or open a local video file. Webcam and display capture require browser permission and localhost or HTTPS; local files are decoded in the browser. Display capture uses Chrome's native picker and feeds the selected `MediaStream` into the same ROI and scope-analysis path as camera video. Playback, 10-second skips, and the progress bar work with seekable sources. The demo analyzes each distinct presented media time once, while ROI, color, probe-resolution, or backend changes can reanalyze the current frame. The network streams support ROI selection, Auto/WebGPU/CPU analysis, sparse probe resolution, and matrix/range overrides; playback quality remains adaptive. For network video, Auto leaves the color options unset so analyzer defaults apply; the matrix affects YCbCr and vectorscope calculations, while decoded browser RGB frames already include the source range conversion. For internal slates, Auto follows the slate metadata: EBU Tech 3373 selects BT.2100 limited-range interpretation, while SMPTE and ARIB select BT.709 limited-range interpretation. The **Pop out scopes** button moves the existing live scope canvas into a separate window and hides the original scopes panel, so only one display raster is rendered. The 3Cat player API supplies a browser-readable MPD, which the demo plays with [dash.js](https://github.com/Dash-Industry-Forum/dash.js); the MPD offers AVC up to 1080p but has no HDR transfer tag. The linked [YouTube upload](https://www.youtube.com/watch?v=odBWmbca9sc) is labeled 4K HDR, but an embedded YouTube player does not expose its video frames to scope analysis. The demo loads hls.js and dash.js from their public CDNs and needs network access. Serve it from localhost or HTTPS. Remote sources must permit CORS for video frame analysis.
