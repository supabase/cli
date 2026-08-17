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
 * migrations at that point — `apps/cli-go/internal/migration/squash/squash.go:83-96`,
 * deleted in CLI-1970; last present at commit 7b469f5b3), while
 * `db diff --use-pgadmin` (CLI-1968, realized: see `diff.handler.ts`'s pgadmin branch) needs
 * create -> health-wait -> `MigrateShadowDatabase` (`apps/cli-go/internal/db/diff/
 * pgadmin.go:70-78`). Exposing every primitive individually lets each future caller compose
 * exactly the subset it needs, matching Go's own module shape 1:1 rather than forcing every
 * caller through one shape only `db diff`/`db pull` happen to need.
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

import {
  Data,
  Effect,
  type Option,
  Schedule,
  type FileSystem,
  type Path,
  type Scope,
} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import {
  legacyCollectText,
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import type { LegacyDbConfigLoadError } from "../legacy-db-config.errors.ts";
import { LegacyDbConnection, type LegacyDbSession } from "../legacy-db-connection.service.ts";
import type { LegacyPgConnInput } from "../legacy-db-connection.service.ts";
import { LEGACY_CLI_PROJECT_LABEL } from "../legacy-docker-ids.ts";
import type { LegacyDockerRun } from "../legacy-docker-run.service.ts";
import { legacyApplyMigrations } from "../legacy-migration-apply.ts";
import type { LegacyVaultSecret } from "../legacy-vault.ts";
import {
  legacyEnsureNetwork,
  legacyCreateContainer,
  LEGACY_COMPOSE_PROJECT_LABEL,
  type LegacyContainerError,
  type LegacyContainerOpts,
} from "./container-lifecycle.ts";
import type { LegacyImagePrepullError } from "./image-prepull.ts";
import type { LegacyHealthCheckTimeoutError } from "./health-check.ts";
import { legacyWaitForHealthyServices } from "./health-check.ts";
import type { LegacyLocalDbContainerInputs } from "./local-container-inputs.ts";
import { legacyListLocalMigrationPaths } from "../legacy-migration-history.ts";
import { legacyToPostgresURL } from "../legacy-postgres-url.ts";
import {
  type LegacyFreshDbSetupInput,
  type LegacySetupDatabaseInput,
  type LegacySetupDatabaseOptions,
  type LegacyStartDbSetupImages,
  type LegacyStartSetupLocalDatabaseError,
  legacyResolveDbSetupPrelude,
  legacySetupDatabase,
} from "./db-setup.ts";
import {
  legacyBuildShadowPostgresContainerSpec,
  type LegacyShadowPostgresContainerSpecInput,
} from "./postgres.service.ts";

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
  readonly reason:
    | "connect"
    | "docker_daemon"
    | "container_configuration"
    | "internal"
    | "port_conflict"
    | "filesystem"
    | "database";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "connect":
        return { ...actionability.dbConnection, fingerprint_suffix: "connect" };
      case "docker_daemon":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "internal":
        return actionability.internalPanic;
      case "port_conflict":
        return { ...actionability.invalidConfig, fingerprint_suffix: "port_conflict" };
      case "filesystem":
        return { ...actionability.permission, fingerprint_suffix: "filesystem" };
      case "database":
        return { ...actionability.dbFinding, fingerprint_suffix: "database" };
      default:
        return { ...actionability.invalidConfig, fingerprint_suffix: "container_configuration" };
    }
  }
}

/** Carries `container-lifecycle.ts`'s own error classification through the shadow wrapper. */
const legacyShadowContainerReason = (
  reason: LegacyContainerError["reason"],
): LegacyShadowDbError["reason"] => {
  switch (reason) {
    case "runtime":
      return "docker_daemon";
    case "internal":
      return "internal";
    case "port_conflict":
      return "port_conflict";
    default:
      return "container_configuration";
  }
};

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
      Effect.mapError(
        (cause) => new LegacyShadowDbError({ message: cause.message, reason: "connect" }),
      ),
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
}

/**
 * Port of Go's `CreateShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:138-151`):
 * ensures the local Docker network exists (Go's `DockerStart` calls
 * `DockerNetworkCreateIfNotExists` on EVERY invocation, unlike the `start`/`reset`
 * compositions, which hoist this to run once per orchestrated run — `db diff`/`db pull` have
 * no such orchestrator, so this mirrors Go's own per-call behavior instead), then creates +
 * starts the shadow container.
 *
 * Leak window (deliberate Go parity, not a bug — the canonical explanation every call site
 * below cross-references): every real caller runs this whole function as the `acquire` of an
 * `Effect.acquireUseRelease` whose `release` is {@link legacyRemoveShadowDatabase} (see
 * `diff.handler.ts`/`pull.handler.ts`/`legacy-pgdelta.cache.ts`'s call sites). Effect only
 * registers `release` once `acquire` itself resolves successfully; an `acquire` that fails
 * partway through — `docker create` having already succeeded, but the LATER `docker
 * cp`/`docker start` step inside {@link legacyCreateContainer} then failing
 * (`container-lifecycle.ts`) — has, by definition, nothing for `release` to tear down, so the
 * already-created container is never removed here. This matches Go exactly: `DockerStart`
 * returns `(resp.ID, err)` from the SAME function that calls `ContainerCreate` then
 * `ContainerStart` (`apps/cli-go/internal/utils/docker.go:420-436`), and
 * `PrepareShadowSource`/`CreateShadowDatabase`'s own Go callers only register their `defer
 * DockerRemove(shadow)` AFTER a successful return — on a `DockerStart` error, the returned id
 * is discarded before that `defer` is ever reached (`internal/db/diff/shadow.go:38-41`),
 * leaking the container identically. Not worth a bespoke "clean up whatever `docker create`
 * already made" path just to be stricter than Go's own upstream behavior here.
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
      Effect.mapError(
        (cause) =>
          new LegacyShadowDbError({
            message: cause.message,
            reason: legacyShadowContainerReason(cause.reason),
          }),
      ),
    );
    const spec = legacyBuildShadowPostgresContainerSpec(input);
    // The shadow container has no name (Docker auto-generates one) and no network alias —
    // see this module's own header for why that's still enough for the shadow's own one-shot
    // setup jobs to reach it. The pgsodium root key itself (PG15+ only) never touches host
    // disk at all — it's delivered straight into the container via `docker cp`
    // ({@link LegacyStartContainerSpec.secretFiles}, `container-lifecycle.ts`), same as every
    // other container's secrets.
    const containerOpts: LegacyContainerOpts = {
      projectId: input.projectId,
      isBitbucketPipeline: input.isBitbucketPipeline,
      workdir: input.workdir,
      extraHosts: input.extraHosts,
    };
    const containerId = yield* legacyCreateContainer(spawner, spec, containerOpts).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyShadowDbError({
            message: cause.message,
            reason: legacyShadowContainerReason(cause.reason),
          }),
      ),
    );
    return { containerId };
  });

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
 * {@link legacyDescribeContainerCliFailure}, rather than discarding them unreported.
 */
export const legacyRemoveShadowDatabase = (
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    if (containerId.length === 0) return;
    const failureMessage = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnContainerCli(spawner, ["rm", "-f", "-v", containerId], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          extendEnv: true,
        });
        const [exitCode, stderr] = yield* Effect.all(
          [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? undefined : stderr.trim();
      }),
    ).pipe(Effect.catch((cause) => Effect.succeed(legacyDescribeContainerCliFailure(cause))));
    if (failureMessage !== undefined) {
      const output = yield* Output;
      yield* output.raw(`Failed to remove container: ${containerId} ${failureMessage}\n`, "stderr");
    }
  });

/** A live shadow database left running for the caller to diff against and remove. Mirrors Go's `ShadowSource`. */
export interface LegacyShadowSourceResult {
  /** Container id; the caller MUST remove it (`legacyRemoveShadowDatabase`) when done. */
  readonly container: string;
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
 * {@link LegacyShadowConnectionInput} plus the platform-baseline setup fields
 * {@link legacySetupDatabase}/`legacyMigrateShadowDatabase`/`legacySetupShadowDatabase` need —
 * the full shape {@link legacyShadowRunInputFromLocalContainerInputs} returns. Named here
 * (CLI-1969) rather than as an `Omit<...>` of a diff/pull-specific type, so `migration squash`
 * — which has none of the diff/pull-specific fields (`targetLocal`/`usePgDelta`/`schemaPaths`/
 * `pgDelta`/`ctx`) — can consume the promoted function's return value directly, with no `as`
 * cast. `legacy-shadow-source.ts`'s `LegacyPrepareShadowSourceInput<E>` extends this with
 * those extra fields instead of duplicating the `setup` field itself.
 */
export interface LegacyShadowSetupInput<E> extends LegacyShadowConnectionInput {
  readonly setup: LegacyShadowDbSetupInput<E>;
}

/**
 * Adapts {@link LegacyLocalDbContainerInputs} (`local-container-inputs.ts`, the SAME
 * config/image/JWKS resolution prelude `db start`/`db reset` share) plus the caller's own
 * already-loaded `config.toml` slice into {@link LegacyShadowSetupInput} — every field
 * `legacyPrepareShadowSource`/{@link legacyPrepareRawShadow} (`legacy-shadow-source.ts`/this
 * module) or `migration squash`'s own shadow composition need EXCEPT the diff/pull-specific
 * ones (`targetLocal`/`usePgDelta`/`schemaPaths`/`pgDelta`/`ctx`, left to each call site).
 * Promoted here from
 * `commands/db/shared/legacy-shadow-source.ts` (CLI-1969, hoist-before-duplicate): `migration
 * squash` needs this same shadow run-input shape, but importing the `db`-family-scoped
 * `legacy-shadow-source.ts` would drag its whole pg-delta/migra/declarative stack into a
 * command that has no diff engine at all.
 *
 * On `db diff --linked`/`db pull` (linked), the caller passes its own resolved ref straight
 * through to `legacyBuildLocalDbContainerInputs` (its own `projectRef` parameter — see
 * that function's doc comment), which threads it into `legacyLoadLocalProjectContext` ->
 * `loadProjectConfig({ projectRef })`. So the shadow's OWN container config (image, JWT
 * secret, root key, `db.settings`, service enabled-for-setup flags, sourced from
 * `localInputs.context.config`/`postgresSpecBase`) reflects the matching `[remotes.<ref>]`
 * override, same as `toml` (the caller's own `legacyReadDbToml(..., linkedRef)` result,
 * which feeds `pgDelta`/vault/`apiAutoExposeNewTables` below) — matching Go's own uniform
 * remote-merge on the linked path (`LoadConfig` seeds `flags.ProjectRef` before every field
 * read). The two config reads still go through independent remote-merge implementations
 * (`@supabase/config`'s `applyRemoteOverride` for `localInputs.context.config`;
 * `legacy-db-config.toml-read.ts`'s own TOML-based merge for `toml`) rather than a single
 * shared decode — unifying those is a larger, out-of-scope refactor, not a per-command gap.
 */
export function legacyShadowRunInputFromLocalContainerInputs(
  localInputs: LegacyLocalDbContainerInputs,
  resolvedImage: string,
  toml: {
    readonly shadowPort: number;
    readonly password: string;
    readonly webhooksEnabled: boolean;
    readonly baseline: { readonly apiAutoExposeNewTables: Option.Option<boolean> };
    readonly vault: ReadonlyArray<LegacyVaultSecret>;
  },
  fs: FileSystem.FileSystem,
  path: Path.Path,
): LegacyShadowSetupInput<LegacyDbConfigLoadError> {
  const { postgresSpecBase } = localInputs;
  return {
    db: {
      major_version: postgresSpecBase.db.major_version,
      settings: postgresSpecBase.db.settings,
    },
    experimental: postgresSpecBase.experimental,
    jwtSecret: postgresSpecBase.jwtSecret,
    jwtExpiry: postgresSpecBase.jwtExpiry,
    networkId: localInputs.networkId,
    image: resolvedImage,
    configImage: postgresSpecBase.configImage,
    rootKey: postgresSpecBase.rootKey,
    shadowPort: toml.shadowPort,
    projectId: localInputs.context.projectId,
    isBitbucketPipeline: localInputs.containerOpts.isBitbucketPipeline,
    workdir: localInputs.containerOpts.workdir,
    extraHosts: localInputs.containerOpts.extraHosts,
    fs,
    path,
    hostname: localInputs.context.hostname,
    password: toml.password,
    healthTimeoutSeconds: localInputs.dbHealthTimeoutSeconds,
    setup: {
      majorVersion: localInputs.setup.majorVersion,
      config: localInputs.setup.config,
      webhooksEnabled: toml.webhooksEnabled,
      // NOT `localInputs.setup.dbUrl` — that carries the REGULAR local container's own
      // hardcoded-"postgres" password (`legacy-local-config-values.ts`'s `DEFAULT_DB_PASSWORD`),
      // for a DIFFERENT container. The shadow's own one-shot setup jobs
      // (`legacyBuildShadowSetupDatabaseInput`) only ever consume this `dbUrl` to extract a
      // password (`legacyStartInternalDbPassword`) for the SHADOW they actually run against, so
      // it must carry the SAME resolved `toml.password` the shadow container itself is
      // initialized with (see `legacyBuildShadowPostgresContainerSpec`) — otherwise a non-default
      // `[db] password` authenticates against the wrong secret and every setup job fails.
      dbUrl: legacyToPostgresURL({
        host: localInputs.context.hostname,
        port: toml.shadowPort,
        user: "postgres",
        password: toml.password,
        database: "postgres",
      }),
      jwtSecret: localInputs.setup.jwtSecret,
      jwks: localInputs.setup.jwks,
      apiUrl: localInputs.setup.apiUrl,
      authExternalUrl: localInputs.setup.authExternalUrl,
      siteUrl: localInputs.setup.siteUrl,
      anonKey: localInputs.setup.anonKey,
      serviceRoleKey: localInputs.setup.serviceRoleKey,
      storageTargetMigration: localInputs.setup.storageTargetMigration,
      realtimeEnabledForSetup: localInputs.setup.realtimeEnabledForSetup,
      storageEnabledForSetup: localInputs.setup.storageEnabledForSetup,
      authEnabledForSetup: localInputs.setup.authEnabledForSetup,
      serviceVersionOverrides: localInputs.setup.serviceVersionOverrides,
      projectEnvValues: localInputs.setup.projectEnvValues,
      debug: localInputs.setup.debug,
      apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
      vault: toml.vault,
    },
  };
}

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
    const { containerId } = handle;
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
      sourceUrl: legacyToPostgresURL(connConfig),
      targetUrlOverride: undefined,
    };
  });

/**
 * Port of Go's `setupShadowConn` (`apps/cli-go/internal/db/diff/diff.go:171-179`):
 * {@link legacySetupDatabase} (Go's `SetupDatabase`) against an already-connected shadow,
 * dialed at `input.dbHost` = `container.slice(0, 12)` (see this module's own header), then
 * unconditionally {@link LEGACY_SHADOW_CREATE_TEMPLATE_SQL} — every real Go caller of
 * `setupShadowConn` itself (`SetupShadowDatabase`/`MigrateShadowDatabase` below) always
 * creates the template database; a future caller that only needs the bare `SetupDatabase`
 * step (`migration squash`, which calls `start.SetupDatabase` DIRECTLY, bypassing
 * `setupShadowConn` entirely — `squash.go:96`) calls {@link legacySetupDatabase} on its own
 * instead, so this function stays the exact `setupShadowConn` shape without a parameter for
 * a branch no real caller of THIS function takes.
 */
export const legacySetupShadowConn = (
  spawner: Spawner,
  input: LegacySetupDatabaseInput,
  options: LegacySetupDatabaseOptions = {},
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyShadowDbError,
  Output | LegacyDockerRun | RuntimeInfo
> =>
  Effect.gen(function* () {
    yield* legacySetupDatabase(spawner, input, options);
    yield* input.session.exec(LEGACY_SHADOW_CREATE_TEMPLATE_SQL).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyShadowDbError({
            message: `failed to create template database: ${errMessage(cause)}`,
            reason: "database",
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
  readonly webhooksEnabled: LegacySetupDatabaseInput["webhooksEnabled"];
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
  webhooksEnabled: input.setup.webhooksEnabled,
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
 * legacyResolveDbSetupPrelude}) and runs {@link legacySetupShadowConn} — the platform
 * baseline plus the template database, no user migrations. Connect-then-setup, matching Go's
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
  options: LegacySetupDatabaseOptions = {},
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
        options,
      );
    }),
  );

/**
 * Port of Go's `MigrateShadowDatabase` (`apps/cli-go/internal/db/diff/diff.go:195-209`):
 * lists local migrations FIRST (Go's `migration.ListLocalMigrations`, fails fast on a bad
 * migrations directory before any DB connection is even attempted), THEN connects (Go's
 * `ConnectShadowDatabase`), THEN resolves the setup prelude (JWKS/pinned image names, {@link
 * legacyResolveDbSetupPrelude}) and sets up the platform baseline + template database ({@link
 * legacySetupShadowConn}), then applies every listed migration (Go's
 * `migration.ApplyMigrations`). Connect-then-setup (not the reverse) matches Go's own
 * `MigrateShadowDatabase` (`diff.go:195-209`) and this same module's `legacyRunFreshDbSetup`
 * (`db-setup.ts`) for the real local `db` container — see {@link legacySetupShadowDatabase}'s
 * own doc comment for why the ordering matters. Connection closed once this resolves, matching
 * Go's `defer conn.Close(...)`.
 */
const migrateShadowDatabase = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupRunInput<E>,
  setupOptions: LegacySetupDatabaseOptions,
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
      ).pipe(
        Effect.mapError(
          (cause) => new LegacyShadowDbError({ message: cause.message, reason: "filesystem" }),
        ),
      );

      const session = yield* legacyConnectShadowDatabase(input.connConfig);
      const resolved = yield* legacyResolveDbSetupPrelude(input.setup);
      yield* legacySetupShadowConn(
        spawner,
        legacyBuildShadowSetupDatabaseInput(input, session, resolved),
        setupOptions,
      );
      yield* legacyApplyMigrations(
        session,
        input.fs,
        input.path,
        pending,
        (message) => new LegacyShadowDbError({ message, reason: "database" }),
      );
    }),
  );

/**
 * Migrates a shadow for migra and the legacy pg-delta engine. Those Go-backed
 * workflows historically include `pg_net` in the platform baseline regardless of
 * project config, so preserve that baseline while sharing the native TS setup path.
 */
export const legacyMigrateShadowDatabase = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupRunInput<E>,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyShadowDbError | LegacyImagePrepullError | E,
  Output | LegacyDockerRun | RuntimeInfo | LegacyDbConnection
> => migrateShadowDatabase(spawner, input, { webhooks: "enabled" });

/**
 * Migrates a shadow for the in-process pg-delta engine. Unlike the legacy engine,
 * extension activation follows project config through `legacySetupDatabase`'s
 * default options.
 */
export const legacyMigrateNextShadowDatabase = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupRunInput<E>,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyShadowDbError | LegacyImagePrepullError | E,
  Output | LegacyDockerRun | RuntimeInfo | LegacyDbConnection
> => migrateShadowDatabase(spawner, input, {});
