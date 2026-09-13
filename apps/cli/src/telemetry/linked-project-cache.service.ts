import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

interface LinkedProjectCacheShape {
  /**
   * Fire-and-forget: fetches the project metadata from the Management API and writes
   * `<workdir>/supabase/.temp/linked-project.json` if no cache exists yet.
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
   * `apiUrl` overrides the Management API base URL of the cache-fill GET: commands that reconcile
   * a flag-effective profile differing from the config layer's (e.g. `sso add`/`update`) pass
   * that profile's URL. Defaults to `cliSettings.apiUrl`.
   *
   * `accessToken` complements `apiUrl`: a reconciled caller passes the reconciled profile's token
   * along with its URL, since the stale profile's bearer token must never be sent to the
   * reconciled host. `Some` uses that token, `None` skips the GET entirely, `undefined` resolves
   * from the config/credentials services.
   */
  readonly cache: (
    ref: string,
    workdir?: string,
    apiUrl?: string,
    accessToken?: Option.Option<Redacted.Redacted<string>>,
  ) => Effect.Effect<void>;
}

export class LinkedProjectCache extends Context.Service<
  LinkedProjectCache,
  LinkedProjectCacheShape
>()("supabase/cli/LinkedProjectCache") {}
