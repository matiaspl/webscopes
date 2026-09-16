export function v210BytesPerRow(width) {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("width must be a positive integer");
  return Math.ceil(width / 48) * 128;
}

function normalizeModeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/^bmdmode/, "")
    .replace(/^hd/, "")
    .replace(/psf/g, "p")
    .replace(/[^a-z0-9]/g, "");
}

export function listTenBitModes(device, macadam, deviceId) {
  const modesByName = new Map();
  for (const [name, code] of Object.entries(macadam)) {
    if (!name.startsWith("bmdMode") || name === "bmdModeUnknown" || !Number.isInteger(code)) continue;
    const width = macadam.modeWidth(code);
    const height = macadam.modeHeight(code);
    if (width > 0 && height > 0) modesByName.set(normalizeModeName(name), { code, width, height });
  }

  const formats = [];
  for (const inputMode of device.inputDisplayModes ?? []) {
    if (!inputMode.videoModes?.includes("10-bit YUV")) continue;
    const normalizedInputName = normalizeModeName(inputMode.name);
    let match = modesByName.get(normalizedInputName);
    if (!match) {
      const suffixMatches = [...modesByName.entries()]
        .filter(([name, candidate]) => candidate.width === inputMode.width
          && candidate.height === inputMode.height
          && (normalizedInputName.endsWith(name) || name.endsWith(normalizedInputName)));
      if (suffixMatches.length === 1) match = suffixMatches[0][1];
    }
    if (!match || match.width !== inputMode.width || match.height !== inputMode.height) continue;
    const [frameDuration, frameScale] = inputMode.frameRate ?? [];
    const fps = frameDuration > 0 ? frameScale / frameDuration : 0;
    const interlaced = /(?:^|[^a-z])i(?:[^a-z]|\d)/i.test(inputMode.name);
    const scanLabel = interlaced ? " · interlaced" : "";
    const key = String(match.code);
    if (formats.some((format) => format.key === key)) continue;
    formats.push({
      key,
      displayMode: match.code,
      width: match.width,
      height: match.height,
      frameDuration,
      frameScale,
      label: `${inputMode.name} · ${match.width}×${match.height} · ${fps.toFixed(fps % 1 ? 3 : 0)} fps${scanLabel}`,
    });
  }
  return formats;
}

export function makeV210Preview(data, width, height, bytesPerRow, options = {}) {
  const minimumRowBytes = v210BytesPerRow(width);
  if (!ArrayBuffer.isView(data) || bytesPerRow < minimumRowBytes || data.byteLength < bytesPerRow * height) {
    throw new RangeError("DeckLink returned an incomplete v210 frame.");
  }

  const maxWidth = options.maxWidth ?? 960;
  const maxHeight = options.maxHeight ?? 540;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const previewWidth = Math.max(1, Math.round(width * scale));
  const previewHeight = Math.max(1, Math.round(height * scale));
  const rgba = new Uint8ClampedArray(previewWidth * previewHeight * 4);
  const bytes = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const matrix = options.colorMatrix ?? "bt709";
  const range = options.colorRange ?? "limited";
  const coefficients = matrix === "bt601"
    ? [1.402, 0.344136, 0.714136, 1.772]
    : matrix === "bt2020" || matrix === "bt2100"
      ? [1.4746, 0.164553, 0.571353, 1.8814]
      : [1.5748, 0.187324, 0.468124, 1.8556];

  for (let y = 0; y < previewHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / previewHeight));
    const rowOffset = sourceY * bytesPerRow;
    for (let x = 0; x < previewWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / previewWidth));
      const group = Math.floor(sourceX / 6);
      const pixel = sourceX % 6;
      const offset = rowOffset + group * 16;
      const word0 = bytes.getUint32(offset, true);
      const word1 = bytes.getUint32(offset + 4, true);
      const word2 = bytes.getUint32(offset + 8, true);
      const word3 = bytes.getUint32(offset + 12, true);
      const luma = [
        (word0 >>> 10) & 1023,
        word1 & 1023,
        (word1 >>> 20) & 1023,
        (word2 >>> 10) & 1023,
        word3 & 1023,
        (word3 >>> 20) & 1023,
      ][pixel];
      const chromaPair = Math.floor(pixel / 2);
      const cb = [word0 & 1023, (word1 >>> 10) & 1023, (word2 >>> 20) & 1023][chromaPair];
      const cr = [(word0 >>> 20) & 1023, word2 & 1023, (word3 >>> 10) & 1023][chromaPair];
      const yy = range === "full" ? luma / 1023 : (luma - 64) / 876;
      const cbOffset = (cb - 512) / (range === "full" ? 1023 : 896);
      const crOffset = (cr - 512) / (range === "full" ? 1023 : 896);
      const [redCr, greenCb, greenCr, blueCb] = coefficients;
      const destination = (y * previewWidth + x) * 4;
      rgba[destination] = Math.round(255 * Math.max(0, Math.min(1, yy + redCr * crOffset)));
      rgba[destination + 1] = Math.round(255 * Math.max(0, Math.min(1, yy - greenCb * cbOffset - greenCr * crOffset)));
      rgba[destination + 2] = Math.round(255 * Math.max(0, Math.min(1, yy + blueCb * cbOffset)));
      rgba[destination + 3] = 255;
    }
  }

  return { width: previewWidth, height: previewHeight, data: rgba };
}
