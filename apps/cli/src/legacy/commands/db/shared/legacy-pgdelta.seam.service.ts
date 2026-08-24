import { Context, type Effect } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

/**
 * Which shadow-database catalog `exportCatalog` should produce: the Supabase platform baseline
 * (auth/storage/realtime) with nothing else applied, or that same baseline with the declarative
 * directory applied on top. Local migrations never go through this seam — `db diff`'s explicit
 * `--from/--to migrations` and `db schema declarative sync`'s migrations-catalog diff source both
 * resolve their own shadow natively (`legacy-pgdelta.cache.ts`'s `legacyResolveMigrationsCatalogRef`
 * and `legacyGetMigrationsCatalogRef`).
 */
export type LegacyCatalogMode = "baseline" | "declarative";

interface LegacyDeclarativeSeamShape {
  /**
   * Provisions a shadow database with the Supabase platform baseline (and, for `declarative`,
   * applies the declarative directory on top), exports its pg-delta catalog, and returns the
   * workdir-relative path of the persisted snapshot (cached under `supabase/.temp/pgdelta/`).
   * Progress ("Creating shadow database...") is written to stderr.
   */
  readonly exportCatalog: (opts: {
    readonly mode: LegacyCatalogMode;
    readonly noCache: boolean;
    /**
     * Resolved linked project ref for `generate --linked`: the config read this builds the
     * baseline/declarative catalog from merges the matching `[remotes.<ref>]` override when
     * set. Absent → base config only.
     */
    readonly projectRef?: string;
  }) => Effect.Effect<string, LegacyDeclarativeShadowDbError>;
  /**
   * For the `--local` declarative paths: when the local Postgres container is not already
   * running, starts it (the same DB-only bring-up `db start` uses) so
   * `db schema declarative generate --local`/`sync` can bootstrap a stopped stack instead of
   * failing to connect. A no-op, silently, when the container is already running.
   */
  readonly ensureLocalDatabaseStarted: Effect.Effect<void, LegacyDeclarativeShadowDbError>;
  /**
   * Checks the running local Postgres container image tag against the currently
   * resolved Postgres image. A missing container is accepted: catalog cache keys
   * self-invalidate on setup inputs, and local-apply paths will start/connect later.
   */
  readonly ensureLocalPostgresImageCurrent: Effect.Effect<void, LegacyDeclarativeShadowDbError>;
}

export class LegacyDeclarativeSeam extends Context.Service<
  LegacyDeclarativeSeam,
  LegacyDeclarativeSeamShape
>()("supabase/legacy/DeclarativeSeam") {}
