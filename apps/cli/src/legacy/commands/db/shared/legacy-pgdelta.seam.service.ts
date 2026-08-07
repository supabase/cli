import { Context, type Effect, type Scope } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

/**
 * Which shadow-database catalog the Go seam should produce.
 *
 * `"migrations"` was removed from this union under CLI-1959: both call sites
 * that used it (`db diff`'s explicit `--from/--to migrations`, and
 * `db schema declarative sync`'s migrations-catalog diff source) now resolve
 * natively — see `legacy-pgdelta.cache.ts`'s `legacyResolveMigrationsCatalogRef`
 * and `legacyGetMigrationsCatalogRef` respectively. `"baseline"` and
 * `"declarative"` remain seam-backed because they need a shadow provisioned with
 * ONLY the platform baseline (no migrations) or with declarative files applied —
 * neither has a native TS equivalent yet (`start.SetupDatabase` against an
 * arbitrary shadow, and `pgdelta.ApplyDeclarative`), and porting either
 * overlaps with CLI-1956's in-progress native shadow-provisioning work. CLI-1823
 * (native pg-delta lib) and CLI-1956 are the tracked follow-ups for retiring the
 * rest of this seam.
 */
export type LegacyCatalogMode = "baseline" | "declarative";

/**
 * Which live shadow database the Go seam should provision and leave running:
 *  - `diff`: platform baseline + local migrations (the `db diff` / migration-style
 *    `db pull` diff source), plus the local-target declarative branch.
 *  - `declarative`: a bare shadow with no baseline/migrations (the `db pull
 *    --declarative` empty export source).
 */
type LegacyShadowMode = "diff" | "declarative";

/** A live shadow database left running for the caller to diff against and remove. */
export interface LegacyShadowSource {
  /** Container id; the caller removes it via `removeShadowContainer` when done. */
  readonly container: string;
  /** The diff source Postgres URL (the provisioned shadow). */
  readonly sourceUrl: string;
}

/** The independently hosted databases used by the pg-delta next planner. */
export interface LegacyNextShadowSource {
  /** Platform baseline with local configuration and migrations applied. */
  readonly migrationsUrl: string;
  /** Platform baseline with local configuration, ready for declarative SQL. */
  readonly declarativeUrl: string;
}

interface LegacyDeclarativeSeamShape {
  /**
   * Provisions the shadow-database platform baseline (and, for `declarative`,
   * applies declarative files) via the bundled Go binary's hidden
   * `db schema declarative __catalog` command, and returns the workdir-relative
   * path of the exported pg-delta catalog (cached under `supabase/.temp/pgdelta/`).
   * Go's progress is teed to stderr; only the catalog path is captured from stdout.
   *
   * This is the seam for `start.SetupDatabase` (the auth/storage/realtime service
   * migrations) run against an arbitrary shadow, and for `pgdelta.ApplyDeclarative`
   * (the `declarative` mode), neither of which is yet ported to TypeScript
   * (CLI-1959/CLI-1956/CLI-1823 — see {@link LegacyCatalogMode}'s doc comment).
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
  /**
   * Provisions a live shadow database via the bundled Go binary's hidden
   * `db __shadow` command and returns it running (the container is NOT removed —
   * the caller must call `removeShadowContainer` when the diff completes). This
   * is the migration-state source that both the migra and pg-delta engines run
   * against in `db diff` / `db pull`.
   * Go's shadow-provisioning progress is teed to stderr.
   */
  readonly provisionShadow: (opts: {
    readonly mode: LegacyShadowMode;
    readonly schema: ReadonlyArray<string>;
    /**
     * Resolved linked project ref, passed ONLY on the `--linked` path so the
     * shadow merges the matching `[remotes.<ref>]` config override (Go builds the
     * shadow from the already-remote-merged global config on the linked path).
     * Omitted for local/db-url shadows, which Go never remote-merges.
     */
    readonly projectRef?: string;
  }) => Effect.Effect<LegacyShadowSource, LegacyDeclarativeShadowDbError>;
  /**
   * Provisions the two isolated pg-delta next shadows through the Go seam's
   * JSON/ack ownership protocol. Both containers are owned by the current
   * Effect scope before the child is acknowledged, and are independently
   * removed when that scope closes.
   */
  readonly provisionNextShadow: (opts: {
    readonly schema: ReadonlyArray<string>;
    readonly projectRef?: string;
  }) => Effect.Effect<LegacyNextShadowSource, LegacyDeclarativeShadowDbError, Scope.Scope>;
  /**
   * Removes a shadow database container left running by `provisionShadow`
   * (`docker rm -f <id>`). Best-effort: a failure to remove is swallowed so it
   * never masks the underlying diff result.
   */
  readonly removeShadowContainer: (container: string) => Effect.Effect<void>;
}

export class LegacyDeclarativeSeam extends Context.Service<
  LegacyDeclarativeSeam,
  LegacyDeclarativeSeamShape
>()("supabase/legacy/DeclarativeSeam") {}
