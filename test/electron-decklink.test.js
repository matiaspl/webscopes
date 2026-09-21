import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { listTenBitModes, makeV210Preview, resolveCaptureMode, v210BytesPerRow } from "../examples/electron-decklink/macadam-utils.js";
import { patchMacadamCaptureHeader, patchMacadamCaptureSource } from "../examples/electron-decklink/scripts/macadam-auto-detect.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ignores late helper events after the window is closed or destroyed", async () => {
  const mainSource = await readFile(path.join(projectRoot, "examples/electron-decklink/main.js"), "utf8");
  const handler = mainSource.match(/^function handleHelperMessage\(message\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(handler, "main.js must define the helper message handler");

  for (const mainWindow of [undefined, { isDestroyed: () => true }]) {
    assert.doesNotThrow(() => runInNewContext(
      `${handler}\nhandleHelperMessage({ type: "event", name: "preview", value: {} });`,
      { mainWindow, settleRequest() {}, capture: undefined },
    ));
  }
});

test("Electron serves every module in the renderer entry point's static import graph", async () => {
  const mainSource = await readFile(path.join(projectRoot, "examples/electron-decklink/main.js"), "utf8");
  const allowlistSource = mainSource.match(/const rendererFiles = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(allowlistSource, "main.js must define the renderer resource allowlist");
  const allowedFiles = new Set([...allowlistSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  const htmlPath = "examples/electron-decklink/index.html";
  assert.ok(allowedFiles.has(htmlPath), `${htmlPath} must be served`);

  const htmlSource = await readFile(path.join(projectRoot, htmlPath), "utf8");
  const script = htmlSource.match(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/i);
  assert.ok(script, "index.html must point to a module entry point");

  const pending = [path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), script[1]))];
  const visited = new Set();
  const staticImports = /(?:^|[\r\n])\s*(?:import|export)\s+(?:[^'";\r\n]*?\s+from\s+)?["']([^"']+)["']/g;
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    assert.ok(allowedFiles.has(file), `Electron protocol blocks renderer module ${file}`);
    const source = await readFile(path.join(projectRoot, file), "utf8");
    for (const match of source.matchAll(staticImports)) {
      if (match[1].startsWith(".")) {
        pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
      }
    }
  }
});

test("lists only 10-bit input modes that match a Macadam display-mode enum", () => {
  const api = {
    bmdModeHD1080i50: 1,
    bmdModeHD720p50: 2,
    modeWidth: (mode) => mode === 1 ? 1920 : 1280,
    modeHeight: (mode) => mode === 1 ? 1080 : 720,
  };
  const formats = listTenBitModes({
    inputDisplayModes: [
      { name: "HD 1080i50", width: 1920, height: 1080, frameRate: [1000, 25000], videoModes: ["8-bit YUV", "10-bit YUV"] },
      { name: "HD 720p50", width: 1280, height: 720, frameRate: [1000, 50000], videoModes: ["8-bit YUV"] },
    ],
  }, api, 0);

  assert.equal(formats.length, 1);
  assert.equal(formats[0].displayMode, 1);
  assert.match(formats[0].label, /1080i50.*interlaced/);
});

test("resolves automatic mode detection only for supported devices", () => {
  const formats = [
    { key: "720", width: 1280, height: 720, label: "720p50" },
    { key: "1080i50", width: 1920, height: 1080, label: "HD 1080i50" },
  ];

  assert.deepEqual(resolveCaptureMode("auto", formats, true), { format: formats[1], autoDetect: true });
  assert.deepEqual(resolveCaptureMode("720", formats, true), { format: formats[0], autoDetect: false });
  assert.throws(() => resolveCaptureMode("auto", formats, false), /does not support automatic input format detection/);
  assert.throws(() => resolveCaptureMode("missing", formats, true), /Select a capture mode/);
});

test("patches Macadam's native capture API with idempotent input format detection", async (t) => {
  const macadamRoot = path.join(projectRoot, "examples/electron-decklink/node_modules/@spaceagetv/macadam");
  let header;
  let source;
  try {
    [header, source] = await Promise.all([
      readFile(path.join(macadamRoot, "src/capture_promise.h"), "utf8"),
      readFile(path.join(macadamRoot, "src/capture_promise.cc"), "utf8"),
    ]);
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("install the Electron sample dependencies to verify the Macadam patch");
    throw error;
  }

  const patchedHeader = patchMacadamCaptureHeader(header);
  const patchedSource = patchMacadamCaptureSource(source);
  assert.match(patchedHeader, /bool autoDetect = false/);
  assert.match(patchedSource, /bmdVideoInputEnableFormatDetection/);
  assert.match(patchedSource, /deckLinkInput->FlushStreams\(\)/);
  assert.equal(patchMacadamCaptureHeader(patchedHeader), patchedHeader);
  assert.equal(patchMacadamCaptureSource(patchedSource), patchedSource);
});

test("creates limited-range black and white previews from Macadam v210 buffers", () => {
  const storage = new Uint8Array(v210BytesPerRow(2) + 8);
  const frame = storage.subarray(4, 4 + v210BytesPerRow(2));
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const setFirstPixelPair = (luma) => {
    view.setUint32(0, 512 | (luma << 10) | (512 << 20), true);
    view.setUint32(4, luma | (512 << 10), true);
  };

  setFirstPixelPair(64);
  const black = makeV210Preview(frame, 2, 1, 128);
  assert.deepEqual([...black.data.slice(0, 8)], [0, 0, 0, 255, 0, 0, 0, 255]);

  setFirstPixelPair(940);
  const white = makeV210Preview(frame, 2, 1, 128);
  assert.deepEqual([...white.data.slice(0, 8)], [255, 255, 255, 255, 255, 255, 255, 255]);
});

test("unpacks all six v210 luma positions without changing 10-bit preview levels", () => {
  const frame = new Uint8Array(v210BytesPerRow(6));
  const view = new DataView(frame.buffer);
  const luma = [64, 240, 416, 600, 780, 940];
  view.setUint32(0, 512 | (luma[0] << 10) | (512 << 20), true);
  view.setUint32(4, luma[1] | (512 << 10) | (luma[2] << 20), true);
  view.setUint32(8, 512 | (luma[3] << 10) | (512 << 20), true);
  view.setUint32(12, luma[4] | (512 << 10) | (luma[5] << 20), true);

  const preview = makeV210Preview(frame, 6, 1, 128);
  const actual = Array.from({ length: 6 }, (_, pixel) => preview.data[pixel * 4]);
  const expected = luma.map((value) => Math.round(255 * (value - 64) / 876));
  assert.deepEqual(actual, expected);
  for (let pixel = 0; pixel < 6; pixel += 1) {
    assert.equal(preview.data[pixel * 4 + 1], expected[pixel]);
    assert.equal(preview.data[pixel * 4 + 2], expected[pixel]);
    assert.equal(preview.data[pixel * 4 + 3], 255);
  }
});

test("rejects truncated v210 frames before reading them", () => {
  assert.throws(() => makeV210Preview(new Uint8Array(16), 1920, 1080, 5120), /incomplete v210 frame/);
});

test("computes standard v210 row alignment", () => {
  assert.equal(v210BytesPerRow(6), 128);
  assert.equal(v210BytesPerRow(48), 128);
  assert.equal(v210BytesPerRow(64), 256);
  assert.equal(v210BytesPerRow(1920), 5120);
  assert.throws(() => v210BytesPerRow(0), /positive integer/);
});
