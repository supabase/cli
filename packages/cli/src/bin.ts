#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const PLATFORMS: Record<string, Record<string, string[]>> = {
  darwin: { arm64: ["darwin-arm64"], x64: ["darwin-x64"] },
  linux: {
    arm64: ["linux-arm64", "linux-arm64-musl"],
    x64: ["linux-x64", "linux-x64-musl"],
  },
  win32: { x64: ["windows-x64"] },
};

const platformMap = PLATFORMS[process.platform];
if (!platformMap) throw new Error(`Unsupported platform: ${process.platform}`);
const candidates = platformMap[os.arch()];
if (!candidates) throw new Error(`Unsupported architecture: ${os.arch()} on ${process.platform}`);

const ext = process.platform === "win32" ? ".exe" : "";
const require = createRequire(import.meta.url);

let binPath: string | undefined;
for (const suffix of candidates) {
  try {
    const pkgPath = path.dirname(require.resolve(`@supabase/cli-${suffix}/package.json`));
    binPath = path.join(pkgPath, "bin", `supabase${ext}`);
    break;
  } catch {
    // package not installed — try next candidate
  }
}

if (!binPath) {
  throw new Error(
    `No matching Supabase CLI binary package found for ${process.platform}-${os.arch()}`,
  );
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  if (e && typeof e === "object" && "status" in e && typeof e.status === "number")
    process.exit(e.status);
  throw e;
}
