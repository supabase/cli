import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

interface LegacyLinkedProjectCacheShape {
  /**
   * Fire-and-forget: fetches the project metadata from the Management API and
   * writes `<workdir>/supabase/.temp/linked-project.json` if no cache exists yet.
   *
   * `workdir` overrides the directory the cache resolves against. Callers that have
   * already changed the working directory (e.g. `bootstrap`, whose target workdir can
   * come from an interactive prompt rather than `cliConfig.workdir`) pass their resolved
   * workdir so the cache lands beside the other `supabase/.temp/` files. When omitted it
   * falls back to `cliConfig.workdir` (the cwd-walk result), matching every other caller.
   *
   * Best-effort. Never fails the calling effect — auth errors, network errors,
   * and write errors are all swallowed (matches Go's `ensureProjectGroupsCached`
   * which logs to debug and returns).
   *
   * `apiUrl` overrides the Management API base URL of the cache-fill GET.
   * Go's `ensureProjectGroupsCached` goes through `GetSupabase()` and the
   * process-wide `CurrentProfile` — commands that reconcile a pflag-effective
   * profile differing from the config layer's (sso add/update, PR #5974
   * round 7) pass that profile's URL. Defaults to `cliConfig.apiUrl`.
   *
   * `accessToken` complements `apiUrl`: Go resolves credentials for the same
   * process-wide reconciled profile (`access_token.go:43`), so a reconciled
   * caller passes the reconciled profile's token with the URL — the stale
   * profile's bearer token must never be sent to the reconciled host (review
   * r3684524241). `Some` uses that token, `None` skips the GET entirely
   * (Go's token lookup fails before any request), `undefined` resolves from
   * the config/credentials services.
   */
  readonly cache: (
    ref: string,
    workdir?: string,
    apiUrl?: string,
    accessToken?: Option.Option<Redacted.Redacted<string>>,
  ) => Effect.Effect<void>;
}

export class LegacyLinkedProjectCache extends Context.Service<
  LegacyLinkedProjectCache,
  LegacyLinkedProjectCacheShape
>()("supabase/legacy/LinkedProjectCache") {}
