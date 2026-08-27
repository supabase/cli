import { basename } from "node:path";
import { Effect, type FileSystem, type Path } from "effect";
import type { LoadedCliConfig } from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { normalizeProjectId } from "./functions-docker.ts";

/**
 * Everything the native `functions` Docker paths (`deploy`/`download`/`serve`)
 * need from project config resolution, unified across both shells. In the
 * legacy shell this also runs the same `Config.Validate`/dotenv pipeline
 * `start`/`stop`/`status` already go through — see {@link FunctionsGoConfigCompat}.
 * `next` keeps its existing plain `loadCliConfig` behavior exactly (no
 * Go-parity claim there).
 */
interface FunctionsCliConfigContext {
  readonly loaded: LoadedCliConfig | null;
  /** Go's post-`loadNestedEnv` merged env (ambient-wins). `undefined` in `next`. */
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /** Go's `Config.ProjectId`, sanitized, after `Config.Validate` in the legacy shell. */
  readonly projectId: string;
  readonly denoVersion: number | undefined;
}

/**
 * Legacy-shell-only Go-parity hook, injected so this file (used by both
 * shells) never imports `legacy/`-specific validation/dotenv machinery
 * directly — same isolation rationale as `download.ts`'s `styleEmphasis`/
 * `styleAqua`. `undefined` marks the `next` shell.
 *
 * A single method (not one hook per step) so the legacy implementation can
 * delegate its dotenv/config-load work to `legacy-local-project-context.ts`'s
 * `legacyLoadLocalProjectContext` end to end — the same pipeline `start`/
 * `stop`/`status` already share — rather than re-implementing it here.
 */
export interface FunctionsGoConfigCompat {
  readonly load: (input: {
    readonly projectRoot: string;
    readonly projectRef: string | undefined;
  }) => Effect.Effect<
    {
      readonly loaded: LoadedCliConfig | null;
      readonly projectEnvValues: Readonly<Record<string, string>>;
      readonly projectId: string;
      readonly denoVersion: number;
    },
    Error,
    FileSystem.FileSystem | Path.Path
  >;
}

/**
 * Go: `flags.LoadConfig` (`internal/utils/flags/config_path.go:10-14` ->
 * `pkg/config/config.go:579-611,878`) — loads dotenv, decodes config.toml
 * (merging template defaults + env even when the file is absent), and ends in
 * `Config.Validate`, unconditionally, before any Docker/API work. Only the
 * legacy shell (`goConfigCompat` set) runs that Go-parity dotenv/validate
 * pipeline; `next` keeps today's plain `loadCliConfig` behavior exactly.
 */
export const loadFunctionsCliConfig = Effect.fnUntraced(function* (input: {
  readonly projectRoot: string;
  readonly projectRef: string | undefined;
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
}) {
  if (input.goConfigCompat === undefined) {
    const loaded = yield* loadCliConfig(input.projectRoot, {
      ...(input.projectRef === undefined ? {} : { projectRef: input.projectRef }),
      goViperCompat: false,
    });
    return {
      loaded,
      projectEnvValues: undefined,
      // `input.projectRef` is a definite string for every current caller
      // (`deploy`/`download` always resolve one first); the `basename`
      // fallback only matters if this ever runs with `projectRef`
      // `undefined` and no `project_id` in the file — matching Go's `Eject`
      // basename default (`pkg/config/config.go:561-570`) and the legacy
      // branch's own `legacyResolveLocalProjectId` fallback below.
      // Sanitized like the legacy branch's (`legacySanitizeProjectId`, run
      // inside its validate pipeline): this id feeds `dockerProjectLabels`'
      // raw label values as well as `localDockerId`'s (self-sanitizing)
      // resource names, and an unsanitized `project_id = "My Project"` would
      // label the container `My Project` while its network/volume are named
      // `..._My_Project` — breaking label-based cleanup filters.
      projectId: normalizeProjectId(
        loaded?.config.project_id ?? input.projectRef ?? basename(input.projectRoot),
      ),
      denoVersion: loaded?.config.edge_runtime.deno_version,
    } satisfies FunctionsCliConfigContext;
  }

  const context = yield* input.goConfigCompat.load({
    projectRoot: input.projectRoot,
    projectRef: input.projectRef,
  });
  return {
    loaded: context.loaded,
    projectEnvValues: context.projectEnvValues,
    projectId: context.projectId,
    denoVersion: context.denoVersion,
  } satisfies FunctionsCliConfigContext;
});
