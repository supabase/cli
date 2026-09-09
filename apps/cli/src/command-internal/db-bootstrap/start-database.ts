/**
 * Strict 1:1 port of Go's `StartDatabase` (`apps/cli-go/internal/db/start/start.go:133-190`) —
 * the ONE function both `supabase start` (`commands/start/start.handler.ts`) and `db start`
 * (`commands/db/start/start.handler.ts`) call to bring up the local Postgres container. Hoisted
 * here as CLI-1954's own follow-up fix: both callers used to run their own independently-typed
 * ~200-line copy of this exact sequence, with no test comparing them — the highest-drift-risk
 * shape available in a codebase whose whole contract is byte-level Go parity. A future change to
 * Go's `StartDatabase` now only has one TS home to update.
 *
 * Exact Go call order: pre-create volume-existence probe (+ the `fromBackup`-on-an-existing-volume
 * guard) -> image resolve + network ensure (Go's `DockerStart` resolves the image, THEN creates
 * the network, both strictly
 * ahead of container create — `docker.go:363-386` — so NEITHER one ever runs on a request the
 * volume guard above already rejected) -> Postgres container create+start -> health wait
 * (swallowed ONLY when `fromBackup` is set — "restoring a large backup may take longer than 2
 * minutes") -> the fresh-volume `SetupLocalDatabase`-equivalent pipeline (skipped IN FULL when
 * `fromBackup` is set) -> `initCurrentBranch`, unconditionally (the LAST line of `StartDatabase`,
 * reached on every path that doesn't already return/fail above).
 *
 * Deliberately has ZERO knowledge of `--ignore-health-check` — matching Go exactly: that flag is
 * `internal/start/start.go`'s `Run()`'s own concern, entirely OUTSIDE `StartDatabase` (Go's
 * `StartDatabase` has no `ignoreHealthCheck` parameter at all). `supabase start`'s own caller
 * wraps the WHOLE call to {@link startDatabase} in its own `Effect.result` and decides
 * whether to downgrade an unhealthy-Postgres failure to a warning and continue with the REST of
 * its own bring-up (the other ~13 services) — this function only ever propagates that failure
 * bare, exactly like Go's `StartDatabase` returning it to `run()` unfiltered. Rollback
 * (`rollbackStart`) is ALSO the caller's own concern, not this function's — matching Go,
 * where `DockerRemoveAll` lives in `Run()` (both `db/start/start.go`'s own `Run` and
 * `internal/start/start.go`'s `Run`), never inside `StartDatabase` itself.
 *
 * Two inputs are caller-supplied `Effect`s rather than plain values, because their TIMING
 * relative to this function's own body genuinely differs between callers (not just a stylistic
 * choice — see each field's own doc comment below for the Go citation):
 *  - `resolvePostgresImage` — `db start` has no pre-pull pass at all (Go's `db start` binary has
 *    none either), so it resolves the registry candidate lazily, right here, exactly where Go's
 *    `DockerStart` would; `supabase start` already resolved it as part of its own batched
 *    `ensureImagesCached` pre-pull, before bring-up even starts, and just threads that value
 *    through.
 *  - `setup.jwks` — `db start` has no earlier use for JWKS at all, so it resolves it lazily,
 *    conditionally (only when reached AND `majorVersion >= 15` AND `realtime.enabled` — Go's
 *    `initSchema`, `start.go:243-254`, only ever reaches `initSchema15`'s `ResolveJWKS` call on
 *    PG15+; the PG13/14 branch, `InitSchema14`, never touches JWKS at all), matching Go's own
 *    `initSchema15`-local `ResolveJWKS` call (`internal/db/start/start.go:337-341`) exactly; `supabase start`
 *    resolves JWKS once, unconditionally, near the top of its OWN prelude (feeding its
 *    long-running Realtime/GoTrue/PostgREST containers too — `internal/start/start.go:274-277`)
 *    and reuses that SAME already-resolved value here rather than re-resolving (a second resolve
 *    could re-sign an asymmetric JWT with a different `exp`, disagreeing with the value already
 *    baked into those containers' envs).
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
 * Go's `StartDatabase` `fromBackup` guard (`start.go:170-172`): the local Postgres volume
 * already exists AND `fromBackup` was passed. Restoring into an already-provisioned volume
 * would silently no-op (or worse, mix a restored dump with whatever data the volume already
 * has) — Go refuses outright rather than guessing which the caller wants. Raised BEFORE any
 * container is created (no `docker create`/`docker start` happens on this path). Only ever
 * reachable via `db start` (the sole caller that ever sets `postgresSpec.fromBackup`).
 * Exported only so the exhaustive actionability guard can inspect its declaration;
 * runtime callers observe it through {@link StartDatabaseError}.
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
  /** Fed straight to `buildPostgresStartContainerSpec` — `fromBackup` (if set) drives BOTH the restore-entrypoint variant and the backup-volume-exists guard below. */
  readonly postgresSpec: Omit<PostgresStartServiceInput, "image">;
  /**
   * Lazy — evaluated right where Go's `DockerStart` would resolve it. See this module's header.
   * Fixed to `ImagePrepullError` (not generic `E`): both callers' real implementations
   * either never fail (`supabase start`'s already-resolved `Effect.succeed`) or fail with exactly
   * this error (`db start`'s own `ensureImagesCached` call) — already part of this
   * function's own fixed {@link StartDatabaseError} union.
   */
  readonly resolvePostgresImage: Effect.Effect<string, ImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  /** Effective `[experimental.webhooks].enabled`, used to converge existing volumes. */
  readonly webhooksEnabled: boolean;
  readonly setup: FreshDbSetupInput<E>;
  /**
   * Caller's `utils.NoBackupVolume` equivalent for `rollbackStart`. Fired once
   * after pre-create refuse guards pass. Skipped on those guards so rollback cannot
   * treat leftover sibling volumes as this run's fresh data.
   */
  readonly onFreshVolumeResolved: (isFreshVolume: boolean) => void;
}

/**
 * Runs the exact Go `StartDatabase` sequence — see this module's header for the full call order
 * and for why `resolvePostgresImage`/`setup.jwks` are caller-supplied `Effect`s rather than plain
 * values.
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

    // Go's pre-create volume-existence check (`internal/db/start/start.go:165-167`) — MUST run
    // before Postgres's own volume gets created below, AND before the network is created too:
    // `docker volume create`/`docker network create` are both idempotent, so creating either
    // first would make "did this volume already exist" unobservable, and would leave a Docker
    // network behind even for a request the guard below is about to reject outright — Go's own
    // `VolumeInspect` and the guard both run strictly BEFORE `DockerStart`, which is the ONLY
    // place Go ever creates the network (`docker.go:363-386`).
    const isFreshVolume = !(yield* volumeExists(spawner, input.dbContainerId));
    const fromBackup = input.postgresSpec.fromBackup;

    if (!isFreshVolume && fromBackup !== undefined) {
      // Go's `StartDatabase` (`start.go:170-172`): a `--from-backup` restore into an
      // already-provisioned volume is refused outright, BEFORE any container or network is
      // created — and before freshness is published, so rollback cannot prune it.
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

    // Go's `DockerStart` (`docker.go:363-386`): image resolve, THEN network create, both
    // strictly ahead of container create — hoisted here to run ONCE per `start` run instead of
    // once per container (Go's own repeated per-container call is a no-op after the first, see
    // `ensureNetwork`'s own doc comment), but kept in Go's own relative position:
    // after the volume probe/guard above, never before it.
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
      // Go's `StartDatabase` (`start.go:179-181`): `WaitForHealthyService`'s error is discarded
      // ONLY when `len(fromBackup) > 0` — the log dump to stderr already happened inside
      // `waitForHealthyServices` regardless of this branch. Any OTHER failure propagates
      // BARE — this function has no `--ignore-health-check` knowledge at all, see this module's
      // header for why that's entirely the caller's concern.
      if (fromBackup === undefined) {
        return yield* Effect.fail(postgresHealthResult.failure);
      }
    }

    // Go's `if utils.NoBackupVolume && len(fromBackup) == 0 { SetupLocalDatabase(...) }`
    // (`start.go:184-188`) — SKIPPED IN FULL when `fromBackup` is set, not merely reduced: no
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
        // Go's own `StartDatabase` -> `SetupLocalDatabase(ctx, "", ...)` call
        // (`start.go:185`) — every pending migration, no `db reset`-only seed
        // override (`db start` has neither `--no-seed` nor `--sql-paths`).
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

    // Go's `initCurrentBranch` (`db/start/start.go:189`) — the LAST line of `StartDatabase`,
    // reached on every path that doesn't already return/fail above: a fresh volume, a non-fresh
    // restart, AND a swallowed `fromBackup` health-check timeout.
    yield* startInitCurrentBranch(input.fs, input.path, input.workdir);
  });
