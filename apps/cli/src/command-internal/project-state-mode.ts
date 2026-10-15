import { Effect, type FileSystem, type Path } from "effect";

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
export const projectStateMode = (input: {
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<
  ProjectStateMode,
  ExperimentalFeatureFlagError,
  FileSystem.FileSystem | Path.Path
> =>
  resolveExperimentalFeature({
    feature: "stack",
    configValue: readExperimentalFeatureConfig({
      feature: "stack",
      args: input.args ?? [],
      cwd: input.cwd,
      env: input.env,
    }),
    env: input.env,
  }).pipe(Effect.map((enabled) => (enabled ? "stack" : "legacy")));
