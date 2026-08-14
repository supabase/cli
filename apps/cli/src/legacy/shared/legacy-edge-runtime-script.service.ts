import { Context, type Effect, Option } from "effect";

import type { LegacyEdgeRuntimeScriptError } from "./legacy-edge-runtime-script.errors.ts";

/**
 * Printed to stderr by the pg-delta Deno templates when their body throws (see
 * the `catch` blocks in `apps/cli-go/internal/db/diff/templates/*.ts`). The
 * templates force the edge-runtime worker to exit by throwing on both the
 * success and failure paths, and that non-zero exit is otherwise suppressed when
 * stderr contains `"main worker has been destroyed"`. Without a distinct marker
 * a crashed script is indistinguishable from a successful empty diff, so
 * `db pull` reports "No schema changes found" while the real error is swallowed.
 * Byte-for-byte mirror of `EdgeRuntimeScriptErrorSentinel`
 * (`apps/cli-go/internal/utils/edgeruntime.go`). See supabase/cli#5826.
 */
export const LEGACY_EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL = "PGDELTA_SCRIPT_ERROR";

/** A file dropped alongside `index.ts` in the container's working directory. */
export interface LegacyEdgeRuntimeFile {
  readonly name: string;
  readonly content: string;
}

export interface LegacyEdgeRuntimeRunOpts {
  /** The `index.ts` program (already version-interpolated for pg-delta). */
  readonly script: string;
  /** Container env (`KEY` → value); merged with `extraEnv`. */
  readonly env: Readonly<Record<string, string>>;
  /** Volume binds (e.g. the Deno cache volume + `cwd:/workspace`). */
  readonly binds: ReadonlyArray<string>;
  /** Prefix for the failure message, matching `errPrefix`. */
  readonly errPrefix: string;
  /** Extra files written next to `index.ts` (e.g. `.npmrc`). */
  readonly extraFiles?: ReadonlyArray<LegacyEdgeRuntimeFile>;
  /** Extra container env appended after `env` (`WithExtraEnv`). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * Effective `edge_runtime.deno_version` for this run, used to pick the image tag
   * (`1` → the `deno1` image). Lets a caller that has the remote-merged config (e.g.
   * `--linked` declarative generate) override the layer's base-config default so
   * pg-delta runs under the configured Deno version. Absent → the base-config value.
   */
  readonly denoVersion?: number;
  /**
   * The caller's authoritative target directory (e.g. `LegacyPgDeltaContext.cwd`),
   * used to resolve the `supabase/.temp/edge-runtime-version` image pin (and, when
   * `denoVersion` is absent, the base-config fallback read). Overrides the layer's
   * own `LegacyCliConfig.workdir` — needed because that layer is built once, before
   * a command's own `process.chdir` (e.g. `bootstrap`, whose real target directory
   * only exists after its handler runs). Absent → the layer's `LegacyCliConfig.workdir`.
   */
  readonly workdir?: string;
}

export interface LegacyEdgeRuntimeRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface LegacyEdgeRuntimeScriptShape {
  /**
   * Runs a Deno program in the edge-runtime container and returns its captured
   * stdout/stderr. Mirrors `RunEdgeRuntimeScript`
   * (`apps/cli-go/internal/utils/edgeruntime.go`): writes the files via a
   * here-document entrypoint, starts `edge-runtime start --main-service=.` on a
   * free host port over the host network, and ignores a non-zero exit whose
   * stderr contains `"main worker has been destroyed"`.
   */
  readonly run: (
    opts: LegacyEdgeRuntimeRunOpts,
  ) => Effect.Effect<LegacyEdgeRuntimeRunResult, LegacyEdgeRuntimeScriptError>;
}

export class LegacyEdgeRuntimeScript extends Context.Service<
  LegacyEdgeRuntimeScript,
  LegacyEdgeRuntimeScriptShape
>()("supabase/legacy/EdgeRuntimeScript") {}

/**
 * Builds the `edge-runtime start` argv. Mirrors `EdgeRuntimeStartCmd` +
 * the `--verbose` append in `RunEdgeRuntimeScript`: the HTTP listener binds a
 * free host port so concurrent/leftover host-network containers don't collide
 * on the default port (supabase/cli#5407). `--verbose` is added under `--debug`.
 * A `None` port (allocation failed) drops the flag, preserving prior behaviour.
 */
export function legacyBuildEdgeRuntimeStartCmd(opts: {
  readonly port: Option.Option<number>;
  readonly debug: boolean;
}): ReadonlyArray<string> {
  const cmd = ["edge-runtime", "start", "--main-service=."];
  if (Option.isSome(opts.port)) cmd.push(`--port=${opts.port.value}`);
  if (opts.debug) cmd.push("--verbose");
  return cmd;
}

/**
 * Builds the `sh -c` entrypoint body that writes each file via a here-document
 * (so contents may contain `EOF`) and then runs `cmd`. Byte-for-byte port of
 * `buildEdgeRuntimeEntrypoint` (`apps/cli-go/internal/utils/edgeruntime.go`):
 * all heredoc openers are joined with `&&` before the bodies so the shell stacks
 * them in declaration order; each body ends with a unique sentinel.
 */
export function legacyBuildEdgeRuntimeEntrypoint(
  files: ReadonlyArray<LegacyEdgeRuntimeFile>,
  cmd: string,
): string {
  // `exec` diverges from Go's byte-for-byte script on purpose: edge-runtime (not `sh`) becomes
  // PID 1, so an early `docker stop`/`rm -f` SIGTERM reaches it directly instead of burning the
  // 10s grace period. These containers are `--rm` and normally exit on their own, so this is a
  // cancellation-latency nicety, not a stop-path requirement. Timing is outside the Go-parity
  // surface (ADR 0016).
  if (files.length === 0) return `exec ${cmd}\n`;
  let head = "";
  let bodies = "";
  files.forEach((file, index) => {
    const sentinel = `__EDGE_RT_FILE_${index}__`;
    head += `cat <<'${sentinel}' > ${file.name} && `;
    bodies += `${file.content}\n${sentinel}\n`;
  });
  return `${head}exec ${cmd}\n${bodies}`;
}
