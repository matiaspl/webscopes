import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTenBitModes, makeV210Preview, v210BytesPerRow } from "../examples/electron-decklink/macadam-utils.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
