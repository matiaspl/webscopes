import test from "node:test";
import assert from "node:assert/strict";
import { listTenBitModes, makeV210Preview, v210BytesPerRow } from "./macadam-utils.js";

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

test("creates limited-range black and white previews from v210 frames", () => {
  const frame = new Uint8Array(v210BytesPerRow(2));
  const view = new DataView(frame.buffer);
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
