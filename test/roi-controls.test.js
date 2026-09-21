import test from "node:test";
import assert from "node:assert/strict";
import { createFramePacer, createRoiRefreshScheduler, createRoiSelectionController, regionForPreset, selectionRectangle } from "../examples/roi-controls.js";

function fakeAnimationFrames() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    callbacks,
    request(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) { callbacks.delete(id); },
    flush() {
      const next = callbacks.entries().next().value;
      if (!next) return false;
      callbacks.delete(next[0]);
      next[1]();
      return true;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function selectionHarness(initial = { x: 0, y: 0, width: 1, height: 1 }) {
  let region = { ...initial };
  let draws = 0;
  let commits = 0;
  const controller = createRoiSelectionController({
    getRegion: () => region,
    setRegion: (value) => { region = value; },
    drawRegion: () => { draws += 1; },
    onCommit: () => { commits += 1; },
  });
  return {
    controller,
    get region() { return region; },
    get draws() { return draws; },
    get commits() { return commits; },
  };
}

test("selection rectangles clamp their full dimensions at all source edges", () => {
  const selection = selectionRectangle({ x: 0.99, y: 0.99 }, { x: 1, y: 1 });
  assert.deepEqual(selection, { x: 0.985, y: 0.985, width: 0.015, height: 0.015 });
  assert.ok(selection.x >= 0 && selection.y >= 0);
  assert.ok(selection.x + selection.width <= 1 && selection.y + selection.height <= 1);

  const reverse = selectionRectangle({ x: 0.8, y: 0.7 }, { x: 0.1, y: 0.2 });
  assert.deepEqual(reverse, { x: 0.1, y: 0.2, width: 0.7000000000000001, height: 0.49999999999999994 });
});

test("ROI presets select the full frame, center, and left half", () => {
  assert.deepEqual(regionForPreset("full"), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(regionForPreset("center"), { x: 0.25, y: 0.2, width: 0.5, height: 0.6 });
  assert.deepEqual(regionForPreset("left"), { x: 0, y: 0, width: 0.45, height: 1 });
});

test("frame pacer skips duplicate frame tokens but allows ROI and analyzer changes", () => {
  const pacer = createFramePacer();
  const scopesA = {};
  const scopesB = {};
  assert.equal(pacer.shouldAnalyze(1.25, 0, scopesA), true);
  assert.equal(pacer.shouldAnalyze(1.25, 0, scopesA), false);
  assert.equal(pacer.shouldAnalyze(1.3, 0, scopesA), true);
  assert.equal(pacer.shouldAnalyze(1.3, 1, scopesA), true);
  assert.equal(pacer.shouldAnalyze(1.3, 1, scopesB), true);
  assert.equal(pacer.shouldAnalyze(1.3, 1, scopesB), false);
  pacer.reset();
  assert.equal(pacer.shouldAnalyze(1.3, 1, scopesB), true);
});

test("frame pacer rate limits before accepting a token and forced refreshes bypass one deadline", () => {
  let now = 0;
  const pacer = createFramePacer({ maxRefreshRate: 20, now: () => now });
  const scopes = {};
  assert.equal(pacer.shouldAnalyze(1, 0, scopes), true);
  now = 25;
  assert.equal(pacer.shouldAnalyze(2, 0, scopes), false);
  now = 50;
  assert.equal(pacer.shouldAnalyze(2, 0, scopes), true, "a throttled frame token was not recorded as analyzed");
  now = 60;
  assert.equal(pacer.shouldAnalyze(3, 0, scopes), false);
  assert.equal(pacer.shouldAnalyze(3, 1, scopes, { force: true }), true);
  now = 85;
  assert.equal(pacer.shouldAnalyze(4, 1, scopes), false, "the forced update starts the next normal deadline");
  now = 110;
  assert.equal(pacer.shouldAnalyze(4, 1, scopes), true);
});

test("frame pacer measures the next deadline from update completion", () => {
  let now = 0;
  const pacer = createFramePacer({ maxRefreshRate: 20, now: () => now });
  const scopes = {};
  assert.equal(pacer.shouldAnalyze(1, 0, scopes), true);
  now = 80;
  pacer.complete();
  now = 100;
  assert.equal(pacer.shouldAnalyze(2, 0, scopes), false);
  now = 130;
  assert.equal(pacer.shouldAnalyze(2, 0, scopes), true);
  now = 170;
  pacer.complete();
  now = 190;
  assert.equal(pacer.shouldAnalyze(3, 0, scopes), false);
  now = 220;
  assert.equal(pacer.shouldAnalyze(3, 0, scopes), true);
});

test("a twenty update per second cap bounds thirty and sixty frame per second input", () => {
  for (const sourceRate of [30, 60]) {
    let now = 0;
    const pacer = createFramePacer({ maxRefreshRate: 20, now: () => now });
    const scopes = {};
    let accepted = 0;
    for (let frame = 0; frame < sourceRate; frame += 1) {
      now = frame * 1_000 / sourceRate;
      if (pacer.shouldAnalyze(frame, 0, scopes)) {
        accepted += 1;
        now += 3;
        pacer.complete();
      }
    }
    assert.ok(accepted <= 20, `accepted ${accepted} updates from ${sourceRate} presented frames`);
  }
});

test("a tap leaves the ROI unchanged and does not schedule analysis", () => {
  const original = { x: 0.2, y: 0.1, width: 0.5, height: 0.6 };
  const harness = selectionHarness(original);
  const point = { x: 0.4, y: 0.5, inside: true };
  assert.equal(harness.controller.begin(point, 7), true);
  assert.equal(harness.controller.end(point, 7), true);
  assert.deepEqual(harness.region, original);
  assert.equal(harness.commits, 0);
  assert.equal(harness.draws, 1);
});

test("pointer cancellation restores the previous ROI and does not refresh", () => {
  const original = { x: 0, y: 0, width: 1, height: 1 };
  const harness = selectionHarness(original);
  assert.equal(harness.controller.begin({ x: 0.2, y: 0.3, inside: true }, 3), true);
  harness.controller.move({ x: 0.7, y: 0.8, inside: true }, 3);
  assert.notDeepEqual(harness.region, original);
  assert.equal(harness.controller.end({ x: 1, y: 1, inside: true }, 3, true), true);
  assert.deepEqual(harness.region, original);
  assert.equal(harness.commits, 0);
});

test("pointer release includes the final position and commits one clamped selection", () => {
  const harness = selectionHarness();
  assert.equal(harness.controller.begin({ x: 0.95, y: 0.94, inside: true }, 2), true);
  assert.equal(harness.controller.move({ x: 0.98, y: 0.97, inside: true }, 2), true);
  assert.equal(harness.commits, 0);
  harness.controller.end({ x: 1, y: 1, inside: true }, 2);
  assert.deepEqual(harness.region, { x: 0.95, y: 0.94, width: 0.050000000000000044, height: 0.06000000000000005 });
  assert.equal(harness.commits, 1);
});

test("refresh scheduler coalesces changes and refreshes while video is paused", () => {
  const frames = fakeAnimationFrames();
  const updates = [];
  const pending = deferred();
  let selectedRegion = "left";
  const scheduler = createRoiRefreshScheduler({
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    run() {
      updates.push({ selectedRegion, paused: true });
      return { promise: pending.promise, regionRevision: scheduler.revision };
    },
  });

  scheduler.schedule();
  selectedRegion = "center";
  scheduler.schedule();
  selectedRegion = "right";
  scheduler.schedule();
  assert.equal(frames.callbacks.size, 1);
  frames.flush();
  assert.deepEqual(updates, [{ selectedRegion: "right", paused: true }]);
  assert.equal(scheduler.pending, false);
  pending.resolve();
});

test("refresh scheduler analyzes the final region after an in-flight refresh", async () => {
  const frames = fakeAnimationFrames();
  const updates = [];
  const first = deferred();
  let selectedRegion = "center";
  const scheduler = createRoiRefreshScheduler({
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    run() {
      const promise = updates.length === 0 ? first.promise : Promise.resolve();
      updates.push({ selectedRegion, revision: scheduler.revision });
      return { promise, regionRevision: scheduler.revision };
    },
  });

  scheduler.schedule();
  frames.flush();
  selectedRegion = "left";
  scheduler.schedule();
  assert.equal(frames.callbacks.size, 0);
  first.resolve();
  await Promise.resolve();
  assert.equal(frames.callbacks.size, 1);
  frames.flush();
  assert.deepEqual(updates, [
    { selectedRegion: "center", revision: 1 },
    { selectedRegion: "left", revision: 2 },
  ]);
});

test("pending refresh resumes when a frame becomes available and destroy cancels queued work", async () => {
  const frames = fakeAnimationFrames();
  let available = false;
  let updates = 0;
  const scheduler = createRoiRefreshScheduler({
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    run() {
      if (!available) return undefined;
      updates += 1;
      return { promise: Promise.resolve(), regionRevision: scheduler.revision };
    },
  });

  scheduler.schedule();
  frames.flush();
  assert.equal(scheduler.pending, true);
  available = true;
  scheduler.resume();
  frames.flush();
  assert.equal(updates, 1);
  scheduler.schedule();
  await Promise.resolve();
  assert.equal(frames.callbacks.size, 1);
  scheduler.destroy();
  assert.equal(frames.callbacks.size, 0);
});

test("refresh scheduler suspends queued work and coalesces changes until visible", async () => {
  const frames = fakeAnimationFrames();
  const updates = [];
  const scheduler = createRoiRefreshScheduler({
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    run({ revision, force }) {
      updates.push({ revision, force });
      return { promise: Promise.resolve(), regionRevision: revision };
    },
  });
  scheduler.suspend();
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(frames.callbacks.size, 0);
  scheduler.resume();
  assert.equal(frames.callbacks.size, 1);
  frames.flush();
  await Promise.resolve();
  assert.deepEqual(updates, [{ revision: 2, force: true }]);
  scheduler.destroy();
});

test("refresh scheduler cancels a queued callback with the window that created it", () => {
  const firstWindow = fakeAnimationFrames();
  const secondWindow = fakeAnimationFrames();
  const owners = [];
  let owner = firstWindow;
  const scheduler = createRoiRefreshScheduler({
    requestFrame(callback) {
      const callbackOwner = owner;
      const id = callbackOwner.request(callback);
      return { callbackOwner, id };
    },
    cancelFrame(handle) { handle.callbackOwner.cancel(handle.id); },
    run() {
      owners.push(owner);
      return { promise: Promise.resolve(), regionRevision: scheduler.revision };
    },
  });
  scheduler.schedule();
  owner = secondWindow;
  scheduler.rebind();
  assert.equal(firstWindow.callbacks.size, 0);
  assert.equal(secondWindow.callbacks.size, 1);
  secondWindow.flush();
  assert.deepEqual(owners, [secondWindow]);
  scheduler.destroy();
});
