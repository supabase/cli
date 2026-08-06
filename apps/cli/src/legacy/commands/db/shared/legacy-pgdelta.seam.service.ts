import { Context, type Effect } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

/** Which shadow-database catalog the Go seam should produce. */
export type LegacyCatalogMode = "baseline" | "migrations" | "declarative";

/**
 * Which live shadow database the Go seam should provision and leave running:
 *  - `diff`: platform baseline + local migrations (the `db diff` / migration-style
 *    `db pull` diff source), plus the local-target declarative branch.
 *  - `declarative`: a bare shadow with no baseline/migrations (the `db pull
 *    --declarative` empty export source).
 *  - `pgdelta-next`: platform baseline + local migrations in `postgres`, plus
 *    an empty same-cluster `pgdelta_declarative` scratch database. Declarative
 *    SQL is deliberately not applied by Go in this mode; the TypeScript next
 *    engine loads it later through `planSchemaFiles`.
 */
type LegacyShadowMode = "diff" | "declarative" | "pgdelta-next";

/** A live shadow database left running for the caller to diff against and remove. */
export interface LegacyShadowSource {
  /** Container id; the caller removes it via `removeShadowContainer` when done. */
  readonly container: string;
  /** The diff source Postgres URL (the provisioned shadow). */
  readonly sourceUrl: string;
  /**
   * Optional second live database. For legacy diff it replaces the target with
   * `contrib_regression` after Go applies declarative schemas. For
   * `pgdelta-next` it is the empty declarative scratch database; TypeScript
   * loads the declarative files later through `planSchemaFiles`.
   */
  readonly targetUrlOverride: string | undefined;
}

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
   * Runs the bundled Go binary with the given args, inheriting stdio (so the
   * user sees its output) and returning its exit code — without exiting the
   * host process. Used for the sync apply-failure recovery, which shells out
   * to the Go binary's own `db reset --local` (`declarative.smart-target.ts`)
   * rather than calling the native TS `legacyDbReset` handler in-process —
   * `db reset` itself is `ported`, but its handler isn't yet structured to be
   * invoked from other TS commands rather than the CLI's own dispatch. Known,
   * documented scope-leak (not a porting-status gap): two live `db reset`
   * implementations remain until `legacyDbReset` is made in-process-callable.
   */
  readonly execInherit: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<number, LegacyDeclarativeShadowDbError>;
  /**
   * Go's `ensureLocalDatabaseStarted` for the `--local` declarative paths
   * (`apps/cli-go/cmd/db_schema_declarative.go:190,249,291`): inspects the local
   * Postgres container and, when it is not running, starts it via the bundled
   * Go binary's own DB-only `db start` (`internal/db/start.Run`, the same path
   * `supabase db start` uses — not the full `supabase start` stack, so this
   * avoids failing on unavailable auth/storage/etc. ports or images). TS's own
   * native `db start` (`legacy/commands/db/start/`) exists but is not yet
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
   * is the diff "source" that both the migra and pg-delta engines run against in
   * `db diff` / `db pull`, mirroring Go's `DiffDatabase` (`differ(shadow, target)`).
   * Go's shadow-provisioning progress is teed to stderr.
   */
  readonly provisionShadow: (opts: {
    readonly mode: LegacyShadowMode;
    readonly targetLocal: boolean;
    readonly usePgDelta: boolean;
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
