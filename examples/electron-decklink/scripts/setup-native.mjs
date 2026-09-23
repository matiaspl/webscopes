import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMacadamAutoDetectPatch } from "./macadam-auto-detect.mjs";

const require = createRequire(import.meta.url);
const sampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameRingRoot = path.join(sampleRoot, "native/frame-ring");
const sharedRgbaRoot = path.join(sampleRoot, "native/shared-rgba");
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error("Run this setup with `npm run setup:native`.");

const macadamRoot = path.dirname(require.resolve("@spaceagetv/macadam"));
const macadamPackage = JSON.parse(readFileSync(path.join(macadamRoot, "package.json"), "utf8"));
if (macadamPackage.version !== "2.1.1") {
  throw new Error(`Expected Macadam 2.1.1, found ${macadamPackage.version}.`);
}

await applyMacadamAutoDetectPatch(macadamRoot);

const electronRoot = path.dirname(require.resolve("electron"));
const electronInstall = spawnSync(process.execPath, [path.join(electronRoot, "install.js")], {
  cwd: sampleRoot,
  stdio: "inherit",
});
if (electronInstall.error) throw electronInstall.error;
if (electronInstall.status !== 0) process.exit(electronInstall.status ?? 1);

// The addon runs in the isolated Node helper, not Electron. Its N-API build
// does not need Electron's ABI, but lifecycle scripts are disabled by .npmrc.
// Macadam's install hook only selects an existing addon; invoke its build script to compile the patched C++ sources,
// including input-format detection and optional per-frame colorspace metadata.
const nativeBuild = spawnSync(process.execPath, [npmCli, "run", "build", "--prefix", macadamRoot, "--ignore-scripts"], {
  cwd: sampleRoot,
  stdio: "inherit",
});
if (nativeBuild.error) throw nativeBuild.error;
if (nativeBuild.status !== 0) process.exit(nativeBuild.status ?? 1);

const bundledNodeGyp = path.resolve(path.dirname(npmCli), "../node_modules/node-gyp/bin/node-gyp.js");
const nodeGyp = process.env.npm_config_node_gyp || (existsSync(bundledNodeGyp) ? bundledNodeGyp : "node-gyp");
const electronVersion = JSON.parse(readFileSync(path.join(electronRoot, "package.json"), "utf8")).version;
function buildFrameRing(abi, extraArgs = [], environment = {}) {
  const result = spawnSync(nodeGyp, ["rebuild", "--directory", frameRingRoot, ...extraArgs], {
    cwd: sampleRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const output = path.join(frameRingRoot, "build/Release/frame_ring.node");
  const destinationDirectory = path.join(frameRingRoot, abi);
  mkdirSync(destinationDirectory, { recursive: true });
  copyFileSync(output, path.join(destinationDirectory, "frame_ring.node"));
}

// Keep both ABIs available: the helper may use an external system Node through
// WEBSCOPES_NODE_PATH, while the default Electron-run-as-node path uses the
// Electron ABI and the main process always uses the Electron ABI.
buildFrameRing("node");
buildFrameRing("electron", [`--target=${electronVersion}`, "--dist-url=https://electronjs.org/headers"]);

if (process.platform === "darwin") {
  const result = spawnSync(nodeGyp, ["rebuild", "--directory", sharedRgbaRoot,
    `--target=${electronVersion}`, "--dist-url=https://electronjs.org/headers"], {
    cwd: sampleRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const destinationDirectory = path.join(sharedRgbaRoot, "electron");
  mkdirSync(destinationDirectory, { recursive: true });
  copyFileSync(path.join(sharedRgbaRoot, "build/Release/shared_rgba.node"),
    path.join(destinationDirectory, "shared_rgba.node"));
}

const api = require("@spaceagetv/macadam");
const requiredFunctions = ["capture", "getDeviceInfo", "modeWidth", "modeHeight"];
const missingFunctions = requiredFunctions.filter((name) => typeof api[name] !== "function");
if (missingFunctions.length || !Number.isInteger(api.bmdFormat10BitYUV)) {
  throw new Error(`Macadam native API is incomplete${missingFunctions.length ? `: ${missingFunctions.join(", ")}` : "."}`);
}

const nativeSourcePaths = [
  path.join(macadamRoot, "src/capture_promise.h"),
  path.join(macadamRoot, "src/capture_promise.cc"),
];
const nativeAddonPath = path.join(macadamRoot, "build/Release/macadam.node");
const newestSourceMtime = Math.max(...nativeSourcePaths.map((filePath) => statSync(filePath).mtimeMs));
if (statSync(nativeAddonPath).mtimeMs < newestSourceMtime) {
  throw new Error("Macadam's native addon is older than the patched source; automatic input detection is not ready.");
}

process.stdout.write(`Macadam ${macadamPackage.version} is ready for Node ${process.version} (${process.platform}/${process.arch}).\n`);
