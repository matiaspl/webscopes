# Electron DeckLink / v210 sample

This sample mirrors the live ROI page: it previews a Blackmagic video input, lets you draw or preset an analysis region, and shows waveform plus vectorscope results. Macadam captures 10-bit YUV directly from a DeckLink or UltraStudio device. The captured `bmdFormat10BitYUV` frame is v210 and is sent to the reusable WebScopes WebGPU display without converting it through the preview when the GPU path is available.

## Requirements

- macOS, Windows, or Linux with a supported Blackmagic DeckLink or UltraStudio device and Desktop Video driver.
- Node.js 22.12 or newer, npm, and the platform's C/C++ build tools.
- A video mode that the card reports as supporting 10-bit YUV capture.

From this directory, install the packages, prepare Electron, and build or select Macadam's native addon for the Node helper:

```sh
npm install
npm run setup:native
npm start
```

The local `.npmrc` disables package lifecycle scripts. The sample pins the Electron-safe `spaceagetv/macadam` v2.1.1 source at a fixed commit. `setup:native` applies the sample's automatic-format-detection and optional per-frame colorspace-metadata patches, downloads Electron's runtime if needed, forces a source build of the native addon, and builds the frame-ring addon for both the system Node and Electron ABIs. Run setup after changing the Macadam patch, Node version, Electron version, or architecture. The ring addon is loaded only by the helper and main processes, never by the sandboxed renderer.

The app runs Macadam in a separate Node helper process, so a native SDK crash does not take down the Electron window. By default, the helper uses Electron's bundled Node runtime so advanced IPC serialization stays compatible with the main process. Set `WEBSCOPES_NODE_PATH` only to a Node executable with the same Node version as Electron; a different version can make the helper's IPC messages fail to decode. If the helper exits unexpectedly, the app reports the failure and Macadam's crash log is written in the system temporary directory.

Select the active connector and input in Blackmagic Desktop Video Setup first. Click **Refresh inputs**, choose a device, then select **Auto · follow input format** or a specific 10-bit mode. Auto is shown only when the device reports SDK input-format-detection support; it restarts capture when the detected display mode changes and updates the preview dimensions to match. Manual mode requires choosing the exact 10-bit mode matching the incoming signal. The app requests `bmdFormat10BitYUV` (v210). The default **Auto · DeckLink metadata** matrix uses per-frame `IDeckLinkVideoFrameMetadataExtensions` colorspace metadata when the device and source provide it, and falls back to BT.709 when it is absent. Range remains an explicit Limited/Full control because the DeckLink frame metadata interface does not provide a separate per-frame range value.

## Data path

```text
Blackmagic video input (10-bit YUV / v210)
  ├─ Macadam frame buffer + optional colorspace/EOTF metadata → native 3-slot shared ring → Electron IPC → WebGPU v210 decode/analysis/display
  ├─ opt-in macOS trial: ring → RGBA IOSurface → Electron sharedTexture → WebGPU external texture → v210 shader
  ├─ native ring failure/device loss → WebScopes CPU analyzer → Canvas2D scopes
  └─ WebGPU v210-to-RGB preview or CPU reduced RGBA preview → picture canvas
  └─ RP188 timecode/user bits → parsed VITC readout beside the picture
```

The GPU path attempts every captured frame. The ring overwrites the oldest ready slot when the renderer falls behind and reports transport drops; the renderer also keeps only the newest pending presentation to bound latency. The analyzer samples at reduced spatial resolution, preserves 10-bit waveform bins, and reports GPU submission/completion separately from captured-frame rate. The waveform selector includes luma, RGB/YCbCr parades, RGB overlay, and an active-picture composite view. Display and vectorscope dithering are disabled. The preview is display-only and uses the effective matrix/range controls; the signal footer shows whether Auto used DeckLink metadata or the BT.709 fallback and displays the raw HDR EOTF code when present.

The optional macOS `npm run start:shared-rgba` path tests Electron shared textures. `v210-rgba.js` defines the reversible byte layout: three consecutive v210 bytes occupy each texture pixel's RGB channels and alpha is 255; texture width is `ceil(v210BytesPerRow / 3)`, not picture width. The main process packs each frame into a native RGBA IOSurface and transfers it as a `VideoFrame`. The sandboxed preload transfers that frame into the page; WebGPU imports it as an external texture. Both the scope and preview shaders reconstruct v210 words from the RGBA texels on the GPU, without `VideoFrame.copyTo()` or a renderer-side v210 upload. The first submitted frame gets a full GPU readback and SHA-256 comparison against the original v210 bytes. A changed byte, unsupported API, or failed transfer disables the experimental path and retries via the existing v210 IPC transport. The source dimensions and row stride remain separate metadata. The default `npm start` path is unchanged. This still CPU-packs the IOSurface and does not guarantee a copy-free Chromium import.

Run `npm run test:shared-rgba` after `setup:native` for a hidden Electron test with a synthetic 1920×1080 v210 frame. It verifies exact bytes through IOSurface, `sharedTexture`, `VideoFrame.copyTo()`, and the isolated preload bridge. The live app separately validates its external-texture GPU path on the first submitted frame. The hidden test does not exercise a DeckLink device or WebGPU presentation.

When the input carries RP188 timecode, the picture footer shows the normalized `HH:MM:SS:FF` readout, drop-frame state, optional frame-pair marker, and the 32-bit user bits as hexadecimal. Macadam requests `bmdTimecodeRP188Any`, so the DeckLink SDK may supply VITC1, VITC2, or LTC; the UI labels the result as VITC/RP188 and shows `NO VITC` when the frame has no timecode metadata.

## Validation notes

- This is a development sample run from the repository checkout, not a packaged product.
- The renderer uses context isolation and a narrow preload bridge; it does not receive Node.js access. Electron hardware acceleration is not disabled; the UI reports runtime GPU-compositing status.
- The helper remains the Macadam crash-isolation boundary. In GPU mode it writes raw v210 into the bounded shared ring and sends only ready metadata over child IPC; the renderer performs the v210 upload, analysis, scope rendering, and optional preview rendering on WebGPU. CPU analysis/Canvas2D is automatic fallback.
- Mode lists come from Macadam's DeckLink capability report and include only modes marked as supporting 10-bit YUV.
- Macadam v2.1.1 bundles DeckLink API 10.11.2 headers. Compatibility with the installed Desktop Video driver and the connected card/input must be confirmed on the target hardware.
- A successful native build does not prove that the installed driver/device combination can capture. Validate with the actual Blackmagic device and incoming signal format.
- The experimental RGBA shared-texture path currently uses a macOS IOSurface addon. `setup:native` builds it against the selected Electron headers on macOS; other platforms retain the v210 IPC path.
