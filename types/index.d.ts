/// <reference types="@webgpu/types" />

export type WaveformModeName = "rgb" | "rgb-parade" | "luma" | "ycbcr-parade" | "composite";
export type ColorMatrixName = "bt601" | "bt709" | "bt2020" | "bt2100";
export type ColorRangeName = "limited" | "full";
export type TestSignalPatternName = "smpte" | "ebu" | "arib" | "diagnostic";
export type BackendName = "auto" | "webgpu" | "cpu";

export interface PixelFrame {
  data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array | Float64Array;
  width: number;
  height: number;
  /** Optional matrix metadata used when no per-call or instance override is supplied. */
  colorMatrix?: ColorMatrixName;
  /** Pixel code depth for right-aligned Uint16Array samples. Required for 10/12-bit data. */
  bitDepth?: 8 | 10 | 12;
  /** Bytes from one row to the next. Defaults to width * pixelStride * data.BYTES_PER_ELEMENT. */
  bytesPerRow?: number;
  /** Elements between adjacent pixels. Defaults to 4 (RGBA). */
  pixelStride?: number;
}

export interface V210Frame {
  /** Packed little-endian v210 4:2:2 frame from a decoder or capture pipeline. */
  format: "v210";
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Bytes from one row to the next. Defaults to v210's 128-byte / 48-pixel row alignment. */
  bytesPerRow?: number;
  /** Signal range in the packed samples. Defaults to limited-range video. */
  colorRange?: ColorRangeName;
  /** Matrix metadata used when no per-call or instance override is supplied. */
  colorMatrix?: ColorMatrixName;
}

export interface TestSignalSlate {
  label: string;
  standard: string;
  nativeColorMatrix?: ColorMatrixName;
  nativeColorRange?: ColorRangeName;
  pattern: TestSignalPatternName;
  colorMatrix: ColorMatrixName;
  colorRange: ColorRangeName;
  bitDepth: 10;
  frame: V210Frame;
  preview: PixelFrame;
}

export interface ScopeOptions {
  backend?: BackendName;
  /** Video input path for WebGPU. "auto" uses reusable texture copies on Safari and external textures elsewhere. */
  videoTextureMode?: "auto" | "copy" | "external";
  canvas?: HTMLCanvasElement | OffscreenCanvas | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  autoRender?: boolean;
  waveformMode?: WaveformModeName;
  waveformWidth?: number;
  /** Defaults to 2 ** bitDepth (256, 1024, or 4096). */
  waveformHeight?: number;
  vectorscopeSize?: number;
  colorMatrix?: ColorMatrixName;
  /** Code depth for raw Uint16Array RGBA input; browser image/video sources use 8-bit decoded pixels. Precedence: per-call options, instance options, frame metadata, then input-derived defaults. */
  bitDepth?: 8 | 10 | 12;
  /** Video signal range for v210 frames. Defaults to limited range; ignored for RGB inputs. */
  colorRange?: ColorRangeName;
  region?: { x: number; y: number; width: number; height: number };
  /** Fraction of source samples analyzed in each dimension, from (0, 1]. */
  inputResolutionScaling?: number;
  /** Compatibility with web-color-meters normalized crop values. */
  inputRegionX0?: number;
  inputRegionY0?: number;
  inputRegionX1?: number;
  inputRegionY1?: number;
  renderOptions?: RenderOptions;
  onWarning?: (message: string) => void;
  gpu?: GPU;
  adapter?: GPUAdapter;
  device?: GPUDevice;
  adapterOptions?: GPURequestAdapterOptions;
}

export interface RenderOptions {
  layout?: "side-by-side" | "stacked";
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  gap?: number;
  inset?: number;
  gain?: number;
  /** Show the processing FPS and frame time badge. Defaults to true. */
  showPerformance?: boolean;
  /** Area-filter waveform bins when shrinking, and linearly interpolate rows when enlarging the raster. Defaults to true. */
  waveformAntialias?: boolean;
  /** Display-only waveform dither in 8-bit output code values (0–1, default 0); 0 disables it. Histograms are unchanged. */
  dither?: number;
  /** Display-only vectorscope dither in 8-bit output code values; defaults to 0. Histograms are unchanged. */
  vectorscopeDither?: number;
  background?: string;
  textColor?: string;
  performanceColor?: string;
}

export interface ScopeResult {
  width: number;
  height: number;
  sampleCount: number;
  waveform: {
    width: number;
    height: number;
    bitDepth: 8 | 10 | 12;
    mode: WaveformModeName;
    channelNames: string[];
    /** One row-major Uint32 histogram per channel. */
    channels: Uint32Array[];
  };
  vectorscope: { width: number; height: number; bins: Uint32Array; colorMatrix: ColorMatrixName };
  stats: {
    clippedLow?: number;
    clippedHigh?: number;
    colorMatrix: ColorMatrixName;
    colorRange?: ColorRangeName;
    bitDepth?: 8 | 10 | 12;
    performance?: {
      backend?: "webgpu" | "cpu";
      /** Time from update start through capture and analysis, before rendering. */
      frameTimeMs: number;
      /** Reciprocal processing estimate based on frameTimeMs, not delivered updates. */
      fps: number;
      averageFrameTimeMs?: number;
      averageFps?: number;
      /** Browser source capture and pixel readback time, when performed. */
      captureTimeMs?: number;
      /** Analysis time, including asynchronous WebGPU submission and histogram readback. */
      analysisTimeMs?: number;
      /** Automatic render time for this update; zero when no render was performed. */
      renderTimeMs?: number;
      /** Total elapsed update time, including automatic rendering. */
      updateTimeMs?: number;
      /** Bytes copied from a browser source for this update, when available. */
      captureBytes?: number;
      /** True when an exact native-size ROI was copied instead of the full frame. */
      captureUsedRoi?: boolean;
    };
  };
}

export interface Scopes {
  readonly backend: "webgpu" | "cpu";
  /** Selected WebGPU video input path; undefined when the instance uses CPU. */
  readonly videoTextureMode: "copy" | "external" | undefined;
  readonly result: ScopeResult | undefined;
  canvas: ScopeOptions["canvas"];
  update(frame: CanvasImageSource | VideoFrame | ImageData | PixelFrame | V210Frame, options?: Partial<ScopeOptions>): Promise<ScopeResult>;
  render(options?: RenderOptions): ScopeResult;
  renderFrame(frame: CanvasImageSource | VideoFrame | ImageData | PixelFrame | V210Frame, options?: Partial<ScopeOptions>): Promise<ScopeResult>;
  destroy(): void;
}

export interface ScopeDisplayOptions extends Omit<ScopeOptions, "canvas" | "backend" | "autoRender"> {
  /** A fresh canvas that has not acquired a 2D rendering context. */
  canvas: HTMLCanvasElement;
  /** Called when the WebGPU queue has finished this frame's work; this is not compositor presentation. */
  onQueueCompleted?: (event: { frameId: number; submittedFrames: number; queueCompletedFrames: number }) => void;
  /** Called after the display device is lost. The caller can restore a Canvas2D surface. */
  onDeviceLost?: (error: Error) => void;
  onError?: (error: Error) => void;
}

export interface ScopeDisplayMetadata {
  frameId: number;
  width: number;
  height: number;
  sampleCount: number;
  waveform: {
    width: number;
    height: number;
    bitDepth: 8 | 10 | 12;
    mode: WaveformModeName;
    channelNames: string[];
    channelCount: number;
  };
  vectorscope: { width: number; height: number; colorMatrix: ColorMatrixName };
  stats: { colorMatrix: ColorMatrixName; bitDepth: 8 | 10 | 12 };
}

export type ScopeDisplayPresentResult =
  | { status: "superseded" }
  | {
    status: "submitted";
    frameId: number;
    submittedFrames: number;
    /** Frames whose WebGPU queue work completed; this is not compositor presentation. */
    queueCompletedFrames: number;
    metadata: ScopeDisplayMetadata;
    /** CPU wall time through GPU queue submission, not GPU execution or display time. */
    submissionTimeMs: number;
  };

export interface ScopeDisplay {
  readonly canvas: HTMLCanvasElement;
  readonly submittedFrames: number;
  /** Highest submitted frame id whose WebGPU queue work completed, not a displayed-frame count. */
  readonly queueCompletedFrames: number;
  /** Submit a decoded browser source. Raw pixel arrays remain on createScopes/analyzeFrame. */
  present(source: CanvasImageSource | VideoFrame, options?: Partial<Omit<ScopeOptions, "canvas" | "backend" | "autoRender">>): Promise<ScopeDisplayPresentResult>;
  /** Read back the exact most recently submitted frame; every returned histogram is independently owned. */
  snapshot(): Promise<ScopeResult>;
  /** Release display-owned GPU resources and wait for in-flight GPU work. Caller-owned devices remain alive. */
  destroy(): Promise<void>;
}

export declare const WaveformMode: Readonly<{ RGB: "rgb"; RGB_PARADE: "rgb-parade"; LUMA: "luma"; YCBCR_PARADE: "ycbcr-parade"; COMPOSITE: "composite" }>;
export declare const ColorMatrix: Readonly<{
  BT601: "bt601";
  BT709: "bt709";
  BT2020: "bt2020";
  BT2100: "bt2100";
}>;
export declare const TEST_SIGNAL_PATTERNS: readonly TestSignalPatternName[];
export declare const TEST_SIGNAL_COLOR_MATRICES: readonly ColorMatrixName[];
export declare const TEST_SIGNAL_COLOR_RANGES: readonly ColorRangeName[];
export declare function generateTestSignalSlate(options?: {
  pattern?: TestSignalPatternName;
  colorMatrix?: ColorMatrixName;
  colorRange?: ColorRangeName;
  width?: number;
  height?: number;
}): TestSignalSlate;
export declare function getDefaultScopesConfig(): ScopeOptions;
export declare function analyzeFrame(frame: PixelFrame | V210Frame | ImageData, options?: Partial<ScopeOptions>): ScopeResult;
export declare function renderScopes(result: ScopeResult, canvasOrContext: HTMLCanvasElement | OffscreenCanvas | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, options?: RenderOptions): ScopeResult;
export declare function createScopes(options?: ScopeOptions): Promise<Scopes>;
export declare function createScopeDisplay(options: ScopeDisplayOptions): Promise<ScopeDisplay>;
export declare const createVideoScopes: typeof createScopes;
