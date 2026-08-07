/**
 * Native TypeScript port of Go's shadow-database provisioning primitives
 * (`apps/cli-go/internal/db/diff/diff.go:138-209`) — CLI-1956. These are the low-level
 * building blocks; `legacyPrepareRawShadow` below (create -> health-wait, no platform
 * baseline) is one of the two composed shapes `db diff`/`db pull` actually call (Go's
 * `PrepareRawShadow`, `apps/cli-go/internal/db/diff/shadow.go:93-116`) — it has zero
 * pg-delta/declarative dependency, so it lives here rather than in
 * `commands/db/shared/legacy-shadow-source.ts`, which owns the OTHER composed shape
 * (`legacyPrepareShadowSource`, Go's `PrepareShadowSource`) precisely because that one also
 * needs the `--target-local` declarative-schema branch and pg-delta, which this module —
 * deliberately kept dependency-light, like every other `shared/db-bootstrap/` module — does
 * not.
 *
 * Exposed separately (not fused into one monolithic function) because the composed shapes
 * Go itself has are NOT all the same: `migration squash` (a future port, CLI-1969) only ever
 * needs create -> health-wait -> connect -> `SetupDatabase` (no `CREATE_TEMPLATE`, no
 * migrations at that point — `apps/cli-go/internal/migration/squash/squash.go:83-96`), while
 * `db diff --use-pgadmin` (CLI-1968) needs create -> health-wait -> `MigrateShadowDatabase`
 * (`apps/cli-go/internal/db/diff/pgadmin.go:70-78`). Exposing every primitive individually
 * lets each future caller compose exactly the subset it needs, matching Go's own module shape
 * 1:1 rather than forcing every caller through one shape only `db diff`/`db pull` happen to
 * need.
 *
 * A note on the shadow container's own addressing, since it's the one genuinely surprising
 * empirical fact this whole module depends on: the shadow container is created with NO name
 * (Docker auto-generates one) and NO network alias (`legacyBuildShadowPostgresContainerSpec`),
 * unlike every other container this codebase creates. The PG15+ one-shot setup jobs
 * (`legacySetupDatabase` -> `initSchema15`) still need SOME hostname to reach it over the
 * shared Docker network, though — Go passes `container[:12]` (the container id's own 12-char
 * short form) as that hostname (`diff.go:172`, `squash.go:96`). This was verified empirically
 * against a real Docker daemon (matching Go's exact container-creation shape: no `--name`, no
 * `--network-alias`, joined to a user-defined network via `NetworkMode` alone): `docker
 * inspect`'s `NetworkSettings.Networks.<net>.DNSNames` lists BOTH the auto-generated name AND
 * the 12-char short id, and a sibling container on the same network successfully resolved and
 * authenticated against Postgres using ONLY the short id as hostname. So `dbHost:
 * container.slice(0, 12)` below is not a guess — it is the exact mechanism Go itself relies on.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Schedule, type FileSystem, type Path, type Scope } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  collectText,
  legacyDescribeContainerCliFailure,
  legacyIsContainerNotFoundMessage,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import { LegacyDbConnection, type LegacyDbSession } from "../legacy-db-connection.service.ts";
import type { LegacyPgConnInput } from "../legacy-db-connection.service.ts";
import { LEGACY_CLI_PROJECT_LABEL } from "../legacy-docker-ids.ts";
import type { LegacyDockerRun } from "../legacy-docker-run.service.ts";
import { legacyApplyMigrations } from "../legacy-migration-apply.ts";
import {
  legacyEnsureNetwork,
  legacyCreateContainer,
  LEGACY_COMPOSE_PROJECT_LABEL,
  type LegacyContainerOpts,
} from "./container-lifecycle.ts";
import type { LegacyImagePrepullError } from "./image-prepull.ts";
import type { LegacyHealthCheckTimeoutError } from "./health-check.ts";
import { legacyWaitForHealthyServices } from "./health-check.ts";
import { legacyListLocalMigrationPaths } from "../legacy-migration-history.ts";
import { legacyToPostgresURL } from "../legacy-postgres-url.ts";
import {
  type LegacyFreshDbSetupInput,
  type LegacySetupDatabaseInput,
  type LegacyStartDbSetupImages,
  type LegacyStartSetupLocalDatabaseError,
  legacyResolveDbSetupPrelude,
  legacySetupDatabase,
} from "./db-setup.ts";
import {
  LEGACY_SHADOW_ENTRYPOINT_ARGS,
  legacyBuildShadowPostgresContainerSpec,
  type LegacyShadowPostgresContainerSpecInput,
} from "./postgres.service.ts";

// Re-exported for convenience — the entrypoint-args constant lives on `postgres.service.ts`
// alongside the container-spec builder it feeds, but it documents THIS module's own Go
// citation (`CreateShadowDatabase`, `diff.go:140`) just as much.
export { LEGACY_SHADOW_ENTRYPOINT_ARGS };

type Spawner = ChildProcessSpawner["Service"];

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Creating, connecting to, setting up, or migrating the shadow database failed. Kept in
 * `shared/db-bootstrap/` (not `commands/db/shared/legacy-pgdelta.errors.ts`'s
 * `LegacyDeclarativeShadowDbError`) so these primitives stay usable by future callers outside
 * the `db diff`/`db pull` family (`migration squash`, `db diff --use-pgadmin`) without pulling
 * in a pg-delta-family-specific error type — see this module's own header.
 */
export class LegacyShadowDbError extends Data.TaggedError("LegacyShadowDbError")<{
  readonly message: string;
}> {}

/**
 * Required to bypass the pg_cron check
 * (https://github.com/citusdata/pg_cron/blob/main/pg_cron.sql#L3). Go's `CREATE_TEMPLATE`
 * (`apps/cli-go/internal/db/diff/diff.go:164`).
 */
export const LEGACY_SHADOW_CREATE_TEMPLATE_SQL =
  "CREATE DATABASE contrib_regression TEMPLATE postgres";

/**
 * Go's `ConnectShadowDatabase`'s fixed timeout — 10 seconds, EVERY real Go caller
 * (`apps/cli-go/internal/db/diff/diff.go:187,200`, `internal/migration/squash/squash.go:91`)
 * passes the same `10*time.Second` literal.
 */
export const LEGACY_SHADOW_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Go's `NewBackoffPolicy(ctx, timeout)` (`apps/cli-go/internal/db/start/start.go:192-198`): a
 * 1-second constant delay, capped at `timeout` (in whole seconds) retries after the initial
 * attempt.
 */
const LEGACY_SHADOW_CONNECT_SCHEDULE = Schedule.max([
  Schedule.spaced("1 seconds"),
  Schedule.recurs(LEGACY_SHADOW_CONNECT_TIMEOUT_SECONDS),
]);

/**
 * Port of Go's `ConnectShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:153-161`): a
 * SECOND, independent connect-retry loop layered ON TOP OF the container health wait the
 * caller already ran (`start.WaitForHealthyService`) — a healthy Postgres healthcheck doesn't
 * guarantee the very next connection attempt succeeds instantly, so Go retries the connect
 * itself too, constant 1s backoff, up to {@link LEGACY_SHADOW_CONNECT_TIMEOUT_SECONDS} retries.
 * Scoped: the returned session's connection closes when the caller's scope closes, matching
 * Go's `defer conn.Close(context.Background())` at each real call site.
 */
export const legacyConnectShadowDatabase = (
  cfg: LegacyPgConnInput,
): Effect.Effect<LegacyDbSession, LegacyShadowDbError, LegacyDbConnection | Scope.Scope> =>
  Effect.gen(function* () {
    const dbConnection = yield* LegacyDbConnection;
    return yield* dbConnection.connect(cfg, { isLocal: true, dnsResolver: "native" }).pipe(
      Effect.mapError((cause) => new LegacyShadowDbError({ message: cause.message })),
      Effect.retry({ schedule: LEGACY_SHADOW_CONNECT_SCHEDULE }),
    );
  });

/**
 * Input to {@link legacyCreateShadowDatabase} — the subset of the real `db` container's own
 * bootstrap inputs the shadow variant needs, plus its own host port. See
 * {@link LegacyShadowPostgresContainerSpecInput} (the container-spec shape this wraps) for
 * the field-by-field Go citations.
 */
export interface LegacyCreateShadowDatabaseInput extends LegacyShadowPostgresContainerSpecInput {
  /** Go's `Config.ProjectId` — merged onto the shadow's own labels (`DockerStart`'s unconditional label assignment) and the network-create call, matching every other container this codebase creates. */
  readonly projectId: string;
  readonly isBitbucketPipeline: boolean;
  readonly workdir: string;
  readonly extraHosts: ReadonlyArray<string>;
}

/** Resolved by {@link legacyCreateShadowDatabase} — everything a caller needs to both use and later tear down the shadow. */
export interface LegacyShadowDatabaseHandle {
  /** Docker always returns the id from `docker create`, regardless of whether `--name` was passed. */
  readonly containerId: string;
  /** See {@link legacyCreateShadowDatabase}'s own doc comment for why this is generated per-call rather than fixed. Threaded through by the caller to {@link legacyRemoveShadowDatabase} so the staged secret directory (see {@link LegacyContainerOpts.secretDirId}) is reclaimed at teardown. */
  readonly secretDirId: string;
}

/**
 * Port of Go's `CreateShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:138-151`):
 * ensures the local Docker network exists (Go's `DockerStart` calls
 * `DockerNetworkCreateIfNotExists` on EVERY invocation, unlike the `start`/`reset`
 * compositions, which hoist this to run once per orchestrated run — `db diff`/`db pull` have
 * no such orchestrator, so this mirrors Go's own per-call behavior instead), then creates +
 * starts the shadow container.
 */
export const legacyCreateShadowDatabase = (
  spawner: Spawner,
  input: LegacyCreateShadowDatabaseInput,
): Effect.Effect<LegacyShadowDatabaseHandle, LegacyShadowDbError> =>
  Effect.gen(function* () {
    const labels = {
      [LEGACY_CLI_PROJECT_LABEL]: input.projectId,
      [LEGACY_COMPOSE_PROJECT_LABEL]: input.projectId,
    };
    yield* legacyEnsureNetwork(spawner, input.networkId, labels).pipe(
      Effect.mapError((cause) => new LegacyShadowDbError({ message: cause.message })),
    );
    const spec = legacyBuildShadowPostgresContainerSpec(input);
    // The shadow container has no name (Docker auto-generates one) — key its staged secret
    // files (the pgsodium root key, PG15+ only) off a fallback identifier instead of
    // `spec.containerName` (see `LegacyContainerOpts.secretDirId`'s own doc comment).
    // Randomized (not a fixed `"shadow"` string): `legacyStageStartSecretFiles` `rm -rf`s
    // its target directory FIRST on every call, so two concurrent `db diff`/`db pull` runs
    // in the same workdir (two terminals, a CI matrix) sharing a fixed identifier could have
    // one wipe the other's staged root key mid-flight, BEFORE either container's own
    // `docker start` even runs (so a shared `shadowPort` — which would itself collide, since
    // both runs read the same config.toml — can't be used as the differentiator either).
    // Reclaimed once the shadow container itself is torn down, not eagerly right after
    // `docker start` returns: Postgres's entrypoint actually reads the file at
    // postmaster-start, seconds later — safe only if the bind mount's source inode is pinned
    // by then, which is guaranteed on native Linux dockerd but NOT on Docker Desktop
    // (macOS/Windows). {@link legacyRemoveShadowDatabase} `rm -rf`s this exact directory
    // (keyed off `secretDirId`, returned below) once the container is gone, so a randomized
    // per-call id doesn't leak a directory per invocation — see that function's own doc
    // comment.
    const secretDirId = `shadow-${randomUUID()}`;
    const containerOpts: LegacyContainerOpts = {
      projectId: input.projectId,
      isBitbucketPipeline: input.isBitbucketPipeline,
      workdir: input.workdir,
      extraHosts: input.extraHosts,
      secretDirId,
    };
    const containerId = yield* legacyCreateContainer(spawner, spec, containerOpts).pipe(
      Effect.mapError((cause) => new LegacyShadowDbError({ message: cause.message })),
    );
    return { containerId, secretDirId };
  });

/** Input to {@link legacyRemoveShadowDatabase} — everything needed to tear down both halves of a shadow ({@link legacyCreateShadowDatabase}'s container AND its staged secret directory). */
export interface LegacyRemoveShadowDatabaseInput {
  readonly containerId: string;
  /** {@link LegacyShadowDatabaseHandle.secretDirId} — the NORMAL reclaim path for the shadow's staged secret directory (see {@link legacyCreateShadowDatabase}'s own doc comment): the shadow container has no name, so `legacyStageStartSecretFiles`'s self-healing `rm -rf` (keyed off the SAME directory being reused across calls) can never find it, and `legacyCleanupStartSecrets`'s own name-keyed fallback can't either. If this process is killed before this function ever runs, `legacyCleanupStartSecrets` can still recover the SAME directory later via the container's own `LEGACY_CLI_SECRET_DIR_LABEL` (stamped at creation time, read back off the orphan `stop` finds by project label) — see that label's doc comment (`legacy-docker-ids.ts`) for why that fallback exists (review: PRRT_kwDOErm0O86W8ZYt). */
  readonly secretDirId: string;
  readonly workdir: string;
}

/**
 * Best-effort `rm -rf` of the shadow's OWN staged secret directory
 * (`<workdir>/supabase/.temp/start-secrets/<secretDirId>/`, PG15+ only — see
 * {@link legacyCreateShadowDatabase}'s own doc comment) — a no-op when nothing was ever
 * staged (PG<=14, or `secretDirId` empty). Never fails: a missing directory is already the
 * desired end state, and a real deletion error is not worth failing the caller's diff/pull
 * over.
 */
const legacyCleanupShadowSecretDir = (
  secretDirId: string,
  workdir: string,
): Effect.Effect<void> => {
  if (secretDirId.length === 0) return Effect.void;
  return Effect.tryPromise(() =>
    rm(join(workdir, "supabase", ".temp", "start-secrets", secretDirId), {
      recursive: true,
      force: true,
    }),
  ).pipe(
    Effect.asVoid,
    Effect.orElseSucceed(() => undefined),
  );
};

/**
 * Port of Go's `utils.DockerRemove(shadow)` as called by every shadow caller
 * (`apps/cli-go/internal/db/diff/diff.go:217`, `shadow.go:45,103`,
 * `internal/migration/squash/squash.go:87`): `RemoveOptions{RemoveVolumes: true, Force:
 * true}` via `docker rm -f -v <id>`. Best-effort for the OVERALL operation — Go's own
 * `DockerRemove` swallows the removal's ERROR RETURN (it has no return value at all), so a
 * failure here must never mask whatever the caller was doing with the shadow — but it does
 * NOT swallow the message: Go prints `"Failed to remove container:", containerId, err` to
 * stderr on failure (`apps/cli-go/internal/utils/docker.go:442-449`), so this does the same
 * before continuing. That includes a failure to even launch/collect the removal itself (the
 * container CLI missing, a disconnected runtime, a stream-read error) — Go's single
 * `Docker.ContainerRemove` SDK call folds every one of those causes into the same `err` it
 * prints, so this catches {@link spawnContainerCli}/exit-code-collection failures the same way
 * {@link legacyRestartSatelliteService} does (`restart-services.ts`), via
 * {@link legacyDescribeContainerCliFailure}, rather than discarding them unreported. Also
 * reclaims the shadow's staged secret directory (see {@link legacyCleanupShadowSecretDir}) —
 * but ONLY once the container is confirmed gone (removal succeeded, or it was already absent),
 * never on a genuine removal failure (daemon disconnected, CLI missing, an unrecognized
 * error). {@link legacyCreateShadowDatabase}'s own doc comment explains why the secret
 * directory (the PG15+ pgsodium root-key bind source) must outlive `docker start` by seconds so
 * Postgres's entrypoint can still read it — that same invariant means it must ALSO outlive a
 * shadow that `docker rm` failed to actually remove: a still-running (or later-restarted)
 * orphan would find its bind source deleted out from under it. `secretDirId` is randomized per
 * shadow, not keyed off the container's name, so this reclaim (once safe) is the NORMAL path
 * that finds it — the only other path is `legacyCleanupStartSecrets`'s
 * `LEGACY_CLI_SECRET_DIR_LABEL` fallback, for when this whole process (not just `docker rm`)
 * never got to run at all, e.g. killed mid-flight (review: PRRT_kwDOErm0O86W8ZYt).
 */
export const legacyRemoveShadowDatabase = (
  spawner: Spawner,
  input: LegacyRemoveShadowDatabaseInput,
): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const { containerId, secretDirId, workdir } = input;
    let containerGone = containerId.length === 0;
    if (containerId.length > 0) {
      const failureMessage = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawnContainerCli(spawner, ["rm", "-f", "-v", containerId], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
            extendEnv: true,
          });
          const [exitCode, stderr] = yield* Effect.all(
            [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
            { concurrency: "unbounded" },
          );
          return exitCode === 0 ? undefined : stderr.trim();
        }),
      ).pipe(Effect.catch((cause) => Effect.succeed(legacyDescribeContainerCliFailure(cause))));
      if (failureMessage !== undefined) {
        const output = yield* Output;
        yield* output.raw(
          `Failed to remove container: ${containerId} ${failureMessage}\n`,
          "stderr",
        );
      }
      containerGone =
        failureMessage === undefined || legacyIsContainerNotFoundMessage(failureMessage);
    }
    if (containerGone) {
      yield* legacyCleanupShadowSecretDir(secretDirId, workdir);
    }
  });

/** A live shadow database left running for the caller to diff against and remove. Mirrors Go's `ShadowSource`. */
export interface LegacyShadowSourceResult {
  /** Container id; the caller MUST remove it (`legacyRemoveShadowDatabase`) when done. */
  readonly container: string;
  /** {@link LegacyShadowDatabaseHandle.secretDirId} — the caller MUST also thread this (and the shadow's own `workdir`) into `legacyRemoveShadowDatabase` so the staged secret directory is reclaimed alongside the container. No Go equivalent (Go never stages this on host disk at all). */
  readonly secretDirId: string;
  /** The diff source Postgres URL (the provisioned shadow). */
  readonly sourceUrl: string;
  /**
   * When set, replaces the diff target with a second database on the SAME shadow container
   * (`contrib_regression`, cloned from `postgres` by `CREATE_TEMPLATE` during shadow setup —
   * see {@link legacySetupShadowConn}) with declarative schemas applied. Mirrors Go's
   * local-target declarative branch, where the user's local DB is not diffed. Only ever set
   * by `legacy-shadow-source.ts`'s `legacyPrepareShadowSource` — {@link legacyPrepareRawShadow}
   * below always leaves this `undefined`.
   */
  readonly targetUrlOverride: string | undefined;
}

/** Fields shared by `legacy-shadow-source.ts`'s `LegacyPrepareShadowSourceInput`/{@link LegacyPrepareRawShadowInput}. */
export interface LegacyShadowConnectionInput extends LegacyCreateShadowDatabaseInput {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly hostname: string;
  /** `[db] password` (already resolved from `config.toml`) — the shadow's own connect password. */
  readonly password: string;
  readonly healthTimeoutSeconds: number;
}

export type LegacyPrepareRawShadowInput = LegacyShadowConnectionInput;

/**
 * Port of Go's `PrepareRawShadow` (`apps/cli-go/internal/db/diff/shadow.go:93-116`): health-wait
 * against an already-{@link legacyCreateShadowDatabase}-created shadow (created + healthy, no
 * platform baseline or migrations applied) — used inline (`db pull --declarative`'s empty
 * declarative-export source), not the `ok`-sentinel error-path pattern
 * `legacy-shadow-source.ts`'s `legacyPrepareShadowSource` uses, since there is only ONE step
 * here that can fail (the health wait) rather than several. Lives here (not
 * `legacy-shadow-source.ts`) because it has zero pg-delta/declarative dependency — see this
 * module's own header.
 *
 * Deliberately does NOT call {@link legacyCreateShadowDatabase} itself — the caller does, as the
 * `acquire` of an `Effect.acquireUseRelease` whose `use` phase is this function (see
 * `diff.handler.ts`/`pull.handler.ts`'s call sites). Go's `PrepareRawShadow` threads a single
 * cancellable `ctx` through both creation and the health wait, so a SIGINT can interrupt either;
 * an earlier shape here instead passed the WHOLE create-then-health-wait effect as `acquire`,
 * which Effect's `uninterruptibleMask` (`acquireUseRelease(acquire, use, release) =>
 * uninterruptibleMask(restore => flatMap(acquire, a => onExitPrimitive(restore(use(a)), ...)))`)
 * makes entirely uninterruptible — a SIGINT during the health wait (which can run for up to
 * `healthTimeoutSeconds`) was silently swallowed until the wait finished or timed out on its
 * own, unlike Go. Splitting `legacyCreateShadowDatabase` out as the (brief, Docker-API-bound)
 * `acquire` and keeping this health-wait as part of the interruptible `use` restores that parity
 * — a SIGINT here now lands immediately, same as Go's ctx cancellation, while
 * `legacyRemoveShadowDatabase` still runs as the `release` finalizer regardless of how `use`
 * exits (review: PRRT_kwDOErm0O86XMrID).
 */
export const legacyPrepareRawShadow = (
  spawner: Spawner,
  handle: LegacyShadowDatabaseHandle,
  input: LegacyPrepareRawShadowInput,
): Effect.Effect<
  LegacyShadowSourceResult,
  LegacyHealthCheckTimeoutError,
  Output | LegacyDockerRun | RuntimeInfo | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const { containerId, secretDirId } = handle;
    yield* legacyWaitForHealthyServices(spawner, [containerId], {
      timeoutSeconds: input.healthTimeoutSeconds,
    });
    const connConfig: LegacyPgConnInput = {
      host: input.hostname,
      port: input.shadowPort,
      user: "postgres",
      password: input.password,
      database: "postgres",
    };
    return {
      container: containerId,
      secretDirId,
      sourceUrl: legacyToPostgresURL(connConfig),
      targetUrlOverride: undefined,
    };
  });

/**
 * Port of Go's `setupShadowConn` (`apps/cli-go/internal/db/diff/diff.go:171-179`):
 * {@link legacySetupDatabase} (Go's `SetupDatabase`) against an already-connected shadow,
 * dialed at `input.dbHost` = `container.slice(0, 12)` (see this module's own header), then
 * optionally {@link LEGACY_SHADOW_CREATE_TEMPLATE_SQL}. `withTemplate` is `true` for every
 * real Go caller of `setupShadowConn` itself (`SetupShadowDatabase`/`MigrateShadowDatabase`
 * below); exposed as a parameter (not hardcoded) so a future caller that only needs the bare
 * `SetupDatabase` step (`migration squash`, which calls `start.SetupDatabase` DIRECTLY,
 * bypassing `setupShadowConn` entirely — `squash.go:96`) can call {@link legacySetupDatabase}
 * on its own instead, while this function stays the exact `setupShadowConn` shape.
 */
export const legacySetupShadowConn = (
  spawner: Spawner,
  input: LegacySetupDatabaseInput,
  withTemplate: boolean,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyShadowDbError,
  Output | LegacyDockerRun | RuntimeInfo
> =>
  Effect.gen(function* () {
    yield* legacySetupDatabase(spawner, input);
    if (!withTemplate) return;
    yield* input.session.exec(LEGACY_SHADOW_CREATE_TEMPLATE_SQL).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyShadowDbError({
            message: `failed to create template database: ${errMessage(cause)}`,
          }),
      ),
    );
  });

/**
 * Shared fields both {@link legacySetupShadowDatabase} and {@link legacyMigrateShadowDatabase}
 * need to resolve JWKS/images and run {@link legacySetupDatabase} — derived from `db-setup.ts`'s
 * `LegacyFreshDbSetupInput` (the exact same shape `legacyRunFreshDbSetup` resolves for the real
 * local `db` container) rather than hand-copied, so the two never silently drift: swap
 * `experimental` (which only `legacyStartSetupLocalDatabase`'s trailing `MigrateAndSeed` call
 * needs — irrelevant to the shadow's `SetupDatabase`-only pipeline, see {@link
 * LegacySetupDatabaseInput}'s own doc comment) for the two fields the shadow's own caller
 * (`legacy-shadow-source.ts`) resolves from an already-loaded `config.toml` instead
 * (`apiAutoExposeNewTables`/`vault`), threaded straight through here rather than re-read.
 */
export type LegacyShadowDbSetupInput<E> = Omit<LegacyFreshDbSetupInput<E>, "experimental"> & {
  readonly apiAutoExposeNewTables: LegacySetupDatabaseInput["apiAutoExposeNewTables"];
  readonly vault: LegacySetupDatabaseInput["vault"];
};

/** Common caller-supplied plumbing for {@link legacySetupShadowDatabase}/{@link legacyMigrateShadowDatabase}. */
interface LegacyShadowSetupRunInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  /** Go's `Config.ProjectId` — labels the shadow's own PG15+ one-shot migrate job containers, same as the real local `db` container's — see {@link LegacySetupDatabaseInput.projectId}'s own doc comment. */
  readonly projectId: string;
  readonly container: string;
  readonly networkId: string;
  /** The shadow's own connect target — host/port/user/password/database (`postgres`/`postgres`). */
  readonly connConfig: LegacyPgConnInput;
  readonly setup: LegacyShadowDbSetupInput<E>;
}

/**
 * Builds a {@link LegacySetupDatabaseInput} for {@link legacySetupDatabase} out of an
 * already-connected shadow session plus the resolved images/JWKS prelude — exported so a
 * future caller that only needs `SetupDatabase` directly (`migration squash`, which calls
 * Go's `start.SetupDatabase` without going through `setupShadowConn` at all — see {@link
 * legacySetupShadowConn}'s own doc comment) can build this same shape without duplicating the
 * `container[:12]` dbHost derivation.
 */
export const legacyBuildShadowSetupDatabaseInput = <E>(
  input: LegacyShadowSetupRunInput<E>,
  session: LegacyDbSession,
  resolved: { readonly jwks: string; readonly images: LegacyStartDbSetupImages },
): LegacySetupDatabaseInput => ({
  session,
  fs: input.fs,
  path: input.path,
  workdir: input.workdir,
  config: input.setup.config,
  majorVersion: input.setup.majorVersion,
  // Go's `container[:12]` — see this module's own header for why this resolves as a
  // hostname at all despite the shadow container having no name/alias.
  dbHost: input.container.slice(0, 12),
  projectId: input.projectId,
  networkId: input.networkId,
  dbUrl: input.setup.dbUrl,
  jwtSecret: input.setup.jwtSecret,
  jwks: resolved.jwks,
  apiUrl: input.setup.apiUrl,
  authExternalUrl: input.setup.authExternalUrl,
  siteUrl: input.setup.siteUrl,
  anonKey: input.setup.anonKey,
  serviceRoleKey: input.setup.serviceRoleKey,
  storageTargetMigration: input.setup.storageTargetMigration,
  images: resolved.images,
  projectEnvValues: input.setup.projectEnvValues,
  debug: input.setup.debug,
  apiAutoExposeNewTables: input.setup.apiAutoExposeNewTables,
  vault: input.setup.vault,
});

/**
 * Port of Go's `SetupShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:181-193`):
 * connects to the shadow (Go's `ConnectShadowDatabase`, {@link legacyConnectShadowDatabase})
 * FIRST, THEN resolves the setup prelude (JWKS/pinned image names, {@link
 * legacyResolveDbSetupPrelude}) and runs {@link legacySetupShadowConn} WITH the template
 * database — the platform baseline only, no user migrations. Connect-then-setup, matching Go's
 * own `SetupShadowDatabase` (which dials `ConnectShadowDatabase` before ever calling
 * `start.SetupDatabase`, `diff.go:186-192`) and this same module's `legacyRunFreshDbSetup`
 * (`db-setup.ts`) for the real local `db` container: an unconnectable shadow must surface a
 * connect error immediately, not pay for JWKS work first. The connection is closed once this
 * resolves (Go's `defer conn.Close(...)`), matching `Effect.scoped`'s finalizer running at the
 * end of this function rather than leaking a `Scope.Scope` requirement to the caller.
 */
export const legacySetupShadowDatabase = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupRunInput<E>,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyShadowDbError | LegacyImagePrepullError | E,
  Output | LegacyDockerRun | RuntimeInfo | LegacyDbConnection
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* legacyConnectShadowDatabase(input.connConfig);
      const resolved = yield* legacyResolveDbSetupPrelude(input.setup);
      yield* legacySetupShadowConn(
        spawner,
        legacyBuildShadowSetupDatabaseInput(input, session, resolved),
        true,
      );
    }),
  );

/**
 * Port of Go's `MigrateShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:195-209`):
 * lists local migrations FIRST (Go's `migration.ListLocalMigrations`, fails fast on a bad
 * migrations directory before any DB connection is even attempted), THEN connects (Go's
 * `ConnectShadowDatabase`), THEN resolves the setup prelude (JWKS/pinned image names, {@link
 * legacyResolveDbSetupPrelude}) and sets up the platform baseline + template database ({@link
 * legacySetupShadowConn}, `withTemplate: true`), then applies every listed migration (Go's
 * `migration.ApplyMigrations`). Connect-then-setup (not the reverse) matches Go's own
 * `MigrateShadowDatabase` (`diff.go:195-209`) and this same module's `legacyRunFreshDbSetup`
 * (`db-setup.ts`) for the real local `db` container — see {@link legacySetupShadowDatabase}'s
 * own doc comment for why the ordering matters. Connection closed once this resolves, matching
 * Go's `defer conn.Close(...)`.
 */
export const legacyMigrateShadowDatabase = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupRunInput<E>,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyShadowDbError | LegacyImagePrepullError | E,
  Output | LegacyDockerRun | RuntimeInfo | LegacyDbConnection
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const migrationsDir = input.path.join(input.workdir, "supabase", "migrations");
      const pending = yield* legacyListLocalMigrationPaths(
        input.fs,
        input.path,
        migrationsDir,
      ).pipe(Effect.mapError((cause) => new LegacyShadowDbError({ message: cause.message })));

      const session = yield* legacyConnectShadowDatabase(input.connConfig);
      const resolved = yield* legacyResolveDbSetupPrelude(input.setup);
      yield* legacySetupShadowConn(
        spawner,
        legacyBuildShadowSetupDatabaseInput(input, session, resolved),
        true,
      );
      yield* legacyApplyMigrations(
        session,
        input.fs,
        input.path,
        pending,
        (message) => new LegacyShadowDbError({ message }),
      );
    }),
  );
