import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFrame, generateTestSignalSlate, TEST_SIGNAL_COLOR_MATRICES, TEST_SIGNAL_COLOR_RANGES, TEST_SIGNAL_PATTERNS } from "../src/index.js";

function readV210Sample(frame, x, y = 0) {
  const group = Math.floor(x / 6);
  const offset = y * frame.bytesPerRow + group * 16;
  const view = new DataView(frame.data.buffer, frame.data.byteOffset + offset, 16);
  const words = [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)];
  const luma = [words[0] >>> 10 & 0x3ff, words[1] & 0x3ff, words[1] >>> 20 & 0x3ff, words[2] >>> 10 & 0x3ff, words[3] & 0x3ff, words[3] >>> 20 & 0x3ff];
  const cb = [words[0] & 0x3ff, words[1] >>> 10 & 0x3ff, words[2] >>> 20 & 0x3ff];
  const cr = [words[0] >>> 20 & 0x3ff, words[2] & 0x3ff, words[3] >>> 10 & 0x3ff];
  return { y: luma[x % 6], cb: cb[(x % 6) >> 1], cr: cr[(x % 6) >> 1] };
}

test("generates every internal slate across all supported matrices and ranges", () => {
  for (const pattern of TEST_SIGNAL_PATTERNS) {
    for (const colorMatrix of TEST_SIGNAL_COLOR_MATRICES) {
      for (const colorRange of TEST_SIGNAL_COLOR_RANGES) {
        const slate = generateTestSignalSlate({ pattern, colorMatrix, colorRange, width: 48, height: 24 });
        assert.equal(slate.frame.format, "v210");
        assert.equal(slate.frame.bytesPerRow, 128);
        assert.equal(slate.frame.data.byteLength, 128 * 24);
        assert.equal(slate.preview.data.length, 48 * 24 * 4);
        assert.equal(slate.bitDepth, 10);

        const result = analyzeFrame(slate.frame, {
          waveformMode: "ycbcr-parade",
          waveformWidth: 48,
          waveformHeight: 1024,
          vectorscopeSize: 64,
          colorMatrix,
          colorRange,
        });
        assert.equal(result.sampleCount, 48 * 24);
        assert.equal(result.stats.colorMatrix, colorMatrix);
        assert.equal(result.stats.colorRange, colorRange);
        assert.ok(result.waveform.channels.every((channel) => channel.some((count) => count > 0)));
        assert.equal(result.vectorscope.bins.reduce((sum, count) => sum + count, 0), 48 * 24);
      }
    }
  }
});

test("slate code values expose range and matrix interpretation errors", () => {
  const slate = generateTestSignalSlate({ pattern: "smpte", colorMatrix: "bt709", colorRange: "limited", width: 48, height: 24 });
  const options = { waveformMode: "rgb", waveformWidth: 48, waveformHeight: 1024, vectorscopeSize: 64 };
  const limited = analyzeFrame(slate.frame, { ...options, colorMatrix: "bt709", colorRange: "limited" });
  const full = analyzeFrame(slate.frame, { ...options, colorMatrix: "bt709", colorRange: "full" });
  const otherMatrix = analyzeFrame(slate.frame, { ...options, colorMatrix: "bt601", colorRange: "limited" });
  assert.notDeepEqual(limited.waveform.channels[0], full.waveform.channels[0]);
  assert.notDeepEqual(limited.waveform.channels, otherMatrix.waveform.channels);
});

test("SMPTE RP 219-1 uses its published HD geometry and 10-bit nominal levels", () => {
  const slate = generateTestSignalSlate({ pattern: "smpte", width: 1920, height: 1080 });
  assert.equal(slate.standard, "SMPTE RP 219-1:2014");
  const pattern1 = [
    [414, 512, 512], [721, 512, 512], [674, 176, 543], [581, 589, 176],
    [534, 253, 207], [251, 771, 817], [204, 435, 848], [111, 848, 481], [414, 512, 512],
  ];
  const pattern1Widths = [240, 206, 206, 206, 204, 206, 206, 206, 240];
  let x = 0;
  pattern1.forEach((expected, index) => {
    assert.deepEqual(readV210Sample(slate.frame, x + Math.floor(pattern1Widths[index] / 2)), { y: expected[0], cb: expected[1], cr: expected[2] });
    x += pattern1Widths[index];
  });
  assert.deepEqual(readV210Sample(slate.frame, 0), { y: 414, cb: 512, cr: 512 });
  assert.deepEqual(readV210Sample(slate.frame, 240), { y: 721, cb: 512, cr: 512 });
  assert.deepEqual(readV210Sample(slate.frame, 446), { y: 674, cb: 176, cr: 543 });
  assert.deepEqual(readV210Sample(slate.frame, 0, 810), { y: 195, cb: 512, cr: 512 });
  assert.deepEqual(readV210Sample(slate.frame, 240, 810), { y: 64, cb: 512, cr: 512 });
  assert.deepEqual(readV210Sample(slate.frame, 548, 810), { y: 940, cb: 512, cr: 512 });
  assert.equal(readV210Sample(slate.frame, 1130, 810).y, 46);
});

test("EBU Tech 3373 uses its published HD code tables", () => {
  const slate = generateTestSignalSlate({ pattern: "ebu", colorMatrix: "bt2100", width: 1920, height: 1080 });
  assert.equal(slate.standard, "EBU Tech 3373:2020");
  assert.equal(slate.nativeColorMatrix, "bt2100");
  assert.deepEqual(readV210Sample(slate.frame, 0), { y: 414, cb: 512, cr: 512 });
  assert.deepEqual(readV210Sample(slate.frame, 240), { y: 940, cb: 512, cr: 512 });
  assert.deepEqual(readV210Sample(slate.frame, 446), { y: 888, cb: 64, cr: 548 });
  assert.equal(readV210Sample(slate.frame, 240, 100).y, 721);
  assert.equal(readV210Sample(slate.frame, 240, 380).y, 602);
  assert.equal(readV210Sample(slate.frame, 240, 480).y, 618);
  assert.equal(readV210Sample(slate.frame, 0, 580).y, 64);
  assert.equal(readV210Sample(slate.frame, 0, 630).y, 250);
  assert.equal(readV210Sample(slate.frame, 446, 1030).y, 32);
});

test("EBU HLG defaults to its native BT.2100 interpretation", () => {
  const slate = generateTestSignalSlate({ pattern: "ebu", width: 48, height: 24 });
  assert.equal(slate.nativeColorMatrix, "bt2100");
  assert.equal(slate.nativeColorRange, "limited");
  assert.equal(slate.colorMatrix, "bt2100");
  assert.equal(slate.colorRange, "limited");
  assert.equal(slate.frame.colorMatrix, "bt2100");
  assert.equal(analyzeFrame(slate.frame).stats.colorMatrix, "bt2100");
});

test("encodes limited-range neutral chroma at v210 code 512", () => {
  const slate = generateTestSignalSlate({ pattern: "smpte", colorMatrix: "bt709", colorRange: "limited", width: 48, height: 24 });
  assert.deepEqual([...slate.preview.data.slice(6 * 4, 6 * 4 + 3)], [191, 191, 191]);
  const result = analyzeFrame(slate.frame, {
    waveformMode: "ycbcr-parade",
    waveformWidth: 48,
    waveformHeight: 1024,
    vectorscopeSize: 64,
    colorMatrix: "bt709",
    colorRange: "limited",
  });
  assert.ok(result.waveform.channels[1][512 * 48] > 0);
  assert.ok(result.waveform.channels[2][512 * 48] > 0);
});

test("keeps the limited-range SMPTE green bar neutral in the green channel", () => {
  const slate = generateTestSignalSlate({ pattern: "smpte", colorMatrix: "bt709", colorRange: "limited" });
  assert.deepEqual([...slate.preview.data.slice((960 * 4), (960 * 4) + 4)], [0, 191, 0, 255]);
});

test("rejects unsupported test slate settings", () => {
  assert.throws(() => generateTestSignalSlate({ pattern: "bars" }), /Unsupported test signal pattern/);
  assert.throws(() => generateTestSignalSlate({ colorMatrix: "bt2022" }), /Unsupported test signal color matrix/);
  assert.throws(() => generateTestSignalSlate({ colorRange: "broadcast" }), /color range/);
  assert.throws(() => generateTestSignalSlate({ width: 4 }), /width/);
});
