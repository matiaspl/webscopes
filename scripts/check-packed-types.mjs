import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "webscopes-pack-consumer-"));

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", temp, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(temp, "npm-cache") },
  }))[0];
  const unpacked = join(temp, "package");
  execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);

  const dependencyDirectory = join(temp, "node_modules", "@webgpu");
  const consumerDirectory = join(temp, "consumer");
  const consumerModules = join(consumerDirectory, "node_modules");
  await mkdir(dependencyDirectory, { recursive: true });
  await mkdir(consumerModules, { recursive: true });
  await symlink(unpacked, join(consumerModules, "webscopes"), "dir");
  await symlink(join(root, "node_modules", "@webgpu", "types"), join(dependencyDirectory, "types"), "dir");

  await writeFile(join(consumerDirectory, "consumer.ts"), `
import { analyzeFrame, createScopes, getDefaultScopesConfig } from "webscopes";
import type { PixelFrame, ScopeOptions, V210Frame } from "webscopes";

const frame: PixelFrame = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1 };
analyzeFrame(frame, { backend: "cpu", colorMatrix: "bt709" });
const v210: V210Frame = { format: "v210", data: new Uint8Array(128), width: 6, height: 1 };
analyzeFrame(v210, { colorRange: "limited", waveformMode: "ycbcr-parade" });
void createScopes({ backend: "cpu" }).then((scopes) => scopes.update(v210, { colorRange: "full" }));
void createScopes({ backend: "cpu" });
const callerDevice = {} as GPUDevice;
const callerOptions: ScopeOptions = {
  backend: "webgpu",
  device: callerDevice,
  adapterOptions: { powerPreference: "low-power" },
};
void createScopes(callerOptions);
const defaults = getDefaultScopesConfig();
const frameDerivedWidth: number | undefined = defaults.waveformWidth;
void frameDerivedWidth;
`);
  await writeFile(join(consumerDirectory, "runtime.mjs"), `
import { analyzeFrame, createScopes, getDefaultScopesConfig } from "webscopes";
export { analyzeFrame, createScopes, getDefaultScopesConfig };
`);

  execFileSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "false",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--lib",
    "ES2022,DOM",
    "consumer.ts",
  ], { cwd: consumerDirectory, stdio: "inherit" });

  const consumer = await import(pathToFileURL(join(consumerDirectory, "runtime.mjs")));
  if (!["analyzeFrame", "createScopes", "getDefaultScopesConfig"].every((name) => typeof consumer[name] === "function")) {
    throw new Error("Packed ESM package is missing expected public exports");
  }
  process.stdout.write("Packed package type check and ESM import passed.\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
