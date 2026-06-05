import type { Effect } from "effect";
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
   */
  readonly cache: (ref: string, workdir?: string) => Effect.Effect<void>;
}

export class LegacyLinkedProjectCache extends Context.Service<
  LegacyLinkedProjectCache,
  LegacyLinkedProjectCacheShape
>()("supabase/legacy/LinkedProjectCache") {}
