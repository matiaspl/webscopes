const FIXED_SCALE = 1024;
const COLOR_MATRICES = Object.freeze({
  bt601: { kr: 0.299, kb: 0.114, krFixed: 306, kbFixed: 117 },
  bt709: { kr: 0.2126, kb: 0.0722, krFixed: 218, kbFixed: 74 },
  bt2020: { kr: 0.2627, kb: 0.0593, krFixed: 269, kbFixed: 61 },
  // BT.2100 non-constant-luminance uses the BT.2020 YCbCr coefficients.
  bt2100: { kr: 0.2627, kb: 0.0593, krFixed: 269, kbFixed: 61 },
});

export function getColorMatrix(name = "bt709") {
  if (!Object.hasOwn(COLOR_MATRICES, name)) throw new RangeError(`Unsupported color matrix: ${name}`);
  const matrix = COLOR_MATRICES[name];
  return matrix;
}

export function getSourceSize(source) {
  const width = source?.displayWidth ?? source?.videoWidth ?? source?.naturalWidth ?? source?.width;
  const height = source?.displayHeight ?? source?.videoHeight ?? source?.naturalHeight ?? source?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError("Frame must expose positive integer width and height");
  }
  return { width, height };
}

function normalizedOptions(sourceWidth, sourceHeight, options) {
  const bitDepth = Number(options.bitDepth ?? 8);
  if (![8, 10, 12].includes(bitDepth)) {
    throw new RangeError("bitDepth must be 8, 10, or 12");
  }
  const colorRange = options.colorRange ?? "limited";
  if (colorRange !== "limited" && colorRange !== "full") {
    throw new RangeError("colorRange must be \"limited\" or \"full\"");
  }
  const region = options.region ?? {
    x: options.inputRegionX0 ?? 0,
    y: options.inputRegionY0 ?? 0,
    width: (options.inputRegionX1 ?? 1) - (options.inputRegionX0 ?? 0),
    height: (options.inputRegionY1 ?? 1) - (options.inputRegionY0 ?? 0),
  };
  const x = Number(region.x ?? 0);
  const y = Number(region.y ?? 0);
  const width = Number(region.width ?? 1);
  const height = Number(region.height ?? 1);
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new RangeError("region must be a positive rectangle in normalized 0..1 coordinates");
  }

  const x0 = Math.floor(x * sourceWidth);
  const y0 = Math.floor(y * sourceHeight);
  const x1 = Math.min(sourceWidth, Math.ceil((x + width) * sourceWidth));
  const y1 = Math.min(sourceHeight, Math.ceil((y + height) * sourceHeight));
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  const inputResolutionScaling = Number(options.inputResolutionScaling ?? 1);
  if (!Number.isFinite(inputResolutionScaling) || inputResolutionScaling <= 0 || inputResolutionScaling > 1) {
    throw new RangeError("inputResolutionScaling must be in the range (0, 1]");
  }
  const sampleWidth = Math.max(1, Math.ceil(cropWidth * inputResolutionScaling));
  const sampleHeight = Math.max(1, Math.ceil(cropHeight * inputResolutionScaling));
  const boundedInteger = (name, value, fallback, minimum, maximum) => {
    const number = Number(value ?? fallback);
    if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be a positive finite number`);
    return Math.max(minimum, Math.min(maximum, Math.floor(number)));
  };
  const waveformWidth = boundedInteger("waveformWidth", options.waveformWidth, Math.min(cropWidth, 1024), 1, 4096);
  const waveformHeight = boundedInteger("waveformHeight", options.waveformHeight, 2 ** bitDepth, 16, 4096);
  const vectorscopeSize = boundedInteger("vectorscopeSize", options.vectorscopeSize, 256, 64, 1024);
  const waveformMode = options.waveformMode ?? "rgb-parade";
  if (!["rgb", "rgb-parade", "luma", "ycbcr-parade", "composite"].includes(waveformMode)) {
    throw new RangeError(`Unsupported waveformMode: ${waveformMode}`);
  }
  const colorMatrix = options.colorMatrix ?? "bt709";
  const { kr, kb, krFixed, kbFixed } = getColorMatrix(colorMatrix);

  return {
    x0, y0, cropWidth, cropHeight, sampleWidth, sampleHeight, waveformWidth, waveformHeight,
    vectorscopeSize, waveformMode, colorMatrix, kr, kb, krFixed, kbFixed, bitDepth, colorRange,
  };
}

export function isRawPixelFrame(frame) {
  return frame != null && (frame.data != null || isV210Frame(frame))
    && Number.isInteger(frame.width) && Number.isInteger(frame.height);
}

export function isV210Frame(frame) {
  return frame?.format === "v210";
}

export function readFramePixels(frame, reusableCapture) {
  if (isRawPixelFrame(frame)) return frame;
  const { width, height } = getSourceSize(frame);
  const capture = reusableCapture ?? {};
  let canvas = capture.canvas;
  if (!canvas) {
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(width, height);
    } else if (typeof document !== "undefined") {
      canvas = document.createElement("canvas");
    } else {
      throw new TypeError("CPU analysis needs RGBA pixel data or a browser canvas source");
    }
    capture.canvas = canvas;
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = capture.context ?? canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create a 2D canvas context for CPU analysis");
  capture.context = context;
  context.drawImage(frame, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/**
 * Read a browser source without allocating a new ImageData object on every
 * frame when WebCodecs is available. The destination RGBA buffer is reused by
 * the real-time analyzer and is safe to recycle because createScopes awaits
 * each CPU analysis before accepting the next one.
 */
export async function readFramePixelsAsync(frame, reusableCapture = {}) {
  if (isRawPixelFrame(frame)) return frame;
  if (reusableCapture.videoFrameReadback !== false && typeof globalThis.VideoFrame === "function") {
    let videoFrame;
    let ownsVideoFrame = false;
    try {
      if (frame instanceof globalThis.VideoFrame) videoFrame = frame;
      else {
        videoFrame = new globalThis.VideoFrame(frame, { timestamp: 0 });
        ownsVideoFrame = true;
      }
      const width = videoFrame.displayWidth ?? videoFrame.codedWidth;
      const height = videoFrame.displayHeight ?? videoFrame.codedHeight;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new TypeError("VideoFrame must expose positive integer display dimensions");
      }
      const byteLength = width * height * 4;
      if (!(reusableCapture.data instanceof Uint8Array) || reusableCapture.data.byteLength !== byteLength) {
        reusableCapture.data = new Uint8Array(byteLength);
      }
      await videoFrame.copyTo(reusableCapture.data, { format: "RGBA" });
      return { width, height, data: reusableCapture.data };
    } catch {
      // Some browsers expose VideoFrame but do not support constructing one
      // from this CanvasImageSource or copying it as RGBA. Avoid retrying the
      // unsupported path for every live frame and use the canvas fallback.
      reusableCapture.videoFrameReadback = false;
    } finally {
      if (ownsVideoFrame) videoFrame?.close();
    }
  }
  return readFramePixels(frame, reusableCapture);
}

function validatePixelLayout(pixels) {
  const { width, height, data } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError("Expected an RGBA pixel frame with positive integer dimensions");
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray || data instanceof Uint16Array
    || data instanceof Float32Array || data instanceof Float64Array)) {
    throw new TypeError("Pixel data must be a supported typed array");
  }
  const bytesPerElement = data.BYTES_PER_ELEMENT;
  const pixelStride = pixels.pixelStride ?? 4;
  if (!Number.isSafeInteger(pixelStride) || pixelStride < 4) {
    throw new RangeError("pixelStride must be an integer of at least 4 elements");
  }
  const minimumRowBytes = width * pixelStride * bytesPerElement;
  const bytesPerRow = pixels.bytesPerRow ?? minimumRowBytes;
  if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow < minimumRowBytes || bytesPerRow % bytesPerElement !== 0) {
    throw new RangeError("bytesPerRow must be an aligned integer large enough for the frame");
  }
  const rowStride = bytesPerRow / bytesPerElement;
  const lastRequiredElement = (height - 1) * rowStride + (width - 1) * pixelStride + 3;
  if (!Number.isSafeInteger(lastRequiredElement) || lastRequiredElement >= data.length) {
    throw new TypeError("Expected an RGBA pixel frame; data is truncated before the final component");
  }
  return { rowStride, pixelStride };
}

function validateV210Layout(frame) {
  const { width, height, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError("Expected a v210 frame with positive integer dimensions");
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
    throw new TypeError("v210 data must be a Uint8Array or Uint8ClampedArray");
  }
  const minimumRowBytes = Math.ceil(width / 6) * 16;
  // The v210 row convention pads to 48 pixels / 128 bytes. Callers with a
  // tightly packed buffer can pass its actual stride explicitly.
  const defaultRowBytes = Math.ceil(width / 48) * 128;
  const bytesPerRow = frame.bytesPerRow ?? defaultRowBytes;
  if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow < minimumRowBytes) {
    throw new RangeError("bytesPerRow must be an integer large enough for the v210 row");
  }
  const lastRequiredByte = (height - 1) * bytesPerRow + minimumRowBytes;
  if (!Number.isSafeInteger(lastRequiredByte) || lastRequiredByte > data.byteLength) {
    throw new TypeError("Expected a v210 frame; data is truncated before the final row");
  }
  return { bytesPerRow };
}

function readLittleEndianWord(data, offset) {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function decodeV210Group(data, offset, y, cb, cr) {
  const word0 = readLittleEndianWord(data, offset);
  const word1 = readLittleEndianWord(data, offset + 4);
  const word2 = readLittleEndianWord(data, offset + 8);
  const word3 = readLittleEndianWord(data, offset + 12);

  cb[0] = word0 & 0x3ff;
  y[0] = (word0 >>> 10) & 0x3ff;
  cr[0] = (word0 >>> 20) & 0x3ff;
  y[1] = word1 & 0x3ff;
  cb[1] = (word1 >>> 10) & 0x3ff;
  y[2] = (word1 >>> 20) & 0x3ff;
  cr[1] = word2 & 0x3ff;
  y[3] = (word2 >>> 10) & 0x3ff;
  cb[2] = (word2 >>> 20) & 0x3ff;
  y[4] = word3 & 0x3ff;
  cr[2] = (word3 >>> 10) & 0x3ff;
  y[5] = (word3 >>> 20) & 0x3ff;
}

function analyzeV210Frame(frame, config, startedAt) {
  const { bytesPerRow } = validateV210Layout(frame);
  const {
    width, height, data,
  } = frame;
  const {
    x0, y0, cropWidth, cropHeight, sampleWidth, sampleHeight, waveformWidth, waveformHeight,
    vectorscopeSize, waveformMode, colorMatrix, kr, kb, bitDepth, colorRange,
  } = config;
  if (bitDepth !== 10) throw new RangeError("v210 frames have a fixed bit depth of 10");

  const channelCount = waveformMode === "luma" || waveformMode === "composite" ? 1 : 3;
  const channels = Array.from({ length: channelCount }, () => new Uint32Array(waveformWidth * waveformHeight));
  const vectorscope = new Uint32Array(vectorscopeSize * vectorscopeSize);
  const yValues = new Uint16Array(6);
  const cbValues = new Uint16Array(3);
  const crValues = new Uint16Array(3);
  const yScale = waveformHeight - 1;
  const xScale = waveformWidth / sampleWidth;
  const vecScale = vectorscopeSize - 1;
  const yOffset = colorRange === "limited" ? 64 : 0;
  const yRange = colorRange === "limited" ? 876 : 1023;
  const chromaRange = colorRange === "limited" ? 896 : 1023;
  const channelNames = waveformMode === "luma" ? ["Y"]
    : waveformMode === "ycbcr-parade" ? ["Y", "Cb", "Cr"]
      : waveformMode === "composite" ? ["Composite"] : ["R", "G", "B"];
  let sampleCount = 0;
  let clippedLow = 0;
  let clippedHigh = 0;

  for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
    const sy = sampleHeight === cropHeight ? sampleY : sampledCoordinate(sampleY, cropHeight, sampleHeight);
    const rowOffset = (y0 + sy) * bytesPerRow;
    let decodedGroup = -1;
    for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
      const sx = sampleWidth === cropWidth ? sampleX : sampledCoordinate(sampleX, cropWidth, sampleWidth);
      const sourceX = x0 + sx;
      const group = Math.floor(sourceX / 6);
      if (group !== decodedGroup) {
        decodeV210Group(data, rowOffset + group * 16, yValues, cbValues, crValues);
        decodedGroup = group;
      }

      const yCode = yValues[sourceX % 6];
      const cbCode = cbValues[(sourceX % 6) >> 1];
      const crCode = crValues[(sourceX % 6) >> 1];
      const y = (yCode - yOffset) / yRange;
      const cb = (cbCode - 512) / chromaRange;
      const cr = (crCode - 512) / chromaRange;
      const redUnclipped = y + cr * 2 * (1 - kr);
      const blueUnclipped = y + cb * 2 * (1 - kb);
      const greenUnclipped = (y - kr * redUnclipped - kb * blueUnclipped) / (1 - kr - kb);
      const red = Math.min(1, Math.max(0, redUnclipped));
      const green = Math.min(1, Math.max(0, greenUnclipped));
      const blue = Math.min(1, Math.max(0, blueUnclipped));
      const column = Math.min(waveformWidth - 1, Math.floor(sampleX * xScale));
      const yCodeBin = Math.min(yScale, Math.round(yCode * yScale / 1023));
      const cbCodeBin = Math.min(yScale, Math.round(cbCode * yScale / 1023));
      const crCodeBin = Math.min(yScale, Math.round(crCode * yScale / 1023));
      const compositeValue = compositeWaveformValue(yCodeBin, cbCodeBin, crCodeBin, yScale, sourceX);
      const vectorX = Math.min(vecScale, Math.max(0, Math.round((cb + 0.5) * vecScale)));
      const vectorY = Math.min(vecScale, Math.max(0, Math.round((0.5 - cr) * vecScale)));
      vectorscope[vectorY * vectorscopeSize + vectorX] += 1;

      if (waveformMode === "luma") {
        channels[0][yCodeBin * waveformWidth + column] += 1;
      } else if (waveformMode === "ycbcr-parade") {
        channels[0][yCodeBin * waveformWidth + column] += 1;
        channels[1][cbCodeBin * waveformWidth + column] += 1;
        channels[2][crCodeBin * waveformWidth + column] += 1;
      } else if (waveformMode === "composite") {
        channels[0][compositeValue * waveformWidth + column] += 1;
      } else {
        channels[0][Math.round(red * yScale) * waveformWidth + column] += 1;
        channels[1][Math.round(green * yScale) * waveformWidth + column] += 1;
        channels[2][Math.round(blue * yScale) * waveformWidth + column] += 1;
      }
      sampleCount += 1;
      if (y <= 1 / 1023) clippedLow += 1;
      if (y >= 1022 / 1023) clippedHigh += 1;
    }
  }

  const frameTimeMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
  return {
    width,
    height,
    sampleCount,
    waveform: { width: waveformWidth, height: waveformHeight, bitDepth, mode: waveformMode, channelNames, channels },
    vectorscope: { width: vectorscopeSize, height: vectorscopeSize, bins: vectorscope, colorMatrix },
    stats: {
      clippedLow,
      clippedHigh,
      colorMatrix,
      colorRange,
      bitDepth,
      performance: {
        frameTimeMs,
        fps: frameTimeMs > 0 ? 1000 / frameTimeMs : 0,
        averageFrameTimeMs: frameTimeMs,
        averageFps: frameTimeMs > 0 ? 1000 / frameTimeMs : 0,
      },
    },
  };
}

function roundProductRatio(value, scale, denominator) {
  return Math.floor((value * scale + denominator / 2) / denominator);
}

// A composite scope is an active-picture quadrature view. It uses a
// deterministic four-sample subcarrier phase so Y, U, and V modulation are
// visible in one waveform without inventing sync or blanking intervals.
function compositeWaveformValue(yValue, cbValue, crValue, yScale, sourceX) {
  const chromaCenter = yScale / 2;
  let modulation = crValue - chromaCenter;
  switch (sourceX & 3) {
    case 1: modulation = cbValue - chromaCenter; break;
    case 2: modulation = chromaCenter - crValue; break;
    case 3: modulation = chromaCenter - cbValue; break;
    default: break;
  }
  return Math.max(0, Math.min(yScale, Math.round(yValue + modulation * 0.5)));
}

function sampledCoordinate(index, cropSize, sampleSize) {
  if (sampleSize <= 1) return 0;
  const numerator = index * (cropSize - 1);
  const denominator = sampleSize - 1;
  const whole = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  return whole + (remainder * 2 >= denominator ? 1 : 0);
}

function validateSampledRgb(data, config, rowStride, pixelStride) {
  if (!(data instanceof Float32Array || data instanceof Float64Array)) return;
  const { x0, y0, cropWidth, cropHeight, sampleWidth, sampleHeight } = config;
  for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
    const sy = sampleHeight === cropHeight ? sampleY : sampledCoordinate(sampleY, cropHeight, sampleHeight);
    const row = (y0 + sy) * rowStride;
    for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
      const sx = sampleWidth === cropWidth ? sampleX : sampledCoordinate(sampleX, cropWidth, sampleWidth);
      const offset = row + (x0 + sx) * pixelStride;
      if (!Number.isFinite(data[offset]) || !Number.isFinite(data[offset + 1]) || !Number.isFinite(data[offset + 2])) {
        throw new TypeError("Sampled RGB values must be finite numbers");
      }
    }
  }
}

/** Analyze interleaved RGBA pixels into waveform and vectorscope histograms. */
export function analyzeFrame(frame, options = {}) {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const pixels = readFramePixels(frame);
  const { width, height, data } = pixels;
  const inputBitDepth = options.bitDepth ?? pixels.bitDepth ?? (isV210Frame(pixels) ? 10 : undefined);
  if (data instanceof Uint16Array && inputBitDepth === undefined) {
    throw new RangeError("bitDepth is required for Uint16Array pixel data");
  }
  const config = normalizedOptions(width, height, {
    ...options,
    bitDepth: inputBitDepth,
    colorMatrix: options.colorMatrix ?? pixels.colorMatrix,
    colorRange: options.colorRange ?? pixels.colorRange,
  });
  if (isV210Frame(pixels)) return analyzeV210Frame(pixels, config, startedAt);

  const { rowStride, pixelStride } = validatePixelLayout(pixels);
  if (inputBitDepth > 8 && !(data instanceof Uint16Array) && !(data instanceof Float32Array) && !(data instanceof Float64Array)) {
    throw new TypeError("10-bit and 12-bit integer pixels must use Uint16Array data");
  }
  validateSampledRgb(data, config, rowStride, pixelStride);

  const {
    x0, y0, cropWidth, cropHeight, sampleWidth, sampleHeight, waveformWidth, waveformHeight,
    vectorscopeSize, waveformMode, colorMatrix, kr, kb, krFixed, kbFixed, bitDepth,
  } = config;
  const channelCount = waveformMode === "luma" || waveformMode === "composite" ? 1 : 3;
  const channels = Array.from({ length: channelCount }, () => new Uint32Array(waveformWidth * waveformHeight));
  const vectorscope = new Uint32Array(vectorscopeSize * vectorscopeSize);

  const yScale = waveformHeight - 1;
  const xScale = waveformWidth / sampleWidth;
  const vecScale = vectorscopeSize - 1;
  const krDiv = 2 * (1 - kr);
  const kbDiv = 2 * (1 - kb);
  const floating = data instanceof Float32Array || data instanceof Float64Array;
  const fixedEightBit = !floating && data.BYTES_PER_ELEMENT === 1;
  const codeMax = 2 ** bitDepth - 1;
  const divisor = floating ? 1 : codeMax;
  const yDenominatorFixed = 255 * FIXED_SCALE;
  const kgFixed = FIXED_SCALE - krFixed - kbFixed;
  let sampleCount = 0;
  let clippedLow = 0;
  let clippedHigh = 0;

  for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
    const sy = sampleHeight === cropHeight ? sampleY : sampledCoordinate(sampleY, cropHeight, sampleHeight);
    const row = (y0 + sy) * rowStride;
    for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
      const sx = sampleWidth === cropWidth ? sampleX : sampledCoordinate(sampleX, cropWidth, sampleWidth);
      const offset = row + (x0 + sx) * pixelStride;
      const rawR = data[offset];
      const rawG = data[offset + 1];
      const rawB = data[offset + 2];
      const r = Math.min(1, Math.max(0, rawR / divisor));
      const g = Math.min(1, Math.max(0, rawG / divisor));
      const b = Math.min(1, Math.max(0, rawB / divisor));
      const column = Math.min(waveformWidth - 1, Math.floor(sampleX * xScale));
      let luma;
      let cb;
      let cr;
      let yValue;
      let cbValue;
      let crValue;
      let rValue;
      let gValue;
      let bValue;
      if (fixedEightBit) {
        const red = Math.min(255, Math.max(0, rawR));
        const green = Math.min(255, Math.max(0, rawG));
        const blue = Math.min(255, Math.max(0, rawB));
        const yNumerator = krFixed * red + kgFixed * green + kbFixed * blue;
        const cbDenominator = 510 * (FIXED_SCALE - kbFixed);
        const crDenominator = 510 * (FIXED_SCALE - krFixed);
        const cbNumerator = 255 * (FIXED_SCALE - kbFixed) + blue * FIXED_SCALE - yNumerator;
        const crNumerator = 255 * (FIXED_SCALE - krFixed) + red * FIXED_SCALE - yNumerator;
        yValue = roundProductRatio(yNumerator, yScale, yDenominatorFixed);
        cbValue = roundProductRatio(cbNumerator, yScale, cbDenominator);
        crValue = roundProductRatio(crNumerator, yScale, crDenominator);
        const vectorX = Math.min(vecScale, roundProductRatio(cbNumerator, vecScale, cbDenominator));
        const vectorY = Math.min(vecScale, roundProductRatio(crDenominator - crNumerator, vecScale, crDenominator));
        vectorscope[vectorY * vectorscopeSize + vectorX] += 1;
        luma = yNumerator / yDenominatorFixed;
        cb = cbNumerator / cbDenominator - 0.5;
        cr = crNumerator / crDenominator - 0.5;
        rValue = roundProductRatio(red, yScale, 255);
        gValue = roundProductRatio(green, yScale, 255);
        bValue = roundProductRatio(blue, yScale, 255);
      } else {
        luma = kr * r + (1 - kr - kb) * g + kb * b;
        cb = (b - luma) / kbDiv;
        cr = (r - luma) / krDiv;
        yValue = Math.min(yScale, Math.round(luma * yScale));
        cbValue = Math.min(yScale, Math.max(0, Math.round((cb + 0.5) * yScale)));
        crValue = Math.min(yScale, Math.max(0, Math.round((cr + 0.5) * yScale)));
        rValue = Math.min(yScale, Math.max(0, Math.round(r * yScale)));
        gValue = Math.min(yScale, Math.max(0, Math.round(g * yScale)));
        bValue = Math.min(yScale, Math.max(0, Math.round(b * yScale)));
        const vectorX = Math.min(vecScale, Math.max(0, Math.round((cb + 0.5) * vecScale)));
        const vectorY = Math.min(vecScale, Math.max(0, Math.round((0.5 - cr) * vecScale)));
        vectorscope[vectorY * vectorscopeSize + vectorX] += 1;
      }

      const compositeValue = compositeWaveformValue(yValue, cbValue, crValue, yScale, x0 + sx);

      if (waveformMode === "luma") {
        channels[0][yValue * waveformWidth + column] += 1;
      } else if (waveformMode === "ycbcr-parade") {
        channels[0][yValue * waveformWidth + column] += 1;
        channels[1][cbValue * waveformWidth + column] += 1;
        channels[2][crValue * waveformWidth + column] += 1;
      } else if (waveformMode === "composite") {
        channels[0][compositeValue * waveformWidth + column] += 1;
      } else {
        channels[0][rValue * waveformWidth + column] += 1;
        channels[1][gValue * waveformWidth + column] += 1;
        channels[2][bValue * waveformWidth + column] += 1;
      }
      sampleCount += 1;
      if (fixedEightBit ? luma <= 1 / 255 : luma <= 1 / codeMax) clippedLow += 1;
      if (fixedEightBit ? luma >= 254 / 255 : luma >= (codeMax - 1) / codeMax) clippedHigh += 1;
    }
  }

  const channelNames = waveformMode === "luma" ? ["Y"]
    : waveformMode === "ycbcr-parade" ? ["Y", "Cb", "Cr"]
      : waveformMode === "composite" ? ["Composite"] : ["R", "G", "B"];
  const frameTimeMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
  return {
    width,
    height,
    sampleCount,
    waveform: { width: waveformWidth, height: waveformHeight, bitDepth, mode: waveformMode, channelNames, channels },
    vectorscope: { width: vectorscopeSize, height: vectorscopeSize, bins: vectorscope, colorMatrix },
    stats: {
      clippedLow,
      clippedHigh,
      colorMatrix,
      bitDepth,
      performance: {
        frameTimeMs,
        fps: frameTimeMs > 0 ? 1000 / frameTimeMs : 0,
        averageFrameTimeMs: frameTimeMs,
        averageFps: frameTimeMs > 0 ? 1000 / frameTimeMs : 0,
      },
    },
  };
}

export { normalizedOptions as normalizeAnalysisOptions };
