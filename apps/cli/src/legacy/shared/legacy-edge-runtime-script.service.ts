import { Context, type Effect, Option } from "effect";

import type { LegacyEdgeRuntimeScriptError } from "./legacy-edge-runtime-script.errors.ts";

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
  /** Prefix for the failure message, matching Go's `errPrefix`. */
  readonly errPrefix: string;
  /** Extra files written next to `index.ts` (e.g. `.npmrc`). */
  readonly extraFiles?: ReadonlyArray<LegacyEdgeRuntimeFile>;
  /** Extra container env appended after `env` (Go's `WithExtraEnv`). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * Effective `edge_runtime.deno_version` for this run, used to pick the image tag
   * (`1` → the `deno1` image). Lets a caller that has the remote-merged config (e.g.
   * `--linked` declarative generate) override the layer's base-config default so
   * pg-delta runs under the configured Deno version. Absent → the base-config value.
   */
  readonly denoVersion?: number;
}

export interface LegacyEdgeRuntimeRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface LegacyEdgeRuntimeScriptShape {
  /**
   * Runs a Deno program in the edge-runtime container and returns its captured
   * stdout/stderr. Mirrors Go's `RunEdgeRuntimeScript`
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
 * Builds the `edge-runtime start` argv. Mirrors Go's `EdgeRuntimeStartCmd` +
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
 * Go's `buildEdgeRuntimeEntrypoint` (`apps/cli-go/internal/utils/edgeruntime.go`):
 * all heredoc openers are joined with `&&` before the bodies so the shell stacks
 * them in declaration order; each body ends with a unique sentinel.
 */
export function legacyBuildEdgeRuntimeEntrypoint(
  files: ReadonlyArray<LegacyEdgeRuntimeFile>,
  cmd: string,
): string {
  if (files.length === 0) return `${cmd}\n`;
  let head = "";
  let bodies = "";
  files.forEach((file, index) => {
    const sentinel = `__EDGE_RT_FILE_${index}__`;
    head += `cat <<'${sentinel}' > ${file.name} && `;
    bodies += `${file.content}\n${sentinel}\n`;
  });
  return `${head}${cmd}\n${bodies}`;
}
