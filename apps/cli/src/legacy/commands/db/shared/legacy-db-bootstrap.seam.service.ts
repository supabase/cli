import { Context, type Effect } from "effect";

import type { LegacyGoChildExitError } from "../../../../shared/legacy/legacy-go-child-exit.error.ts";
import type { LegacyDbBootstrapError } from "./legacy-db-bootstrap.errors.ts";

/**
 * Seam over the bundled Go binary's hidden `db __db-bootstrap` command, exposing
 * the container-bootstrap primitives that native `db reset --local` still needs
 * but that are not ported to TypeScript: the database container recreate flow and
 * the storage health gate before bucket seeding. The TS handlers orchestrate
 * everything else (user-facing messages, version resolution, bucket seeding, the
 * git-branch line, telemetry, and `--output-format` shaping); only the Docker
 * lifecycle lives behind here.
 *
 * `db start`'s own container bootstrap (`start.StartDatabase`) was removed from
 * this seam by CLI-1954 — it is now a fully native TS implementation
 * (`commands/db/start/start.handler.ts`), reusing `commands/start/`'s already-ported
 * container-bootstrap primitives instead of shelling out to the Go binary. The
 * local-stack "is running?" probe (`legacyIsLocalDbRunning`) was already a native
 * TS implementation before CLI-1954 — that same change also hoisted it out of this
 * seam into `legacy/shared/db-bootstrap/local-db-running.ts`, since it never shelled
 * out to Go and is shared by both `db start` and `db reset`.
 *
 * Mirrors {@link LegacyDeclarativeSeam} (`db __shadow`): each method shells out to
 * the same resolved `supabase-go`, with the child's telemetry disabled so the
 * hidden seam never double-counts the user's command, and its progress teed to
 * stderr.
 */
interface LegacyDbBootstrapSeamShape {
  /**
   * The PG14/PG15 container-recreate half of local `db reset`
   * (`reset.RecreateLocalDatabase`): recreate the db container/volume, init schema,
   * migrate + seed up to `version`, restart the satellite containers
   * (storage/auth/realtime/pooler), and reload Kong so its nginx re-resolves
   * the restarted containers' addresses — otherwise routes to a container that
   * moved keep returning 502 after the reset succeeds (issue #6016). The
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
  }) => Effect.Effect<void, LegacyDbBootstrapError | LegacyGoChildExitError>;
  /**
   * The storage health gate local `db reset` runs before seeding buckets
   * (`reset.AwaitStorageReady`): if the storage container exists but is unhealthy,
   * wait up to 30s for it. Resolves `true` when the storage container exists (so
   * the caller should run the ported bucket seeding) and `false` when it does not
   * — matching Go, which silently skips buckets when storage is absent.
   */
  readonly awaitStorageReady: () => Effect.Effect<
    boolean,
    LegacyDbBootstrapError | LegacyGoChildExitError
  >;
}

export class LegacyDbBootstrapSeam extends Context.Service<
  LegacyDbBootstrapSeam,
  LegacyDbBootstrapSeamShape
>()("supabase/legacy/DbBootstrapSeam") {}
