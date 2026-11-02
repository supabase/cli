import { Context, Effect, Exit, type FileSystem, Layer, Option, type Path } from "effect";

import {
  type ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "./experimental-feature.ts";

/** Which state model a project uses: the stack runtime, or the legacy `supabase/.temp` files. */
export type ProjectStateMode = "stack" | "legacy";

/**
 * Reads the mode before any command runtime exists: `SUPABASE_EXPERIMENTAL_STACK=1|0` wins, and
 * an unset or empty value falls back to `[experimental] stack` in the project's config. It
 * decodes that single key, so an unreadable or invalid config counts as unset. Any other
 * environment value fails.
 */
export const projectStateMode = Effect.fn("ProjectStateMode.resolve")(function* (input: {
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.fn.Return<
  ProjectStateMode,
  ExperimentalFeatureFlagError,
  FileSystem.FileSystem | Path.Path
> {
  const enabled = yield* resolveExperimentalFeature({
    feature: "stack",
    configValue: readExperimentalFeatureConfig({
      feature: "stack",
      args: input.args ?? [],
      cwd: input.cwd,
    }),
  });
  const mode: ProjectStateMode = enabled ? "stack" : "legacy";
  yield* Effect.annotateCurrentSpan("project_state.mode", mode);
  return mode;
});

/**
 * The project state mode chosen once at startup. It is an `Exit` so that an invalid
 * `SUPABASE_EXPERIMENTAL_STACK` fails only the readers that need the mode.
 */
export class ProjectStateModeContext extends Context.Service<
  ProjectStateModeContext,
  { readonly mode: Exit.Exit<ProjectStateMode, ExperimentalFeatureFlagError> }
>()("supabase/cli/ProjectStateMode") {}

export const projectStateModeLayer = (
  mode: Exit.Exit<ProjectStateMode, ExperimentalFeatureFlagError> | ProjectStateMode,
) =>
  Layer.succeed(ProjectStateModeContext, {
    mode: typeof mode === "string" ? Exit.succeed(mode) : mode,
  });

/**
 * The mode every state reader branches on, `legacy` when none was provided (such as in
 * unit-level layers). Fails when the startup environment value was invalid.
 */
export const currentProjectStateMode: Effect.Effect<
  ProjectStateMode,
  ExperimentalFeatureFlagError
> = Effect.serviceOption(ProjectStateModeContext).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed<ProjectStateMode>("legacy"),
      onSome: (value) => value.mode,
    }),
  ),
);

/** Mode for best-effort readers: an invalid environment value reads as `legacy` state. */
export const softProjectStateMode: Effect.Effect<ProjectStateMode> = currentProjectStateMode.pipe(
  Effect.orElseSucceed((): ProjectStateMode => "legacy"),
);
