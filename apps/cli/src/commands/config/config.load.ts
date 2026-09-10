import { loadCliConfig } from "@supabase/config/internal";
import { Effect } from "effect";

import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../command-internal/workdir-search.ts";

export { relativeConfigPath };

/**
 * Loads `supabase/config.{toml,json}` for the `config` family (`diff`, `pull`, `push`) with one
 * shared failure shape. A parse failure names the file that actually failed, since `config.json`
 * is probed before falling back to `config.toml`. A missing-file message suggests `supabase init`
 * only for a defaulted workdir; an explicit `--workdir`/`SUPABASE_WORKDIR` never climbs ancestors
 * and fails instead of silently loading an unrelated project's config.
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
