export function selectionRectangle(start, end, minimum = 0.015) {
  const width = Math.min(1, Math.max(minimum, Math.abs(end.x - start.x)));
  const height = Math.min(1, Math.max(minimum, Math.abs(end.y - start.y)));
  const x = Math.max(0, Math.min(Math.min(start.x, end.x), 1 - width));
  const y = Math.max(0, Math.min(Math.min(start.y, end.y), 1 - height));
  return { x, y, width, height };
}

export function regionForPreset(preset) {
  if (preset === "center") return { x: 0.25, y: 0.2, width: 0.5, height: 0.6 };
  if (preset === "left") return { x: 0, y: 0, width: 0.45, height: 1 };
  return { x: 0, y: 0, width: 1, height: 1 };
}

export function createFramePacer() {
  let hasFrame = false;
  let lastFrameToken;
  let lastRegionRevision;
  let lastScopes;
  return {
    shouldAnalyze(frameToken, regionRevision, scopes) {
      if (hasFrame && Object.is(frameToken, lastFrameToken)
        && regionRevision === lastRegionRevision && scopes === lastScopes) return false;
      hasFrame = true;
      lastFrameToken = frameToken;
      lastRegionRevision = regionRevision;
      lastScopes = scopes;
      return true;
    },
    reset() {
      hasFrame = false;
      lastFrameToken = undefined;
      lastRegionRevision = undefined;
      lastScopes = undefined;
    },
  };
}

export function createRoiSelectionController({ getRegion, setRegion, drawRegion, onCommit }) {
  let dragging;

  function begin(point, pointerId) {
    if (!point.inside || dragging) return false;
    dragging = {
      x: point.x,
      y: point.y,
      pointerId,
      moved: false,
      previousRegion: { ...getRegion() },
    };
    return true;
  }

  function move(point, pointerId) {
    if (!dragging || pointerId !== dragging.pointerId) return false;
    if (Math.abs(point.x - dragging.x) > Number.EPSILON || Math.abs(point.y - dragging.y) > Number.EPSILON) {
      dragging.moved = true;
    }
    if (!dragging.moved) return false;
    setRegion(selectionRectangle(dragging, point));
    drawRegion();
    return true;
  }

  function end(point, pointerId, cancelled = false) {
    if (!dragging || pointerId !== dragging.pointerId) return false;
    const selection = dragging;
    if (cancelled) {
      setRegion(selection.previousRegion);
    } else {
      move(point, pointerId);
      if (!selection.moved) setRegion(selection.previousRegion);
    }
    dragging = undefined;
    drawRegion();
    if (!cancelled && selection.moved) onCommit();
    return true;
  }

  return { begin, move, end };
}

export function bindRoiSelection(stage, controller, pointToSource) {
  stage.addEventListener("pointerdown", (event) => {
    if (controller.begin(pointToSource(event), event.pointerId)) stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => controller.move(pointToSource(event), event.pointerId));
  stage.addEventListener("pointerup", (event) => controller.end(pointToSource(event), event.pointerId));
  stage.addEventListener("pointercancel", (event) => controller.end(pointToSource(event), event.pointerId, true));
}

export function createRoiRefreshScheduler({ requestFrame, cancelFrame, run }) {
  let frame;
  let pending = false;
  let inFlight = false;
  let revision = 0;
  let closing = false;

  function queue() {
    if (closing || !pending || inFlight || frame !== undefined) return;
    frame = requestFrame(() => {
      frame = undefined;
      if (closing || !pending) return;
      const analysis = run();
      if (!analysis) return;
      pending = false;
      inFlight = true;
      const finish = () => {
        inFlight = false;
        if (pending || analysis.regionRevision !== revision) {
          pending = true;
          queue();
        }
      };
      analysis.promise.then(finish, finish);
    });
  }

  return {
    schedule() {
      if (closing) return revision;
      revision += 1;
      pending = true;
      queue();
      return revision;
    },
    resume: queue,
    destroy() {
      closing = true;
      pending = false;
      if (frame !== undefined) cancelFrame(frame);
      frame = undefined;
    },
    get pending() { return pending; },
    get revision() { return revision; },
  };
}
