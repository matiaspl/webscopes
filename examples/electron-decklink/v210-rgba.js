// Store v210 as opaque RGBA pixels. RGB is a byte container, not a rendered
// representation of the captured image. Alpha stays opaque so an image path
// cannot destroy payload bytes by premultiplying arbitrary alpha values.
export function packedRgbaWidth(v210BytesPerRow) {
  if (!Number.isSafeInteger(v210BytesPerRow) || v210BytesPerRow < 16 || v210BytesPerRow % 4 !== 0) {
    throw new RangeError("v210BytesPerRow must be a positive multiple of four");
  }
  return Math.ceil(v210BytesPerRow / 3);
}

const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;

export function packV210ToRgba(data, width, height, v210BytesPerRow, reuse) {
  if (!(data instanceof Uint8Array)) throw new TypeError("v210 data must be Uint8Array");
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("v210 dimensions must be positive integers");
  }
  const minimumRowBytes = Math.ceil(width / 6) * 16;
  const rgbaWidth = packedRgbaWidth(v210BytesPerRow);
  if (v210BytesPerRow < minimumRowBytes || !Number.isSafeInteger(v210BytesPerRow * height)
    || data.byteLength < v210BytesPerRow * height) {
    throw new RangeError("v210 data is truncated or its row stride is invalid");
  }
  const rgbaBytesPerRow = rgbaWidth * 4;
  const rgbaByteLength = rgbaBytesPerRow * height;
  if (!Number.isSafeInteger(rgbaByteLength)) throw new RangeError("RGBA texture is too large");
  const output = reuse instanceof Uint8Array && reuse.byteLength >= rgbaByteLength
    ? reuse.subarray(0, rgbaByteLength) : new Uint8Array(rgbaByteLength);
  const words = littleEndian && output.byteOffset % 4 === 0
    ? new Uint32Array(output.buffer, output.byteOffset, rgbaByteLength / 4) : null;
  for (let y = 0; y < height; y++) {
    const srcRow = y * v210BytesPerRow;
    const dstRow = y * rgbaBytesPerRow;
    const completePixels = Math.floor(v210BytesPerRow / 3);
    for (let x = 0; x < completePixels; x++) {
      const src = srcRow + x * 3;
      const dst = dstRow + x * 4;
      const r = data[src];
      const g = data[src + 1];
      const b = data[src + 2];
      if (words) words[dst / 4] = (r | (g << 8) | (b << 16) | 0xff000000) >>> 0;
      else { output[dst] = r; output[dst + 1] = g; output[dst + 2] = b; output[dst + 3] = 255; }
    }
    if (completePixels < rgbaWidth) {
      const src = srcRow + completePixels * 3;
      const dst = dstRow + completePixels * 4;
      const remaining = v210BytesPerRow - completePixels * 3;
      const r = data[src];
      const g = remaining === 2 ? data[src + 1] : 0;
      if (words) words[dst / 4] = (r | (g << 8) | 0xff000000) >>> 0;
      else { output[dst] = r; output[dst + 1] = g; output[dst + 2] = 0; output[dst + 3] = 255; }
    }
  }
  return { format: "rgba-v210-bytes", data: output, width: rgbaWidth, height,
    sourceWidth: width, v210BytesPerRow, rgbaBytesPerRow };
}

export function unpackV210FromRgba(frame, reuse) {
  const { data, width, height, sourceWidth, v210BytesPerRow, rgbaBytesPerRow = width * 4 } = frame ?? {};
  if (!(data instanceof Uint8Array)) throw new TypeError("RGBA data must be Uint8Array");
  if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(height) || height < 1
    || width !== packedRgbaWidth(v210BytesPerRow) || v210BytesPerRow < Math.ceil(sourceWidth / 6) * 16
    || !Number.isSafeInteger(v210BytesPerRow * height) || rgbaBytesPerRow < width * 4
    || data.byteLength < rgbaBytesPerRow * height) {
    throw new RangeError("Packed RGBA dimensions or row stride are invalid");
  }
  const byteLength = v210BytesPerRow * height;
  const output = reuse instanceof Uint8Array && reuse.byteLength >= byteLength
    ? reuse.subarray(0, byteLength) : new Uint8Array(byteLength);
  for (let y = 0; y < height; y++) {
    const srcRow = y * rgbaBytesPerRow;
    const dstRow = y * v210BytesPerRow;
    for (let byte = 0; byte < v210BytesPerRow; byte++) {
      const pixel = Math.floor(byte / 3);
      output[dstRow + byte] = data[srcRow + pixel * 4 + byte % 3];
    }
  }
  return { format: "v210", data: output, width: sourceWidth, height, bytesPerRow: v210BytesPerRow };
}
