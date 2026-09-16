const COLORS = {
  background: "#080d13",
  grid: "rgba(176, 196, 214, 0.22)",
  gridSoft: "rgba(176, 196, 214, 0.10)",
  text: "#a9bbc9",
  R: [255, 62, 72],
  G: [62, 238, 133],
  B: [72, 146, 255],
  Y: [255, 222, 92],
  Cb: [66, 195, 255],
  Cr: [255, 101, 119],
  Composite: [255, 222, 92],
};
const DITHER_TILE_SIZE = 256;
const DITHER_TILE = (() => {
  const tile = new Float32Array(DITHER_TILE_SIZE * DITHER_TILE_SIZE);
  let state = 0x6d2b79f5;
  for (let index = 0; index < tile.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    tile[index] = (state >>> 0) / 0xffffffff * 2 - 1;
  }
  return tile;
})();
const COVERAGE_CACHE = new Map();
const INTENSITY_CACHE = new Map();
const IMAGE_CACHE = new WeakMap();
const MAX_COVERAGE_CACHE_ENTRIES = 32;
const MAX_IMAGE_CACHE_ENTRIES = 4;
const MAX_INTENSITY_TABLE_SIZE = 65536;

function colorFor(name) {
  return COLORS[name] ?? COLORS.Y;
}

function cssColorFor(name) {
  const color = colorFor(name);
  return Array.isArray(color) ? `rgb(${color[0]} ${color[1]} ${color[2]})` : color;
}

function chartImage(context, width, height) {
  let images = IMAGE_CACHE.get(context);
  if (!images) {
    images = new Map();
    IMAGE_CACHE.set(context, images);
  }
  const key = `${width}x${height}`;
  let image = images.get(key);
  if (!image) {
    if (images.size >= MAX_IMAGE_CACHE_ENTRIES) images.delete(images.keys().next().value);
    image = context.createImageData(width, height);
    images.set(key, image);
  }
  const data = image.data;
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 8;
    data[offset + 1] = 13;
    data[offset + 2] = 19;
    data[offset + 3] = 255;
  }
  return image;
}

function writeDitheredPixel(data, offset, red, green, blue, x, y, strength) {
  const tileIndex = ((y & (DITHER_TILE_SIZE - 1)) * DITHER_TILE_SIZE) + (x & (DITHER_TILE_SIZE - 1));
  const noise = strength > 0 ? DITHER_TILE[tileIndex] * strength : 0;
  if (red !== 8) red = Math.max(0, red + noise);
  if (green !== 13) green = Math.max(0, green + noise);
  if (blue !== 19) blue = Math.max(0, blue + noise);
  // Keep the accumulated intensity fractional until this final ImageData write.
  data[offset] = red;
  data[offset + 1] = green;
  data[offset + 2] = blue;
}

function signalIntensity(count, gain) {
  return count <= 0 ? 0 : Math.min(1, Math.log1p(count * gain) / 2.2);
}

function intensityLookup(gain) {
  if (INTENSITY_CACHE.has(gain)) return INTENSITY_CACHE.get(gain);
  const table = new Float64Array(MAX_INTENSITY_TABLE_SIZE);
  for (let count = 1; count < table.length; count += 1) table[count] = signalIntensity(count, gain);
  INTENSITY_CACHE.set(gain, table);
  if (INTENSITY_CACHE.size > 4) INTENSITY_CACHE.delete(INTENSITY_CACHE.keys().next().value);
  return table;
}

function intensityFor(count, gain, table) {
  return count < table.length ? table[count] : signalIntensity(count, gain);
}

function coverageRange(sourceLength, start, end) {
  const left = Math.max(0, Math.min(sourceLength, start));
  const right = Math.max(left, Math.min(sourceLength, end));
  const entries = [];
  for (let index = Math.floor(left); index < Math.ceil(right); index += 1) {
    const weight = Math.min(right, index + 1) - Math.max(left, index);
    if (weight > 0) entries.push({ index, weight });
  }
  return { entries, coverage: right - left };
}

function cachedCoverage(key, create) {
  if (COVERAGE_CACHE.has(key)) return COVERAGE_CACHE.get(key);
  const value = create();
  COVERAGE_CACHE.set(key, value);
  if (COVERAGE_CACHE.size > MAX_COVERAGE_CACHE_ENTRIES) {
    COVERAGE_CACHE.delete(COVERAGE_CACHE.keys().next().value);
  }
  return value;
}

function axisCoverage(sourceLength, targetLength, reverse = false) {
  return cachedCoverage(`axis:${sourceLength}:${targetLength}:${reverse ? 1 : 0}`, () => {
    if (targetLength > sourceLength) {
      // Sample neighboring histogram rows at display-pixel centers. The
      // previous fixed three-bin footprint made a single populated code row
      // become a broad horizontal stripe when the display was taller than the
      // histogram. This is display-only interpolation; the histogram remains
      // an exact integer accumulator.
      return Array.from({ length: targetLength }, (_, targetIndex) => {
        if (sourceLength <= 1) return { entries: [{ index: 0, weight: 1 }], coverage: 1 };
        const targetFraction = (targetIndex + 0.5) / targetLength;
        const sourceFraction = reverse ? 1 - targetFraction : targetFraction;
        const sourcePosition = Math.max(0, Math.min(sourceLength - 1, sourceFraction * sourceLength - 0.5));
        const first = Math.floor(sourcePosition);
        const second = Math.min(sourceLength - 1, first + 1);
        const fraction = sourcePosition - first;
        if (first === second) return { entries: [{ index: first, weight: 1 }], coverage: 1 };
        return {
          entries: [{ index: first, weight: 1 - fraction }, { index: second, weight: fraction }],
          coverage: 1,
        };
      });
    }
    return Array.from({ length: targetLength }, (_, targetIndex) => {
      let start = targetIndex * sourceLength / targetLength;
      let end = (targetIndex + 1) * sourceLength / targetLength;
      if (reverse) [start, end] = [sourceLength - end, sourceLength - start];
      return coverageRange(sourceLength, start, end);
    });
  });
}

function pointCoverage(sourceLength, fraction) {
  const index = Math.max(0, Math.min(sourceLength - 1, Math.floor(fraction * sourceLength)));
  return { entries: [{ index, weight: 1 }], coverage: 1 };
}

function filteredIntensity(channel, waveformWidth, xCoverage, yCoverage, gain, table) {
  let weightedIntensity = 0;
  for (const row of yCoverage.entries) {
    const rowOffset = row.index * waveformWidth;
    for (const column of xCoverage.entries) {
      const count = channel[rowOffset + column.index];
      if (count > 0) weightedIntensity += intensityFor(count, gain, table) * row.weight * column.weight;
    }
  }
  return weightedIntensity / (xCoverage.coverage * yCoverage.coverage);
}

function drawWaveformImage(context, waveform, x, y, width, height, gain, antialias, dither, dpr) {
  if (width < 1 || height < 1) return;
  const image = chartImage(context, width, height);
  const data = image.data;
  const mode = waveform.mode;
  const parade = mode === "rgb-parade" || mode === "ycbcr-parade";
  const paneWidth = width / 3;
  const horizontal = cachedCoverage(`wave-x:${waveform.width}:${width}:${parade ? 1 : 0}:${antialias ? 1 : 0}`, () => Array.from({ length: width }, (_, px) => {
    const pane = parade ? Math.min(2, Math.floor((px + 0.5) / paneWidth)) : 0;
    if (!antialias) {
      const localX = parade ? ((px + 0.5) - pane * paneWidth) / paneWidth : (px + 0.5) / width;
      return { pane, coverage: pointCoverage(waveform.width, localX) };
    }
    const paneLeft = parade ? pane * paneWidth : 0;
    const paneRight = parade ? paneLeft + paneWidth : width;
    const pixelLeft = Math.max(px, paneLeft);
    const pixelRight = Math.min(px + 1, paneRight);
    const localStart = parade ? (pixelLeft - paneLeft) / paneWidth : pixelLeft / width;
    const localEnd = parade ? (pixelRight - paneLeft) / paneWidth : pixelRight / width;
    return {
      pane,
      coverage: coverageRange(waveform.width, localStart * waveform.width, localEnd * waveform.width),
    };
  }));
  const vertical = antialias
    ? axisCoverage(waveform.height, height, true)
    : cachedCoverage(`wave-y-point:${waveform.height}:${height}`, () => Array.from({ length: height }, (_, py) => pointCoverage(waveform.height, (height - 1 - py) / height)));
  const table = intensityLookup(gain);

  for (let py = 0; py < height; py += 1) {
    const yCoverage = vertical[py];
    for (let px = 0; px < width; px += 1) {
      const { pane, coverage: xCoverage } = horizontal[px];
      const offset = (py * width + px) * 4;
      let red = 8;
      let green = 13;
      let blue = 19;
      if (mode === "rgb-parade" || mode === "ycbcr-parade") {
        const channel = waveform.channels[pane];
        const color = colorFor(waveform.channelNames[pane]);
        const amount = filteredIntensity(channel, waveform.width, xCoverage, yCoverage, gain, table);
        red += color[0] * amount;
        green += color[1] * amount;
        blue += color[2] * amount;
      } else if (mode === "luma" || mode === "composite") {
        const density = filteredIntensity(waveform.channels[0], waveform.width, xCoverage, yCoverage, gain, table);
        const color = colorFor(mode === "composite" ? "Composite" : "Y");
        red += color[0] * density;
        green += color[1] * density;
        blue += color[2] * density;
      } else {
        for (let channelIndex = 0; channelIndex < 3; channelIndex += 1) {
          const channel = waveform.channels[channelIndex];
          const name = waveform.channelNames[channelIndex];
          const density = filteredIntensity(channel, waveform.width, xCoverage, yCoverage, gain, table);
          const color = colorFor(name);
          red += color[0] * density;
          green += color[1] * density;
          blue += color[2] * density;
        }
      }
      writeDitheredPixel(data, offset, red, green, blue, px, py, dither);
    }
  }
  context.putImageData(image, x, y);

  context.save();
  context.strokeStyle = COLORS.grid;
  context.lineWidth = Math.max(1, dpr);
  context.setLineDash([4 * dpr, 5 * dpr]);
  context.fillStyle = COLORS.text;
  context.font = `${Math.max(9, Math.round(11 * dpr))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = "middle";
  const levels = [0, 0.25, 0.5, 0.75, 1];
  const codeMax = (2 ** (waveform.bitDepth ?? 8)) - 1;
  for (const level of levels) {
    const lineY = y + Math.round((1 - level) * height) + 0.5 * dpr;
    context.beginPath();
    context.moveTo(x, lineY);
    context.lineTo(x + width, lineY);
    context.stroke();
    if (width > 100) {
      const labelY = Math.max(y + 7 * dpr, Math.min(y + height - 7 * dpr, lineY - 7 * dpr));
      context.textAlign = "left";
      context.fillText(`${Math.round(level * 100)}%`, x + 5 * dpr, labelY);
      context.textAlign = "right";
      context.fillText(`${Math.round(level * codeMax)}`, x + width - 5 * dpr, labelY);
    }
  }
  if (mode === "rgb-parade" || mode === "ycbcr-parade") {
    context.setLineDash([]);
    for (let pane = 1; pane < 3; pane += 1) {
      const separator = x + (width * pane) / 3;
      context.strokeStyle = COLORS.gridSoft;
      context.beginPath();
      context.moveTo(separator + 0.5 * dpr, y);
      context.lineTo(separator + 0.5 * dpr, y + height);
      context.stroke();
    }
    const paneWidth = width / 3;
    for (let pane = 0; pane < 3; pane += 1) {
      context.fillStyle = cssColorFor(waveform.channelNames[pane]);
      context.fillText(waveform.channelNames[pane], x + paneWidth * pane + 8 * dpr, y + 14 * dpr);
    }
  }
  context.restore();
}

function chromaForRgb(r, g, b, kr, kb) {
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  return { cb: (b - y) / (2 * (1 - kb)), cr: (r - y) / (2 * (1 - kr)) };
}

function binRanges(binCount, pixelCount, plotStart, plotExtent) {
  return Array.from({ length: pixelCount }, (_, pixel) => {
    const left = Math.max(pixel, plotStart);
    const right = Math.min(pixel + 1, plotStart + plotExtent);
    if (right <= left) return { first: 1, last: 0 };
    const start = Math.max(0, Math.min(binCount - 1, (left - plotStart) / plotExtent * (binCount - 1)));
    const end = Math.max(0, Math.min(binCount - 1, (right - plotStart) / plotExtent * (binCount - 1)));
    return {
      first: Math.max(0, Math.floor(start)),
      last: Math.min(binCount - 1, Math.ceil(end)),
    };
  });
}

function drawVectorscope(context, vectorscope, x, y, width, height, gain, dither, dpr) {
  const size = Math.min(width, height);
  const left = x + Math.floor((width - size) / 2);
  const top = y + Math.floor((height - size) / 2);
  const image = chartImage(context, size, size);
  const data = image.data;
  const { bins, width: binsWidth, height: binsHeight } = vectorscope;
  const matrix = vectorscope.colorMatrix === "bt601" ? [0.299, 0.114]
    : vectorscope.colorMatrix === "bt2020" || vectorscope.colorMatrix === "bt2100" ? [0.2627, 0.0593] : [0.2126, 0.0722];
  const [kr, kb] = matrix;
  const kg = 1 - kr - kb;
  const center = (size - 1) / 2;
  const radius = size * 0.44;
  const plotStart = center - radius;
  const plotExtent = radius * 2;
  const xRanges = cachedCoverage(`vector-x:${binsWidth}:${size}`, () => binRanges(binsWidth, size, plotStart, plotExtent));
  const yRanges = cachedCoverage(`vector-y:${binsHeight}:${size}`, () => binRanges(binsHeight, size, plotStart, plotExtent));
  const table = intensityLookup(gain);
  for (let py = 0; py < size; py += 1) {
    const yRange = yRanges[py];
    if (yRange.last < yRange.first) continue;
    for (let px = 0; px < size; px += 1) {
      const xRange = xRanges[px];
      if (xRange.last < xRange.first) continue;
      let peakCount = 0;
      let peakX = 0;
      let peakY = 0;
      for (let by = yRange.first; by <= yRange.last; by += 1) {
        const rowOffset = by * binsWidth;
        for (let bx = xRange.first; bx <= xRange.last; bx += 1) {
          const count = bins[rowOffset + bx];
          if (count > peakCount) {
            peakCount = count;
            peakX = bx;
            peakY = by;
          }
        }
      }
      if (!peakCount) continue;
      const cb = peakX / (binsWidth - 1) - 0.5;
      const cr = 0.5 - peakY / (binsHeight - 1);
      const red = Math.max(0, Math.min(1, 0.5 + 2 * (1 - kr) * cr)) * 255;
      const blue = Math.max(0, Math.min(1, 0.5 + 2 * (1 - kb) * cb)) * 255;
      const green = Math.max(0, Math.min(1, (0.5 - kr * (red / 255) - kb * (blue / 255)) / kg)) * 255;
      const offset = (py * size + px) * 4;
      const intensity = intensityFor(peakCount, gain, table);
      writeDitheredPixel(
        data,
        offset,
        8 + red * intensity,
        13 + green * intensity,
        19 + blue * intensity,
        px,
        py,
        dither,
      );
    }
  }
  context.putImageData(image, left, top);

  const centerX = left + center;
  const centerY = top + center;
  context.save();
  context.strokeStyle = COLORS.grid;
  context.lineWidth = Math.max(1, dpr);
  for (const factor of [0.5, 1]) {
    context.beginPath();
    context.arc(centerX, centerY, radius * factor, 0, Math.PI * 2);
    context.stroke();
  }
  context.strokeStyle = COLORS.gridSoft;
  context.beginPath();
  context.moveTo(centerX - radius, centerY);
  context.lineTo(centerX + radius, centerY);
  context.moveTo(centerX, centerY - radius);
  context.lineTo(centerX, centerY + radius);
  context.stroke();

  const targets = [
    { name: "R", rgb: [1, 0, 0] }, { name: "Y", rgb: [1, 1, 0] },
    { name: "G", rgb: [0, 1, 0] }, { name: "C", rgb: [0, 1, 1] },
    { name: "B", rgb: [0, 0, 1] }, { name: "M", rgb: [1, 0, 1] },
  ];
  context.font = `${Math.max(9, Math.round(10 * dpr))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const markerRadius = Math.max(2, 3 * dpr);
  const labelOffset = Math.max(7, 9 * dpr);
  for (const target of targets) {
    const { cb, cr } = chromaForRgb(...target.rgb, kr, kb);
    const tx = centerX + cb * 2 * radius;
    const ty = centerY - cr * 2 * radius;
    context.fillStyle = cssColorFor(target.name === "C" ? "Cb" : target.name === "M" ? "Cr" : target.name);
    context.beginPath();
    context.arc(tx, ty, markerRadius, 0, Math.PI * 2);
    context.fill();
    const labelX = Math.max(left + labelOffset, Math.min(left + size - labelOffset, tx + Math.sign(cb || 0.01) * labelOffset));
    const labelY = Math.max(top + labelOffset, Math.min(top + size - labelOffset, ty - Math.sign(cr || 0.01) * labelOffset));
    context.fillText(target.name, labelX, labelY);
  }
  const skin = chromaForRgb(1, 0.55, 0.38, kr, kb);
  context.strokeStyle = "rgba(255, 186, 117, 0.55)";
  context.beginPath();
  context.moveTo(centerX, centerY);
  context.lineTo(centerX + skin.cb * 2 * radius, centerY - skin.cr * 2 * radius);
  context.stroke();
  context.restore();
}

/** Draw both scopes into a supplied 2D canvas context. */
export function renderScopes(result, canvasOrContext, options = {}) {
  const context = typeof canvasOrContext?.getContext === "function"
    ? canvasOrContext.getContext("2d")
    : canvasOrContext;
  if (!context || typeof context.putImageData !== "function") throw new TypeError("renderScopes needs a canvas or 2D canvas context");
  const canvas = context.canvas;
  const dpr = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
  if (options.width && options.height && canvas && (canvas.width !== Math.round(options.width * dpr) || canvas.height !== Math.round(options.height * dpr))) {
    canvas.width = Math.round(options.width * dpr);
    canvas.height = Math.round(options.height * dpr);
  }
  const width = canvas?.width ?? options.pixelWidth;
  const height = canvas?.height ?? options.pixelHeight;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new TypeError("Canvas needs a positive drawing-buffer size");
  }
  const gap = Math.max(0, Math.round((options.gap ?? 10) * dpr));
  const inset = Math.max(0, Math.round((options.inset ?? 16) * dpr));
  context.fillStyle = options.background ?? COLORS.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = options.textColor ?? COLORS.text;
  context.font = `${Math.max(10, Math.round(12 * dpr))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = "top";
  const layout = options.layout ?? "side-by-side";
  let waveformRect;
  let vectorRect;
  if (layout === "stacked") {
    const chartHeight = Math.floor((height - inset * 2 - gap) / 2);
    waveformRect = { x: inset, y: inset + 22 * dpr, width: width - inset * 2, height: chartHeight - 22 * dpr };
    vectorRect = { x: inset, y: inset + chartHeight + gap + 22 * dpr, width: width - inset * 2, height: chartHeight - 22 * dpr };
    context.fillText("WAVEFORM", inset, inset);
    context.fillText("VECTORSCOPE", inset, inset + chartHeight + gap);
  } else {
    const chartWidth = Math.floor((width - inset * 2 - gap) * 0.58);
    waveformRect = { x: inset, y: inset + 22 * dpr, width: chartWidth, height: height - inset * 2 - 22 * dpr };
    vectorRect = { x: inset + chartWidth + gap, y: inset + 22 * dpr, width: width - inset * 2 - chartWidth - gap, height: height - inset * 2 - 22 * dpr };
    context.fillText("WAVEFORM", waveformRect.x, inset);
    context.fillText("VECTORSCOPE", vectorRect.x, inset);
  }
  const gain = options.gain ?? 0.18;
  const dither = options.dither === undefined
    ? 0
    : Math.max(0, Math.min(1, Number.isFinite(options.dither) ? options.dither : 0));
  const vectorscopeDither = options.vectorscopeDither === undefined
    ? 0
    : Math.max(0, Math.min(1, Number.isFinite(options.vectorscopeDither) ? options.vectorscopeDither : 0));
  drawWaveformImage(
    context,
    result.waveform,
    waveformRect.x,
    waveformRect.y,
    Math.max(1, Math.floor(waveformRect.width)),
    Math.max(1, Math.floor(waveformRect.height)),
    gain,
    options.waveformAntialias ?? true,
    dither,
    dpr,
  );
  drawVectorscope(context, result.vectorscope, vectorRect.x, vectorRect.y, Math.max(1, Math.floor(vectorRect.width)), Math.max(1, Math.floor(vectorRect.height)), gain, vectorscopeDither, dpr);
  const performance = result.stats?.performance;
  if ((options.showPerformance ?? true) && performance) {
    const fps = performance.averageFps ?? performance.fps;
    const frameTimeMs = performance.frameTimeMs;
    const backend = performance.backend ? `${performance.backend.toUpperCase()} ` : "";
    context.save();
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillStyle = options.performanceColor ?? "#d9e7f0";
    context.font = `${Math.max(10, Math.round(11 * dpr))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    context.fillText(
      `${backend}avg ${fps.toFixed(1)} FPS · last ${frameTimeMs.toFixed(1)} ms`,
      width - inset,
      height - inset / 2,
      Math.max(80, width - inset * 2),
    );
    context.restore();
  }
  return result;
}
