# Electron DeckLink / v210 sample

This sample mirrors the live ROI page: it previews a Blackmagic video input, lets you draw or preset an analysis region, and shows waveform plus vectorscope results. Macadam captures 10-bit YUV directly from a DeckLink or UltraStudio device. The captured `bmdFormat10BitYUV` frame is v210 and is sent to the WebScopes analyzer without converting it through the preview.

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

The local `.npmrc` disables package lifecycle scripts. The sample pins the Electron-safe `spaceagetv/macadam` v2.1.1 source at a fixed commit. `setup:native` applies the sample's automatic-format-detection patch, downloads Electron's runtime if needed, explicitly runs Macadam's native install hook, and verifies that the 10-bit capture API loads. The addon runs in the helper's Node process, not in Electron. Run setup again after changing Node versions or architectures.

The app runs Macadam in a separate Node helper process, so a native SDK crash does not take down the Electron window. By default, the helper uses Electron's bundled Node runtime so advanced IPC serialization stays compatible with the main process. Set `WEBSCOPES_NODE_PATH` only to a Node executable with the same Node version as Electron; a different version can make the helper's IPC messages fail to decode. If the helper exits unexpectedly, the app reports the failure and Macadam's crash log is written in the system temporary directory.

Select the active connector and input in Blackmagic Desktop Video Setup first. Click **Refresh inputs**, choose a device, then select **Auto · follow input format** or a specific 10-bit mode. Auto is shown only when the device reports SDK input-format-detection support; it restarts capture when the detected display mode changes and updates the preview dimensions to match. Manual mode requires choosing the exact 10-bit mode matching the incoming signal. The app requests `bmdFormat10BitYUV` (v210). If the source is not already in the incoming signal's color range or matrix, select the appropriate scope interpretation in the toolbar.

## Data path

```text
Blackmagic video input (10-bit YUV / v210)
  ├─ Macadam frame buffer → WebScopes CPU analyzer → Electron scopes canvas
  └─ reduced RGBA preview derived from that frame → Electron picture canvas
```

The analyzer samples at reduced spatial resolution and targets up to ten updates per second. It preserves 10-bit waveform bins and analyzes the newest available frame rather than building a stale queue. The waveform selector includes luma, RGB/YCbCr parades, RGB overlay, and an active-picture composite view. Display and vectorscope dithering are disabled. The preview is display-only and uses the selected matrix/range controls.

## Validation notes

- This is a development sample run from the repository checkout, not a packaged product.
- The renderer uses context isolation and a narrow preload bridge; it does not receive Node.js access. Electron hardware acceleration is not disabled; the UI reports runtime GPU-compositing status.
- Packed v210 scope analysis runs on the CPU in the isolated helper to preserve exact 10-bit code values. GPU acceleration of Chromium composition does not move this raw-frame analysis onto the GPU.
- Mode lists come from Macadam's DeckLink capability report and include only modes marked as supporting 10-bit YUV.
- Macadam v2.1.1 bundles DeckLink API 10.11.2 headers. Compatibility with the installed Desktop Video driver and the connected card/input must be confirmed on the target hardware.
- A successful native build does not prove that the installed driver/device combination can capture. Validate with the actual Blackmagic device and incoming signal format.
