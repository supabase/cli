import { loadCliConfig } from "@supabase/config/internal";
import { Effect } from "effect";

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
 * message, and a missing file points at `supabase init`. Every family member
 * keeps its own tagged error class; `makeError` builds it from the shared
 * message text, mirroring `legacyResolveConfigTarget`'s per-family error
 * construction (`config.target.ts`).
 */
export function legacyLoadLocalConfig<E>(
  workdir: string,
  projectRef: string | undefined,
  makeError: (message: string) => E,
) {
  return loadCliConfig(workdir, { projectRef, goViperCompat: true }).pipe(
    Effect.catchTags({
      CliConfigParseError: (cause) =>
        Effect.fail(
          makeError(
            `failed to parse ${legacyRelativeConfigPath(workdir, cause.path)}: ${String(cause.cause)}`,
          ),
        ),
      DuplicateRemoteProjectIdError: (cause) => Effect.fail(makeError(cause.message)),
    }),
    Effect.flatMap((loaded) =>
      loaded === null
        ? Effect.fail(
            makeError(
              "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
            ),
          )
        : Effect.succeed(loaded),
    ),
  );
}
