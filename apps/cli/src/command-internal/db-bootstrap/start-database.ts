/**
 * The one function both `supabase start` and `db start` call to bring up the local Postgres
 * container, so the two callers share one sequence to test and maintain instead of
 * independently-typed copies that could drift.
 *
 * Call order: pre-create volume-existence probe (+ the `fromBackup`-on-an-existing-volume guard)
 * -> image resolve + network ensure -> container create+start -> health wait (swallowed only when
 * `fromBackup` is set) -> the fresh-volume setup pipeline (skipped entirely when `fromBackup` is
 * set) -> `initCurrentBranch`, unconditionally, on every path that doesn't already return or fail
 * above. `--ignore-health-check` and rollback are the caller's own concern, not this function's.
 *
 * `resolvePostgresImage` and `setup.jwks` are caller-supplied `Effect`s, not plain values, because
 * their timing differs between callers: `db start` resolves both lazily, right where they're
 * needed, while `supabase start` already resolved them earlier in its own prelude (for its
 * pre-pull and its other services respectively) and just threads the same values through — see
 * each field's own doc comment.
 */

import { Data, Effect, type FileSystem, type Path, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { Output } from "../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { aqua } from "../colors.ts";
import { DbConnection } from "../db-connection.service.ts";
import type { DbConnectError } from "../db-connection.errors.ts";
import { CLI_PROJECT_LABEL } from "../docker-ids.ts";
import type { DockerRun } from "../docker-run.service.ts";
import {
  ensureNetwork,
  createContainer,
  volumeExists,
  COMPOSE_PROJECT_LABEL,
  type ContainerCreateError,
  type ContainerOpts,
  type ContainerStartError,
  type NetworkCreateError,
  type VolumeCreateError,
  type VolumeInspectError,
} from "./container-lifecycle.ts";
import {
  runDatabaseWebhooksSetup,
  runFreshDbSetup,
  startInitCurrentBranch,
  type FreshDbSetupInput,
  type StartSetupLocalDatabaseError,
} from "./db-setup.ts";
import type { ImagePrepullError } from "./image-prepull.ts";
import { waitForHealthyServices, type HealthCheckTimeoutError } from "./health-check.ts";
import {
  START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
  START_STARTING_DATABASE_MESSAGE,
} from "./messages.ts";
import {
  buildPostgresStartContainerSpec,
  type PostgresStartServiceInput,
} from "./postgres.service.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * The local Postgres volume already exists and `fromBackup` was passed. Restoring into an
 * already-provisioned volume would silently no-op or mix a restored dump with existing data, so
 * this refuses outright before any container is created. Exported only so the exhaustive
 * actionability guard can inspect its declaration; runtime callers see it via {@link StartDatabaseError}.
 */
class StartBackupVolumeExistsError extends Data.TaggedError("StartBackupVolumeExistsError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.stopStack;
  }
}

/** Every failure {@link startDatabase} itself can produce, independent of the caller's own `E`. */
export type StartDatabaseError =
  | NetworkCreateError
  | VolumeInspectError
  | StartBackupVolumeExistsError
  | VolumeCreateError
  | ContainerCreateError
  | ContainerStartError
  | ImagePrepullError
  | HealthCheckTimeoutError
  | DbConnectError
  | StartSetupLocalDatabaseError;

export interface StartDatabaseInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  readonly projectId: string;
  readonly networkId: string;
  readonly hostname: string;
  /** `localDbContainerId(projectId)` — also the connect-target host inside the local Postgres session below. */
  readonly dbContainerId: string;
  readonly dbPort: number;
  readonly containerOpts: ContainerOpts;
  /** Fed straight to `buildPostgresStartContainerSpec` — `fromBackup` (if set) drives both the restore-entrypoint variant and the backup-volume-exists guard below. */
  readonly postgresSpec: Omit<PostgresStartServiceInput, "image">;
  /**
   * Lazy — evaluated right here rather than pre-resolved. See this module's header. Fixed to
   * `ImagePrepullError` (not generic `E`) since both callers' real implementations either never
   * fail or fail with exactly this error, already part of {@link StartDatabaseError}.
   */
  readonly resolvePostgresImage: Effect.Effect<string, ImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /** Effective `[experimental.webhooks].enabled`, used to converge existing volumes. */
  readonly webhooksEnabled: boolean;
  readonly setup: FreshDbSetupInput<E>;
  /**
   * Reports whether the volume was freshly created, for the caller's own rollback logic. Fired
   * once after the pre-create refuse guards pass, so rollback never treats a leftover sibling
   * volume as this run's fresh data.
   */
  readonly onFreshVolumeResolved: (isFreshVolume: boolean) => void;
}

/**
 * See this module's header for the full call order and for why `resolvePostgresImage`/
 * `setup.jwks` are caller-supplied `Effect`s rather than plain values.
 */
export const startDatabase = <E>(
  spawner: Spawner,
  input: StartDatabaseInput<E>,
): Effect.Effect<
  void,
  StartDatabaseError | E,
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

    // Must run before the volume or network are created: both `docker volume create` and
    // `docker network create` are idempotent, so creating either first would make "did this
    // volume already exist" unobservable and could leave a network behind for a request the
    // guard below is about to reject.
    const isFreshVolume = !(yield* volumeExists(spawner, input.dbContainerId));
    const fromBackup = input.postgresSpec.fromBackup;

    if (!isFreshVolume && fromBackup !== undefined) {
      // Refused before any container or network is created, and before freshness is published,
      // so rollback cannot prune it.
      return yield* Effect.fail(
        new StartBackupVolumeExistsError({
          message: "backup volume already exists",
          suggestion: `Run ${aqua("supabase stop --no-backup")} to remove existing docker volumes.`,
        }),
      );
    }

    // Print this before image resolve so a flag-off cold/failed pull still
    // follows the established progress order.
    yield* output.raw(
      isFreshVolume ? START_STARTING_DATABASE_MESSAGE : START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
      "stderr",
    );

    const resolvedPostgresImage = yield* input.resolvePostgresImage;

    input.onFreshVolumeResolved(isFreshVolume);

    // Runs once per `start` run rather than once per container — see `ensureNetwork`'s own doc
    // comment — but kept after the volume probe/guard above, never before it.
    yield* ensureNetwork(spawner, input.networkId, {
      [CLI_PROJECT_LABEL]: input.projectId,
      [COMPOSE_PROJECT_LABEL]: input.projectId,
    });

    const postgresSpec = buildPostgresStartContainerSpec({
      ...input.postgresSpec,
      image: resolvedPostgresImage,
    });
    yield* createContainer(spawner, postgresSpec, input.containerOpts);

    const postgresHealthResult = yield* waitForHealthyServices(
      spawner,
      [postgresSpec.containerName],
      {
        timeoutSeconds: input.dbHealthTimeoutSeconds,
        images: new Map([[postgresSpec.containerName, resolvedPostgresImage]]),
      },
    ).pipe(Effect.result);
    if (Result.isFailure(postgresHealthResult)) {
      // Discarded only when `fromBackup` is set — the log dump to stderr already happened
      // inside `waitForHealthyServices` regardless. Any other failure propagates bare; see this
      // module's header for why `--ignore-health-check` is entirely the caller's concern.
      if (fromBackup === undefined) {
        return yield* Effect.fail(postgresHealthResult.failure);
      }
    }

    // Skipped entirely when `fromBackup` is set, not merely reduced: no
    // initSchema/ApplyApiPrivileges/vault/roles.sql/MigrateAndSeed on that path at all.
    if (isFreshVolume && fromBackup === undefined) {
      yield* runFreshDbSetup(spawner, {
        fs: input.fs,
        path: input.path,
        workdir: input.workdir,
        projectId: input.projectId,
        networkId: input.networkId,
        hostname: input.hostname,
        dbPort: input.dbPort,
        // Every pending migration, no seed override — `db start` has neither `--no-seed` nor
        // `--sql-paths`.
        version: "",
        seedFlags: { noSeed: false, sqlPaths: [] },
        setup: input.setup,
      });
    } else if (fromBackup === undefined) {
      yield* runDatabaseWebhooksSetup({
        fs: input.fs,
        path: input.path,
        hostname: input.hostname,
        dbPort: input.dbPort,
        dbUrl: input.setup.dbUrl,
        enabled: input.webhooksEnabled,
      });
    }

    // Reached on every path that doesn't already return or fail above: a fresh volume, a
    // non-fresh restart, and a swallowed `fromBackup` health-check timeout.
    yield* startInitCurrentBranch(input.fs, input.path, input.workdir);
  });
