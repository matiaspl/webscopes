import test from "node:test";
import assert from "node:assert/strict";
import { computeScopeCanvasSize, createQualityProfileState, createRollingRate, getQualityProfile } from "../examples/mobile-performance.js";

test("quality profiles expose deterministic analysis and display budgets", () => {
  assert.deepEqual(getQualityProfile("standard"), {
    name: "standard",
    label: "Standard",
    inputResolutionScaling: 1,
    waveformWidth: 480,
    waveformHeight: 512,
    vectorscopeSize: 256,
    canvasWidth: 960,
    canvasHeight: 520,
    maxRefreshRate: undefined,
  });
  assert.deepEqual(getQualityProfile("mobile"), {
    name: "mobile",
    label: "Mobile",
    inputResolutionScaling: 0.25,
    waveformWidth: 240,
    waveformHeight: 256,
    vectorscopeSize: 128,
    canvasWidth: 480,
    canvasHeight: 260,
    maxRefreshRate: 20,
  });
  assert.throws(() => getQualityProfile("automatic"), /Unsupported quality profile/);
});

test("profile selection applies its probe scale and a manual scale lasts until the next selection", () => {
  const quality = createQualityProfileState();
  assert.equal(quality.current.name, "standard");
  assert.equal(quality.current.inputResolutionScaling, 1);
  assert.equal(quality.setProbeScale(0.5).inputResolutionScaling, 0.5);
  assert.equal(quality.current.manualProbeOverride, true);
  assert.equal(quality.select("mobile").inputResolutionScaling, 0.25);
  assert.equal(quality.current.manualProbeOverride, false);
  assert.equal(quality.setProbeScale(0.75).inputResolutionScaling, 0.75);
  assert.equal(quality.select("standard").inputResolutionScaling, 1);
  assert.throws(() => quality.setProbeScale(0), /Probe scale/);
});

test("scope canvas sizing stays proportional and inside each profile budget", () => {
  assert.deepEqual(computeScopeCanvasSize(320, "mobile"), { width: 320, height: 173 });
  assert.deepEqual(computeScopeCanvasSize(900, "mobile"), { width: 480, height: 260 });
  assert.deepEqual(computeScopeCanvasSize(1, "mobile"), undefined);
  assert.deepEqual(computeScopeCanvasSize(2_000, "standard"), { width: 960, height: 520 });
});

test("completed update rate uses a rolling window and resets cleanly", () => {
  const rate = createRollingRate({ windowMs: 1_000 });
  assert.equal(rate.record(0), 0);
  assert.equal(rate.record(50), 20);
  assert.equal(rate.record(100), 20);
  assert.equal(rate.getRate(1_101), 0);
  rate.record(1_150);
  assert.equal(rate.record(1_200), 20);
  rate.reset();
  assert.equal(rate.getRate(1_200), 0);
});

test("completed throughput falls when update completion is delayed by rendering", () => {
  const fast = createRollingRate({ windowMs: 5_000 });
  fast.record(0);
  fast.record(50);
  fast.record(100);

  const withRenderDelay = createRollingRate({ windowMs: 5_000 });
  withRenderDelay.record(0);
  withRenderDelay.record(50);
  withRenderDelay.record(200);

  assert.equal(fast.getRate(100), 20);
  assert.equal(withRenderDelay.getRate(200), 10);
});
