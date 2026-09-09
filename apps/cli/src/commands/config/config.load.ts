import { loadCliConfig } from "@supabase/config/internal";
import { Effect } from "effect";

import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../command-internal/workdir-search.ts";

// Re-exported for existing `config` family importers — the pure helper
// itself now lives in `workdir-project.ts` since `gen types` needs it
// too (Hoist Before You Duplicate: used across ≥2 command families).
export { relativeConfigPath };

/**
 * Loads `supabase/config.{toml,json}` for the `config` command family
 * (`diff`, `pull`, `push`) with one shared failure shape: a parse failure
 * names the file that actually failed — `loadCliConfig` probes
 * `supabase/config.json` before falling back to `supabase/config.toml`
 * (`findCliProjectPaths`), so hardcoding the `.toml` name would mislabel a
 * broken `config.json` — a duplicate `[remotes.*].project_id` keeps its own
 * message, and a missing-file message is built by
 * `missingProjectConfigMessageEffect` (CLI-2285): it points at
 * `supabase init` only for a DEFAULTED workdir, and (via
 * `shouldSearchAncestors`) never climbs ancestors to find the config in
 * the first place when `cliSettings.explicitWorkdir` is true — an explicit
 * `--workdir`/`SUPABASE_WORKDIR` with no project of its own must fail rather
 * than silently loading an unrelated ancestor project's config. Every family
 * member keeps its own tagged error class; `makeError` builds it from the
 * shared message text, mirroring `resolveConfigTarget`'s per-family
 * error construction (`command-internal/project-target.ts`).
 */
export function loadLocalConfig<E>(
  cliSettings: { readonly workdir: string; readonly explicitWorkdir: boolean },
  projectRef: string | undefined,
  makeError: (message: string) => E,
) {
  return loadCliConfig(cliSettings.workdir, {
    projectRef,
    goViperCompat: true,
    search: shouldSearchAncestors(cliSettings),
  }).pipe(
    Effect.catchTags({
      CliConfigParseError: (cause) =>
        Effect.fail(
          makeError(
            `failed to parse ${relativeConfigPath(cliSettings.workdir, cause.path)}: ${String(cause.cause)}`,
          ),
        ),
      DuplicateRemoteProjectIdError: (cause) => Effect.fail(makeError(cause.message)),
    }),
    Effect.flatMap((loaded) =>
      loaded === null
        ? Effect.gen(function* () {
            const message = yield* missingProjectConfigMessageEffect(cliSettings);
            return yield* Effect.fail(makeError(message));
          })
        : Effect.succeed(loaded),
    ),
  );
}
