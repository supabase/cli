import { loadCliConfig } from "@supabase/config/internal";
import { Effect } from "effect";

import { legacyMissingProjectConfigMessageEffect } from "../../command-internal/legacy-workdir-project.ts";
import { legacyShouldSearchAncestors } from "../../command-internal/legacy-workdir-search.ts";

/**
 * `cause.path`/`loaded.path` are anchored under `workdir`; render them
 * relative so a message reads `supabase/config.json` like the rest of the
 * `config` family, regardless of invocation cwd.
 */
export function legacyRelativeConfigPath(workdir: string, path: string): string {
  return path.startsWith(workdir) ? path.slice(workdir.length).replace(/^[/\\]/, "") : path;
}

/**
 * Loads `supabase/config.{toml,json}` for the `config` command family
 * (`diff`, `pull`, `push`) with one shared failure shape: a parse failure
 * names the file that actually failed — `loadCliConfig` probes
 * `supabase/config.json` before falling back to `supabase/config.toml`
 * (`findCliProjectPaths`), so hardcoding the `.toml` name would mislabel a
 * broken `config.json` — a duplicate `[remotes.*].project_id` keeps its own
 * message, and a missing-file message is built by
 * `legacyMissingProjectConfigMessageEffect` (CLI-2285): it points at
 * `supabase init` only for a DEFAULTED workdir, and (via
 * `legacyShouldSearchAncestors`) never climbs ancestors to find the config in
 * the first place when `cliSettings.explicitWorkdir` is true — an explicit
 * `--workdir`/`SUPABASE_WORKDIR` with no project of its own must fail rather
 * than silently loading an unrelated ancestor project's config. Every family
 * member keeps its own tagged error class; `makeError` builds it from the
 * shared message text, mirroring `legacyResolveConfigTarget`'s per-family
 * error construction (`config.target.ts`).
 */
export function legacyLoadLocalConfig<E>(
  cliSettings: { readonly workdir: string; readonly explicitWorkdir: boolean },
  projectRef: string | undefined,
  makeError: (message: string) => E,
) {
  return loadCliConfig(cliSettings.workdir, {
    projectRef,
    goViperCompat: true,
    search: legacyShouldSearchAncestors(cliSettings),
  }).pipe(
    Effect.catchTags({
      CliConfigParseError: (cause) =>
        Effect.fail(
          makeError(
            `failed to parse ${legacyRelativeConfigPath(cliSettings.workdir, cause.path)}: ${String(cause.cause)}`,
          ),
        ),
      DuplicateRemoteProjectIdError: (cause) => Effect.fail(makeError(cause.message)),
    }),
    Effect.flatMap((loaded) =>
      loaded === null
        ? Effect.gen(function* () {
            const message = yield* legacyMissingProjectConfigMessageEffect(cliSettings);
            return yield* Effect.fail(makeError(message));
          })
        : Effect.succeed(loaded),
    ),
  );
}
