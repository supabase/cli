import type { Effect } from "effect";
import { Context } from "effect";

interface LegacyLinkedProjectCacheShape {
  /**
   * Fire-and-forget: fetches the project metadata from the Management API and
   * writes `<workdir>/supabase/.temp/linked-project.json` if no cache exists yet.
   *
   * Best-effort. Never fails the calling effect — auth errors, network errors,
   * and write errors are all swallowed (matches Go's `ensureProjectGroupsCached`
   * which logs to debug and returns).
   */
  readonly cache: (ref: string) => Effect.Effect<void>;
}

export class LegacyLinkedProjectCache extends Context.Service<
  LegacyLinkedProjectCache,
  LegacyLinkedProjectCacheShape
>()("supabase/legacy/LinkedProjectCache") {}
