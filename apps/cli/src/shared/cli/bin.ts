#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PLATFORMS: Record<string, Record<string, string[]>> = {
  darwin: { arm64: ["darwin-arm64"], x64: ["darwin-x64"] },
  linux: {
    arm64: ["linux-arm64", "linux-arm64-musl"],
    x64: ["linux-x64", "linux-x64-musl"],
  },
  win32: { arm64: ["windows-arm64"], x64: ["windows-x64"] },
};

const platformMap = PLATFORMS[process.platform];
if (!platformMap) throw new Error(`Unsupported platform: ${process.platform}`);
const candidates = platformMap[os.arch()];
if (!candidates) throw new Error(`Unsupported architecture: ${os.arch()} on ${process.platform}`);

const ext = process.platform === "win32" ? ".exe" : "";
const require = createRequire(import.meta.url);

// `SUPABASE_CLI_BINARY_OVERRIDE` lets tests and local dev point the shim at a
// specific compiled binary on disk, bypassing the optional-dependency lookup.
// This is the entrypoint the e2e harness uses to exercise the real shim +
// compiled binary handoff without publishing platform packages.
let binPath = process.env["SUPABASE_CLI_BINARY_OVERRIDE"];

if (!binPath) {
  for (const suffix of candidates) {
    try {
      const pkgPath = path.dirname(require.resolve(`@supabase/cli-${suffix}/package.json`));
      binPath = path.join(pkgPath, "bin", `supabase${ext}`);
      break;
    } catch {
      // package not installed — try next candidate
    }
  }
}

if (!binPath) {
  throw new Error(
    `No matching Supabase CLI binary package found for ${process.platform}-${os.arch()}`,
  );
}

// A terminal Ctrl-C signals the whole foreground group; the compiled binary
// owns signal semantics, so the shim only waits and mirrors its exit.
// Registering handlers disables the default terminate action even while
// execFileSync blocks the event loop.
const holdSignal = () => {};
const heldSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of heldSignals) process.on(signal, holdSignal);
try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  if (e && typeof e === "object" && "status" in e && typeof e.status === "number")
    process.exit(e.status);
  if (e && typeof e === "object" && "signal" in e && typeof e.signal === "string") {
    // Mirror a signal death so the parent shell sees the conventional 128+n.
    for (const signal of heldSignals) process.removeListener(signal, holdSignal);
    process.kill(process.pid, e.signal as NodeJS.Signals);
    setInterval(() => {}, 1_000); // keep the loop alive until it lands
  } else {
    throw e;
  }
} finally {
  for (const signal of heldSignals) process.removeListener(signal, holdSignal);
}
