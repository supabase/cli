import { Context, type Effect } from "effect";

import type { LegacyDbBootstrapError } from "./legacy-db-bootstrap.errors.ts";

/**
 * Seam over the bundled Go binary's hidden `db __db-bootstrap` command, exposing
 * the container-bootstrap primitives that native `db start` / `db reset --local`
 * still need but that are not ported to TypeScript: the local-stack "is running?"
 * probe, the database container create/recreate flows, and the storage health gate
 * before bucket seeding. The TS handlers orchestrate everything else (user-facing
 * messages, version resolution, bucket seeding, the git-branch line, telemetry,
 * and `--output-format` shaping); only the Docker lifecycle lives behind here.
 *
 * Mirrors {@link LegacyDeclarativeSeam} (`db __shadow`): each method shells out to
 * the same resolved `supabase-go`, with the child's telemetry disabled so the
 * hidden seam never double-counts the user's command, and its progress teed to
 * stderr.
 */
interface LegacyDbBootstrapSeamShape {
  /**
   * Go's `utils.AssertSupabaseDbIsRunning` (`internal/utils/misc.go:144`): inspect
   * the local Postgres container. `true` when it exists (the stack is up), `false`
   * when Docker reports "No such container" (Go's `ErrNotRunning`). Any other
   * inspect failure (e.g. the Docker daemon is unreachable) fails with
   * {@link LegacyDbBootstrapError}, matching Go, which returns the wrapped inspect
   * error rather than treating the database as stopped.
   */
  readonly isDbRunning: () => Effect.Effect<boolean, LegacyDbBootstrapError>;
  /**
   * `db start`'s container bootstrap — `start.StartDatabase(fromBackup)` plus Go's
   * `DockerRemoveAll` cleanup on failure (`internal/db/start/start.go:54-60`):
   * create the Postgres container, wait for health, apply the initial schema +
   * roles + migrations + seed on a fresh volume, and write `_current_branch`.
   * Progress (`Starting database...`, `Initialising schema...`) is teed to stderr.
   */
  readonly startDatabase: (opts: {
    readonly fromBackup?: string;
  }) => Effect.Effect<void, LegacyDbBootstrapError>;
  /**
   * The PG14/PG15 container-recreate half of local `db reset`
   * (`reset.RecreateLocalDatabase`): recreate the db container/volume, init schema,
   * migrate + seed up to `version`, and restart the satellite containers. The
   * caller has already printed `Resetting local database…`; the seam tees the
   * remaining progress (`Recreating database...`, `Restarting containers...`) to
   * stderr. `version` is the resolved migration version ("" for all migrations);
   * `noSeed` disables the seed and `sqlPaths` overrides `[db.seed].sql_paths`
   * inside the recreate's MigrateAndSeed, mirroring the `db reset`
   * `--no-seed` / `--sql-paths` handling (`cmd/db.go` `dbResetCmd`).
   */
  readonly recreateDatabase: (opts: {
    readonly version: string;
    readonly noSeed: boolean;
    readonly sqlPaths: ReadonlyArray<string>;
  }) => Effect.Effect<void, LegacyDbBootstrapError>;
  /**
   * The storage health gate local `db reset` runs before seeding buckets
   * (`reset.AwaitStorageReady`): if the storage container exists but is unhealthy,
   * wait up to 30s for it. Resolves `true` when the storage container exists (so
   * the caller should run the ported bucket seeding) and `false` when it does not
   * — matching Go, which silently skips buckets when storage is absent.
   */
  readonly awaitStorageReady: () => Effect.Effect<boolean, LegacyDbBootstrapError>;
}

export class LegacyDbBootstrapSeam extends Context.Service<
  LegacyDbBootstrapSeam,
  LegacyDbBootstrapSeamShape
>()("supabase/legacy/DbBootstrapSeam") {}
