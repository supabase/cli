import { createRequire } from "node:module";
import os from "node:os";
import process from "node:process";
import { Config, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { resolveWorkdir } from "../config/command-settings.layer.ts";
import { CLI_VERSION } from "../shared/cli/version.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { GoChildExitError } from "./go-child-exit.error.ts";
import { GoProxyInvocation } from "./go-proxy-invocation.ts";
import { GoProxy } from "./go-proxy.service.ts";
import { readProjectLinkFile } from "./project-link.ts";
import { usesStackState } from "./stack-backend.ts";
import { shellEnv } from "./viper-env.ts";
import { withProcessSpan } from "../shared/telemetry/spans.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const markDelegated = Effect.serviceOption(GoProxyInvocation).pipe(
  Effect.flatMap((invocation) =>
    Option.isSome(invocation) ? invocation.value.markDelegated : Effect.void,
  ),
);

/**
 * Tells the Go child to leave `supabase/.temp` alone when the project keeps its state in
 * `$SUPABASE_HOME`, and hands it the linked project's identity as the JSON of its
 * `linked-project.json` record so it can still attribute telemetry. Read from the calling fiber,
 * like `markDelegated`.
 */
const makeStackStateEnv = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: Effect.Effect<string>,
): Effect.Effect<Record<string, string>> =>
  Effect.gen(function* (): Effect.fn.Return<Record<string, string>> {
    if (!(yield* usesStackState)) return {};
    const link = yield* readProjectLinkFile(fs, path, yield* workdir).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(link)) return { SUPABASE_INTERNAL_STACK_STATE: "1" };
    const { project } = link.value;
    return {
      SUPABASE_INTERNAL_STACK_STATE: "1",
      SUPABASE_INTERNAL_LINKED_PROJECT: yield* encodeJson({
        ref: project.ref,
        name: project.name ?? "",
        organization_id: project.organization_id ?? "",
        organization_slug: project.organization_slug ?? "",
      }).pipe(Effect.orDie),
    };
  });

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

const resolveBinary = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.fn.Return<BinaryResolution> {
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  const tried: string[] = [];

  const envBin = yield* shellEnv("SUPABASE_GO_BINARY");
  if (envBin) return { found: envBin };
  tried.push("$SUPABASE_GO_BINARY (unset)");

  const ext = process.platform === "win32" ? ".exe" : "";

  // When running as a compiled standalone binary (exec'd by the base shim), process.execPath is
  // this binary's own path; look for supabase-go co-located next to it.
  const colocated = path.join(path.dirname(process.execPath), `supabase-go${ext}`);
  if (yield* exists(colocated)) return { found: colocated };
  tried.push(`${colocated} (not found alongside the shim)`);

  // When running from source, resolve via installed npm packages.
  // Guard with exists — in dev the workspace stub packages exist but their bin/ is empty.
  const candidates = PLATFORM_CANDIDATES[process.platform]?.[os.arch()] ?? [];
  for (const suffix of candidates) {
    const pkgJson = yield* Effect.try(() =>
      require.resolve(`@supabase/cli-${suffix}/package.json`),
    ).pipe(Effect.option);
    if (Option.isNone(pkgJson)) {
      tried.push(`@supabase/cli-${suffix} (npm package not installed)`);
      continue;
    }
    const bin = path.join(path.dirname(pkgJson.value), "bin", `supabase-go${ext}`);
    if (yield* exists(bin)) return { found: bin };
    tried.push(`${bin} (npm package present, binary missing)`);
  }

  return { notFound: tried };
});

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
   * The `--workdir` the user passed, which locates the project link handed to stack-mode children.
   */
  workdir?: Option.Option<string>;
  /**
   * Let the parent emit its success tail after re-emitting captured stdout.
   */
  parentOwnsCapturedSuccessTail?: boolean;
  /**
   * Override binary resolution. Primarily a test seam so specs don't have to
   * pin `SUPABASE_GO_BINARY` or stub the filesystem:
   *  - `string`              — treat as the resolved Go binary path.
   *  - `{ notFound: [...] }` — simulate the not-found path; `.exec` will print
   *                            the diagnostic and fail with a non-zero exit code.
   *
   * In production, leave unset and let `resolveBinary()` pick the right
   * artifact for the host platform.
   */
  binary?: string | BinaryResolution;
}): Layer.Layer<
  GoProxy,
  never,
  ProcessControl | ChildProcessSpawner | FileSystem.FileSystem | Path.Path | RuntimeInfo
> {
  return Layer.effect(
    GoProxy,
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const spawner = yield* ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeInfo = yield* RuntimeInfo;
      const resolved: BinaryResolution =
        typeof opts?.binary === "string"
          ? { found: opts.binary }
          : (opts?.binary ?? (yield* resolveBinary(fs, path)));
      const globalArgs = opts?.globalArgs ?? [];
      const projectWorkdir = Effect.gen(function* () {
        const envValue = yield* Config.option(Config.String("SUPABASE_WORKDIR")).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        );
        const { workdir } = yield* resolveWorkdir(
          opts?.workdir ?? Option.none(),
          envValue,
          opts?.cwd ?? runtimeInfo.cwd,
          (candidate) => fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
          path,
        );
        return workdir;
      });
      const stackStateEnv = makeStackStateEnv(fs, path, projectWorkdir);

      return GoProxy.of({
        exec: (args, execOpts) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (!("found" in resolved)) {
                yield* Effect.sync(() => {
                  process.stderr.write(`${formatGoBinaryNotFoundError(resolved.notFound)}\n`);
                });
                return yield* new GoChildExitError({
                  exitCode: 1,
                  message: "supabase-go binary not found",
                });
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
                ...(yield* stackStateEnv),
              };
              const argv = [...globalArgs, ...args];
              const exitCode = yield* withProcessSpan(
                "GoProxy.exec",
                { executable: binary, argCount: argv.length },
                (traceEnv) =>
                  spawner
                    .exitCode(
                      ChildProcess.make(binary, argv, {
                        cwd: execOpts?.cwd ?? opts?.cwd,
                        env: { ...env, ...traceEnv },
                        extendEnv: true,
                        stdin: "inherit",
                        stdout: "inherit",
                        stderr: "inherit",
                        detached: false,
                      }),
                    )
                    .pipe(Effect.orDie),
              );
              if (exitCode !== 0) {
                return yield* new GoChildExitError({
                  exitCode,
                  message: `supabase-go exited with code ${exitCode} (see stderr for details)`,
                });
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
                return yield* new GoChildExitError({
                  exitCode: 1,
                  message: "supabase-go binary not found",
                });
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
                ...(yield* stackStateEnv),
              };
              // Capture stdout while keeping stderr inherited, so progress still reaches the user
              // while stdout is collected for wrapping. Callers pass stdin: "ignore" to give the
              // child a non-TTY stdin so it can't block on a prompt before the wrapper emits its
              // machine-output envelope.
              const argv = [...globalArgs, ...args];
              const { captured, exitCode } = yield* withProcessSpan(
                "GoProxy.execCapture",
                { executable: binary, argCount: argv.length },
                (traceEnv) =>
                  Effect.gen(function* () {
                    const handle = yield* spawner.spawn(
                      ChildProcess.make(binary, argv, {
                        cwd: execOpts?.cwd ?? opts?.cwd,
                        env: { ...env, ...traceEnv },
                        extendEnv: true,
                        stdin: execOpts?.stdin ?? "inherit",
                        stdout: "pipe",
                        stderr: "inherit",
                        detached: false,
                      }),
                    );
                    // Drain stdout fully before awaiting exit so a full pipe buffer can't
                    // deadlock the child.
                    const captured = yield* Stream.mkString(Stream.decodeText(handle.stdout));
                    const exitCode = yield* handle.exitCode;
                    return { captured, exitCode };
                  }).pipe(Effect.orDie),
                (result) => result.exitCode,
              );
              if (exitCode !== 0) {
                return yield* new GoChildExitError({
                  exitCode,
                  message: `supabase-go exited with code ${exitCode} (see stderr for details)`,
                });
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
