import { Context, type Effect } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./declarative.errors.ts";

/** Which shadow-database catalog the Go seam should produce. */
export type LegacyCatalogMode = "baseline" | "migrations" | "declarative";

interface LegacyDeclarativeSeamShape {
  /**
   * Provisions the shadow-database platform baseline (and, for
   * `migrations`/`declarative`, applies migrations / declarative files) via the
   * bundled Go binary's hidden `db schema declarative __catalog` command, and
   * returns the workdir-relative path of the exported pg-delta catalog (cached
   * under `supabase/.temp/pgdelta/`). Go's progress is teed to stderr; only the
   * catalog path is captured from stdout.
   *
   * This is the seam for `start.SetupDatabase` (the auth/storage/realtime service
   * migrations), which is not yet ported to TypeScript.
   */
  readonly exportCatalog: (opts: {
    readonly mode: LegacyCatalogMode;
    readonly noCache: boolean;
  }) => Effect.Effect<string, LegacyDeclarativeShadowDbError>;
  /**
   * Runs the bundled Go binary with the given args, inheriting stdio (so the
   * user sees its output) and returning its exit code — without exiting the
   * host process. Used for the sync apply-failure recovery (`db reset --local`),
   * where the failure must be catchable rather than terminating the process
   * (`db reset` is still a `wrapped` Go command).
   */
  readonly execInherit: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<number, LegacyDeclarativeShadowDbError>;
}

export class LegacyDeclarativeSeam extends Context.Service<
  LegacyDeclarativeSeam,
  LegacyDeclarativeSeamShape
>()("supabase/legacy/DeclarativeSeam") {}
