export function createCpuWorkerClient({
  WorkerClass = globalThis.Worker,
  VideoFrameClass = globalThis.VideoFrame,
  workerUrl = new URL("./cpu-worker.js", import.meta.url),
} = {}) {
  const ANALYSIS_OPTION_KEYS = [
    "waveformMode", "waveformWidth", "waveformHeight", "vectorscopeSize", "colorMatrix", "colorRange",
    "bitDepth", "region", "inputResolutionScaling", "inputRegionX0", "inputRegionY0", "inputRegionX1", "inputRegionY1",
  ];
  let worker;
  let unavailable = false;
  let closing = false;
  let nextId = 0;
  const pending = new Map();

  function failAll(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function disable(error = new Error("CPU VideoFrame worker is unavailable")) {
    unavailable = true;
    try { worker?.terminate(); } catch {}
    worker = undefined;
    failAll(error);
  }

  function finishCloseWhenIdle() {
    if (closing && pending.size === 0) {
      try { worker?.terminate(); } catch {}
      worker = undefined;
    }
  }

  function getWorker() {
    if (unavailable || closing || typeof WorkerClass !== "function" || typeof VideoFrameClass !== "function") {
      throw new Error("Worker and transferable VideoFrame support are required for worker analysis");
    }
    if (worker) return worker;
    const created = new WorkerClass(workerUrl, { type: "module", name: "webscopes-cpu-analysis" });
    created.addEventListener?.("message", (event) => {
      const response = event.data ?? {};
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      finishCloseWhenIdle();
      if (response.error) {
        const error = new Error(response.error.message);
        error.name = response.error.name ?? "Error";
        request.reject(error);
        disable(error);
        return;
      }
      request.resolve(response.analysis);
    });
    created.addEventListener?.("error", (event) => {
      const error = event.error ?? new Error(event.message || "CPU analysis worker failed");
      disable(error);
    });
    // Small test and embedded Worker implementations commonly expose event
    // properties only; support both without registering duplicate handlers.
    if (!created.addEventListener) {
      created.onmessage = (event) => {
        const response = event.data ?? {};
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        finishCloseWhenIdle();
        if (response.error) {
          const error = new Error(response.error.message);
          error.name = response.error.name ?? "Error";
          request.reject(error);
          disable(error);
        } else request.resolve(response.analysis);
      };
      created.onerror = (event) => disable(event.error ?? new Error(event.message || "CPU analysis worker failed"));
    }
    worker = created;
    return worker;
  }

  return {
    get available() {
      return !unavailable && !closing && typeof WorkerClass === "function" && typeof VideoFrameClass === "function";
    },
    async analyze(source, options = {}) {
      if (!this.available) throw new Error("Worker and transferable VideoFrame support are not available");
      let ownedFrame;
      const snapshotStartedAt = globalThis.performance?.now?.() ?? Date.now();
      try {
        // Never transfer a caller-owned VideoFrame. This snapshot is owned by
        // the client until postMessage succeeds and by the worker thereafter.
        ownedFrame = new VideoFrameClass(source, { timestamp: 0 });
        const snapshotTimeMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - snapshotStartedAt);
        const activeWorker = getWorker();
        const id = ++nextId;
        const workerOptions = Object.fromEntries(ANALYSIS_OPTION_KEYS
          .filter((key) => options[key] !== undefined)
          .map((key) => [key, options[key]]));
        const analysis = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            activeWorker.postMessage({ id, frame: ownedFrame, options: workerOptions }, [ownedFrame]);
            ownedFrame = undefined;
          } catch (error) {
            pending.delete(id);
            disable(error);
            reject(error);
          }
        });
        return { ...analysis, snapshotTimeMs };
      } catch (error) {
        try { ownedFrame?.close?.(); } catch {}
        if (!unavailable) disable(error);
        throw error;
      }
    },
    disable,
    destroy() {
      closing = true;
      const error = new Error("CPU VideoFrame worker client has been destroyed");
      try { worker?.terminate(); } catch {}
      worker = undefined;
      failAll(error);
    },
  };
}
