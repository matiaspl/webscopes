import test from "node:test";
import assert from "node:assert/strict";
import { parseDeviceNames, parseFormats, v210BytesPerRow } from "../examples/electron-decklink/ffmpeg-utils.js";

test("parses DeckLink source names from FFmpeg source output", () => {
  const report = [
    "Auto-detected sources for decklink:",
    "  75:0a4aa32e:00000000 [Intensity Pro 4K]",
    "  46:00000000:002e0900 [DeckLink SDI (2)]",
    "  46:00000000:002e0900 [DeckLink SDI (2)]",
  ].join("\n");

  assert.deepEqual(parseDeviceNames(report), ["Intensity Pro 4K", "DeckLink SDI (2)"]);
});

test("parses DeckLink FourCC modes and rational frame rates", () => {
  const report = [
    "Supported formats for 'DeckLink SDI':",
    "    format_code    description",
    "    Hi50        1920x1080 at 25000/1000 fps (interlaced, upper field first)",
    "    Hp29        1920x1080 at 30000/1001 fps",
    "    pal         720x576 at 25000/1000 fps",
  ].join("\n");

  assert.deepEqual(parseFormats(report), [
    {
      key: "Hi50|1920x1080|25000/1000",
      code: "Hi50",
      width: 1920,
      height: 1080,
      numerator: 25000,
      denominator: 1000,
      label: "Hi50 · 1920×1080 · 25 fps · interlaced",
    },
    {
      key: "Hp29|1920x1080|30000/1001",
      code: "Hp29",
      width: 1920,
      height: 1080,
      numerator: 30000,
      denominator: 1001,
      label: "Hp29 · 1920×1080 · 29.970 fps",
    },
    {
      key: "pal|720x576|25000/1000",
      code: "pal",
      width: 720,
      height: 576,
      numerator: 25000,
      denominator: 1000,
      label: "pal · 720×576 · 25 fps",
    },
  ]);
});

test("computes standard v210 row alignment", () => {
  assert.equal(v210BytesPerRow(6), 128);
  assert.equal(v210BytesPerRow(48), 128);
  assert.equal(v210BytesPerRow(64), 256);
  assert.equal(v210BytesPerRow(1920), 5120);
  assert.throws(() => v210BytesPerRow(0), /positive integer/);
});
