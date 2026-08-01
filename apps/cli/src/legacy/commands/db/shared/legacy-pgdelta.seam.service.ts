import { Context, type Effect } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

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
   * Runs the bundled Go binary with the given args, inheriting stdio (so the
   * user sees its output) and returning its exit code — without exiting the
   * host process. Used for the sync apply-failure recovery (`db reset --local`),
   * where the failure must be catchable rather than terminating the process
   * (`db reset` is still a `wrapped` Go command).
   */
  readonly execInherit: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<number, LegacyDeclarativeShadowDbError>;
  /**
   * Go's `ensureLocalDatabaseStarted` for the `--local` declarative paths
   * (`apps/cli-go/cmd/db_schema_declarative.go:190,249,291`): inspects the local
   * Postgres container and, when it is not running, starts the stack via the
   * bundled `supabase-go start` (the stack-start subsystem is not yet ported).
   * A no-op when the container is already running, so
   * `db schema declarative generate --local` bootstraps a stopped stack instead
   * of failing to connect, matching Go.
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
