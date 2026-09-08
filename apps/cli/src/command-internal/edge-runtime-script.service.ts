import { Context, type Effect, Option } from "effect";

import type { EdgeRuntimeScriptError } from "./edge-runtime-script.errors.ts";

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
export const EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL = "PGDELTA_SCRIPT_ERROR";

/** A file dropped alongside `index.ts` in the container's working directory. */
export interface EdgeRuntimeFile {
  readonly name: string;
  readonly content: string;
}

export interface EdgeRuntimeRunOpts {
  /** The `index.ts` program (already version-interpolated for pg-delta). */
  readonly script: string;
  /** Container env (`KEY` → value). */
  readonly env: Readonly<Record<string, string>>;
  /** Volume binds (e.g. the Deno cache volume + `cwd:/workspace`). */
  readonly binds: ReadonlyArray<string>;
  /** Prefix for the failure message, matching `errPrefix`. */
  readonly errPrefix: string;
  /**
   * Effective `edge_runtime.deno_version` for this run, used to pick the image tag
   * (`1` → the `deno1` image). Lets a caller that has the remote-merged config (e.g.
   * `--linked` declarative generate) override the layer's base-config default so
   * pg-delta runs under the configured Deno version. Absent → the base-config value.
   */
  readonly denoVersion?: number;
  /**
   * The caller's authoritative target directory (e.g. `PgDeltaContext.cwd`),
   * used to resolve the `supabase/.temp/edge-runtime-version` image pin (and, when
   * `denoVersion` is absent, the base-config fallback read). Overrides the layer's
   * own `CommandSettings.workdir` — needed because that layer is built once, before
   * a command's own `process.chdir` (e.g. `bootstrap`, whose real target directory
   * only exists after its handler runs). Absent → the layer's `CommandSettings.workdir`.
   */
  readonly workdir?: string;
}

interface EdgeRuntimeRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface EdgeRuntimeScriptShape {
  /**
   * Runs a Deno program in the edge-runtime container and returns its captured
   * stdout/stderr. Mirrors `RunEdgeRuntimeScript`
   * (`apps/cli-go/internal/utils/edgeruntime.go`): writes the files via a
   * here-document entrypoint, starts `edge-runtime start --main-service=.` on a
   * free host port over the host network, and ignores a non-zero exit whose
   * stderr contains `"main worker has been destroyed"`.
   */
  readonly run: (
    opts: EdgeRuntimeRunOpts,
  ) => Effect.Effect<EdgeRuntimeRunResult, EdgeRuntimeScriptError>;
}

export class EdgeRuntimeScript extends Context.Service<EdgeRuntimeScript, EdgeRuntimeScriptShape>()(
  "supabase/cli/EdgeRuntimeScript",
) {}

/**
 * Builds the `edge-runtime start` argv. Mirrors `EdgeRuntimeStartCmd` +
 * the `--verbose` append in `RunEdgeRuntimeScript`: the HTTP listener binds a
 * free host port so concurrent/leftover host-network containers don't collide
 * on the default port (supabase/cli#5407). `--verbose` is added under `--debug`.
 * A `None` port (allocation failed) drops the flag, preserving prior behaviour.
 */
export function buildEdgeRuntimeStartCmd(opts: {
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
 * (so contents may contain `EOF`) and then `exec`s `cmd` so edge-runtime is
 * PID 1 and an early `docker stop` reaches it directly.
 */
export function buildEdgeRuntimeEntrypoint(
  files: ReadonlyArray<EdgeRuntimeFile>,
  cmd: string,
): string {
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
