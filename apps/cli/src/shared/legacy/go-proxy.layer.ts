import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect, Layer, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { CLI_VERSION } from "../cli/version.ts";
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
    win32: { arm64: ["windows-arm64"], x64: ["windows-x64"] },
  };

const require = createRequire(import.meta.url);

/**
 * Outcome of looking up `supabase-go`. The `notFound` variant carries the
 * list of locations the resolver checked so the user-facing error can be
 * specific about what was tried — no silent fallback that fork-bombs the
 * shim against itself via PATH (CLI-1488).
 */
export type BinaryResolution =
  | { readonly found: string }
  | { readonly notFound: ReadonlyArray<string> };

export function resolveBinary(): BinaryResolution {
  const tried: string[] = [];

  const envBin = process.env["SUPABASE_GO_BINARY"];
  if (envBin) return { found: envBin };
  tried.push("$SUPABASE_GO_BINARY (unset)");

  const ext = process.platform === "win32" ? ".exe" : "";

  // When running as a compiled standalone SFE (exec'd by the base shim via execFileSync),
  // process.execPath is the SFE binary path. Look for supabase-go co-located next to it.
  const colocated = path.join(path.dirname(process.execPath), `supabase-go${ext}`);
  if (existsSync(colocated)) return { found: colocated };
  tried.push(`${colocated} (not found alongside the shim)`);

  // When running from source, resolve via installed npm packages.
  // Guard with existsSync — in dev the workspace stub packages exist but their bin/ is empty.
  const candidates = PLATFORM_CANDIDATES[process.platform]?.[os.arch()] ?? [];
  for (const suffix of candidates) {
    try {
      const pkgPath = path.dirname(require.resolve(`@supabase/cli-${suffix}/package.json`));
      const bin = path.join(pkgPath, "bin", `supabase-go${ext}`);
      if (existsSync(bin)) return { found: bin };
      tried.push(`${bin} (npm package present, binary missing)`);
    } catch {
      tried.push(`@supabase/cli-${suffix} (npm package not installed)`);
    }
  }

  return { notFound: tried };
}

/**
 * Build a concrete `curl | tar` install snippet for the host platform, using
 * the version baked into this shim at build time (`CLI_VERSION`). The release
 * pipeline ships a `.tar.gz` for every (platform, arch) pair we support —
 * including Windows — so the snippet is uniform across hosts. Returns null
 * only when CLI_VERSION is the dev sentinel (we have no concrete URL) or the
 * host arch isn't one the release pipeline targets.
 */
function reinstallTarballSnippet(): ReadonlyArray<string> | null {
  if (CLI_VERSION === "0.0.0-dev") return null;
  const archSuffix = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (archSuffix === null) return null;
  // Map Node's `process.platform` to the release asset's OS slug. `win32` is
  // historical (Win16 vs Win32); GitHub assets use the modern `windows` slug.
  const osSlug = process.platform === "win32" ? "windows" : process.platform;
  const asset = `supabase_${CLI_VERSION}_${osSlug}_${archSuffix}.tar.gz`;
  return [
    `      mkdir -p "$HOME/.local/share/supabase"`,
    `      curl -sL https://github.com/supabase/cli/releases/download/v${CLI_VERSION}/${asset} \\`,
    `        | tar -xzf - -C "$HOME/.local/share/supabase"`,
    `      export PATH="$HOME/.local/share/supabase:$PATH"`,
  ];
}

export function formatGoBinaryNotFoundError(tried: ReadonlyArray<string>): string {
  const snippet = reinstallTarballSnippet();
  return [
    "Could not find the `supabase-go` binary.",
    "",
    "The Supabase CLI ships as two co-located binaries: `supabase` (this shim)",
    "and `supabase-go` (the Go CLI that the shim forwards to). The shim looked",
    "for `supabase-go` in:",
    "",
    ...tried.map((line) => `  • ${line}`),
    "",
    "To fix, do one of:",
    "  • Extract the release tarball into a directory and add the directory to",
    "    PATH (do not move `supabase` somewhere `supabase-go` doesn't follow).",
    ...(snippet === null ? [] : ["    For example, on this host:", "", ...snippet, ""]),
    "  • Install via npm: `npm i -g supabase`.",
    "  • Set SUPABASE_GO_BINARY to the absolute path of `supabase-go`.",
  ].join("\n");
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
  /**
   * Override binary resolution. Primarily a test seam so specs don't have to
   * mutate `process.env.SUPABASE_GO_BINARY` or stub the filesystem:
   *  - `string`              — treat as the resolved Go binary path.
   *  - `{ notFound: [...] }` — simulate the not-found path; `.exec` will
   *                            print the diagnostic and exit non-zero.
   *
   * In production, leave unset and let `resolveBinary()` pick the right
   * artifact for the host platform.
   */
  binary?: string | BinaryResolution;
}): Layer.Layer<LegacyGoProxy, never, ProcessControl | ChildProcessSpawner> {
  return Layer.effect(
    LegacyGoProxy,
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const spawner = yield* ChildProcessSpawner;
      const resolved: BinaryResolution =
        typeof opts?.binary === "string"
          ? { found: opts.binary }
          : (opts?.binary ?? resolveBinary());
      const globalArgs = opts?.globalArgs ?? [];

      return LegacyGoProxy.of({
        exec: (args, execOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (!("found" in resolved)) {
                // CLI-1488: never silently fall back to `supabase` on PATH —
                // when the shim is on PATH and `supabase-go` is not co-located,
                // that fallback resolves to the shim itself and fork-bombs.
                // Print a specific diagnostic and exit non-zero instead.
                yield* Effect.sync(() => {
                  process.stderr.write(`${formatGoBinaryNotFoundError(resolved.notFound)}\n`);
                });
                yield* processControl.exit(1);
                return;
              }
              const binary = resolved.found;

              // Hold the terminal-signals on the parent for the duration of
              // the child's lifetime. Rationale:
              //
              // 1. Effect's Node/Bun ChildProcessSpawner defaults
              //    `detached: true` on non-Windows (see NodeChildProcessSpawner.ts),
              //    which puts the child in its own process group and makes it
              //    miss tty signals. We explicitly pass `detached: false` below
              //    so Ctrl+C → SIGINT → foreground pgrp reaches the Go binary,
              //    and the Go CLI's own handlers (docker cleanup on `start`,
              //    context cancellation, etc.) run as expected.
              //
              // 2. Without a userland listener, Bun/Node default-terminates
              //    the parent on SIGINT with exit code 130, which would race
              //    the child's graceful shutdown and lose its real exit code.
              //    `processControl.holdSignals` installs no-op listeners that
              //    disable the default action so the parent stays blocked on
              //    `spawner.exitCode` and propagates the Go binary's exit
              //    status verbatim.
              //
              // Scoped via `Effect.scoped` so listeners are always removed on
              // normal completion, failure, or fiber interruption.
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              // Per-call env (execOpts.env) overlays the construction-time env;
              // `extendEnv: true` keeps both on top of the inherited process env.
              const env =
                opts?.env || execOpts?.env ? { ...opts?.env, ...execOpts?.env } : undefined;
              const command = ChildProcess.make(binary, [...globalArgs, ...args], {
                cwd: execOpts?.cwd ?? opts?.cwd,
                env,
                extendEnv: true,
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
                detached: false,
              });
              const exitCode = yield* spawner.exitCode(command).pipe(Effect.orDie);
              if (exitCode !== 0) {
                yield* processControl.exit(exitCode);
              }
            }),
          ),
        execCapture: (args, execOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (!("found" in resolved)) {
                yield* Effect.sync(() => {
                  process.stderr.write(`${formatGoBinaryNotFoundError(resolved.notFound)}\n`);
                });
                return yield* processControl.exit(1);
              }
              const binary = resolved.found;
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              const env =
                opts?.env || execOpts?.env ? { ...opts?.env, ...execOpts?.env } : undefined;
              // Capture stdout (pipe) while keeping stderr inherited, so the child's
              // progress still reaches the user but its stdout is collected for
              // wrapping rather than written to our stdout. stdin defaults to
              // inherited (interactive); callers pass `"ignore"` to give the child a
              // non-TTY stdin so it can't block on a prompt before the wrapper emits
              // its machine-output envelope.
              const command = ChildProcess.make(binary, [...globalArgs, ...args], {
                cwd: execOpts?.cwd ?? opts?.cwd,
                env,
                extendEnv: true,
                stdin: execOpts?.stdin ?? "inherit",
                stdout: "pipe",
                stderr: "inherit",
                detached: false,
              });
              const handle = yield* spawner.spawn(command).pipe(Effect.orDie);
              // Drain stdout fully before awaiting exit so a full pipe buffer can't
              // deadlock the child.
              const captured = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
                Effect.orDie,
              );
              const exitCode = yield* handle.exitCode.pipe(Effect.orDie);
              if (exitCode !== 0) {
                return yield* processControl.exit(exitCode);
              }
              return captured;
            }),
          ),
      });
    }),
  );
}
