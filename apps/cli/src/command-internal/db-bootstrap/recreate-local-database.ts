/**
 * `db reset --local`'s container-recreate composition — not a thin wrapper over
 * {@link startDatabase}, since the shared `StartDatabase`-equivalent primitive is never called
 * from a reset either. Reuses the same underlying primitives (`ensureNetwork`,
 * `buildPostgresStartContainerSpec`, `createContainer`, `waitForHealthyServices`,
 * `startSetupLocalDatabase`) with a distinct sequence per major version: PG >= 15 recreates the
 * container/volume/network and re-runs setup; PG <= 14 recreates the two databases in place and
 * reinitializes the schema. Neither path probes for an existing volume, supports
 * `--from-backup`, or rolls back on failure.
 */

import { Data, Effect, Result, Schedule, type FileSystem, type Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { isSqlState } from "../connect-errors.ts";
import { checkDbToml } from "../db-config.toml-read.ts";
import { DbConnection, type DbSession } from "../db-connection.service.ts";
import { DbExecError, type DbConnectError } from "../db-connection.errors.ts";
import { CLI_PROJECT_LABEL } from "../docker-ids.ts";
import type { DockerRun } from "../docker-run.service.ts";
import { migrateAndSeed } from "../migrate-and-seed.ts";
import { formatExecBatchError, type MigrationApplyError } from "../migration-apply.ts";
import { errorMessage } from "../error-message.ts";
import type { MigrationSeedError } from "../seed.ts";
import {
  ensureNetwork,
  removeContainer,
  removeVolume,
  createContainer,
  COMPOSE_PROJECT_LABEL,
  type ContainerRemoveError,
  type ContainerError,
  type ContainerOpts,
  type NetworkCreateError,
  type VolumeRemoveError,
} from "./container-lifecycle.ts";
import {
  runFreshDbSetup,
  resolveResetSeedConfig,
  applyApiPrivileges,
  applyDatabaseWebhooks,
  initSchema14,
  removeDatabaseWebhooks,
  DbSetupError,
  type FreshDbSetupInput,
  type StartSetupLocalDatabaseError,
} from "./db-setup.ts";
import { waitForHealthyServices, type HealthCheckTimeoutError } from "./health-check.ts";
import type { ImagePrepullError } from "./image-prepull.ts";
import { startInternalDbPassword } from "./internal-db-connection.ts";
import {
  buildPostgresStartContainerSpec,
  type PostgresStartServiceInput,
} from "./postgres.service.ts";
import {
  restartContainer,
  restartServicesAndReloadKong,
  type ContainerRestartError,
  type KongReloadError,
  type RestartServicesError,
} from "./restart-services.ts";

type Spawner = ChildProcessSpawner["Service"];

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * One or more replication slots are still active (retryable — the WAL sender that owns the
 * slot may still be tearing down), or counting them failed outright (permanent).
 */
export class ResetReplicationSlotsError extends Data.TaggedError("ResetReplicationSlotsError")<{
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
export type RecreateLocalDatabaseError =
  // PG15
  | NetworkCreateError
  | ContainerRemoveError
  | VolumeRemoveError
  | ContainerError
  | ImagePrepullError
  | HealthCheckTimeoutError
  | StartSetupLocalDatabaseError
  // PG14
  | DbConnectError
  | DbExecError
  | ResetReplicationSlotsError
  | DbSetupError
  | ContainerRestartError
  | MigrationApplyError
  | MigrationSeedError
  // Shared post-recreate step (both branches)
  | RestartServicesError
  | KongReloadError;

export interface RecreateLocalDatabaseInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  readonly projectId: string;
  readonly networkId: string;
  readonly hostname: string;
  /** Also this composition's own volume name. */
  readonly dbContainerId: string;
  readonly dbPort: number;
  readonly containerOpts: ContainerOpts;
  /** Fed straight to `buildPostgresStartContainerSpec` — reset has no `fromBackup` concept. */
  readonly postgresSpec: Omit<PostgresStartServiceInput, "image" | "fromBackup">;
  /** Lazy: only resolved on the PG15 path. */
  readonly resolvePostgresImage: Effect.Effect<string, ImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /** The resolved reset migration version (`""` for every pending migration). */
  readonly version: string;
  /** `db reset`'s `--no-seed`/`--sql-paths` — see {@link resolveResetSeedConfig}. */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
  /** The same shape `start-database.ts`'s `StartDatabaseInput.setup` uses — hoisted to {@link FreshDbSetupInput}. */
  readonly setup: FreshDbSetupInput<E>;
}

/** Postgres SQLSTATE for "database doesn't exist yet", expected on a first-ever reset. */
const PG_INVALID_CATALOG_NAME = "3D000";

/**
 * Disables new connections to `postgres`/`_supabase`, terminates existing backends, then waits
 * for WAL senders to drop their replication slots (1-second backoff, 10 retries max).
 */
export const resetDisconnectClients = Effect.fnUntraced(function* (session: DbSession) {
  // Must run sequentially, unwrapped: looping these in a transaction is unsupported, and
  // Effect's short-circuit-on-failure stops at the first bad statement.
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
    // `failure.code` isn't reliably PgError-only: the driver's exec-error mapping can also set
    // `code` to a bare OS errno (`ECONNRESET`, `ETIMEDOUT`, ...), so `isSqlState` must gate
    // treating it as a real Postgres code. A non-PgError failure and a 3D000 PgError are both
    // silently swallowed.
    if (
      failure.code !== undefined &&
      isSqlState(failure.code) &&
      failure.code !== PG_INVALID_CATALOG_NAME
    ) {
      return yield* Effect.fail(
        new DbSetupError({
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
          new ResetReplicationSlotsError({
            message: `failed to count replication slots: ${cause.message}`,
            retryable: false,
          }),
      ),
      Effect.flatMap((rows) => {
        const count = Number(rows[0]?.["count"] ?? 0);
        return count > 0
          ? Effect.fail(
              new ResetReplicationSlotsError({
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

// `DROP`/`CREATE DATABASE` cannot run inside a `BEGIN`/`COMMIT` block, so these run as bare,
// sequential statements rather than the batch primitive (which would wrap them in a
// transaction). Each statement's index matches its position in this list, used for error
// formatting.
const RESET_RECREATE_DATABASES_STATEMENTS = [
  "DROP DATABASE IF EXISTS postgres WITH (FORCE)",
  "CREATE DATABASE postgres WITH OWNER postgres",
  "DROP DATABASE IF EXISTS _supabase WITH (FORCE)",
  "CREATE DATABASE _supabase WITH OWNER postgres",
] as const;

/**
 * Connects as `supabase_admin` to `template1`, disconnects clients, then runs four sequential
 * statements. Roles are not dropped here since they are cluster-level entities — use stop then
 * start instead.
 */
const resetRecreateDatabases = Effect.fnUntraced(function* (session: DbSession) {
  yield* resetDisconnectClients(session);
  for (const [index, statement] of RESET_RECREATE_DATABASES_STATEMENTS.entries()) {
    yield* session.exec(statement).pipe(
      Effect.mapError(
        (error) =>
          new DbExecError({
            message: errorMessage(formatExecBatchError(error, index, statement)),
            code: error.code,
            detail: error.detail,
            position: error.position,
          }),
      ),
    );
  }
});

/** PG >= 15 recreate path — see this module's own header for the full sequence. */
const recreateLocalDatabase15 = <E>(
  spawner: Spawner,
  input: RecreateLocalDatabaseInput<E>,
): Effect.Effect<
  void,
  RecreateLocalDatabaseError | E,
  | Output
  | DbConnection
  | DockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const output = yield* Output;

    yield* removeContainer(spawner, input.dbContainerId);
    yield* removeVolume(spawner, input.dbContainerId);

    yield* ensureNetwork(spawner, input.networkId, {
      [CLI_PROJECT_LABEL]: input.projectId,
      [COMPOSE_PROJECT_LABEL]: input.projectId,
    });

    yield* output.raw("Recreating database...\n", "stderr");

    const resolvedPostgresImage = yield* input.resolvePostgresImage;
    const postgresSpec = buildPostgresStartContainerSpec({
      ...input.postgresSpec,
      image: resolvedPostgresImage,
    });
    yield* createContainer(spawner, postgresSpec, input.containerOpts);

    // Never swallowed — reset has no `--from-backup`-equivalent gate.
    yield* waitForHealthyServices(spawner, [postgresSpec.containerName], {
      timeoutSeconds: input.dbHealthTimeoutSeconds,
      images: new Map([[postgresSpec.containerName, resolvedPostgresImage]]),
    });

    // No fresh-volume gate needed: a reset just removed the volume above, so it's always fresh.
    // Passes the resolved reset `version`/`seedFlags`, unlike `db start`'s own call.
    yield* runFreshDbSetup(spawner, {
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
    });

    yield* output.raw("Restarting containers...\n", "stderr");
    yield* restartServicesAndReloadKong(spawner, input.projectId);
  });

/**
 * Loads `config.toml` once, ahead of `initDatabase` (needs `api.auto_expose_new_tables`) and the
 * final `MigrateAndSeed` (needs `db.migrations.enabled`/`[db.seed]`/pg-delta gate).
 */
const recreateLocalDatabase14 = <E>(
  spawner: Spawner,
  input: RecreateLocalDatabaseInput<E>,
): Effect.Effect<
  void,
  RecreateLocalDatabaseError | E,
  | Output
  | DbConnection
  | DockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const { setup, fs, path, workdir } = input;
    const dbPassword = startInternalDbPassword(setup.dbUrl);
    const toml = yield* checkDbToml(fs, path, workdir);
    const dbConnection = yield* DbConnection;
    const output = yield* Output;

    const connectAs = (user: string, database: string) =>
      dbConnection.connect(
        { host: input.hostname, port: input.dbPort, user, password: dbPassword, database },
        { isLocal: true, dnsResolver: "native" },
      );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connectAs("supabase_admin", "template1");
        yield* resetRecreateDatabases(session);
      }),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connectAs("supabase_admin", "postgres");
        const tmpDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "supabase-reset-db-setup-" })
          .pipe(
            Effect.mapError(
              (error) =>
                new DbSetupError({
                  message: `failed to create temp directory: ${errMessage(error)}`,
                  reason: "filesystem",
                }),
            ),
          );
        yield* initSchema14(session, fs, path, tmpDir, setup.majorVersion);
        // Same drop-then-conditionally-recreate sequence fresh setup runs
        // (`db-setup.ts`'s `requiresPg14WebhooksCleanup`): the PG14 dump installs pg_net
        // unconditionally, so without this drop a reset with webhooks disabled would leave
        // pg_net installed, causing drift against a fresh `supabase start`. `MigrateAndSeed`
        // re-applies every migration below, so a user migration that creates pg_net still gets
        // it back.
        yield* removeDatabaseWebhooks(session, fs, path, tmpDir);
        yield* applyApiPrivileges(session, fs, path, tmpDir, toml.baseline.apiAutoExposeNewTables);
        yield* applyDatabaseWebhooks(session, fs, path, tmpDir, toml.webhooksEnabled);
      }),
    );

    // "Restarting containers..." first, then an actual restart of the `db` container itself
    // (pg_cron must restart after `pg_terminate_backend`); not tolerant of "not found", unlike
    // the satellite restarts inside `restartServicesAndReloadKong`.
    yield* output.raw("Restarting containers...\n", "stderr");
    yield* restartContainer(spawner, input.dbContainerId);
    yield* waitForHealthyServices(spawner, [input.dbContainerId], {
      timeoutSeconds: input.dbHealthTimeoutSeconds,
    });
    yield* restartServicesAndReloadKong(spawner, input.projectId);

    // Final connect as `postgres`/`postgres` to migrate and seed.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* connectAs("postgres", "postgres");
        yield* migrateAndSeed(session, fs, path, workdir, input.version, {
          migrationsEnabled: toml.migrationsEnabled,
          seed: resolveResetSeedConfig(toml.seed, input.seedFlags, path),
          experimental: setup.experimental,
          pgDeltaEnabled: toml.pgDelta.enabled,
          schemaPaths: toml.schemaPaths,
          localDatabaseWebhooksEnabled: toml.webhooksEnabled,
        });
      }),
    );
  });

/**
 * Runs the PG14/PG15 recreate sequence — see this module's header for the full call order. The
 * caller has already printed `Resetting local database…`.
 */
export const recreateLocalDatabase = <E>(
  spawner: Spawner,
  input: RecreateLocalDatabaseInput<E>,
): Effect.Effect<
  void,
  RecreateLocalDatabaseError | E,
  | Output
  | DbConnection
  | DockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
> =>
  input.setup.majorVersion <= 14
    ? recreateLocalDatabase14(spawner, input)
    : recreateLocalDatabase15(spawner, input);
