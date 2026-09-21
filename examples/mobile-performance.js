const QUALITY_PROFILES = Object.freeze({
  standard: Object.freeze({
    name: "standard",
    label: "Standard",
    inputResolutionScaling: 1,
    waveformWidth: 480,
    waveformHeight: 512,
    vectorscopeSize: 256,
    canvasWidth: 960,
    canvasHeight: 520,
    maxRefreshRate: undefined,
  }),
  mobile: Object.freeze({
    name: "mobile",
    label: "Mobile",
    inputResolutionScaling: 0.25,
    waveformWidth: 240,
    waveformHeight: 256,
    vectorscopeSize: 128,
    canvasWidth: 480,
    canvasHeight: 260,
    maxRefreshRate: 20,
  }),
});

export function getQualityProfile(name = "standard") {
  const profile = QUALITY_PROFILES[name];
  if (!profile) throw new RangeError(`Unsupported quality profile: ${name}`);
  return profile;
}

export function createQualityProfileState(initialProfile = "standard") {
  let profile = getQualityProfile(initialProfile);
  let manualProbeScale;

  function snapshot() {
    return {
      ...profile,
      inputResolutionScaling: manualProbeScale ?? profile.inputResolutionScaling,
      manualProbeOverride: manualProbeScale !== undefined,
    };
  }

  return {
    select(name) {
      profile = getQualityProfile(name);
      manualProbeScale = undefined;
      return snapshot();
    },
    setProbeScale(scale) {
      const numericScale = Number(scale);
      if (!Number.isFinite(numericScale) || numericScale <= 0 || numericScale > 1) {
        throw new RangeError("Probe scale must be in the range (0, 1]");
      }
      manualProbeScale = numericScale;
      return snapshot();
    },
    get current() { return snapshot(); },
  };
}

export function computeScopeCanvasSize(containerWidth, profileName = "standard") {
  const profile = typeof profileName === "string" ? getQualityProfile(profileName) : profileName;
  if (!profile || !Number.isFinite(containerWidth) || containerWidth < 2) return undefined;
  const width = Math.min(Math.floor(containerWidth), profile.canvasWidth);
  const height = Math.round(width * profile.canvasHeight / profile.canvasWidth);
  if (width < 2 || height < 2) return undefined;
  return { width, height };
}

export function createRollingRate({ windowMs = 5_000 } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be a positive finite number");
  const completions = [];

  function prune(now) {
    const cutoff = now - windowMs;
    while (completions.length && completions[0] < cutoff) completions.shift();
  }

  function rate(now) {
    if (completions.length < 2) return 0;
    const elapsedMs = now - completions[0];
    return elapsedMs > 0 ? (completions.length - 1) * 1_000 / elapsedMs : 0;
  }

  return {
    record(completedAt) {
      if (!Number.isFinite(completedAt)) return 0;
      completions.push(completedAt);
      prune(completedAt);
      return rate(completedAt);
    },
    getRate(now) {
      if (!Number.isFinite(now)) return 0;
      prune(now);
      return rate(now);
    },
    reset() { completions.length = 0; },
  };
}
