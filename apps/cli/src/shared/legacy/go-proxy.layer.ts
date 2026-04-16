import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect, Layer } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { LegacyGoProxy } from "./go-proxy.service.ts";

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const PLATFORM_CANDIDATES: Partial<Record<string, Partial<Record<string, ReadonlyArray<string>>>>> =
  {
    darwin: { arm64: ["darwin-arm64"], x64: ["darwin-x64"] },
    linux: {
      arm64: ["linux-arm64", "linux-arm64-musl"],
      x64: ["linux-x64", "linux-x64-musl"],
    },
    win32: { x64: ["windows-x64"] },
  };

const require = createRequire(import.meta.url);

function resolveBinary(): string {
  const envBin = process.env["SUPABASE_GO_BINARY"];
  if (envBin) return envBin;

  const ext = process.platform === "win32" ? ".exe" : "";

  // When running as a compiled standalone SFE (exec'd by the base shim via execFileSync),
  // process.execPath is the SFE binary path. Look for supabase-go co-located next to it.
  const colocated = path.join(path.dirname(process.execPath), `supabase-go${ext}`);
  if (existsSync(colocated)) return colocated;

  // When running from source, resolve via installed npm packages.
  // Guard with existsSync — in dev the workspace stub packages exist but their bin/ is empty.
  const candidates = PLATFORM_CANDIDATES[process.platform]?.[os.arch()] ?? [];
  for (const suffix of candidates) {
    try {
      const pkgPath = path.dirname(require.resolve(`@supabase/cli-${suffix}/package.json`));
      const bin = path.join(pkgPath, "bin", `supabase-go${ext}`);
      if (existsSync(bin)) return bin;
    } catch {
      // Package not installed — try next candidate.
    }
  }

  // Fall back to `supabase` on PATH (useful in CI and development).
  return "supabase";
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

/**
 * Creates a LegacyGoProxy layer.
 *
 * In production use `legacyGoProxyLayer` (no options).
 *
 * In tests pass `{ cwd, env }` to run the binary in an isolated directory
 * with a controlled SUPABASE_HOME, so tests don't pollute the real home dir:
 *
 *   makeGoProxyLayer({
 *     cwd: projectDir,
 *     env: { SUPABASE_HOME: homeDir, SUPABASE_NO_KEYRING: "1", SUPABASE_TELEMETRY_DISABLED: "1" },
 *   })
 *
 * @public
 */
export function makeGoProxyLayer(opts?: {
  cwd?: string;
  env?: Record<string, string>;
  globalArgs?: ReadonlyArray<string>;
}): Layer.Layer<LegacyGoProxy, never, ProcessControl | ChildProcessSpawner> {
  return Layer.effect(
    LegacyGoProxy,
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const spawner = yield* ChildProcessSpawner;
      const binary = resolveBinary();
      const globalArgs = opts?.globalArgs ?? [];

      return LegacyGoProxy.of({
        exec: (args) =>
          Effect.gen(function* () {
            const command = ChildProcess.make(binary, [...globalArgs, ...args], {
              cwd: opts?.cwd,
              env: opts?.env,
              extendEnv: true,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
            const exitCode = yield* spawner.exitCode(command).pipe(Effect.orDie);
            if (exitCode !== 0) {
              yield* processControl.exit(exitCode);
            }
          }),
      });
    }),
  );
}
