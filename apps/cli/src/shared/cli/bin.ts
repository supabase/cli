#!/usr/bin/env node
import { spawn } from "node:child_process";
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

// The compiled binary owns signal semantics, so the shim never dies to a
// signal's default action while the child runs: a group signal (terminal
// Ctrl-C) already reaches the child directly, and a signal sent to the shim
// PID alone (a supervisor's kill) is forwarded so cancellation still lands.
// Either way the shim just waits and mirrors the child's exit.
const child = spawn(binPath, process.argv.slice(2), { stdio: "inherit" });
const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const forwarders = forwardedSignals.map((signal) => {
  const forward = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on(signal, forward);
  return [signal, forward] as const;
});
child.on("error", (error) => {
  for (const [signal, forward] of forwarders) process.removeListener(signal, forward);
  throw error;
});
child.on("exit", (code, signal) => {
  for (const [sig, forward] of forwarders) process.removeListener(sig, forward);
  if (signal !== null) {
    // Mirror a signal death so the parent shell sees the conventional 128+n.
    process.kill(process.pid, signal);
    setInterval(() => {}, 1_000); // keep the loop alive until it lands
    return;
  }
  process.exit(code ?? 1);
});
