import { Context, type Effect, Option } from "effect";

import type { EdgeRuntimeScriptError } from "./edge-runtime-script.errors.ts";

/**
 * Printed to stderr when a pg-delta Deno template's body throws. The templates force the
 * edge-runtime worker to exit by throwing on both the success and failure paths, and that
 * non-zero exit is otherwise suppressed whenever stderr contains `"main worker has been
 * destroyed"`. Without this marker, a crashed script is indistinguishable from a successful
 * empty diff, so `db pull` would report "No schema changes found" while swallowing the real
 * error.
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
  /** Prefix for the failure message. */
  readonly errPrefix: string;
  /**
   * Effective `edge_runtime.deno_version` for this run, used to pick the image tag (`1` → the
   * `deno1` image). Lets a caller with the remote-merged config (e.g. `--linked` declarative
   * generate) override the layer's base-config default. Absent → the base-config value.
   */
  readonly denoVersion?: number;
  /**
   * The caller's authoritative target directory (e.g. `PgDeltaContext.cwd`), used to resolve the
   * `supabase/.temp/edge-runtime-version` image pin and, when `denoVersion` is absent, the
   * base-config fallback. Overrides the layer's own `CommandSettings.workdir`, needed because
   * that layer is built once, before a command's own `process.chdir` (e.g. `bootstrap`) runs.
   * Absent → the layer's `CommandSettings.workdir`.
   */
  readonly workdir?: string;
}

interface EdgeRuntimeRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface EdgeRuntimeScriptShape {
  /**
   * Runs a Deno program in the edge-runtime container and returns its captured stdout/stderr:
   * writes the files via a here-document entrypoint, starts `edge-runtime start
   * --main-service=.` on a free host port over the host network, and ignores a non-zero exit
   * whose stderr contains `"main worker has been destroyed"`.
   */
  readonly run: (
    opts: EdgeRuntimeRunOpts,
  ) => Effect.Effect<EdgeRuntimeRunResult, EdgeRuntimeScriptError>;
}

export class EdgeRuntimeScript extends Context.Service<EdgeRuntimeScript, EdgeRuntimeScriptShape>()(
  "supabase/cli/EdgeRuntimeScript",
) {}

/**
 * Builds the `edge-runtime start` argv. The HTTP listener binds a free host port so
 * concurrent/leftover host-network containers don't collide on the default port; `--verbose` is
 * added under `--debug`. A `None` port (allocation failed) drops the `--port` flag.
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
