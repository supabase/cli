import { Context, type Effect } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

/**
 * Which shadow-database catalog the Go seam should produce.
 *
 * `"migrations"` was removed from this union under CLI-1959: both call sites
 * that used it (`db diff`'s explicit `--from/--to migrations`, and
 * `db schema declarative sync`'s migrations-catalog diff source) now resolve
 * natively — see `legacy-pgdelta.cache.ts`'s `legacyResolveMigrationsCatalogRef`
 * and `legacyGetMigrationsCatalogRef` respectively; CLI-1956 then ported the
 * shadow those two functions provision off the Go seam too (see
 * `legacy-pgdelta.cache.ts`'s `exportViaShadowCatalog`), so no TS-side caller
 * routes shadow provisioning through this seam any more. `"baseline"` and
 * `"declarative"` remain seam-backed because they need a shadow provisioned with
 * ONLY the platform baseline (no migrations) or with declarative files applied,
 * and the Go subprocess still provisions that shadow itself. The underlying
 * primitives ARE natively ported now (`legacySetupDatabase`,
 * `shared/db-bootstrap/db-setup.ts`, and `legacyApplyDeclarativePgDelta`,
 * `legacy-pgdelta.apply.ts` — both CLI-1956); what's left is composing the
 * baseline/declarative catalog export on top of them. CLI-1823 (native
 * pg-delta lib) and the remaining `db schema declarative` porting work are the
 * tracked next steps for retiring the rest of this seam.
 */
export type LegacyCatalogMode = "baseline" | "declarative";

interface LegacyDeclarativeSeamShape {
  /**
   * Provisions the shadow-database platform baseline (and, for `declarative`,
   * applies declarative files) via the bundled Go binary's hidden
   * `db schema declarative __catalog` command, and returns the workdir-relative
   * path of the exported pg-delta catalog (cached under `supabase/.temp/pgdelta/`).
   * Go's progress is teed to stderr; only the catalog path is captured from stdout.
   *
   * The shadow-database provisioning this needs (`start.SetupDatabase`, the
   * auth/storage/realtime service migrations) IS now natively ported
   * (`legacySetupDatabase`, `shared/db-bootstrap/db-setup.ts`, CLI-1956) — `db diff`/
   * `db pull` no longer go through this Go seam for their own shadow at all (see
   * `commands/db/shared/legacy-shadow-source.ts`). This method stays Go-delegated
   * only because `db schema declarative generate`/`sync` haven't been natively
   * ported yet, not because the underlying shadow primitive is missing.
   */
  readonly exportCatalog: (opts: {
    readonly mode: LegacyCatalogMode;
    readonly noCache: boolean;
    /**
     * Resolved linked project ref for `generate --linked`. Passed to the `__catalog`
     * subprocess as `SUPABASE_PROJECT_ID`, which viper's `AutomaticEnv` binds to
     * `project_id` so `Config.Load` merges the matching `[remotes.<ref>]` override
     * into the platform baseline — mirroring Go's monolith, which loads the remote-
     * merged config before building the baseline catalog
     * (`apps/cli-go/pkg/config/config.go:492-516`). Absent → base config only.
     */
    readonly projectRef?: string;
  }) => Effect.Effect<string, LegacyDeclarativeShadowDbError>;
  /**
   * Go's `ensureLocalDatabaseStarted` for the `--local` declarative paths
   * (`apps/cli-go/cmd/db_schema_declarative.go:190,249,291`): inspects the local
   * Postgres container and, when it is not running, starts ONLY the database via
   * the bundled Go binary's own DB-only `db start` (`internal/db/start.Run`, the
   * same hidden path `supabase db start` uses) -- not the full `supabase start`
   * stack, which was deleted outright as unreachable (CLI-1966); this also avoids
   * failing on unavailable auth/storage/etc. ports or images. TS's own native
   * `db start` (`legacy/commands/db/start/`) exists but is not yet
   * in-process-callable either, so this seam shells out to the Go binary
   * directly rather than to the TS handler. A no-op when the container is
   * already running, so `db schema declarative generate --local` bootstraps a
   * stopped stack instead of failing to connect, matching Go.
   */
  readonly ensureLocalDatabaseStarted: () => Effect.Effect<void, LegacyDeclarativeShadowDbError>;
  /**
   * Checks the running local Postgres container image tag against the currently
   * resolved Postgres image. A missing container is accepted: catalog cache keys
   * self-invalidate on setup inputs, and local-apply paths will start/connect later.
   */
  readonly ensureLocalPostgresImageCurrent: () => Effect.Effect<
    void,
    LegacyDeclarativeShadowDbError
  >;
}

export class LegacyDeclarativeSeam extends Context.Service<
  LegacyDeclarativeSeam,
  LegacyDeclarativeSeamShape
>()("supabase/legacy/DeclarativeSeam") {}
