/**
 * `db reset --local`'s container-recreate composition — not a thin wrapper over
 * {@link startDatabase}, since the shared `StartDatabase`-equivalent primitive is never called
 * from a reset either. Reuses the same underlying primitives (`ensureNetwork`,
 * `buildPostgresStartContainerSpec`, `createContainer`, `waitForPostgresReady`,
 * `startSetupLocalDatabase`): it recreates the container/volume/network and re-runs setup. It
 * does not probe for an existing volume, support `--from-backup`, or roll back the database on
 * failure; it stops storage/auth/realtime/pooler first and restarts them (+ Kong reload) once at
 * the end, or after a failure unless Docker reports the db container missing or stopped.
 */

import { Effect, Exit, Result, type FileSystem, type Path } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { Output } from "../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import type { DbConnection } from "../db-connection.service.ts";
import type { DbConnectError } from "../db-connection.errors.ts";
import { dockerSupportsHealthStartInterval, isContainerNotFoundMessage } from "../container-cli.ts";
import { CLI_PROJECT_LABEL } from "../docker-ids.ts";
import { inspectContainerState } from "../docker-lifecycle.ts";
import type { DockerRun } from "../docker-run.service.ts";
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
  type FreshDbSetupInput,
  type StartSetupLocalDatabaseError,
} from "./db-setup.ts";
import {
  awaitDockerHealthSettled,
  waitForPostgresReady,
  type HealthCheckTimeoutError,
} from "./health-check.ts";
import type { ImagePrepullError } from "./image-prepull.ts";
import { startInternalDbPassword } from "./internal-db-connection.ts";
import {
  buildPostgresStartContainerSpec,
  type PostgresStartServiceInput,
} from "./postgres.service.ts";
import {
  restartServicesAndReloadKong,
  stopSatelliteServices,
  type KongReloadError,
  type RestartServicesError,
} from "./restart-services.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Every failure the `db reset` recreate composition can produce. */
export type RecreateLocalDatabaseError =
  | NetworkCreateError
  | ContainerRemoveError
  | VolumeRemoveError
  | ContainerError
  | ImagePrepullError
  | HealthCheckTimeoutError
  | StartSetupLocalDatabaseError
  | DbConnectError
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
  /** Lazy: resolved after the old container and volume are removed. */
  readonly resolvePostgresImage: Effect.Effect<string, ImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /** The resolved reset migration version (`""` for every pending migration). */
  readonly version: string;
  /** The same shape `start-database.ts`'s `StartDatabaseInput.setup` uses — hoisted to {@link FreshDbSetupInput}. */
  readonly setup: FreshDbSetupInput<E>;
}

const STACK_RECOVERY_HINT = "Run supabase stop && supabase start to bring the local stack back.";

/**
 * Runs the recreate sequence — see this module's header for the full call order. The caller has
 * already printed `Resetting local database…`.
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
  | CliConfigValues
> =>
  Effect.gen(function* () {
    const output = yield* Output;

    yield* stopSatelliteServices(spawner, input.projectId);
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
    yield* createContainer(spawner, postgresSpec, {
      ...input.containerOpts,
      healthStartInterval: yield* dockerSupportsHealthStartInterval(spawner),
    });

    // Never swallowed — reset has no `--from-backup`-equivalent gate.
    yield* waitForPostgresReady(
      spawner,
      postgresSpec.containerName,
      {
        host: input.hostname,
        port: input.dbPort,
        user: "postgres",
        password: startInternalDbPassword(input.setup.dbUrl),
        database: "postgres",
      },
      { timeoutSeconds: input.dbHealthTimeoutSeconds, image: resolvedPostgresImage },
    );

    // No fresh-volume gate needed: a reset just removed the volume above, so it's always fresh.
    // Passes the resolved reset `version`, unlike `db start`'s own call.
    yield* runFreshDbSetup(spawner, {
      fs: input.fs,
      path: input.path,
      workdir: input.workdir,
      projectId: input.projectId,
      networkId: input.networkId,
      hostname: input.hostname,
      dbPort: input.dbPort,
      version: input.version,
      setup: input.setup,
    });

    yield* output.raw("Restarting containers...\n", "stderr");
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? restartServicesAndReloadKong(spawner, input.projectId)
        : Effect.gen(function* () {
            const output = yield* Output;
            const inspected = yield* inspectContainerState(spawner, input.dbContainerId).pipe(
              Effect.result,
            );
            const dbGone = Result.isFailure(inspected)
              ? isContainerNotFoundMessage(inspected.failure.message)
              : !inspected.success.running;
            if (dbGone) {
              return yield* output.warn(
                `The local database is not running, so storage, auth, realtime and the pooler were left stopped.\n${STACK_RECOVERY_HINT}`,
              );
            }
            yield* restartServicesAndReloadKong(spawner, input.projectId).pipe(
              Effect.catchTags({
                RestartServicesError: (error) =>
                  output.warn(`${error.message}\n${STACK_RECOVERY_HINT}`),
                KongReloadError: (error) => output.warn(`${error.message}\n${error.suggestion}`),
              }),
            );
          }),
    ),
    Effect.tap(() => awaitDockerHealthSettled(spawner, input.dbContainerId)),
    Effect.withSpan("DbBootstrap.recreateLocalDatabase", {
      attributes: { "db.major_version": input.setup.majorVersion },
    }),
  );
