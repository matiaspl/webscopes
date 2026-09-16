import { bindRoiSelection, createRoiRefreshScheduler, createRoiSelectionController, regionForPreset } from "./roi-controls.js";

export async function runRoiBrowserChecks() {
  let region = { x: 0, y: 0, width: 1, height: 1 };
  let commits = 0;
  const stage = document.createElement("div");
  stage.setPointerCapture = () => {};
  const selection = createRoiSelectionController({
    getRegion: () => region,
    setRegion: (next) => { region = next; },
    drawRegion() {},
    onCommit: () => { commits += 1; },
  });
  bindRoiSelection(stage, selection, (event) => ({
    x: event.clientX,
    y: event.clientY,
    inside: event.clientX >= 0 && event.clientX <= 1 && event.clientY >= 0 && event.clientY <= 1,
  }));
  const pointer = (type, x, y, pointerId = 5) => stage.dispatchEvent(new PointerEvent(type, {
    pointerId,
    clientX: x,
    clientY: y,
    bubbles: true,
  }));

  const initial = { ...region };
  pointer("pointerdown", 0.4, 0.5);
  pointer("pointerup", 0.4, 0.5);
  const tapUnchanged = JSON.stringify(region) === JSON.stringify(initial) && commits === 0;

  pointer("pointerdown", 0.95, 0.94);
  pointer("pointermove", 0.98, 0.97);
  pointer("pointerup", 1, 1);
  const edgeClamped = region.x + region.width <= 1 && region.y + region.height <= 1;
  const finalPositionUsed = Math.abs(region.width - 0.05) < 1e-12 && Math.abs(region.height - 0.06) < 1e-12;
  const singleCommit = commits === 1;

  const beforeCancel = { ...region };
  pointer("pointerdown", 0.2, 0.3);
  pointer("pointermove", 0.8, 0.8);
  pointer("pointercancel", 0.1, 0.1);
  const cancelRestored = JSON.stringify(region) === JSON.stringify(beforeCancel) && commits === 1;
  const presets = ["center", "left", "full"].map(regionForPreset);
  const presetsValid = presets.length === 3
    && presets[0].width === 0.5
    && presets[1].width === 0.45
    && presets[2].width === 1;

  let selectedPreset = "left";
  let paused = true;
  const refreshes = [];
  const queuedFrames = [];
  const scheduler = createRoiRefreshScheduler({
    requestFrame(callback) { queuedFrames.push(callback); return queuedFrames.length; },
    cancelFrame() {},
    run() {
      refreshes.push({ region: selectedPreset, paused });
      return { promise: Promise.resolve(), regionRevision: scheduler.revision };
    },
  });
  scheduler.schedule();
  selectedPreset = "center";
  scheduler.schedule();
  selectedPreset = "right";
  scheduler.schedule();
  queuedFrames.shift()?.();
  await Promise.resolve();
  scheduler.destroy();
  const pausedRefreshAndCoalescing = refreshes.length === 1
    && refreshes[0].region === "right"
    && refreshes[0].paused;

  const checks = { tapUnchanged, edgeClamped, finalPositionUsed, singleCommit, cancelRestored, presetsValid, pausedRefreshAndCoalescing };
  return { passed: Object.values(checks).every(Boolean), checks };
}
