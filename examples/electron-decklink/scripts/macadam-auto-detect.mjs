import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function replaceExactlyOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Could not apply the Macadam auto-detection patch at ${label}.`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function patchMacadamCaptureHeader(source) {
  source = replaceExactlyOnce(
    source,
    "  BMDPixelFormat requestedPixelFormat;\n  BMDAudioSampleRate requestedSampleRate",
    "  BMDPixelFormat requestedPixelFormat;\n  bool autoDetect = false;\n  BMDVideoInputFlags videoInputFlags = bmdVideoInputFlagDefault;\n  BMDAudioSampleRate requestedSampleRate",
    "captureCarrier input options",
  );
  return replaceExactlyOnce(
    source,
    "  BMDPixelFormat pixelFormat;\n  BMDTimeScale timeScale;",
    "  BMDPixelFormat pixelFormat;\n  BMDVideoInputFlags videoInputFlags = bmdVideoInputFlagDefault;\n  BMDTimeScale timeScale;",
    "captureThreadsafe input flags",
  );
}

export function patchMacadamCaptureSource(source) {
  source = replaceExactlyOnce(
    source,
    `HRESULT captureThreadsafe::VideoInputFormatChanged(
  BMDVideoInputFormatChangedEvents notificationEvents,
  IDeckLinkDisplayMode *newDisplayMode,
  BMDDetectedVideoInputFormatFlags detectedSignalFlags) {

  return E_FAIL;
}`,
    `HRESULT captureThreadsafe::VideoInputFormatChanged(
  BMDVideoInputFormatChangedEvents notificationEvents,
  IDeckLinkDisplayMode *newDisplayMode,
  BMDDetectedVideoInputFormatFlags detectedSignalFlags) {

  if ((notificationEvents & bmdVideoInputDisplayModeChanged) == 0 || newDisplayMode == nullptr) return S_OK;
  const BMDDisplayMode detectedMode = newDisplayMode->GetDisplayMode();
  if (displayMode != nullptr && displayMode->GetDisplayMode() == detectedMode) return S_OK;

  HRESULT hresult = deckLinkInput->PauseStreams();
  if (hresult != S_OK) return hresult;
  hresult = deckLinkInput->EnableVideoInput(detectedMode, pixelFormat, videoInputFlags);
  if (hresult != S_OK) return hresult;
  hresult = deckLinkInput->FlushStreams();
  if (hresult != S_OK) return hresult;
  hresult = deckLinkInput->StartStreams();
  if (hresult != S_OK && hresult != E_ACCESSDENIED) return hresult;

  newDisplayMode->AddRef();
  if (displayMode != nullptr) displayMode->Release();
  displayMode = newDisplayMode;
  BMDTimeValue frameRateDuration = 0;
  BMDTimeScale frameRateScale = 0;
  if (newDisplayMode->GetFrameRate(&frameRateDuration, &frameRateScale) == S_OK && frameRateDuration > 0) {
    timeScale = frameRateScale;
    roughFps = (uint16_t) (frameRateScale / frameRateDuration);
  }

  return S_OK;
}`,
    "VideoInputFormatChanged callback",
  );

  source = replaceExactlyOnce(
    source,
    '  c->status = napi_get_named_property(env, options, "channels", &param);',
    `  c->status = napi_get_named_property(env, options, "autoDetect", &param);
  REJECT_RETURN;
  c->status = napi_typeof(env, param, &type);
  REJECT_RETURN;
  if (type != napi_undefined) {
    if (type != napi_boolean) REJECT_ERROR_RETURN("autoDetect must be a boolean.", MACADAM_INVALID_ARGS);
    c->status = napi_get_value_bool(env, param, &c->autoDetect);
    REJECT_RETURN;
  }
  if (c->autoDetect) c->videoInputFlags = bmdVideoInputEnableFormatDetection;

  c->status = napi_get_named_property(env, options, "channels", &param);`,
    "capture autoDetect option",
  );

  const flagArgument = "c->requestedPixelFormat, bmdVideoInputFlagDefault";
  const flagReplacement = "c->requestedPixelFormat, c->videoInputFlags";
  const occurrences = source.split(flagArgument).length - 1;
  if (occurrences === 0 && !source.includes(flagReplacement)) {
    throw new Error("Could not apply the Macadam auto-detection patch to the input mode checks.");
  }
  source = source.replaceAll(flagArgument, flagReplacement);

  return replaceExactlyOnce(
    source,
    "  crts->pixelFormat = c->requestedPixelFormat;\n",
    "  crts->pixelFormat = c->requestedPixelFormat;\n  crts->videoInputFlags = c->videoInputFlags;\n",
    "capture callback input flags",
  );
}

export async function applyMacadamAutoDetectPatch(macadamRoot) {
  const targets = [
    { relativePath: "src/capture_promise.h", patch: patchMacadamCaptureHeader },
    { relativePath: "src/capture_promise.cc", patch: patchMacadamCaptureSource },
  ];
  let changed = false;
  for (const target of targets) {
    const filePath = path.join(macadamRoot, target.relativePath);
    const source = await readFile(filePath, "utf8");
    const patched = target.patch(source);
    if (patched !== source) {
      await writeFile(filePath, patched);
      changed = true;
    }
  }
  return changed;
}
