import { analyzeTransferredVideoFrame } from "./cpu-worker-core.js";

const capture = {};

self.addEventListener("message", async (event) => {
  const { id, frame, options } = event.data ?? {};
  try {
    const analysis = await analyzeTransferredVideoFrame(frame, options, capture);
    const result = analysis.result;
    const transfer = [result.vectorscope.bins.buffer, ...result.waveform.channels.map((channel) => channel.buffer)];
    self.postMessage({ id, analysis }, transfer);
  } catch (error) {
    self.postMessage({ id, error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
  }
});
