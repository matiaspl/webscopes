# Electron DeckLink / v210 sample

This sample mirrors the live ROI page: it previews a DeckLink SDI input, lets you draw or preset an analysis region, and shows waveform plus vectorscope results. Macadam captures 10-bit YUV directly from DeckLink. The captured `bmdFormat10BitYUV` frame is v210 and is sent to the WebScopes analyzer without converting it through the preview.

## Requirements

- macOS, Windows, or Linux with a supported Blackmagic DeckLink card and Desktop Video driver.
- Node.js 22.12 or newer, npm, and the platform's C/C++ build tools.
- A video mode that the card reports as supporting 10-bit YUV capture.

From this directory, install the packages and build the Macadam addon for the Node executable that will run its helper process:

```sh
npm install
npm run setup:native
npm start
```

The local `.npmrc` disables package lifecycle scripts because Macadam's default install build is not compatible with newer experimental N-API headers. `setup:native` applies the N-API compatibility define, downloads Electron's runtime if needed, and builds Macadam plus its crash-handler dependency. Run it again after changing Node versions or architectures.

The app runs Macadam in a separate Node helper process. This keeps a native SDK crash from taking down the Electron window. If the helper exits unexpectedly, the app reports the failure and Macadam's crash log is written in the system temporary directory. Set `WEBSCOPES_NODE_PATH` if the `node` executable used by npm is not the one you want the helper to run.

Click **Refresh inputs**, choose a DeckLink device, then choose the exact 10-bit mode matching the SDI signal. The app requests `bmdFormat10BitYUV` (v210). If the source is not already in the incoming signal's color range or matrix, select the appropriate scope interpretation in the toolbar.

## Data path

```text
DeckLink SDI (10-bit YUV / v210)
  ├─ Macadam frame buffer → WebScopes CPU analyzer → Electron scopes canvas
  └─ reduced RGBA preview derived from that frame → Electron picture canvas
```

The analyzer samples at reduced spatial resolution and updates up to five times per second. It preserves 10-bit waveform bins and analyzes the newest available frame rather than building a stale queue. The waveform selector includes luma, RGB/YCbCr parades, RGB overlay, and an active-picture composite view. Display and vectorscope dithering are disabled. The preview is display-only and uses the selected matrix/range controls.

## Validation notes

- This is a development sample run from the repository checkout, not a packaged product.
- The renderer uses context isolation and a narrow preload bridge; it does not receive Node.js access.
- Mode lists come from Macadam's DeckLink capability report and include only modes marked as supporting 10-bit YUV.
- A successful native build does not prove that the installed driver/card combination can enumerate or capture. Validate with the actual DeckLink model and incoming SDI format.
