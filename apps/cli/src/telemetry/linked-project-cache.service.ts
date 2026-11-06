import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

/**
 * A reconciled profile whose host and token replace the command's for the cache-fill GET, so the
 * stale profile's bearer token is never sent to the reconciled host.
 */
export interface LinkedProjectCacheProfile {
  /** Management API base URL; defaults to `cliSettings.apiUrl`. */
  readonly apiUrl: string | undefined;
  /** `None` skips the GET rather than fall back to the stale profile's token. */
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
}

interface LinkedProjectCacheShape {
  /**
   * Fire-and-forget: fetches the project metadata from the Management API and writes it if no
   * cache exists yet: `<workdir>/supabase/.temp/linked-project.json` in legacy mode,
   * `$SUPABASE_HOME/project-cache/<ref>.json` in stack mode.
   *
   * `workdir` overrides the directory the cache resolves against. Callers that have already
   * changed the working directory (e.g. `bootstrap`, whose target workdir can come from an
   * interactive prompt rather than `cliSettings.workdir`) pass their resolved workdir so the
   * cache lands beside the other `supabase/.temp/` files. When omitted it falls back to
   * `cliSettings.workdir` (the cwd-walk result), matching every other caller.
   *
   * Best-effort. Never fails the calling effect — auth errors, network errors, and write errors
   * are all swallowed.
   *
   * `profile` is passed by commands that reconcile a flag-effective profile differing from the
   * config layer's (e.g. `sso add`/`update`). Without it the GET uses the command's client.
   */
  readonly cache: (
    ref: string,
    workdir?: string,
    profile?: LinkedProjectCacheProfile,
  ) => Effect.Effect<void>;
}

export class LinkedProjectCache extends Context.Service<
  LinkedProjectCache,
  LinkedProjectCacheShape
>()("supabase/cli/LinkedProjectCache") {}
