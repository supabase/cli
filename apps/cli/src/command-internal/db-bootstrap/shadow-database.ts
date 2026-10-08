/**
 * Shadow-database primitives (create, health-wait, baseline setup, migrations replay), exposed
 * individually because callers compose different subsets; the fused diff/pull shape lives in
 * `commands/db/shared/shadow-source.ts` so this module never imports the diff engines.
 *
 * The shadow container has no name or network alias, so its one-shot setup jobs reach it by the
 * container id's 12-char short form as hostname.
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
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { collectText, describeContainerCliFailure, spawnContainerCli } from "../container-cli.ts";
import type { DbConfigLoadError } from "../db-config.errors.ts";
import { DbConnection, type DbSession } from "../db-connection.service.ts";
import type { PgConnInput } from "../db-connection.service.ts";
import { CLI_PROJECT_LABEL } from "../docker-ids.ts";
import type { DockerRun } from "../docker-run.service.ts";
import { applyMigrations } from "../migration-apply.ts";
import type { VaultSecret } from "../vault.ts";
import {
  ensureNetwork,
  createContainer,
  COMPOSE_PROJECT_LABEL,
  type ContainerError,
  type ContainerOpts,
} from "./container-lifecycle.ts";
import type { StartContainerSpec } from "./docker-create-args.ts";
import type { ImagePrepullError } from "./image-prepull.ts";
import type { LocalDbContainerInputs } from "./local-container-inputs.ts";
import type { LocalProjectContext } from "../local-project-context.ts";
import { listLocalMigrationPaths } from "../migration-history.ts";
import { toPostgresURL } from "../postgres-url.ts";
import {
  type FreshDbSetupInput,
  type SetupDatabaseInput,
  type SetupDatabaseOptions,
  type StartDbSetupImages,
  type StartSetupLocalDatabaseError,
  resolveDbSetupPrelude,
  setupDatabase,
} from "./db-setup.ts";
import {
  buildShadowPostgresContainerSpec,
  type ShadowPostgresContainerSpecInput,
} from "./postgres.service.ts";

type Spawner = ChildProcessSpawner["Service"];

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Creating, connecting to, setting up, or migrating the shadow database failed. Kept here rather
 * than in a pg-delta-family-specific error type so these primitives stay usable by callers
 * outside the `db diff`/`db pull` family, like `migration squash`.
 */
export class ShadowDbError extends Data.TaggedError("ShadowDbError")<{
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
const shadowContainerReason = (reason: ContainerError["reason"]): ShadowDbError["reason"] => {
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
 * (https://github.com/citusdata/pg_cron/blob/main/pg_cron.sql#L3).
 */
export const SHADOW_CREATE_TEMPLATE_SQL = "CREATE DATABASE contrib_regression TEMPLATE postgres";

/** Fixed connect-retry timeout for the shadow database, in seconds. */
const SHADOW_CONNECT_TIMEOUT_SECONDS = 10;

/** Constant 1-second delay between connect retries, capped at {@link SHADOW_CONNECT_TIMEOUT_SECONDS} retries. */
const SHADOW_CONNECT_SCHEDULE = Schedule.max([
  Schedule.spaced("1 seconds"),
  Schedule.recurs(SHADOW_CONNECT_TIMEOUT_SECONDS),
]);

/**
 * A second, independent connect-retry loop layered on top of the container health wait the
 * caller already ran — a healthy Postgres healthcheck doesn't guarantee the next connection
 * attempt succeeds instantly. Scoped: the session's connection closes when the caller's scope
 * closes.
 */
export const connectShadowDatabase = (
  cfg: PgConnInput,
): Effect.Effect<DbSession, ShadowDbError, DbConnection | Scope.Scope> =>
  Effect.gen(function* () {
    const dbConnection = yield* DbConnection;
    let attempts = 0;
    return yield* Effect.suspend(() => {
      attempts += 1;
      return dbConnection.connect(cfg, { isLocal: true, dnsResolver: "native" });
    }).pipe(
      Effect.mapError((cause) => new ShadowDbError({ message: cause.message, reason: "connect" })),
      Effect.retry({ schedule: SHADOW_CONNECT_SCHEDULE }),
      Effect.ensuring(
        Effect.suspend(() => Effect.annotateCurrentSpan("retry.attempt_count", attempts)),
      ),
    );
  }).pipe(Effect.withSpan("ShadowDatabase.connect"));

/**
 * Input to {@link createShadowDatabase} — the subset of the real `db` container's own bootstrap
 * inputs the shadow variant needs, plus its own host port. See
 * {@link ShadowPostgresContainerSpecInput} for the container-spec shape this wraps.
 */
export interface CreateShadowDatabaseInput extends ShadowPostgresContainerSpecInput {
  /** Merged onto the shadow's own labels and the network-create call, same as every other container this codebase creates. */
  readonly projectId: string;
  readonly isBitbucketPipeline: boolean;
  readonly workdir: string;
  readonly extraHosts: ReadonlyArray<string>;
  /**
   * Set only by the shadow baseline cache's warm path: a previously exported PGDATA tar to
   * unpack into the container between `docker create` and `docker start`, so the entrypoint
   * finds an initialized data directory and skips `initdb` and the platform baseline. Everything
   * else about the container is identical to an uncached shadow. Delivered as
   * {@link StartContainerSpec.preStartArchives}.
   */
  readonly restoreArchive?: NonNullable<StartContainerSpec["preStartArchives"]>[number];
  /**
   * Set only by the shadow baseline cache's cold path, to `false`: that path must `docker
   * stop`/`start` the container mid-run to snapshot it, and Docker removes an auto-removed
   * container the moment it exits, leaving nothing to restart. Still removed by `docker rm -f -v`
   * on release, so a SIGKILLed CLI leaves a stopped container behind (swept by `supabase stop`)
   * instead of nothing.
   */
  readonly autoRemove?: boolean;
}

/** Resolved by {@link createShadowDatabase} — everything a caller needs to both use and later tear down the shadow. */
export interface ShadowDatabaseHandle {
  /** Docker always returns the id from `docker create`, regardless of whether `--name` was passed. */
  readonly containerId: string;
}

/**
 * Ensures the local Docker network exists, then creates and starts the shadow container.
 *
 * Leak window: this runs as the `acquire` of an `Effect.acquireUseRelease` whose `release` is
 * {@link removeShadowDatabase}, which only registers once `acquire` resolves successfully. An
 * `acquire` that fails after `docker create` but before the container finishes starting leaves it
 * running with nothing to remove it — accepted as rare rather than worth a bespoke cleanup path.
 */
export const createShadowDatabase = (
  spawner: Spawner,
  input: CreateShadowDatabaseInput,
): Effect.Effect<ShadowDatabaseHandle, ShadowDbError> =>
  Effect.gen(function* () {
    const labels = {
      [CLI_PROJECT_LABEL]: input.projectId,
      [COMPOSE_PROJECT_LABEL]: input.projectId,
    };
    yield* ensureNetwork(spawner, input.networkId, labels).pipe(
      Effect.mapError(
        (cause) =>
          new ShadowDbError({
            message: cause.message,
            reason: shadowContainerReason(cause.reason),
          }),
      ),
    );
    // Both overrides are the shadow baseline cache's and nobody else's — see each field's doc
    // comment on {@link CreateShadowDatabaseInput}.
    const baseSpec = buildShadowPostgresContainerSpec(input);
    const spec: StartContainerSpec = {
      ...baseSpec,
      ...(input.autoRemove === undefined ? {} : { autoRemove: input.autoRemove }),
      ...(input.restoreArchive === undefined ? {} : { preStartArchives: [input.restoreArchive] }),
    };
    // No name or network alias — see this module's own header. The pgsodium root key (PG15+
    // only) is delivered straight into the container via `docker cp`
    // ({@link StartContainerSpec.secretFiles}), same as every other container's secrets.
    const containerOpts: ContainerOpts = {
      projectId: input.projectId,
      isBitbucketPipeline: input.isBitbucketPipeline,
      workdir: input.workdir,
      extraHosts: input.extraHosts,
    };
    const containerId = yield* createContainer(spawner, spec, containerOpts).pipe(
      Effect.mapError(
        (cause) =>
          new ShadowDbError({
            message: cause.message,
            reason: shadowContainerReason(cause.reason),
          }),
      ),
    );
    return { containerId };
  }).pipe(
    Effect.withSpan("ShadowDatabase.create", {
      attributes: { "shadow.restore_archive": input.restoreArchive !== undefined },
    }),
  );

/**
 * `docker rm -f -v <id>`. Best-effort for the overall operation — a removal failure must never
 * mask whatever the caller was doing with the shadow — but the failure is still reported to
 * stderr rather than swallowed silently, including a failure to even launch or collect the
 * removal itself.
 */
export const removeShadowDatabase = (
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
          [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? undefined : stderr.trim();
      }),
    ).pipe(Effect.catch((cause) => Effect.succeed(describeContainerCliFailure(cause))));
    if (failureMessage !== undefined) {
      const output = yield* Output;
      yield* output.raw(`Failed to remove container: ${containerId} ${failureMessage}\n`, "stderr");
    }
  });

/** A live shadow database left running for the caller to diff against and remove. */
export interface ShadowSourceResult {
  /** Container id; the caller must remove it with {@link removeShadowDatabase} when done. */
  readonly container: string;
  /** The diff source Postgres URL (the provisioned shadow). */
  readonly sourceUrl: string;
  /**
   * Legacy migra only. When set, replaces the diff target with `contrib_regression` on the
   * same shadow container (cloned from `postgres` by {@link setupShadowConn}) after declarative
   * schemas are applied. pg-delta leaves this unset and diffs `postgres`.
   */
  readonly targetUrlOverride: string | undefined;
}

/** Fields shared by `shadow-source.ts`'s `PrepareShadowSourceInput` and the shadow readiness probes. */
interface ShadowConnectionInput extends CreateShadowDatabaseInput {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly hostname: string;
  /** `[db] password` (already resolved from `config.toml`) — the shadow's own connect password. */
  readonly password: string;
  readonly healthTimeoutSeconds: number;
}

/**
 * {@link ShadowConnectionInput} plus the platform-baseline setup fields
 * {@link setupDatabase}/`migrateShadowDatabase`/`setupShadowDatabase` need — the full shape
 * {@link shadowRunInputFromLocalContainerInputs} returns. Named here rather than as an
 * `Omit<...>` of a diff/pull-specific type, so `migration squash` (which has none of those
 * fields) can consume the promoted function's return value directly, with no `as` cast.
 */
export interface ShadowSetupInput<E> extends ShadowConnectionInput {
  readonly setup: ShadowDbSetupInput<E>;
  /** Remotes-merged project context from local container inputs, reused for catalog pins. */
  readonly context?: LocalProjectContext;
}

/**
 * Memoizes `effect`'s first success; failures are never cached, so a retry re-runs the real
 * effect. Not `Effect.cached`, since that needs an effectful construction site and
 * {@link shadowRunInputFromLocalContainerInputs} is a plain function; not concurrency-guarded,
 * since the two consumers of the field this wraps evaluate sequentially on the same fiber.
 */
export function memoizeSuccess<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  let succeeded: Effect.Effect<A, E> | undefined;
  return Effect.suspend(
    () =>
      succeeded ??
      effect.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            succeeded = Effect.succeed(value);
          }),
        ),
      ),
  );
}

/**
 * Adapts {@link LocalDbContainerInputs} plus the caller's own already-loaded `config.toml` slice
 * into {@link ShadowSetupInput}, covering every field `shadow-source.ts` or `migration squash`'s
 * shadow composition need except the diff/pull-specific ones left to each call site. Promoted out
 * of `shadow-source.ts` so `migration squash` can reuse this shape without importing that file's
 * whole diff-engine stack.
 *
 * On a linked ref, the container config and `toml` are resolved through two independent
 * remote-merge implementations rather than a shared decode — a known duplication, not a bug.
 */
export function shadowRunInputFromLocalContainerInputs(
  localInputs: LocalDbContainerInputs,
  resolvedImage: string,
  toml: {
    readonly shadowPort: number;
    readonly password: string;
    readonly webhooksEnabled: boolean;
    readonly baseline: { readonly apiAutoExposeNewTables: Option.Option<boolean> };
    readonly vault: ReadonlyArray<VaultSecret>;
  },
  fs: FileSystem.FileSystem,
  path: Path.Path,
): ShadowSetupInput<DbConfigLoadError> {
  const { postgresSpecBase } = localInputs;
  return {
    db: {
      major_version: postgresSpecBase.db.major_version,
      orioledb_version: postgresSpecBase.db.orioledb_version,
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
    context: localInputs.context,
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
      // Not `localInputs.setup.dbUrl`, which carries the regular local container's own
      // hardcoded password for a different container. This must carry the shadow's own
      // resolved `toml.password`, or a non-default `[db] password` authenticates against the
      // wrong secret and every setup job fails.
      dbUrl: toPostgresURL({
        host: localInputs.context.hostname,
        port: toml.shadowPort,
        user: "postgres",
        password: toml.password,
        database: "postgres",
      }),
      jwtSecret: localInputs.setup.jwtSecret,
      // Memoized: with the shadow cache enabled this effect is evaluated twice on a cold run
      // (once for the cache key, once for the baseline), and JWKS discovery can be a real
      // network request. Memoizing the first success keeps the run to one request and keeps the
      // published snapshot consistent with its own key.
      jwks: memoizeSuccess(localInputs.setup.jwks),
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

/** Host/port/password fields every shadow connect target is built from. */
export interface ShadowConnFields {
  readonly hostname: string;
  readonly shadowPort: number;
  readonly password: string;
}

/** The shadow's `postgres`/`postgres` connect target on the published host port. */
export const shadowConnConfig = (input: ShadowConnFields): PgConnInput => ({
  host: input.hostname,
  port: input.shadowPort,
  user: "postgres",
  password: input.password,
  database: "postgres",
});

/**
 * Runs {@link setupDatabase} against an already-connected shadow, dialed at `input.dbHost` =
 * `container.slice(0, 12)` (see this module's own header), then unconditionally creates
 * {@link SHADOW_CREATE_TEMPLATE_SQL}'s template database. A caller that only needs the bare
 * setup step (`migration squash`) calls {@link setupDatabase} directly instead of going through
 * this function.
 */
export const setupShadowConn = (
  spawner: Spawner,
  input: SetupDatabaseInput,
  options: SetupDatabaseOptions = {},
): Effect.Effect<
  void,
  StartSetupLocalDatabaseError | ShadowDbError,
  Output | DockerRun | RuntimeInfo
> =>
  Effect.gen(function* () {
    yield* setupDatabase(spawner, input, options).pipe(
      // A batched SQL file's own pooled connection can fail to acquire — treat that as a shadow
      // connect failure, not a setup/statement failure.
      Effect.catchTag("DbConnectError", (cause) =>
        Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
      ),
    );
    yield* createShadowTemplateDatabase(input.session);
  });

/**
 * Clones `contrib_regression` for the legacy migra shadow. The cache snapshot is taken
 * before this statement, so a warm hit still runs it when that caller asks for the clone.
 * pg-delta does not call this.
 */
const createShadowTemplateDatabase = (
  session: DbSession,
): Effect.Effect<void, ShadowDbError, Output> =>
  session.exec(SHADOW_CREATE_TEMPLATE_SQL).pipe(
    Effect.mapError(
      (cause) =>
        new ShadowDbError({
          message: `failed to create template database: ${errMessage(cause)}`,
          reason: "database",
        }),
    ),
  );

/**
 * Shared fields {@link setupShadowDatabase} and {@link migrateShadowDatabase} need to resolve
 * JWKS/images and run {@link setupDatabase} — derived from `db-setup.ts`'s `FreshDbSetupInput`
 * rather than hand-copied, so the two never silently drift. Swaps `experimental` (irrelevant to
 * the shadow's setup-only pipeline) for the two fields (`apiAutoExposeNewTables`/`vault`) the
 * shadow's caller resolves from an already-loaded `config.toml` instead.
 */
export type ShadowDbSetupInput<E> = Omit<FreshDbSetupInput<E>, "experimental"> & {
  readonly webhooksEnabled: SetupDatabaseInput["webhooksEnabled"];
  readonly apiAutoExposeNewTables: SetupDatabaseInput["apiAutoExposeNewTables"];
  readonly vault: SetupDatabaseInput["vault"];
};

/** Common caller-supplied plumbing for {@link setupShadowDatabase}/{@link migrateShadowDatabase}. */
interface ShadowSetupRunInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  /** Labels the shadow's own PG15+ one-shot migrate job containers, same as the real local `db` container's. */
  readonly projectId: string;
  readonly container: string;
  readonly networkId: string;
  /** The shadow's own connect target — host/port/user/password/database (`postgres`/`postgres`). */
  readonly connConfig: PgConnInput;
  readonly setup: ShadowDbSetupInput<E>;
}

/**
 * Builds a {@link SetupDatabaseInput} for {@link setupDatabase} out of an already-connected
 * shadow session plus the resolved images/JWKS prelude — exported so a caller that calls
 * {@link setupDatabase} directly (`migration squash`) can build this same shape without
 * duplicating the `container[:12]` dbHost derivation.
 */
export const buildShadowSetupDatabaseInput = <E>(
  input: ShadowSetupRunInput<E>,
  session: DbSession,
  resolved: { readonly jwks: string; readonly images: StartDbSetupImages },
): SetupDatabaseInput => ({
  session,
  fs: input.fs,
  path: input.path,
  workdir: input.workdir,
  config: input.setup.config,
  webhooksEnabled: input.setup.webhooksEnabled,
  majorVersion: input.setup.majorVersion,
  // The container id's 12-char short form — see this module's own header for why this resolves
  // as a hostname.
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
 * Connects to the shadow, resolves the setup prelude, and applies the platform baseline.
 * No user migrations. Does not create `contrib_regression`: pg-delta diffs this database,
 * and `CREATE DATABASE … TEMPLATE` crashes OrioleDB when the baseline has an enum-indexed
 * OrioleDB table.
 *
 * `baseline` defaults to {@link SHADOW_BASELINE_COLD}. A warm cache hit returns immediately.
 * A cache-enabled cold provision snapshots after the baseline and does not reconnect.
 */
export const setupShadowDatabase = <E>(
  spawner: Spawner,
  input: ShadowSetupRunInput<E>,
  options: SetupDatabaseOptions = {},
  baseline: ShadowBaselineState = SHADOW_BASELINE_COLD,
): Effect.Effect<
  void,
  StartSetupLocalDatabaseError | ShadowDbError | ImagePrepullError | E,
  Output | DockerRun | RuntimeInfo | DbConnection
> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (baseline.baselinePresent) return;
      if (baseline.snapshotRequired) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const setupSession = yield* connectShadowDatabase(input.connConfig);
            const resolved = yield* resolveDbSetupPrelude(input.setup);
            yield* setupDatabase(
              spawner,
              buildShadowSetupDatabaseInput(input, setupSession, resolved),
              options,
            ).pipe(
              // A batched SQL file's own pooled connection can fail to acquire — treat that as a
              // shadow connect failure, not a setup/statement failure.
              Effect.catchTag("DbConnectError", (cause) =>
                Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
              ),
            );
          }),
        );
        yield* baseline.snapshotBaseline;
        return;
      }
      const session = yield* connectShadowDatabase(input.connConfig);
      const resolved = yield* resolveDbSetupPrelude(input.setup);
      yield* setupDatabase(
        spawner,
        buildShadowSetupDatabaseInput(input, session, resolved),
        options,
      ).pipe(
        // Same connect-failure classification as the snapshot branch above.
        Effect.catchTag("DbConnectError", (cause) =>
          Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
        ),
      );
    }),
  ).pipe(
    Effect.withSpan("ShadowDatabase.setup", {
      attributes: { "shadow.baseline_state": shadowBaselineStateName(baseline) },
    }),
  );

/**
 * What `acquire` hands the `use` phase about the shadow cluster's contents — the seam the warm
 * shadow-container cache needs and nothing else uses. A value the acquire owns and returns
 * (rather than a callback threaded down separately), since the cache is the only party that
 * knows both whether a cluster already carries a baseline and what to do once a fresh one
 * exists. {@link SHADOW_BASELINE_COLD} is what every uncached caller passes.
 */
export interface ShadowBaselineState {
  /**
   * `true` only on a warm cache hit: the cluster already carries the platform baseline, restored
   * from the cache's own PGDATA snapshot, so re-running it would double-apply it.
   */
  readonly baselinePresent: boolean;
  /**
   * `true` only for a cache-enabled cold provision — the one state whose
   * {@link snapshotBaseline} actually stops the container. {@link migrateShadowDatabase} splits
   * its session only for this state: the baseline session must close before a disk-level
   * snapshot, but otherwise a reconnect would pick up role-level defaults `roles.sql` just
   * installed, which a single session never exposes to migrations.
   */
  readonly snapshotRequired: boolean;
  /**
   * Runs after a freshly provisioned baseline and before the template / user
   * migrations. Takes no session; a real snapshot stops the container.
   *
   * A failed snapshot degrades silently except when the shadow does not come
   * back — that is a {@link ShadowDbError}.
   */
  readonly snapshotBaseline: Effect.Effect<void, ShadowDbError, Output | DbConnection>;
}

/** The baseline state every uncached caller passes: provision it, snapshot nothing. */
const SHADOW_BASELINE_COLD: ShadowBaselineState = {
  baselinePresent: false,
  snapshotRequired: false,
  snapshotBaseline: Effect.void,
};

const shadowBaselineStateName = (baseline: ShadowBaselineState): string =>
  baseline.baselinePresent ? "warm" : baseline.snapshotRequired ? "cold_snapshot" : "cold";

/**
 * Lists local migrations first, so a bad migrations directory fails before any DB connection,
 * then connects, resolves the setup prelude, and runs the platform baseline before applying
 * every listed migration. `options.createTemplateDatabase` clones `contrib_regression` for the
 * legacy engine only. Connect-then-setup for the same reason as {@link setupShadowDatabase}.
 *
 * `baseline` defaults to {@link SHADOW_BASELINE_COLD}. A warm hit skips the prelude and setup; a
 * cold cache-enabled provision snapshots between the baseline and later steps. Only that
 * snapshotting branch splits sessions — see {@link ShadowBaselineState.snapshotRequired}.
 */
const migrateShadowDatabaseWith = <E>(
  spawner: Spawner,
  input: ShadowSetupRunInput<E>,
  setupOptions: SetupDatabaseOptions,
  baseline: ShadowBaselineState = SHADOW_BASELINE_COLD,
  options: { readonly createTemplateDatabase?: boolean } = {},
): Effect.Effect<
  void,
  StartSetupLocalDatabaseError | ShadowDbError | ImagePrepullError | E,
  Output | DockerRun | RuntimeInfo | DbConnection
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const migrationsDir = input.path.join(input.workdir, "supabase", "migrations");
      const pending = yield* listLocalMigrationPaths(input.fs, input.path, migrationsDir).pipe(
        Effect.mapError(
          (cause) => new ShadowDbError({ message: cause.message, reason: "filesystem" }),
        ),
      );
      yield* Effect.annotateCurrentSpan("migration.count", pending.length);

      if (!baseline.baselinePresent && baseline.snapshotRequired) {
        // Own scope: the baseline session must be closed before `snapshotBaseline` — see this
        // function's own doc comment.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const setupSession = yield* connectShadowDatabase(input.connConfig);
            const resolved = yield* resolveDbSetupPrelude(input.setup);
            yield* setupDatabase(
              spawner,
              buildShadowSetupDatabaseInput(input, setupSession, resolved),
              setupOptions,
            ).pipe(
              // A batched SQL file's own pooled connection can fail to acquire — treat that as a
              // shadow connect failure, not a setup/statement failure.
              Effect.catchTag("DbConnectError", (cause) =>
                Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
              ),
            );
          }),
        );
        yield* baseline.snapshotBaseline;
      }
      const session = yield* connectShadowDatabase(input.connConfig);
      if (!baseline.baselinePresent && !baseline.snapshotRequired) {
        // The established single-session flow: baseline and migrations share this session.
        // A reconnect would pick up role-level defaults `roles.sql` just installed.
        const resolved = yield* resolveDbSetupPrelude(input.setup);
        yield* setupDatabase(
          spawner,
          buildShadowSetupDatabaseInput(input, session, resolved),
          setupOptions,
        ).pipe(
          // Same connect-failure classification as the snapshot branch above.
          Effect.catchTag("DbConnectError", (cause) =>
            Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
          ),
        );
      }
      if (options.createTemplateDatabase !== false) {
        yield* createShadowTemplateDatabase(session);
      }
      yield* applyMigrations(
        session,
        input.fs,
        input.path,
        pending,
        (message) => new ShadowDbError({ message, reason: "database" }),
      ).pipe(
        // A batch runs on its own pooled connection; failing to acquire it is a connect
        // failure, never a `"database"` statement failure.
        Effect.catchTag("DbConnectError", (cause) =>
          Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
        ),
      );
    }),
  ).pipe(
    Effect.withSpan("ShadowDatabase.migrate", {
      attributes: { "shadow.baseline_state": shadowBaselineStateName(baseline) },
    }),
  );

/**
 * Migrates a shadow for migra and the legacy pg-delta engine. Those
 * workflows include `pg_net` in the platform baseline regardless of
 * project config, so preserve that baseline while sharing the native TS setup path.
 */
export const migrateShadowDatabase = <E>(
  spawner: Spawner,
  input: ShadowSetupRunInput<E>,
  baseline: ShadowBaselineState = SHADOW_BASELINE_COLD,
): Effect.Effect<
  void,
  StartSetupLocalDatabaseError | ShadowDbError | ImagePrepullError | E,
  Output | DockerRun | RuntimeInfo | DbConnection
> => migrateShadowDatabaseWith(spawner, input, { webhooks: "enabled" }, baseline);

/**
 * Migrates a shadow for the in-process pg-delta engine. Extension activation follows
 * project config. Does not create `contrib_regression`: pg-delta never connects to it,
 * and the clone crashes OrioleDB when the baseline has an enum-indexed OrioleDB table.
 */
export const migrateNextShadowDatabase = <E>(
  spawner: Spawner,
  input: ShadowSetupRunInput<E>,
  baseline: ShadowBaselineState = SHADOW_BASELINE_COLD,
): Effect.Effect<
  void,
  StartSetupLocalDatabaseError | ShadowDbError | ImagePrepullError | E,
  Output | DockerRun | RuntimeInfo | DbConnection
> => migrateShadowDatabaseWith(spawner, input, {}, baseline, { createTemplateDatabase: false });
