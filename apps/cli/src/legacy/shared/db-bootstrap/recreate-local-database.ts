/**
 * `db reset --local`'s container-recreate half — a strict 1:1 port of Go's
 * `resetDatabase`/`resetDatabase14`/`resetDatabase15`
 * (`apps/cli-go/internal/db/reset/reset.go:81-176`). This is DELIBERATELY NOT a
 * thin wrapper over {@link legacyStartDatabase} (`./start-database.ts`, the
 * `StartDatabase`-equivalent `db start`/`supabase start` share) — Go's own
 * `resetDatabase15` never calls `StartDatabase` either. It is a distinctly
 * different composition over the SAME underlying primitives
 * (`legacyEnsureNetwork`, `legacyBuildPostgresStartContainerSpec`,
 * `legacyCreateContainer`, `legacyWaitForHealthyServices`,
 * `legacyRunFreshDbSetup`), matching Go's own structure:
 *
 * **PG >= 15** (`resetDatabase15`, `reset.go:114-142`):
 * 1. `docker container rm -f <db>` — NOT tolerant of "not found" (a genuine
 *    remove failure is a hard `failed to remove container`), unlike most other
 *    container lookups in this codebase.
 * 2. `docker volume rm -f <db>` — tolerant of "not found" via the `-f` flag
 *    ITSELF (verified against a real Docker daemon: `force` makes a missing
 *    volume's removal a no-op), so no special-casing is needed here either.
 * 3. `legacyEnsureNetwork` (Go's `DockerStart` always ensures the network
 *    exists, on every call — this is hoisted out of `legacyCreateContainer` for
 *    the SAME reason `start-database.ts` hoists it).
 * 4. `Recreating database...\n` to stderr (NOT `Starting database...`).
 * 5. Build + create + start the Postgres container (byte-identical inputs to
 *    `legacyStartDatabase`'s own — there is no `fromBackup` variant on this
 *    path, reset has no restore concept) via the same
 *    `legacyBuildPostgresStartContainerSpec`/`legacyCreateContainer`.
 * 6. Health wait — NEVER swallowed (no `--from-backup`-equivalent gate here at
 *    all).
 * 7. `legacyRunFreshDbSetup` — UNCONDITIONALLY (no fresh-volume gate: a
 *    reset just removed the volume, so it's always fresh) and with the
 *    RESOLVED reset `version`/`seedFlags` (not `""` like `db start`'s own call)
 *    — see `db-setup.ts`'s own header for this one genuine parameter
 *    difference between the shared function's two real Go callers.
 * 8. `Restarting containers...\n` to stderr, then
 *    {@link legacyRestartServicesAndReloadKong} (`./restart-services.ts`).
 *
 * **PG <= 14** (`resetDatabase14`, `reset.go:96-112`):
 * 1. `recreateDatabase` (`reset.go:157-176`) — connect as `supabase_admin` to
 *    `template1`, `DisconnectClients`, then four UNWRAPPED (no `BEGIN`/`COMMIT`)
 *    statements: `DROP`/`CREATE DATABASE postgres`, `DROP`/`CREATE DATABASE
 *    _supabase`. Go batches these via a pgconn protocol trick that has no TS
 *    equivalent — not needed here: none of the four can ever run inside a
 *    transaction anyway, so plain sequential `session.exec` calls, relying on
 *    Effect's own short-circuit-on-failure, reproduce Go's "stop at first
 *    error" behavior exactly (verified empirically against real Postgres 14/15
 *    with the pinned pgconn/pgx versions — the batching trick is real, but its
 *    OBSERVABLE effect is identical to sequential execution for this
 *    particular statement set).
 * 2. `initDatabase` (`reset.go:144-154`) — connect as `supabase_admin` to the
 *    default `postgres` database, then Go's EXPORTED `InitSchema14` (schema SQL
 *    ONLY, deliberately WITHOUT globals.sql — see `legacyInitSchema14`'s
 *    own doc comment for why this is NOT the same as `db start`'s PG<=14 path)
 *    + `ApplyApiPrivileges` (the exact same exported function `SetupDatabase`
 *    also calls), then pg_net activation when Database Webhooks is enabled.
 * 3. `RestartDatabase` (`reset.go:214-225`) — `Restarting containers...\n`
 *    FIRST, then a REAL `docker restart` of the `db` container itself (NOT
 *    tolerant of "not found" — pg_cron must restart after
 *    `pg_terminate_backend`, Go's own comment), health wait (not swallowed),
 *    then {@link legacyRestartServicesAndReloadKong} — so Kong reload happens on
 *    the PG14 path too, after the db container restart.
 * 4. Final connect as `postgres`/`postgres` → `apply.MigrateAndSeed` with the
 *    resolved reset `version`/`seedFlags` — the same seed-override logic PG15's
 *    `legacyRunFreshDbSetup` call applies.
 *
 * Deliberately absent, matching Go exactly: no volume-existence probe (a reset
 * just removed the volume, so there is nothing to probe), no `NoBackupVolume`/
 * fresh-volume concept, no `fromBackup` handling at all, `initCurrentBranch` is
 * NEVER called (Go's `resetDatabase`/`resetDatabase14`/`resetDatabase15` never
 * call it), and no rollback on failure (Go's `cmd/db.go` only wraps `--mode
 * start` in a `DockerRemoveAll` cleanup — the recreate dispatch has none).
 *
 * Steps 5-7 on the PG15 path additionally run through the baseline PGDATA cache
 * (`main-db-baseline.ts`) — a TS-only addition with no Go counterpart, and the one
 * place this composition diverges from `resetDatabase15`'s literal shape. It decides
 * warm/cold BEFORE the container is created (a warm restore is a `docker cp -` into
 * the created-but-unstarted container), owns the create + health wait so a failed
 * restore can fall back to a cold one, and hands `legacyRunFreshDbSetup` the baseline
 * state that decides whether the platform baseline is re-run or snapshotted. With
 * `SUPABASE_SHADOW_CACHE=false` — and on the PG<=14 path, which never consults it at
 * all — every step above is byte-for-byte what it was.
 *
 * `pgcache.TryCacheMigrationsCatalog`'s best-effort catalog warmup (part of Go's
 * `SetupLocalDatabase`, reachable from the PG15 path above via
 * `legacyRunFreshDbSetup`) IS reached here too — see `db-setup.ts`'s own
 * header for the exact gate/citations. `reset.layers.ts` composes
 * `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer` for it, matching
 * `db start`'s own layer composition (`db/start/start.layers.ts`).
 */

import { Data, Effect, Result, Schedule, type FileSystem, type Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { legacyIsSqlState } from "../legacy-connect-errors.ts";
import { legacyCheckDbToml } from "../legacy-db-config.toml-read.ts";
import { LegacyDbConnection, type LegacyDbSession } from "../legacy-db-connection.service.ts";
import { LegacyDbExecError, type LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import { LEGACY_CLI_PROJECT_LABEL } from "../legacy-docker-ids.ts";
import type { LegacyDockerRun } from "../legacy-docker-run.service.ts";
import type { LegacyEdgeRuntimeScript } from "../legacy-edge-runtime-script.service.ts";
import { legacyMigrateAndSeed } from "../legacy-migrate-and-seed.ts";
import {
  legacyFormatExecBatchError,
  type LegacyMigrationApplyError,
} from "../legacy-migration-apply.ts";
import { legacyErrorMessage } from "../legacy-error-message.ts";
import type { LegacyPgDeltaSslProbe } from "../legacy-pgdelta-ssl-probe.service.ts";
import type { LegacyMigrationSeedError } from "../legacy-seed.ts";
import {
  legacyEnsureNetwork,
  legacyRemoveContainer,
  legacyRemoveVolume,
  LEGACY_COMPOSE_PROJECT_LABEL,
  type LegacyContainerRemoveError,
  type LegacyContainerError,
  type LegacyContainerOpts,
  type LegacyNetworkCreateError,
  type LegacyVolumeRemoveError,
} from "./container-lifecycle.ts";
import {
  legacyRunFreshDbSetup,
  legacyResolveResetSeedConfig,
  legacyApplyApiPrivileges,
  legacyApplyDatabaseWebhooks,
  legacyInitSchema14,
  legacyRemoveDatabaseWebhooks,
  LegacyDbSetupError,
  type LegacyFreshDbSetupInput,
  type LegacyStartSetupLocalDatabaseError,
} from "./db-setup.ts";
import {
  legacyWaitForHealthyServices,
  type LegacyHealthCheckTimeoutError,
} from "./health-check.ts";
import type { LegacyImagePrepullError } from "./image-prepull.ts";
import { legacyStartInternalDbPassword } from "./internal-db-connection.ts";
import {
  legacyBringUpMainDbWithBaseline,
  type LegacyMainDbBaselineTomlInputs,
} from "./main-db-baseline.ts";
import {
  legacyBuildPostgresStartContainerSpec,
  type LegacyPostgresStartServiceInput,
} from "./postgres.service.ts";
import {
  legacyRestartContainer,
  legacyRestartServicesAndReloadKong,
  type LegacyContainerRestartError,
  type LegacyKongReloadError,
  type LegacyRestartServicesError,
} from "./restart-services.ts";

type Spawner = ChildProcessSpawner["Service"];

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * One or more replication slots are still active (retryable — the WAL sender
 * that owns the slot may still be tearing down), OR counting them failed
 * outright (permanent — Go's `backoff.PermanentError`, `reset.go:204-206`:
 * a query-execution failure is never retried, only "count > 0" is). Exported
 * only so the exhaustive actionability guard can inspect its
 * declaration; runtime callers discriminate it through the
 * {@link LegacyRecreateLocalDatabaseError} union's `_tag`.
 */
export class LegacyResetReplicationSlotsError extends Data.TaggedError(
  "LegacyResetReplicationSlotsError",
)<{
  readonly message: string;
  readonly retryable: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.retryable
      ? { ...actionability.dbFinding, fingerprint_suffix: "replication_slots_active" }
      : { ...actionability.dbConnection, fingerprint_suffix: "replication_slots_query" };
  }
}

/** Every failure the PG14/PG15 `db reset` recreate composition can produce. */
export type LegacyRecreateLocalDatabaseError =
  // PG15 (`resetDatabase15`)
  | LegacyNetworkCreateError
  | LegacyContainerRemoveError
  | LegacyVolumeRemoveError
  | LegacyContainerError
  | LegacyImagePrepullError
  | LegacyHealthCheckTimeoutError
  | LegacyStartSetupLocalDatabaseError
  // PG14 (`resetDatabase14`)
  | LegacyDbConnectError
  | LegacyDbExecError
  | LegacyResetReplicationSlotsError
  | LegacyDbSetupError
  | LegacyContainerRestartError
  | LegacyMigrationApplyError
  | LegacyMigrationSeedError
  // Shared post-recreate step (both branches)
  | LegacyRestartServicesError
  | LegacyKongReloadError;

export interface LegacyRecreateLocalDatabaseInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  readonly projectId: string;
  readonly networkId: string;
  readonly hostname: string;
  /** `localDbContainerId(projectId)` — also this composition's own volume name (Go: `utils.DbId` names both). */
  readonly dbContainerId: string;
  readonly dbPort: number;
  readonly containerOpts: LegacyContainerOpts;
  /** Fed straight to `legacyBuildPostgresStartContainerSpec` — reset has no `fromBackup` concept at all. */
  readonly postgresSpec: Omit<LegacyPostgresStartServiceInput, "image" | "fromBackup">;
  /** Lazy — evaluated right where Go's `DockerStart` would resolve it (PG15 path only). */
  readonly resolvePostgresImage: Effect.Effect<string, LegacyImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /**
   * The `[db]` values from the caller's OWN already-validated `legacyCheckDbToml` pass — they
   * describe the baseline the cache keys the PG15 recreate on (see
   * {@link LegacyMainDbBaselineTomlInputs}). The PG14 branch below loads config itself, for the
   * many other fields it needs.
   */
  readonly toml: LegacyMainDbBaselineTomlInputs;
  /** The resolved reset migration version (`""` for every pending migration). */
  readonly version: string;
  /** `db reset`'s `--no-seed`/`--sql-paths` — see {@link legacyResolveResetSeedConfig}. */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
  /** The exact same shape `start-database.ts`'s `LegacyStartDatabaseInput.setup` uses, since Go's `resetDatabase15` calls the SAME `SetupLocalDatabase` `db start` does — hoisted to {@link LegacyFreshDbSetupInput}. */
  readonly setup: LegacyFreshDbSetupInput<E>;
}

/** Go's `pgerrcode.InvalidCatalogName` (`3D000`) — "database doesn't exist yet" on a first-ever reset. */
const PG_INVALID_CATALOG_NAME = "3D000";

/**
 * Port of Go's `DisconnectClients` (`reset.go:183-212`): disable new connections
 * to `postgres`/`_supabase`, terminate existing backends, then wait for WAL
 * senders to drop their replication slots (constant 1-second backoff, 10
 * retries max — Go's `NewBackoffPolicy(ctx, 10*time.Second)`).
 *
 * Exported ONLY so `recreate-local-database.unit.test.ts` can pin the retry
 * schedule's exact 10-retry boundary against a plain mocked {@link
 * LegacyDbSession} (no real filesystem/Docker I/O), using the same `TestClock`
 * + `Effect.forkChild` pattern as `db-bootstrap/await-storage-ready.unit.test.ts` —
 * driving the full `legacyDbReset` composite effect through a fake clock isn't
 * reliable (its many REAL filesystem awaits race unpredictably against a
 * virtual-time nudge issued from the outside), so this narrower, no-real-I/O
 * entry point is the one actually worth pinning this way; the full retry-count
 * behavior stays covered end-to-end by `reset.integration.test.ts`'s own
 * `it.live` tests. Not otherwise used outside this module.
 */
export const legacyResetDisconnectClients = Effect.fnUntraced(function* (session: LegacyDbSession) {
  // Must be executed separately because looping in a transaction is unsupported
  // (Go's own comment, `reset.go:184-185`) — sequential, unwrapped execs, relying on
  // Effect's short-circuit-on-failure to stop at the first bad statement, exactly
  // like pgconn's own batch-pipeline semantics would.
  const disconnectResult = yield* Effect.forEach(
    [
      "ALTER DATABASE postgres ALLOW_CONNECTIONS false",
      "ALTER DATABASE _supabase ALLOW_CONNECTIONS false",
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('postgres', '_supabase')",
    ],
    (sql) => session.exec(sql),
    { discard: true },
  ).pipe(Effect.result);
  if (Result.isFailure(disconnectResult)) {
    const failure = disconnectResult.failure;
    // Go: `if errors.As(err, &pgErr) && pgErr.Code != pgerrcode.InvalidCatalogName { return wrapped }`
    // — surfaced ONLY for a genuine PgError whose code isn't 3D000. `failure.code` is NOT reliably
    // only-ever-set-for-a-real-ErrorResponse: the driver layer's exec-error mapping
    // (`legacyToExecError`) falls back to `legacyExtractSqlState`, which can surface a bare node
    // system errno (`ECONNRESET`, `ETIMEDOUT`, …) as `code` too — those are NOT SQLSTATEs, and
    // `errors.As(err, &pgErr)` never matches a socket error in Go, so this must check
    // `legacyIsSqlState` before treating `code` as a genuine PgError code. A non-PgError failure
    // (network blip, no `code`, or a `code` that isn't a real SQLSTATE) AND a 3D000 PgError are
    // BOTH silently swallowed.
    if (
      failure.code !== undefined &&
      legacyIsSqlState(failure.code) &&
      failure.code !== PG_INVALID_CATALOG_NAME
    ) {
      return yield* Effect.fail(
        new LegacyDbSetupError({
          message: `failed to disconnect clients: ${failure.message}`,
          reason: "database",
        }),
      );
    }
  }

  const countReplicationSlots = session
    .query("SELECT COUNT(*) FROM pg_replication_slots WHERE database IN ('postgres', '_supabase')")
    .pipe(
      Effect.mapError(
        (cause) =>
          new LegacyResetReplicationSlotsError({
            message: `failed to count replication slots: ${cause.message}`,
            retryable: false,
          }),
      ),
      Effect.flatMap((rows) => {
        const count = Number(rows[0]?.["count"] ?? 0);
        return count > 0
          ? Effect.fail(
              new LegacyResetReplicationSlotsError({
                message: `replication slots still active: ${count}`,
                retryable: true,
              }),
            )
          : Effect.void;
      }),
    );
  yield* countReplicationSlots.pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.spaced("1 seconds"), Schedule.recurs(10)]),
      while: (error) => error.retryable,
    }),
  );
});

// Go builds these four as a single `migration.MigrationFile{Statements: [...]}`
// and calls `.ExecBatch` (`reset.go:165-173`), which formats a failed statement
// with the same rich error context (caret-marked position, `Detail` line, the
// SQLSTATE-42704 extension hint, `At statement: <index>`) real migration files
// get — NOT a real SQL transaction: `DROP`/`CREATE DATABASE` cannot run inside a
// `BEGIN`/`COMMIT` block at all, so these stay bare, sequential, UNWRAPPED
// `session.exec` calls (the pgconn network-pipeline batching `ExecBatch` uses
// instead has no TS equivalent and no observable difference here). Each
// statement's index matches its position in this list, mirroring Go's
// `m.Statements` indexing.
const RESET_RECREATE_DATABASES_STATEMENTS = [
  "DROP DATABASE IF EXISTS postgres WITH (FORCE)",
  "CREATE DATABASE postgres WITH OWNER postgres",
  "DROP DATABASE IF EXISTS _supabase WITH (FORCE)",
  "CREATE DATABASE _supabase WITH OWNER postgres",
] as const;

/**
 * Port of Go's `recreateDatabase` (`reset.go:157-176`): connect as
 * `supabase_admin` to `template1`, disconnect clients, then four UNWRAPPED
 * statements. "We are not dropping roles here because they are cluster level
 * entities. Use stop && start instead." (Go's own comment.)
 */
const legacyResetRecreateDatabases = Effect.fnUntraced(function* (session: LegacyDbSession) {
  yield* legacyResetDisconnectClients(session);
  for (const [index, statement] of RESET_RECREATE_DATABASES_STATEMENTS.entries()) {
    yield* session.exec(statement).pipe(
      Effect.mapError(
        (error) =>
          new LegacyDbExecError({
            message: legacyErrorMessage(legacyFormatExecBatchError(error, index, statement)),
            code: error.code,
            detail: error.detail,
            position: error.position,
          }),
      ),
    );
  }
});

/**
 * Port of Go's `resetDatabase15` (`reset.go:114-142`) — see this module's own
 * header for the full sequence and citations.
 */
const legacyRecreateLocalDatabase15 = <E>(
  spawner: Spawner,
  input: LegacyRecreateLocalDatabaseInput<E>,
): Effect.Effect<
  void,
  LegacyRecreateLocalDatabaseError | E,
  | Output
  | LegacyDbConnection
  | LegacyDockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | LegacyEdgeRuntimeScript
  | LegacyPgDeltaSslProbe
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const output = yield* Output;

    yield* legacyRemoveContainer(spawner, input.dbContainerId);
    yield* legacyRemoveVolume(spawner, input.dbContainerId);

    yield* legacyEnsureNetwork(spawner, input.networkId, {
      [LEGACY_CLI_PROJECT_LABEL]: input.projectId,
      [LEGACY_COMPOSE_PROJECT_LABEL]: input.projectId,
    });

    yield* output.raw("Recreating database...\n", "stderr");

    const resolvedPostgresImage = yield* input.resolvePostgresImage;
    const postgresSpec = legacyBuildPostgresStartContainerSpec({
      ...input.postgresSpec,
      image: resolvedPostgresImage,
    });

    // The baseline cache's decision has to land BEFORE `docker create`: a warm restore is a
    // `docker cp -` into the created-but-unstarted container, so the whole create + health wait
    // belongs to it. Always eligible: a reset just removed the volume, so this run always
    // provisions the platform baseline. See `main-db-baseline.ts`.
    const baseline = yield* legacyBringUpMainDbWithBaseline(spawner, {
      fs: input.fs,
      path: input.path,
      workdir: input.workdir,
      dbContainerId: input.dbContainerId,
      hostname: input.hostname,
      dbPort: input.dbPort,
      healthTimeoutSeconds: input.dbHealthTimeoutSeconds,
      image: resolvedPostgresImage,
      postgresSpec: input.postgresSpec,
      setup: input.setup,
      toml: input.toml,
      spec: postgresSpec,
      containerOpts: input.containerOpts,
      cacheEligible: true,
      // Never swallowed — reset has no `--from-backup`-equivalent gate at all.
      waitReady: legacyWaitForHealthyServices(spawner, [postgresSpec.containerName], {
        timeoutSeconds: input.dbHealthTimeoutSeconds,
        images: new Map([[postgresSpec.containerName, resolvedPostgresImage]]),
      }),
    });

    // UNCONDITIONAL — no fresh-volume gate: a reset just removed the volume above, so
    // it's always fresh. Passes the RESOLVED reset `version`/`seedFlags`, unlike `db
    // start`'s own call — see `db-setup.ts`'s header for this one real difference.
    yield* legacyRunFreshDbSetup(
      spawner,
      {
        fs: input.fs,
        path: input.path,
        workdir: input.workdir,
        projectId: input.projectId,
        networkId: input.networkId,
        hostname: input.hostname,
        dbPort: input.dbPort,
        version: input.version,
        seedFlags: input.seedFlags,
        setup: input.setup,
      },
      baseline,
    );

    yield* output.raw("Restarting containers...\n", "stderr");
    yield* legacyRestartServicesAndReloadKong(spawner, input.projectId);
  });

/**
 * Port of Go's `resetDatabase14` (`reset.go:96-112`) — see this module's own
 * header for the full sequence and citations. Loads `config.toml` once, ahead of
 * `initDatabase` (needs `api.auto_expose_new_tables`) and the final
 * `MigrateAndSeed` (needs `db.migrations.enabled`/`[db.seed]`/pg-delta gate) —
 * the same "each caller re-loads its own config" duplication `db start`'s own
 * handler and `legacyRunFreshDbSetup` both already take independently.
 */
const legacyRecreateLocalDatabase14 = <E>(
  spawner: Spawner,
  input: LegacyRecreateLocalDatabaseInput<E>,
): Effect.Effect<
  void,
  LegacyRecreateLocalDatabaseError | E,
  | Output
  | LegacyDbConnection
  | LegacyDockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | LegacyEdgeRuntimeScript
  | LegacyPgDeltaSslProbe
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const { setup, fs, path, workdir } = input;
    const dbPassword = legacyStartInternalDbPassword(setup.dbUrl);
    const toml = yield* legacyCheckDbToml(fs, path, workdir);
    const dbConnection = yield* LegacyDbConnection;
    const output = yield* Output;

    const connectAs = (user: string, database: string) =>
      dbConnection.connect(
        { host: input.hostname, port: input.dbPort, user, password: dbPassword, database },
        { isLocal: true, dnsResolver: "native" },
      );

    // recreateDatabase: connect as `supabase_admin` to `template1`.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connectAs("supabase_admin", "template1");
        yield* legacyResetRecreateDatabases(session);
      }),
    );

    // initDatabase: connect as `supabase_admin` to the default `postgres` database.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connectAs("supabase_admin", "postgres");
        const tmpDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "supabase-reset-db-setup-" })
          .pipe(
            Effect.mapError(
              (error) =>
                new LegacyDbSetupError({
                  message: `failed to create temp directory: ${errMessage(error)}`,
                  reason: "filesystem",
                }),
            ),
          );
        yield* legacyInitSchema14(session, fs, path, tmpDir, setup.majorVersion);
        // Same drop-then-conditionally-recreate sequence fresh setup runs
        // (`db-setup.ts`'s `requiresPg14WebhooksCleanup`): the PG14 dump installs
        // pg_net unconditionally because later statements grant on its schema, so
        // without this drop a reset with webhooks disabled left pg_net installed and
        // diverged from a fresh `supabase start` — visible as pg_net drift in the next
        // engine's shadow baseline. `MigrateAndSeed` re-applies every migration below,
        // so a user migration that creates pg_net still gets it back.
        yield* legacyRemoveDatabaseWebhooks(session, fs, path, tmpDir);
        yield* legacyApplyApiPrivileges(
          session,
          fs,
          path,
          tmpDir,
          toml.baseline.apiAutoExposeNewTables,
        );
        yield* legacyApplyDatabaseWebhooks(session, fs, path, tmpDir, toml.webhooksEnabled);
      }),
    );

    // RestartDatabase: "Restarting containers..." FIRST, then a REAL restart of the `db`
    // container itself (pg_cron must restart after `pg_terminate_backend`) — NOT tolerant
    // of "not found", unlike the satellite restarts inside `legacyRestartServicesAndReloadKong`.
    yield* output.raw("Restarting containers...\n", "stderr");
    yield* legacyRestartContainer(spawner, input.dbContainerId);
    yield* legacyWaitForHealthyServices(spawner, [input.dbContainerId], {
      timeoutSeconds: input.dbHealthTimeoutSeconds,
    });
    yield* legacyRestartServicesAndReloadKong(spawner, input.projectId);

    // Final connect as `postgres`/`postgres` -> apply.MigrateAndSeed(ctx, version, ...).
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connectAs("postgres", "postgres");
        yield* legacyMigrateAndSeed(session, fs, path, workdir, input.version, {
          migrationsEnabled: toml.migrationsEnabled,
          seed: legacyResolveResetSeedConfig(toml.seed, input.seedFlags, path),
          experimental: setup.experimental,
          pgDeltaEnabled: toml.pgDelta.enabled,
          schemaPaths: toml.schemaPaths,
          localDatabaseWebhooksEnabled: toml.webhooksEnabled,
        });
      }),
    );
  });

/**
 * Runs the exact Go `resetDatabase`/`resetDatabase14`/`resetDatabase15` sequence —
 * see this module's header for the full call order and citations. The caller has
 * already printed `Resetting local database…`, matching Go's own `resetDatabase`
 * wrapper (`reset.go:81-87`) minus that one line (which the seam this replaces
 * used to print itself, and which `db/reset/reset.handler.ts` now prints
 * directly, exactly like before).
 */
export const legacyRecreateLocalDatabase = <E>(
  spawner: Spawner,
  input: LegacyRecreateLocalDatabaseInput<E>,
): Effect.Effect<
  void,
  LegacyRecreateLocalDatabaseError | E,
  | Output
  | LegacyDbConnection
  | LegacyDockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | LegacyEdgeRuntimeScript
  | LegacyPgDeltaSslProbe
  | FileSystem.FileSystem
  | Path.Path
> =>
  input.setup.majorVersion <= 14
    ? legacyRecreateLocalDatabase14(spawner, input)
    : legacyRecreateLocalDatabase15(spawner, input);
