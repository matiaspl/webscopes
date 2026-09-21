import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error("Run this setup with `npm run setup:native`.");

const electronRoot = path.dirname(require.resolve("electron"));
const electronInstall = spawnSync(process.execPath, [path.join(electronRoot, "install.js")], {
  cwd: sampleRoot,
  stdio: "inherit",
});
if (electronInstall.error) throw electronInstall.error;
if (electronInstall.status !== 0) process.exit(electronInstall.status ?? 1);

// The addon runs in the isolated Node helper, not Electron. Its N-API build
// does not need Electron's ABI, but lifecycle scripts are disabled by .npmrc.
const rebuild = spawnSync(process.execPath, [npmCli, "rebuild", "@spaceagetv/macadam", "--ignore-scripts=false"], {
  cwd: sampleRoot,
  stdio: "inherit",
});
if (rebuild.error) throw rebuild.error;
if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);

const macadamRoot = path.dirname(require.resolve("@spaceagetv/macadam"));
const macadamPackage = JSON.parse(readFileSync(path.join(macadamRoot, "package.json"), "utf8"));
if (macadamPackage.version !== "2.1.1") {
  throw new Error(`Expected Macadam 2.1.1, found ${macadamPackage.version}.`);
}

const api = require("@spaceagetv/macadam");
const requiredFunctions = ["capture", "getDeviceInfo", "modeWidth", "modeHeight"];
const missingFunctions = requiredFunctions.filter((name) => typeof api[name] !== "function");
if (missingFunctions.length || !Number.isInteger(api.bmdFormat10BitYUV)) {
  throw new Error(`Macadam native API is incomplete${missingFunctions.length ? `: ${missingFunctions.join(", ")}` : "."}`);
}

process.stdout.write(`Macadam ${macadamPackage.version} is ready for Node ${process.version} (${process.platform}/${process.arch}).\n`);
