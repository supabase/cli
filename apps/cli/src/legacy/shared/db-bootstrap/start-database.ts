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
 * the network, both strictly ahead of container create — `docker.go:363-386` — so NEITHER one
 * ever runs on a request the volume guard above already rejected) -> Postgres container
 * create+start -> health wait (swallowed ONLY when `fromBackup` is set — "restoring a large
 * backup may take longer than 2 minutes") -> the fresh-volume `SetupLocalDatabase`-equivalent
 * pipeline (skipped IN FULL when `fromBackup` is set) -> `initCurrentBranch`, unconditionally (the
 * LAST line of `StartDatabase`, reached on every path that doesn't already return/fail above).
 *
 * Deliberately has ZERO knowledge of `--ignore-health-check` — matching Go exactly: that flag is
 * `internal/start/start.go`'s `Run()`'s own concern, entirely OUTSIDE `StartDatabase` (Go's
 * `StartDatabase` has no `ignoreHealthCheck` parameter at all). `supabase start`'s own caller
 * wraps the WHOLE call to {@link legacyStartDatabase} in its own `Effect.result` and decides
 * whether to downgrade an unhealthy-Postgres failure to a warning and continue with the REST of
 * its own bring-up (the other ~13 services) — this function only ever propagates that failure
 * bare, exactly like Go's `StartDatabase` returning it to `run()` unfiltered. Rollback
 * (`legacyRollbackStart`) is ALSO the caller's own concern, not this function's — matching Go,
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

import { Output } from "../../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import type { LocalServiceVersionOverrides } from "../../../shared/services/services.shared.ts";
import { legacyAqua } from "../legacy-colors.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import type { LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import { LEGACY_CLI_PROJECT_LABEL } from "../legacy-docker-ids.ts";
import type { LegacyDockerRun } from "../legacy-docker-run.service.ts";
import {
  legacyEnsureStartNetwork,
  legacyStartContainer,
  legacyStartVolumeExists,
  LEGACY_COMPOSE_PROJECT_LABEL,
  type LegacyStartContainerCreateError,
  type LegacyStartContainerOpts,
  type LegacyStartContainerStartError,
  type LegacyStartNetworkCreateError,
  type LegacyStartVolumeCreateError,
  type LegacyStartVolumeInspectError,
} from "./container-lifecycle.ts";
import {
  legacyStartInitCurrentBranch,
  legacyStartSetupLocalDatabase,
  type LegacyStartDbSetupImages,
  type LegacyStartSetupLocalDatabaseError,
  type LegacyStartSetupLocalDatabaseInput,
} from "./db-setup.ts";
import { type LegacyImagePrepullError } from "./image-prepull.ts";
import {
  legacyWaitForHealthyServices,
  type LegacyHealthCheckTimeoutError,
} from "./health-check.ts";
import { legacyStartInternalDbPassword } from "./internal-db-connection.ts";
import {
  LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
  LEGACY_START_STARTING_DATABASE_MESSAGE,
} from "./messages.ts";
import { legacyResolvePinnedImage } from "./pinned-image.ts";
import {
  legacyBuildPostgresStartContainerSpec,
  type LegacyPostgresStartServiceInput,
} from "./postgres.service.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Go's `StartDatabase` `fromBackup` guard (`start.go:170-172`): the local Postgres volume
 * already exists AND `fromBackup` was passed. Restoring into an already-provisioned volume
 * would silently no-op (or worse, mix a restored dump with whatever data the volume already
 * has) — Go refuses outright rather than guessing which the caller wants. Raised BEFORE any
 * container is created (no `docker create`/`docker start` happens on this path). Only ever
 * reachable via `db start` (the sole caller that ever sets `postgresSpec.fromBackup`).
 * Not exported outside this module — callers only ever observe it through the
 * {@link LegacyStartDatabaseError} union and its `_tag`, never by importing the class.
 */
class LegacyStartBackupVolumeExistsError extends Data.TaggedError(
  "LegacyStartBackupVolumeExistsError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {}

/** Every failure {@link legacyStartDatabase} itself can produce, independent of the caller's own `E`. */
export type LegacyStartDatabaseError =
  | LegacyStartNetworkCreateError
  | LegacyStartVolumeInspectError
  | LegacyStartBackupVolumeExistsError
  | LegacyStartVolumeCreateError
  | LegacyStartContainerCreateError
  | LegacyStartContainerStartError
  | LegacyImagePrepullError
  | LegacyHealthCheckTimeoutError
  | LegacyDbConnectError
  | LegacyStartSetupLocalDatabaseError;

/**
 * Everything {@link legacyStartSetupLocalDatabase} needs, minus what `legacyStartDatabase`
 * itself already resolves/threads through (`session`, `majorVersion`, `projectId`,
 * `networkId`, `images`). Not exported outside this module — callers build this shape as
 * the `setup` field of {@link LegacyStartDatabaseInput} without needing to name the type.
 */
interface LegacyStartDatabaseSetupInput<E> {
  readonly majorVersion: number;
  /** Already spliced with the caller's own realtime/storage/auth enabled-for-setup + ip_version/max_header_length/file_size_limit overrides — see `bootstrap-config.ts`'s `LegacyDbBootstrapConfig`. */
  readonly config: LegacyStartSetupLocalDatabaseInput["config"];
  /** Threaded straight through to {@link LegacyStartSetupLocalDatabaseInput.experimental} — see its own doc comment. */
  readonly experimental: boolean;
  readonly dbUrl: string;
  readonly jwtSecret: string;
  /** Lazy — evaluated only when reached (fresh volume, `fromBackup` unset) AND `realtimeEnabledForSetup`. See this module's header for why this is caller-supplied rather than resolved here unconditionally. */
  readonly jwks: Effect.Effect<string, E>;
  readonly apiUrl: string;
  readonly authExternalUrl: string | undefined;
  readonly siteUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly storageTargetMigration: string;
  readonly realtimeEnabledForSetup: boolean;
  readonly storageEnabledForSetup: boolean;
  readonly authEnabledForSetup: boolean;
  readonly serviceVersionOverrides: LocalServiceVersionOverrides;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
}

export interface LegacyStartDatabaseInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  readonly projectId: string;
  readonly networkId: string;
  readonly hostname: string;
  /** `localDbContainerId(projectId)` — also the connect-target host inside the local Postgres session below. */
  readonly dbContainerId: string;
  readonly dbPort: number;
  readonly containerOpts: LegacyStartContainerOpts;
  /** Fed straight to `legacyBuildPostgresStartContainerSpec` — `fromBackup` (if set) drives BOTH the restore-entrypoint variant and the backup-volume-exists guard below. */
  readonly postgresSpec: Omit<LegacyPostgresStartServiceInput, "image">;
  /**
   * Lazy — evaluated right where Go's `DockerStart` would resolve it. See this module's header.
   * Fixed to `LegacyImagePrepullError` (not generic `E`): both callers' real implementations
   * either never fail (`supabase start`'s already-resolved `Effect.succeed`) or fail with exactly
   * this error (`db start`'s own `legacyEnsureImagesCached` call) — already part of this
   * function's own fixed {@link LegacyStartDatabaseError} union.
   */
  readonly resolvePostgresImage: Effect.Effect<string, LegacyImagePrepullError>;
  readonly dbHealthTimeoutSeconds: number;
  readonly setup: LegacyStartDatabaseSetupInput<E>;
  /**
   * Fired synchronously, exactly once, right after the pre-create volume probe resolves —
   * the caller's own equivalent of Go's package-level `utils.NoBackupVolume` global, needed by
   * the caller's OWN `legacyRollbackStart` (which this function does NOT call itself — see this
   * module's header) even when this function fails partway through, after the probe.
   */
  readonly onFreshVolumeResolved: (isFreshVolume: boolean) => void;
}

/**
 * Runs the exact Go `StartDatabase` sequence — see this module's header for the full call order
 * and for why `resolvePostgresImage`/`setup.jwks` are caller-supplied `Effect`s rather than plain
 * values.
 */
export const legacyStartDatabase = <E>(
  spawner: Spawner,
  input: LegacyStartDatabaseInput<E>,
): Effect.Effect<
  void,
  LegacyStartDatabaseError | E,
  Output | LegacyDbConnection | LegacyDockerRun | RuntimeInfo | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const dbConnection = yield* LegacyDbConnection;

    // Go's pre-create volume-existence check (`internal/db/start/start.go:165-167`) — MUST run
    // before Postgres's own volume gets created below, AND before the network is created too:
    // `docker volume create`/`docker network create` are both idempotent, so creating either
    // first would make "did this volume already exist" unobservable, and would leave a Docker
    // network behind even for a request the guard below is about to reject outright — Go's own
    // `VolumeInspect` and the guard both run strictly BEFORE `DockerStart`, which is the ONLY
    // place Go ever creates the network (`docker.go:363-386`).
    const isFreshVolume = !(yield* legacyStartVolumeExists(spawner, input.dbContainerId));
    input.onFreshVolumeResolved(isFreshVolume);

    const fromBackup = input.postgresSpec.fromBackup;
    if (!isFreshVolume && fromBackup !== undefined) {
      // Go's `StartDatabase` (`start.go:170-172`): a `--from-backup` restore into an
      // already-provisioned volume is refused outright, BEFORE any container or network is
      // created.
      return yield* Effect.fail(
        new LegacyStartBackupVolumeExistsError({
          message: "backup volume already exists",
          suggestion: `Run ${legacyAqua("supabase stop --no-backup")} to remove existing docker volumes.`,
        }),
      );
    }

    if (output.format === "text") {
      yield* output.raw(
        isFreshVolume
          ? LEGACY_START_STARTING_DATABASE_MESSAGE
          : LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
        "stderr",
      );
    }

    const resolvedPostgresImage = yield* input.resolvePostgresImage;

    // Go's `DockerStart` (`docker.go:363-386`): image resolve, THEN network create, both
    // strictly ahead of container create — hoisted here to run ONCE per `start` run instead of
    // once per container (Go's own repeated per-container call is a no-op after the first, see
    // `legacyEnsureStartNetwork`'s own doc comment), but kept in Go's own relative position:
    // after the volume probe/guard above, never before it.
    yield* legacyEnsureStartNetwork(spawner, input.networkId, {
      [LEGACY_CLI_PROJECT_LABEL]: input.projectId,
      [LEGACY_COMPOSE_PROJECT_LABEL]: input.projectId,
    });

    const postgresSpec = legacyBuildPostgresStartContainerSpec({
      ...input.postgresSpec,
      image: resolvedPostgresImage,
    });
    yield* legacyStartContainer(spawner, postgresSpec, input.containerOpts);

    const postgresHealthResult = yield* legacyWaitForHealthyServices(
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
      // `legacyWaitForHealthyServices` regardless of this branch. Any OTHER failure propagates
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { setup } = input;
          const dbPassword = legacyStartInternalDbPassword(setup.dbUrl);
          const session = yield* dbConnection.connect(
            {
              host: input.hostname,
              port: input.dbPort,
              user: "postgres",
              password: dbPassword,
              database: "postgres",
            },
            { isLocal: true, dnsResolver: "native" },
          );

          // Go's `initSchema15`'s realtime job resolves JWKS itself — see this module's header
          // for why this is a caller-supplied lazy `Effect`, gated the same way Go gates the
          // call: only when reached AND `majorVersion >= 15` AND `Realtime.Enabled`. Go's
          // `initSchema` (`start.go:243-254`) branches to `initSchema15` — the ONLY place
          // `ResolveJWKS` is ever called — solely on `majorVersion >= 15`; the PG13/14 branch
          // (`InitSchema14`) never touches JWKS, so a PG13/14 database with realtime enabled must
          // not pay for (or fail on) an external JWKS fetch it will never use.
          const jwks =
            setup.majorVersion >= 15 && setup.realtimeEnabledForSetup ? yield* setup.jwks : "";

          // Go's one-shot fresh-DB setup jobs (`initSchema15`) use the SAME already-pin-rewritten
          // `utils.Config.{Realtime,Storage,Auth}.Image` fields the long-running containers would
          // use (`internal/db/start/start.go:270,299,321`), regardless of `--exclude` — resolved
          // through `legacyResolvePinnedImage`, not the raw Dockerfile default, so a linked
          // project's version pins apply here too. Deliberately NOT resolved/pulled here as a
          // batch: Go resolves (and pulls) each one-shot job's own image individually,
          // sequentially, right before THAT job runs (`DockerRunJob` -> `DockerStart` ->
          // `DockerResolveImageIfNotCached`, `start.go:334-355`, `docker.go:363-365`) — neither
          // caller pre-pulls these three images as a batch ahead of time (see
          // `commands/start/start.handler.ts`'s own `resolvedImages` comment and
          // `commands/db/start/start.handler.ts`'s `resolvePostgresImage` comment, both of which
          // explicitly exclude these from their own upfront pre-pulls). Batching the resolve here
          // instead would mean one unreachable image (e.g. Storage's) fails the WHOLE setup
          // before an earlier job (e.g. Realtime's) ever gets to run, even though Go would already
          // have run it to completion by the time it reaches Storage's own resolve.
          // `legacyRunStartMigrateJob` (`db-setup.ts`) resolves each of these lazily itself, right
          // before running that job — see its own doc comment.
          const dbSetupImages: LegacyStartDbSetupImages = {
            realtime: legacyResolvePinnedImage(
              "realtime",
              "realtime",
              setup.serviceVersionOverrides,
            ),
            storage: legacyResolvePinnedImage("storage", "storage", setup.serviceVersionOverrides),
            auth: legacyResolvePinnedImage("gotrue", "auth", setup.serviceVersionOverrides),
          };

          yield* legacyStartSetupLocalDatabase(spawner, {
            session,
            fs: input.fs,
            path: input.path,
            workdir: input.workdir,
            config: setup.config,
            experimental: setup.experimental,
            majorVersion: setup.majorVersion,
            projectId: input.projectId,
            networkId: input.networkId,
            dbUrl: setup.dbUrl,
            jwtSecret: setup.jwtSecret,
            jwks,
            apiUrl: setup.apiUrl,
            authExternalUrl: setup.authExternalUrl,
            siteUrl: setup.siteUrl,
            anonKey: setup.anonKey,
            serviceRoleKey: setup.serviceRoleKey,
            storageTargetMigration: setup.storageTargetMigration,
            images: dbSetupImages,
            projectEnvValues: setup.projectEnvValues,
          });
        }),
      );
    }

    // Go's `initCurrentBranch` (`db/start/start.go:189`) — the LAST line of `StartDatabase`,
    // reached on every path that doesn't already return/fail above: a fresh volume, a non-fresh
    // restart, AND a swallowed `fromBackup` health-check timeout.
    yield* legacyStartInitCurrentBranch(input.fs, input.path, input.workdir);
  });
