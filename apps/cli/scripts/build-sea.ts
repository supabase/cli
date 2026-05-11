/**
 * Node Single Executable Application (SEA) PoC build script.
 *
 * Pipeline:
 *   1. esbuild bundles `sea-poc-entry.ts` into a single CJS file (SEA does not support ESM).
 *   2. Node generates a SEA blob from the bundle via `--experimental-sea-config`.
 *   3. The host `node` binary is copied to `dist/sea/supabase-sea`.
 *   4. `postject` injects the blob into the copy under the `NODE_SEA_BLOB` resource.
 *
 * Run with:  pnpm exec bun apps/cli/scripts/build-sea.ts
 *
 * Limitations (intentional for the PoC):
 *   - Linux/macOS only here; Windows would also need `signtool` removal and the
 *     `Mach-O` arg for postject is omitted (would be `--macho-segment-name NODE_SEA`).
 *   - Native modules (e.g. `@napi-rs/keyring`) are NOT packed; the bundle would
 *     `require()` them at runtime and fail. The current entry deliberately avoids them.
 */
import { $ } from "bun";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dir, "../../..");
const outDir = path.join(root, "apps/cli/dist/sea");
const entry = path.join(root, "apps/cli/scripts/sea-poc-entry.ts");
const esbuildBin = path.join(root, "apps/cli/node_modules/.bin/esbuild");
const postjectBin = path.join(root, "apps/cli/node_modules/.bin/postject");
const bundle = path.join(outDir, "sea-poc.cjs");
const seaConfig = path.join(outDir, "sea-config.json");
const seaBlob = path.join(outDir, "sea-poc.blob");
const ext = process.platform === "win32" ? ".exe" : "";
const binary = path.join(outDir, `supabase-sea${ext}`);

const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// process.execPath under Bun points to the Bun binary — we need the host Node
// binary (which contains the SEA fuse sentinel postject must find).
const nodeBin = Bun.which("node");
if (!nodeBin) throw new Error("`node` not found on PATH — required as the SEA host binary.");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

console.log("[1/4] esbuild bundle -> CJS");
await $`${esbuildBin} ${entry} --bundle --platform=node --target=node22 --format=cjs --minify --outfile=${bundle}`.cwd(root);

const bundleSize = (await stat(bundle)).size;
console.log(`       bundle: ${(bundleSize / 1024).toFixed(1)} KiB`);

console.log("[2/4] sea config + blob");
await writeFile(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
);
await $`node --experimental-sea-config ${seaConfig}`;

const blobSize = (await stat(seaBlob)).size;
console.log(`       blob: ${(blobSize / 1024).toFixed(1)} KiB`);

console.log(`[3/4] copy host node binary (${nodeBin})`);
const cpResult = Bun.spawnSync(["/bin/cp", nodeBin, binary]);
if (cpResult.exitCode !== 0) throw new Error(`cp failed: ${cpResult.exitCode}`);
await $`chmod +w ${binary}`;

console.log("[4/4] postject inject");
const postjectArgs = [
  binary,
  "NODE_SEA_BLOB",
  seaBlob,
  "--sentinel-fuse",
  SENTINEL,
];
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
await $`${postjectBin} ${postjectArgs}`.cwd(root);

const binarySize = (await stat(binary)).size;
console.log(`\nbinary: ${binary}`);
console.log(`size:   ${(binarySize / (1024 * 1024)).toFixed(2)} MiB`);
console.log(`run:    ${binary} hello sea\n`);
