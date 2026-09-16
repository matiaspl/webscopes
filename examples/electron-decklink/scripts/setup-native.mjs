import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const macadamRoot = path.dirname(require.resolve("macadam"));
const macadamPackage = JSON.parse(readFileSync(path.join(macadamRoot, "package.json"), "utf8"));
if (macadamPackage.version !== "2.0.18") {
  throw new Error(`This compatibility patch targets Macadam 2.0.18, found ${macadamPackage.version}.`);
}

const bindingPath = path.join(macadamRoot, "binding.gyp");
const bindingText = readFileSync(bindingPath, "utf8");
if (!bindingText.includes("NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT")) {
  const patchedBinding = bindingText.replace(
    /(\"target_name\"\s*:\s*\"macadam\"\s*,)/,
    "$1\n    \"defines\": [ \"NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT\" ],",
  );
  if (patchedBinding === bindingText) throw new Error("Could not find the Macadam native build target.");
  writeFileSync(bindingPath, patchedBinding);
}

const captureHeaderPath = path.join(macadamRoot, "src", "capture_promise.h");
const captureSourcePath = path.join(macadamRoot, "src", "capture_promise.cc");
let captureHeader = readFileSync(captureHeaderPath, "utf8").replace(/\r\n/g, "\n");
let captureSource = readFileSync(captureSourcePath, "utf8").replace(/\r\n/g, "\n");

const patchedHeader = captureHeader.replace(
  "  ~captureThreadsafe() {\n    if (deckLinkInput != nullptr) { deckLinkInput->Release(); }",
  "  ~captureThreadsafe() {\n    while (!framePromises.empty()) {\n      delete framePromises.front();\n      framePromises.pop();\n    }\n    if (deckLinkInput != nullptr) { deckLinkInput->Release(); }",
);
const patchedSource = captureSource
  .replace(
    "  if (hangover != napi_ok) {\n    printf(\"DEBUG: Failed to call NAPI threadsafe function on capture.\");",
    "  if (hangover != napi_ok) {\n    videoFrame->Release();\n    if (audioPacket != nullptr) {\n      audioPacket->Release();\n    }\n    free(data);\n    printf(\"DEBUG: Failed to call NAPI threadsafe function on capture.\");",
  )
  .replace(
    "  free(audio);\n}\n\nnapi_value stopStreams",
    "  free(audio);\n}\n\nvoid rejectPendingFramePromises(napi_env env, captureThreadsafe* crts) {\n  napi_value error;\n  if (napi_create_string_utf8(env, \"Capture stopped.\", NAPI_AUTO_LENGTH, &error) != napi_ok) return;\n  while (!crts->framePromises.empty()) {\n    frameCarrier* pending = crts->framePromises.front();\n    crts->framePromises.pop();\n    napi_reject_deferred(env, pending->_deferred, error);\n    delete pending;\n  }\n}\n\nnapi_value stopStreams",
  )
  .replace(
    "  status = napi_release_threadsafe_function(crts->tsFn, napi_tsfn_release);\n  CHECK_STATUS;\n\n  status = napi_get_undefined",
    "  status = napi_release_threadsafe_function(crts->tsFn, napi_tsfn_release);\n  CHECK_STATUS;\n\n  rejectPendingFramePromises(env, crts);\n\n  status = napi_get_undefined",
  )
  .replace(
    "  else {\n    printf(\"DEBUG: No promise to receive frame.\\n\");\n  }",
    "  else {\n    if (frame->videoFrame != nullptr) frame->videoFrame->Release();\n    if (frame->audioPacket != nullptr) frame->audioPacket->Release();\n    printf(\"DEBUG: No promise to receive frame.\\n\");\n  }",
  );

if (patchedHeader !== captureHeader) writeFileSync(captureHeaderPath, patchedHeader);
if (patchedSource !== captureSource) writeFileSync(captureSourcePath, patchedSource);
if (patchedHeader === captureHeader || patchedSource === captureSource) {
  const hasCleanup = patchedHeader.includes("delete framePromises.front();")
    && patchedSource.includes("rejectPendingFramePromises")
    && patchedSource.includes("videoFrame->Release();");
  if (!hasCleanup) throw new Error("Could not apply the Macadam capture cleanup patch.");
}

const electronRoot = path.dirname(require.resolve("electron"));
const electronInstall = spawnSync(process.execPath, [path.join(electronRoot, "install.js")], {
  cwd: sampleRoot,
  stdio: "inherit",
});
if (electronInstall.status !== 0) process.exit(electronInstall.status ?? 1);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this setup with `npm run setup:native` so npm can rebuild the native modules.");
const rebuild = spawnSync(process.execPath, [npmCli, "rebuild", "macadam", "segfault-handler", "--ignore-scripts=false"], {
  cwd: sampleRoot,
  stdio: "inherit",
});
if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);

process.stdout.write("Macadam and its helper-process dependencies are ready for this Node installation.\n");
