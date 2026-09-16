import { getColorMatrix } from "./analyze.js";

export const TEST_SIGNAL_PATTERNS = Object.freeze([
  "smpte",
  "ebu",
  "arib",
  "diagnostic",
]);

export const TEST_SIGNAL_COLOR_MATRICES = Object.freeze([
  "bt601",
  "bt709",
  "bt2020",
  "bt2100",
]);

export const TEST_SIGNAL_COLOR_RANGES = Object.freeze(["limited", "full"]);

const TEST_SIGNAL_METADATA = Object.freeze({
  smpte: Object.freeze({
    label: "SMPTE RP 219-1:2014 multiformat color bars",
    standard: "SMPTE RP 219-1:2014",
    nativeColorMatrix: "bt709",
    nativeColorRange: "limited",
  }),
  ebu: Object.freeze({
    label: "EBU Tech 3373 HLG HDR UHDTV color bars",
    standard: "EBU Tech 3373:2020",
    nativeColorMatrix: "bt2100",
    nativeColorRange: "limited",
  }),
  arib: Object.freeze({
    label: "ARIB STD-B28:2000 multiformat color bars",
    standard: "ARIB STD-B28:2000",
    nativeColorMatrix: "bt709",
    nativeColorRange: "limited",
  }),
  diagnostic: Object.freeze({
    label: "Analyzer diagnostic slate (non-standard)",
    standard: "custom diagnostic pattern",
    nativeColorMatrix: undefined,
    nativeColorRange: undefined,
  }),
});

const SMPTE_RASTER = Object.freeze({ width: 1920, height: 1080 });
const EBU_RASTER = Object.freeze({ width: 1920, height: 1080 });

const COLOR_BARS = Object.freeze([
  [1, 1, 1],
  [1, 1, 0],
  [0, 1, 1],
  [0, 1, 0],
  [1, 0, 1],
  [1, 0, 0],
  [0, 0, 1],
]);

// SMPTE RP 219-1 Annex C, 1920x1080 even-integer widths.
const SMPTE_PATTERN1_WIDTHS = Object.freeze([240, 206, 206, 206, 204, 206, 206, 206, 240]);
const SMPTE_PATTERN4_WIDTHS = Object.freeze([240, 308, 412, 170, 68, 70, 68, 70, 68, 206, 240]);

// EBU Tech 3373 Tables 3–5, in the order used by Figure 2. Values are
// BT.2100 HLG narrow-range 10-bit R'G'B' and Y'CbCr samples.
const EBU_100 = Object.freeze([
  Object.freeze({ rgb: [940, 940, 940], ycbcr: [940, 512, 512] }),
  Object.freeze({ rgb: [940, 940, 64], ycbcr: [888, 64, 548] }),
  Object.freeze({ rgb: [64, 940, 940], ycbcr: [710, 637, 64] }),
  Object.freeze({ rgb: [64, 940, 64], ycbcr: [658, 189, 100] }),
  Object.freeze({ rgb: [940, 64, 940], ycbcr: [346, 835, 924] }),
  Object.freeze({ rgb: [940, 64, 64], ycbcr: [294, 387, 960] }),
  Object.freeze({ rgb: [64, 64, 940], ycbcr: [116, 960, 476] }),
]);

const EBU_75 = Object.freeze([
  Object.freeze({ rgb: [721, 721, 721], ycbcr: [721, 512, 512] }),
  Object.freeze({ rgb: [721, 721, 64], ycbcr: [682, 176, 539] }),
  Object.freeze({ rgb: [64, 721, 721], ycbcr: [548, 606, 176] }),
  Object.freeze({ rgb: [64, 721, 64], ycbcr: [509, 270, 203] }),
  Object.freeze({ rgb: [721, 64, 721], ycbcr: [276, 754, 821] }),
  Object.freeze({ rgb: [721, 64, 64], ycbcr: [237, 418, 848] }),
  Object.freeze({ rgb: [64, 64, 721], ycbcr: [103, 848, 485] }),
]);

const EBU_DISPLAY_LIGHT = Object.freeze([
  Object.freeze({ rgb: [602, 602, 602], ycbcr: [602, 512, 512] }),
  Object.freeze({ rgb: [594, 601, 246], ycbcr: [578, 331, 523] }),
  Object.freeze({ rgb: [408, 591, 601], ycbcr: [544, 543, 418] }),
  Object.freeze({ rgb: [388, 589, 232], ycbcr: [515, 358, 424] }),
  Object.freeze({ rgb: [534, 227, 595], ycbcr: [329, 656, 654] }),
  Object.freeze({ rgb: [522, 216, 138], ycbcr: [292, 428, 672] }),
  Object.freeze({ rgb: [187, 127, 602], ycbcr: [171, 746, 523] }),
]);

const EBU_SCENE_LIGHT = Object.freeze([
  Object.freeze({ rgb: [618, 618, 618], ycbcr: [618, 512, 512] }),
  Object.freeze({ rgb: [610, 616, 253], ycbcr: [593, 327, 524] }),
  Object.freeze({ rgb: [422, 605, 615], ycbcr: [558, 543, 418] }),
  Object.freeze({ rgb: [400, 603, 238], ycbcr: [528, 354, 423] }),
  Object.freeze({ rgb: [541, 230, 601], ycbcr: [334, 657, 656] }),
  Object.freeze({ rgb: [527, 218, 139], ycbcr: [294, 427, 673] }),
  Object.freeze({ rgb: [186, 126, 598], ycbcr: [170, 745, 523] }),
]);

const EBU_SATURATION = Object.freeze({
  red: Object.freeze([
    [793, 512, 512], [788, 499, 531], [779, 485, 550], [768, 472, 570],
    [753, 458, 590], [735, 443, 614], [709, 425, 640], [673, 403, 674],
    [618, 386, 721], [526, 380, 793], [294, 387, 960],
  ]),
  green: Object.freeze([
    [809, 512, 512], [817, 494, 494], [822, 476, 476], [824, 459, 458],
    [825, 439, 439], [823, 419, 419], [817, 394, 394], [807, 365, 364],
    [786, 326, 322], [750, 282, 255], [658, 189, 100],
  ]),
  blue: Object.freeze([
    [578, 512, 513], [578, 541, 494], [574, 568, 475], [566, 594, 455],
    [554, 622, 437], [535, 651, 420], [511, 682, 407], [474, 718, 399],
    [421, 764, 400], [341, 822, 412], [116, 960, 476],
  ]),
});

const EBU_NEAR_BLACK = Object.freeze([
  [32, 512, 512], [64, 512, 512], [48, 512, 512], [64, 512, 512],
  [56, 512, 512], [64, 512, 512], [72, 512, 512], [64, 512, 512],
  [80, 512, 512], [64, 512, 512], [96, 512, 512], [64, 512, 512],
]);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function validateOptions(options) {
  const pattern = options.pattern ?? "smpte";
  const metadata = TEST_SIGNAL_METADATA[pattern];
  const colorMatrix = options.colorMatrix ?? metadata?.nativeColorMatrix ?? "bt709";
  const colorRange = options.colorRange ?? metadata?.nativeColorRange ?? "limited";
  const width = Number(options.width ?? SMPTE_RASTER.width);
  const height = Number(options.height ?? SMPTE_RASTER.height);
  if (!TEST_SIGNAL_PATTERNS.includes(pattern)) throw new RangeError(`Unsupported test signal pattern: ${pattern}`);
  if (!TEST_SIGNAL_COLOR_MATRICES.includes(colorMatrix)) throw new RangeError(`Unsupported test signal color matrix: ${colorMatrix}`);
  if (!TEST_SIGNAL_COLOR_RANGES.includes(colorRange)) throw new RangeError("Test signal color range must be limited or full");
  if (!Number.isInteger(width) || width < 6 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("Test signal dimensions must be integers; width must be at least 6");
  }
  return { pattern, colorMatrix, colorRange, width, height };
}

function scaledSegments(segments, target, reference) {
  const result = [];
  let previous = 0;
  let ideal = 0;
  for (const segment of segments) {
    ideal += segment * target / reference;
    const next = Math.round(ideal);
    result.push(next - previous);
    previous = next;
  }
  result[result.length - 1] += target - previous;
  return result;
}

function fillRgbRect(rgb, width, height, x0, y0, x1, y1, color) {
  const left = Math.max(0, Math.min(width, Math.round(x0)));
  const top = Math.max(0, Math.min(height, Math.round(y0)));
  const right = Math.max(left, Math.min(width, Math.round(x1)));
  const bottom = Math.max(top, Math.min(height, Math.round(y1)));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 3;
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    }
  }
}

function fillRgbHorizontalRamp(rgb, width, height, y0, y1, callback) {
  const top = Math.max(0, Math.min(height, Math.round(y0)));
  const bottom = Math.max(top, Math.min(height, Math.round(y1)));
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const color = callback(x, y);
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    }
  }
}

function createSmpteSignal(width, height) {
  const signal = createDirectSignal(width, height);
  const rows = scaledSegments([630, 90, 90, 270], height, SMPTE_RASTER.height);
  const pattern1Widths = scaledSegments(SMPTE_PATTERN1_WIDTHS, width, SMPTE_RASTER.width);
  const pattern4Widths = scaledSegments(SMPTE_PATTERN4_WIDTHS, width, SMPTE_RASTER.width);
  const y1 = rows[0];
  const y2 = y1 + rows[1];
  const y3 = y2 + rows[2];

  // SMPTE RP 219-1 Annex B Tables B.1, B.2, B.6, and B.8.
  const pattern1Values = [
    [414, 512, 512], [721, 512, 512], [674, 176, 543], [581, 589, 176],
    [534, 253, 207], [251, 771, 817], [204, 435, 848], [111, 848, 481], [414, 512, 512],
  ];
  let x = 0;
  pattern1Values.forEach((value, index) => {
    const next = x + pattern1Widths[index];
    fillDirectRect(signal, width, height, x, 0, next, y1, value);
    x = next;
  });

  const pattern2Widths = scaledSegments([240, 309, 1131, 240], width, SMPTE_RASTER.width);
  x = 0;
  fillDirectRect(signal, width, height, x, y1, x + pattern2Widths[0], y2, [754, 615, 64]);
  x += pattern2Widths[0];
  fillDirectRect(signal, width, height, x, y1, x + pattern2Widths[1], y2, [721, 512, 512]);
  x += pattern2Widths[1];
  fillDirectRect(signal, width, height, x, y1, x + pattern2Widths[2], y2, [721, 512, 512]);
  x += pattern2Widths[2];
  fillDirectRect(signal, width, height, x, y1, width, y2, [127, 960, 471]);

  const pattern3Widths = scaledSegments([240, 309, 925, 206, 240], width, SMPTE_RASTER.width);
  x = 0;
  fillDirectRect(signal, width, height, x, y2, x + pattern3Widths[0], y3, [877, 64, 553]);
  x += pattern3Widths[0];
  fillDirectRect(signal, width, height, x, y2, x + pattern3Widths[1], y3, [64, 512, 512]);
  x += pattern3Widths[1];
  fillDirectCodeRamp(signal, width, height, y2, y3, (pixel) => {
    const value = clamp((pixel - x) / Math.max(1, pattern3Widths[2] - 1));
    return Math.round(64 + value * 876);
  });
  x += pattern3Widths[2];
  fillDirectRect(signal, width, height, x, y2, x + pattern3Widths[3], y3, [940, 512, 512]);
  x += pattern3Widths[3];
  fillDirectRect(signal, width, height, x, y2, width, y3, [250, 409, 960]);

  const p4 = pattern4Widths;
  const p4x = [0];
  for (const segment of p4) p4x.push(p4x[p4x.length - 1] + segment);
  const p4Rows = scaledSegments([90, 90, 90], height, SMPTE_RASTER.height);
  const p4y = [y3, y3 + p4Rows[0], y3 + p4Rows[0] + p4Rows[1], height];
  fillDirectRect(signal, width, height, p4x[0], y3, p4x[1], height, [195, 512, 512]);
  fillDirectRect(signal, width, height, p4x[10], y3, p4x[11], height, [195, 512, 512]);
  fillDirectRect(signal, width, height, p4x[1], p4y[0], p4x[2], p4y[1], [64, 512, 512]);
  fillDirectRect(signal, width, height, p4x[2], p4y[0], p4x[3], p4y[1], [940, 512, 512]);
  fillDirectRect(signal, width, height, p4x[1], p4y[1], p4x[2], p4y[2], [64, 512, 512]);
  fillDirectRect(signal, width, height, p4x[2], p4y[1], p4x[3], p4y[2], [940, 512, 512]);
  fillDirectRect(signal, width, height, p4x[1], p4y[2], p4x[2], p4y[3], [64, 512, 512]);
  fillDirectRect(signal, width, height, p4x[2], p4y[2], p4x[3], p4y[3], [940, 512, 512]);
  fillDirectRect(signal, width, height, p4x[3], y3, p4x[4], height, [64, 512, 512]);
  for (let index = 4; index < 9; index += 1) {
    const level = [46, 64, 82, 64, 99][index - 4];
    fillDirectRect(signal, width, height, p4x[index], y3, p4x[index + 1], height, [level, 512, 512]);
  }
  fillDirectRect(signal, width, height, p4x[9], y3, p4x[10], height, [64, 512, 512]);
  return { direct: signal, rgb: signal.rgb };
}

function codeToRgb(value) {
  return clamp((value - 64) / 876);
}

function createDirectSignal(width, height) {
  return {
    rgb: new Float32Array(width * height * 3),
    y: new Uint16Array(width * height),
    cb: new Uint16Array(width * height),
    cr: new Uint16Array(width * height),
  };
}

function setDirectPixel(signal, width, x, y, ycbcr, rgb) {
  const index = y * width + x;
  signal.y[index] = ycbcr[0];
  signal.cb[index] = ycbcr[1];
  signal.cr[index] = ycbcr[2];
  const rgbOffset = index * 3;
  signal.rgb[rgbOffset] = codeToRgb(rgb?.[0] ?? ycbcr[0]);
  signal.rgb[rgbOffset + 1] = codeToRgb(rgb?.[1] ?? ycbcr[0]);
  signal.rgb[rgbOffset + 2] = codeToRgb(rgb?.[2] ?? ycbcr[0]);
}

function fillDirectRect(signal, width, height, x0, y0, x1, y1, ycbcr, rgb) {
  const left = Math.max(0, Math.min(width, Math.round(x0)));
  const top = Math.max(0, Math.min(height, Math.round(y0)));
  const right = Math.max(left, Math.min(width, Math.round(x1)));
  const bottom = Math.max(top, Math.min(height, Math.round(y1)));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) setDirectPixel(signal, width, x, y, ycbcr, rgb);
  }
}

function fillDirectCodeRamp(signal, width, height, y0, y1, callback) {
  const top = Math.max(0, Math.min(height, Math.round(y0)));
  const bottom = Math.max(top, Math.min(height, Math.round(y1)));
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const codeValue = callback(x);
      setDirectPixel(signal, width, x, y, [codeValue, 512, 512], [codeValue, codeValue, codeValue]);
    }
  }
}

function createEbuSignal(width, height) {
  const signal = createDirectSignal(width, height);
  const scaleX = (value) => Math.round(value * width / EBU_RASTER.width);
  const scaleY = (value) => Math.round(value * height / EBU_RASTER.height);
  const F = scaleX(240);
  const G = scaleX(206);
  const H = scaleX(103);
  const I = scaleX(238);
  const C = scaleY(100);
  const D = scaleY(50);
  const E = scaleY(580);
  const defaultGrey = [414, 512, 512];
  fillDirectRect(signal, width, height, 0, 0, width, height, defaultGrey, [414, 414, 414]);

  const barWidths = scaledSegments(new Array(7).fill(206), width - F - I, 1442);
  const xBars = [F];
  for (const segment of barWidths) xBars.push(xBars[xBars.length - 1] + segment);
  const topRows = [0, C, E - 2 * C, E - C, E];
  const drawTableRow = (top, bottom, table) => {
    for (let index = 0; index < 7; index += 1) {
      fillDirectRect(signal, width, height, index === 0 ? F : xBars[index], top, xBars[index + 1], bottom, table[index].ycbcr, table[index].rgb);
    }
  };
  fillDirectRect(signal, width, height, 0, topRows[0], F, topRows[4], defaultGrey, [414, 414, 414]);
  fillDirectRect(signal, width, height, width - I, topRows[0], width, topRows[4], defaultGrey, [414, 414, 414]);
  drawTableRow(topRows[0], topRows[1], EBU_100);
  drawTableRow(topRows[1], topRows[2], EBU_75);
  drawTableRow(topRows[2], topRows[3], EBU_DISPLAY_LIGHT);
  drawTableRow(topRows[3], topRows[4], EBU_SCENE_LIGHT);

  const rampTop = E;
  const rampBottom = E + D;
  const rampWidth = 1.5 * 1015 * width / EBU_RASTER.width;
  const rampStart = (width - rampWidth) / 2;
  fillDirectCodeRamp(signal, width, height, rampTop, rampBottom, (x) => {
    if (x <= rampStart) return 64;
    if (x > rampStart + rampWidth) return 721;
    return Math.floor(4 + ((x - rampStart) * 1015) / Math.max(1, rampWidth));
  });

  const textTop = rampBottom;
  fillDirectRect(signal, width, height, 0, textTop, width, textTop + C, [250, 512, 512], [250, 250, 250]);

  const lowerTop = textTop + C;
  const saturationStart = F + G + 3 * H;
  const saturationEnd = width - I;
  const saturationWidth = Math.max(1, saturationEnd - saturationStart);
  const saturationRows = [EBU_SATURATION.red, EBU_SATURATION.green, EBU_SATURATION.blue];
  const saturationRowHeight = C;
  for (let row = 0; row < saturationRows.length; row += 1) {
    const values = saturationRows[row];
    for (let index = 0; index < values.length; index += 1) {
      const left = saturationStart + Math.round(index * saturationWidth / values.length);
      const right = saturationStart + Math.round((index + 1) * saturationWidth / values.length);
      fillDirectRect(signal, width, height, left, lowerTop + row * saturationRowHeight, right, lowerTop + (row + 1) * saturationRowHeight, values[index], values[index]);
    }
  }

  const nearBlackTop = lowerTop + 3 * saturationRowHeight;
  const nearBlackWidths = scaledSegments([240, 206, ...new Array(12).fill(103), 238], width, EBU_RASTER.width);
  let x = 0;
  fillDirectRect(signal, width, height, x, nearBlackTop, x + nearBlackWidths[0], height, defaultGrey, [414, 414, 414]);
  x += nearBlackWidths[0];
  fillDirectRect(signal, width, height, x, nearBlackTop, x + nearBlackWidths[1], height, [64, 512, 512], [64, 64, 64]);
  x += nearBlackWidths[1];
  EBU_NEAR_BLACK.forEach((value, index) => {
    const next = x + nearBlackWidths[index + 2];
    fillDirectRect(signal, width, height, x, nearBlackTop, next, height, value, [value[0], value[0], value[0]]);
    x = next;
  });
  fillDirectRect(signal, width, height, x, nearBlackTop, width, height, defaultGrey, [414, 414, 414]);
  return { direct: signal, rgb: signal.rgb };
}

function createDiagnosticRgbSlate(width, height) {
  const rgb = new Float32Array(width * height * 3);
  const fill = (x0, y0, x1, y1, color) => fillRgbRect(rgb, width, height, x0 * width, y0 * height, x1 * width, y1 * height, color);
  for (let index = 0; index < COLOR_BARS.length; index += 1) {
    fill(index / COLOR_BARS.length, 0, (index + 1) / COLOR_BARS.length, 0.25, COLOR_BARS[index].map((component) => component * 0.75));
  }
  fillRgbHorizontalRamp(rgb, width, height, height * 0.25, height * 0.5, (x) => {
    const value = x / Math.max(1, width - 1);
    return [value, value, value];
  });
  fillRgbHorizontalRamp(rgb, width, height, height * 0.5, height * 0.68, (x) => {
    const value = x / Math.max(1, width - 1);
    return [value, 1 - value, 0.5];
  });
  for (let index = 0; index < 8; index += 1) {
    const value = index / 7;
    fill(index / 8, 0.68, (index + 1) / 8, 0.84, [value, value, value]);
  }
  for (let y = Math.floor(height * 0.84); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = ((x >> 3) + (y >> 3)) & 1 ? 1 : 0;
      const offset = (y * width + x) * 3;
      rgb[offset] = value;
      rgb[offset + 1] = value;
      rgb[offset + 2] = value;
    }
  }
  return { rgb };
}

function createSignal(width, height, pattern) {
  if (pattern === "ebu") return createEbuSignal(width, height);
  if (pattern === "diagnostic") return createDiagnosticRgbSlate(width, height);
  // ARIB STD-B28 uses the same multiformat HD/SD-compatible raster arrangement.
  return createSmpteSignal(width, height);
}

function encodeTestSignal(signal, width, height, colorMatrix, colorRange) {
  const { kr, kb } = getColorMatrix(colorMatrix);
  const kg = 1 - kr - kb;
  const lumaOffset = colorRange === "limited" ? 64 : 0;
  const lumaRange = colorRange === "limited" ? 876 : 1023;
  const chromaRange = colorRange === "limited" ? 896 : 1023;
  const bytesPerRow = Math.ceil(width / 48) * 128;
  const data = new Uint8Array(bytesPerRow * height);
  const preview = new Uint8ClampedArray(width * height * 4);
  const yCodes = new Uint16Array(width);
  const cbValues = new Float32Array(width);
  const crValues = new Float32Array(width);
  const cbCodes = new Uint16Array(Math.ceil(width / 2));
  const crCodes = new Uint16Array(Math.ceil(width / 2));
  const words = new Uint32Array(4);

  function code(value, offset, range) {
    return Math.max(0, Math.min(1023, Math.round(offset + value * range)));
  }

  function remapNativeY(value) {
    return Math.max(0, Math.min(1023, Math.round(lumaOffset + ((value - 64) / 876) * lumaRange)));
  }

  function remapNativeChroma(value) {
    return Math.max(0, Math.min(1023, Math.round(512 + ((value - 512) / 896) * chromaRange)));
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (signal.direct) {
        yCodes[x] = remapNativeY(signal.direct.y[index]);
        cbValues[x] = (remapNativeChroma(signal.direct.cb[index]) - 512) / chromaRange;
        crValues[x] = (remapNativeChroma(signal.direct.cr[index]) - 512) / chromaRange;
      } else {
        const rgbOffset = index * 3;
        const red = clamp(signal.rgb[rgbOffset]);
        const green = clamp(signal.rgb[rgbOffset + 1]);
        const blue = clamp(signal.rgb[rgbOffset + 2]);
        const luma = kr * red + kg * green + kb * blue;
        yCodes[x] = code(luma, lumaOffset, lumaRange);
        cbValues[x] = (blue - luma) / (2 * (1 - kb));
        crValues[x] = (red - luma) / (2 * (1 - kr));
      }
    }
    for (let pair = 0; pair < cbCodes.length; pair += 1) {
      const first = pair * 2;
      const second = Math.min(width - 1, first + 1);
      const cb = clamp((cbValues[first] + cbValues[second]) / 2, -0.5, 0.5);
      const cr = clamp((crValues[first] + crValues[second]) / 2, -0.5, 0.5);
      cbCodes[pair] = Math.max(0, Math.min(1023, Math.round(512 + cb * chromaRange)));
      crCodes[pair] = Math.max(0, Math.min(1023, Math.round(512 + cr * chromaRange)));
    }
    for (let x = 0; x < width; x += 1) {
      const chromaIndex = x >> 1;
      const decodedLuma = (yCodes[x] - lumaOffset) / lumaRange;
      const decodedCb = (cbCodes[chromaIndex] - 512) / chromaRange;
      const decodedCr = (crCodes[chromaIndex] - 512) / chromaRange;
      const decodedRed = clamp(decodedLuma + decodedCr * 2 * (1 - kr));
      const decodedBlue = clamp(decodedLuma + decodedCb * 2 * (1 - kb));
      const decodedGreen = clamp((decodedLuma - kr * decodedRed - kb * decodedBlue) / kg);
      const previewOffset = (y * width + x) * 4;
      preview[previewOffset] = Math.round(decodedRed * 255);
      preview[previewOffset + 1] = Math.round(decodedGreen * 255);
      preview[previewOffset + 2] = Math.round(decodedBlue * 255);
      preview[previewOffset + 3] = 255;
    }

    for (let group = 0; group < Math.ceil(width / 6); group += 1) {
      const base = group * 6;
      const cb0 = cbCodes[base >> 1] ?? 512;
      const cb1 = cbCodes[(base >> 1) + 1] ?? cb0;
      const cb2 = cbCodes[(base >> 1) + 2] ?? cb1;
      const cr0 = crCodes[base >> 1] ?? 512;
      const cr1 = crCodes[(base >> 1) + 1] ?? cr0;
      const cr2 = crCodes[(base >> 1) + 2] ?? cr1;
      words[0] = cb0 | ((yCodes[base] ?? 0) << 10) | (cr0 << 20);
      words[1] = (yCodes[base + 1] ?? yCodes[base] ?? 0) | (cb1 << 10) | ((yCodes[base + 2] ?? yCodes[base + 1] ?? 0) << 20);
      words[2] = cr1 | ((yCodes[base + 3] ?? yCodes[base + 2] ?? 0) << 10) | (cb2 << 20);
      words[3] = (yCodes[base + 4] ?? yCodes[base + 3] ?? 0) | (cr2 << 10) | ((yCodes[base + 5] ?? yCodes[base + 4] ?? 0) << 20);
      const rowOffset = y * bytesPerRow + group * 16;
      const view = new DataView(data.buffer, data.byteOffset + rowOffset, 16);
      for (let word = 0; word < 4; word += 1) view.setUint32(word * 4, words[word], true);
    }
  }

  return {
    frame: { format: "v210", data, width, height, bytesPerRow, colorMatrix, colorRange },
    preview: { data: preview, width, height },
  };
}

/** Create a deterministic 10-bit v210 broadcast test slate from a published layout. */
export function generateTestSignalSlate(options = {}) {
  const { pattern, colorMatrix, colorRange, width, height } = validateOptions(options);
  const signal = createSignal(width, height, pattern);
  const encoded = encodeTestSignal(signal, width, height, colorMatrix, colorRange);
  const metadata = TEST_SIGNAL_METADATA[pattern];
  return {
    label: metadata.label,
    standard: metadata.standard,
    nativeColorMatrix: metadata.nativeColorMatrix,
    nativeColorRange: metadata.nativeColorRange,
    pattern,
    colorMatrix,
    colorRange,
    bitDepth: 10,
    frame: encoded.frame,
    preview: encoded.preview,
  };
}
