import { $ } from "bun";
import { BunPath, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import * as EffectPath from "effect/Path";
import process from "node:process";
import { parseArgs } from "node:util";
import { verifyMacSignature } from "./helpers/macos-signature.ts";
import { createTmpDir, describeError, runNpmTest } from "./helpers/npm-registry.ts";
import { verifyExpectedShell } from "./helpers/release-shell.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const { resolve, join } = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));
const log = (message: string): void => Effect.runSync(Effect.log(message));
const logError = (message: string): void => Effect.runSync(Effect.logError(message));
const exists = (path: string): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.exists(path);
    }).pipe(Effect.provide(BunServices.layer)),
  );
const makeDirectory = (path: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer)),
  );

const version = values.version!;
const tag = values.tag;
if (tag !== "latest" && tag !== "alpha" && tag !== "beta") {
  logError(`Invalid --tag value: ${String(tag)}. Expected "latest", "alpha", or "beta".`);
  process.exit(1);
}
const root = resolve(import.meta.dir, "../../..");

interface TestResult {
  name: string;
  status: "pass" | "fail";
}

const results: TestResult[] = [];

// --- Native ---

log(`\n${"=".repeat(60)}`);
log("Native binary tests");
log("=".repeat(60));

{
  const arch = process.arch; // "arm64" or "x64"
  const name = `native-darwin-${arch}`;
  const binPath = join(root, "packages", `cli-darwin-${arch}`, "bin", "supabase");

  log(`[${name}] Running ${binPath} --version...`);
  try {
    const output = await $`${binPath} --version`.text();
    const trimmed = output.trim();
    const shellCheck = await verifyExpectedShell(binPath);
    const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;
    log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);
    log(`[${name}] ${shellCheck.detail}`);
    results.push({ name, status: passed ? "pass" : "fail" });
  } catch (e) {
    log(`[${name}] FAIL —\n${describeError(e)}`);
    results.push({ name, status: "fail" });
  }
}

// --- Native signature ---

{
  const arch = process.arch; // "arm64" or "x64"
  const binDir = join(root, "packages", `cli-darwin-${arch}`, "bin");
  const binaries = ["supabase"];
  if (await exists(join(binDir, "supabase-go"))) {
    binaries.push("supabase-go");
  }

  for (const binary of binaries) {
    const name = `native-darwin-${arch}-signature-${binary}`;
    const binPath = join(binDir, binary);
    log(`[${name}] Verifying signature of ${binPath}...`);
    try {
      const sig = await verifyMacSignature(binPath);
      log(`[${name}] ${sig.passed ? "PASS" : "FAIL"} — ${sig.detail}`);
      results.push({ name, status: sig.passed ? "pass" : "fail" });
    } catch (e) {
      log(`[${name}] FAIL —\n${describeError(e)}`);
      results.push({ name, status: "fail" });
    }
  }
}

// --- npm ---

log(`\n${"=".repeat(60)}`);
log("npm (Verdaccio) test");
log("=".repeat(60));

try {
  const npmPassed = await runNpmTest(version, tag);
  results.push({ name: "npm", status: npmPassed ? "pass" : "fail" });
} catch (e) {
  logError(`[npm] Error:\n${describeError(e)}`);
  results.push({ name: "npm", status: "fail" });
}

// --- Brew ---

log(`\n${"=".repeat(60)}`);
log("Homebrew test");
log("=".repeat(60));

const hasBrew = await $`brew --version`.quiet().then(
  () => true,
  () => false,
);

if (!hasBrew) {
  log("[brew] SKIP — brew not found");
} else {
  try {
    // Generate the formula with local file:// URLs
    log("Generating Homebrew formula...");
    await $`bun run apps/cli/scripts/update-homebrew.ts --version ${version} --local`.cwd(root);

    // Create a local git-backed tap
    await using tap = await createTmpDir("brew-smoke-");
    await makeDirectory(join(tap.path, "Formula"));
    await $`cp ${join(root, "dist", "supabase.rb")} ${join(tap.path, "Formula", "supabase.rb")}`;
    await $`git -C ${tap.path} init`.quiet();
    await $`git -C ${tap.path} add .`.quiet();
    await $`git -C ${tap.path} commit -m init`.quiet();

    log("Installing via Homebrew...");
    await $`brew tap --force supabase/test-tap ${tap.path}`;

    try {
      await $`brew install supabase/test-tap/supabase`;

      const output = await $`supabase --version`.text();
      const trimmed = output.trim();
      const shellCheck = await verifyExpectedShell("supabase");
      const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;

      log(`[brew] ${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`);
      log(`[brew] ${shellCheck.detail}`);
      results.push({ name: "brew", status: passed ? "pass" : "fail" });
    } finally {
      await $`brew uninstall supabase`.nothrow();
      await $`brew untap supabase/test-tap`.nothrow();
    }
  } catch (e) {
    logError(`[brew] Error:\n${describeError(e)}`);
    results.push({ name: "brew", status: "fail" });
  }
}

// --- Summary ---

log(`\n${"=".repeat(60)}`);
log("macOS Smoke Test Summary");
log("=".repeat(60));

for (const r of results) {
  log(`  ${r.status === "pass" ? "PASS" : "FAIL"}  ${r.name}`);
}

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;

log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

if (failed > 0) {
  process.exit(1);
}
