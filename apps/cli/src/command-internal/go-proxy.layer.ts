import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect, Layer, Option, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { CLI_VERSION } from "../shared/cli/version.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { GoChildExitError } from "./go-child-exit.error.ts";
import { GoProxyInvocation } from "./go-proxy-invocation.ts";
import { GoProxy } from "./go-proxy.service.ts";

const markDelegated = Effect.serviceOption(GoProxyInvocation).pipe(
  Effect.flatMap((invocation) =>
    Option.isSome(invocation) ? invocation.value.markDelegated : Effect.void,
  ),
);

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
 * Outcome of looking up `supabase-go`. `notFound` carries every location checked, so the error can
 * be specific about what was tried, and callers never silently fall back to `supabase` on PATH
 * (which would resolve to this shim itself and fork-bomb).
 */
export type BinaryResolution =
  | { readonly found: string }
  | { readonly notFound: ReadonlyArray<string> };

function resolveBinary(): BinaryResolution {
  const tried: string[] = [];

  const envBin = process.env["SUPABASE_GO_BINARY"];
  if (envBin) return { found: envBin };
  tried.push("$SUPABASE_GO_BINARY (unset)");

  const ext = process.platform === "win32" ? ".exe" : "";

  // When running as a compiled standalone binary (exec'd by the base shim), process.execPath is
  // this binary's own path; look for supabase-go co-located next to it.
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
 * Builds a `curl | tar` install snippet for the host platform, using the version baked into this
 * shim at build time. Returns null when there's no concrete release URL (dev build) or the host
 * arch isn't one the release pipeline targets.
 */
function reinstallTarballSnippet(): ReadonlyArray<string> | null {
  if (CLI_VERSION === "0.0.0-dev") return null;
  const archSuffix = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (archSuffix === null) return null;
  // Node's `process.platform` is `win32`; GitHub release assets use the modern `windows` slug.
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

/**
 * Creates a GoProxy layer.
 *
 * In production use `goProxyLayer` (no options).
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
  /**
   * Extra env for every spawned child.
   */
  env?: Record<string, string>;
  globalArgs?: ReadonlyArray<string>;
  /**
   * Let the parent emit its success tail after re-emitting captured stdout.
   */
  parentOwnsCapturedSuccessTail?: boolean;
  /**
   * Override binary resolution. Primarily a test seam so specs don't have to
   * mutate `process.env.SUPABASE_GO_BINARY` or stub the filesystem:
   *  - `string`              — treat as the resolved Go binary path.
   *  - `{ notFound: [...] }` — simulate the not-found path; `.exec` will print
   *                            the diagnostic and fail with a non-zero exit code.
   *
   * In production, leave unset and let `resolveBinary()` pick the right
   * artifact for the host platform.
   */
  binary?: string | BinaryResolution;
}): Layer.Layer<GoProxy, never, ProcessControl | ChildProcessSpawner> {
  return Layer.effect(
    GoProxy,
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const spawner = yield* ChildProcessSpawner;
      const resolved: BinaryResolution =
        typeof opts?.binary === "string"
          ? { found: opts.binary }
          : (opts?.binary ?? resolveBinary());
      const globalArgs = opts?.globalArgs ?? [];

      return GoProxy.of({
        exec: (args, execOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (!("found" in resolved)) {
                yield* Effect.sync(() => {
                  process.stderr.write(`${formatGoBinaryNotFoundError(resolved.notFound)}\n`);
                });
                return yield* Effect.fail(
                  new GoChildExitError({
                    exitCode: 1,
                    message: "supabase-go binary not found",
                  }),
                );
              }
              const binary = resolved.found;

              // Hold terminal signals on the parent for the child's lifetime: the child spawner
              // defaults to `detached: true` on non-Windows, which would put the child in its own
              // process group and miss tty signals, so `detached: false` below lets Ctrl+C reach
              // the Go binary directly. Without a listener, Bun/Node would also default-terminate
              // the parent on SIGINT before the child's real exit code is known.
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              // Only an instrumented caller that delegates the whole command suppresses child
              // telemetry: the parent already emits `cli_command_executed` there. Pure proxy
              // commands have no parent event, so the child must stay free to report.
              const env = {
                ...opts?.env,
                ...execOpts?.env,
                ...(execOpts?.suppressChildTelemetry === true
                  ? { SUPABASE_TELEMETRY_DISABLED: "1" }
                  : {}),
              };
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
                return yield* Effect.fail(
                  new GoChildExitError({
                    exitCode,
                    message: `supabase-go exited with code ${exitCode} (see stderr for details)`,
                  }),
                );
              }
              yield* markDelegated;
            }),
          ),
        execCapture: (args, execOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (!("found" in resolved)) {
                yield* Effect.sync(() => {
                  process.stderr.write(`${formatGoBinaryNotFoundError(resolved.notFound)}\n`);
                });
                return yield* Effect.fail(
                  new GoChildExitError({
                    exitCode: 1,
                    message: "supabase-go binary not found",
                  }),
                );
              }
              const binary = resolved.found;
              yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
              // Same rule as `exec`: only an instrumented caller that owns the
              // parent `cli_command_executed` event suppresses child telemetry.
              const env = {
                ...opts?.env,
                ...execOpts?.env,
                ...(execOpts?.suppressChildTelemetry === true
                  ? { SUPABASE_TELEMETRY_DISABLED: "1" }
                  : {}),
                ...(opts?.parentOwnsCapturedSuccessTail === true
                  ? { SUPABASE_NO_UPDATE_NOTIFIER: "1" }
                  : {}),
              };
              // Capture stdout while keeping stderr inherited, so progress still reaches the user
              // while stdout is collected for wrapping. Callers pass stdin: "ignore" to give the
              // child a non-TTY stdin so it can't block on a prompt before the wrapper emits its
              // machine-output envelope.
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
                return yield* Effect.fail(
                  new GoChildExitError({
                    exitCode,
                    message: `supabase-go exited with code ${exitCode} (see stderr for details)`,
                  }),
                );
              }
              if (opts?.parentOwnsCapturedSuccessTail !== true) {
                yield* markDelegated;
              }
              return captured;
            }),
          ),
      });
    }),
  );
}
