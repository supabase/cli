/**
 * The baseline cache, applied to the LONG-RUNNING local `db` container — `supabase db reset`'s
 * PG15 recreate and the fresh-volume branch of `supabase start`/`supabase db start`. The cluster
 * those flows build from scratch is, up to the seam `legacySetupDatabase` ends at, the same thing
 * `shadow-cache.ts` already snapshots for the throwaway shadow: the same init schema, the same
 * PG15+ one-shot realtime/storage/auth migrate jobs, the same webhooks convergence, API-privilege
 * pass, vault upsert, and `roles.sql` seed. So it restores from — and publishes into — the SAME
 * tar pool, under the same `legacyShadowCacheKey`.
 *
 * - **Warm** (a snapshot exists for this key): the tar is unpacked into the created-but-unstarted
 *   Postgres container ({@link legacyPgDataRestoreArchive} via `preStartArchives`, exactly as the
 *   warm shadow does), the entrypoint finds an initialized PGDATA and skips `initdb` plus the
 *   whole baseline, and `legacyRunFreshDbSetup` goes straight to `MigrateAndSeed`. `Restoring
 *   cached baseline...` prints where `Initialising schema...` would have.
 * - **Cold** (no snapshot): the container is created exactly as before, and the baseline is
 *   published at the baseline/migrations seam — after `legacySetupDatabase`, before
 *   `MigrateAndSeed` — via {@link legacyExportBaselineSnapshot}.
 * - **Uncachable** (PG<=14, OrioleDB, `SUPABASE_SHADOW_CACHE=false`, unreadable `roles.sql`, or
 *   `db start --from-backup`, which owns `preStartArchives` itself): today's flow, byte for byte.
 *
 * A warm restore that does not come up is never the user's problem to debug:
 * {@link legacyBringUpMainDbWithBaseline} warns, destroys the restored container AND its volume,
 * and re-runs the bring-up cold — the same escape hatch `legacyAcquireShadowDatabase` gives the
 * shadow. An INTERRUPT during that restore destroys them too, for a sharper reason: a
 * half-restored PGDATA volume left behind would read as "not a fresh volume" to the next
 * `supabase start`, which would then skip the fresh-volume setup entirely.
 *
 * **What sharing the pool with the shadow rests on.** The shadow bootstraps under
 * `-c max_worker_processes=0` (`LEGACY_SHADOW_ENTRYPOINT_ARGS`, `postgres.service.ts`) and this
 * container does not, and that difference is deliberately NOT in the key — see
 * `LegacyShadowCacheKeyInputs`'s own doc comment (`shadow-cache.ts`) for why that is safe today
 * and what would break it.
 *
 * Cold publication is best-effort: `Warning: database baseline not cached: <reason>` and the run
 * continues. The ONE failure that still propagates is the cluster not coming back after the
 * snapshot's `docker stop`/`docker start` — see {@link legacyExportBaselineSnapshot} for why
 * reporting success over a dead container is worse than failing.
 *
 * **Why the mid-setup stop is safe on every flow.** `supabase start` finishes the whole DB
 * bootstrap — container, health wait, fresh-volume setup — BEFORE it starts any other service
 * (`start.handler.ts`'s `bringUp`), so nothing is up to observe the pause. `db start` brings up
 * the database alone. `db reset` runs with the satellites up, but they already tolerate a `db`
 * container that was force-removed and recreated from scratch two steps earlier, and the reset
 * restarts them itself immediately after (`Restarting containers...`).
 */

import { Effect, Result, type FileSystem, type Option, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import type { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import type { LegacyPgConnInput } from "../legacy-db-connection.service.ts";
import type { LegacyVaultSecret } from "../legacy-vault.ts";
import { LEGACY_BASELINE_UNCACHED, type LegacyClusterBaselineState } from "./baseline-state.ts";
import {
  legacyCreateContainer,
  legacyRemoveContainer,
  legacyRemoveVolume,
  type LegacyContainerError,
  type LegacyContainerOpts,
  type LegacyContainerRemoveError,
  type LegacyVolumeRemoveError,
} from "./container-lifecycle.ts";
import { LegacyDbSetupError, type LegacyFreshDbSetupInput } from "./db-setup.ts";
import type { LegacyStartContainerSpec } from "./docker-create-args.ts";
import type { LegacyHealthCheckTimeoutError } from "./health-check.ts";
import { legacyStartInternalDbPassword } from "./internal-db-connection.ts";
import { legacyPgDataRestoreArchive } from "./pgdata-snapshot.ts";
import type { LegacyPostgresStartServiceInput } from "./postgres.service.ts";
import {
  legacyExportBaselineSnapshot,
  legacyForgetShadowBaselineTar,
  legacyPeekShadowBaseline,
  legacyRefreshShadowBaselineOnWarmHit,
  legacyShadowBaselineTarPath,
  type LegacyBaselineCacheInput,
} from "./shadow-cache.ts";
import { legacyTimeShadowPhase } from "./shadow-debug.ts";

type Spawner = ChildProcessSpawner["Service"];

/** The local `db` container's own binding of the shared baseline-state seam. */
export type LegacyMainDbBaselineState = LegacyClusterBaselineState<LegacyDbSetupError>;

type LegacyPreStartArchive = NonNullable<LegacyStartContainerSpec["preStartArchives"]>[number];

/**
 * The three `[db]`-config values the cache key needs that the container bring-up inputs do not
 * already carry. Every caller already ran its own validating `legacyCheckDbToml` pass — Go's
 * `flags.LoadConfig`-equivalent gate, long before any Docker work — so these are threaded down
 * from THAT result rather than re-read here: the key MUST describe the baseline the provisioning
 * actually configures (they are the same values `legacyRunFreshDbSetup` hands
 * `legacySetupDatabase`), and a third silent pass over `config.toml` could only ever drift from
 * it.
 */
export interface LegacyMainDbBaselineTomlInputs {
  readonly webhooksEnabled: boolean;
  readonly apiAutoExposeNewTables: Option.Option<boolean>;
  readonly vault: ReadonlyArray<LegacyVaultSecret>;
}

/**
 * Everything the main-db baseline cache needs — assembled by {@link legacyMainDbBaselineInput}
 * from exactly the values both bring-up compositions already hold, so neither one has to know
 * which of them the cache key reads.
 */
interface LegacyMainDbBaselineInput<E> {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  /**
   * The local `db` container's own name, which is ALSO its PGDATA volume's name
   * (`localDbContainerId(projectId)` — Go's `utils.DbId` names both). The warm-failure fallback
   * removes both under this one name.
   */
  readonly dbContainerId: string;
  /** The already registry-resolved `supabase/postgres` image the container runs. */
  readonly image: string;
  /**
   * The `db` container's host-facing connect target, used for the post-snapshot readiness probe.
   * Its `password` is also the key's `dbPassword`: for this container that is always the
   * `"postgres"` literal `legacyBuildPostgresStartContainerSpec` bakes in as `POSTGRES_PASSWORD`,
   * deliberately NOT `[db] password`, which only the shadow honors.
   */
  readonly connConfig: LegacyPgConnInput;
  readonly healthTimeoutSeconds: number;
  /** The container-spec fields the cluster's own identity depends on. */
  readonly postgresSpec: Omit<LegacyPostgresStartServiceInput, "image">;
  readonly setup: LegacyFreshDbSetupInput<E>;
}

/**
 * Assembles a {@link LegacyMainDbBaselineInput} from what `legacyStartDatabase`/
 * `legacyRecreateLocalDatabase15` already have in scope. The connect target is built the exact
 * same way `legacyRunFreshDbSetup` builds its own (`legacyStartInternalDbPassword(setup.dbUrl)`),
 * so the key's `dbPassword` can never drift from the password the run authenticates with.
 */
const legacyMainDbBaselineInput = <E>(args: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workdir: string;
  readonly dbContainerId: string;
  readonly hostname: string;
  readonly dbPort: number;
  readonly healthTimeoutSeconds: number;
  readonly image: string;
  readonly postgresSpec: Omit<LegacyPostgresStartServiceInput, "image">;
  readonly setup: LegacyFreshDbSetupInput<E>;
}): LegacyMainDbBaselineInput<E> => ({
  fs: args.fs,
  path: args.path,
  workdir: args.workdir,
  dbContainerId: args.dbContainerId,
  image: args.image,
  connConfig: {
    host: args.hostname,
    port: args.dbPort,
    user: "postgres",
    password: legacyStartInternalDbPassword(args.setup.dbUrl),
    database: "postgres",
  },
  healthTimeoutSeconds: args.healthTimeoutSeconds,
  postgresSpec: args.postgresSpec,
  setup: args.setup,
});

/** What {@link legacyPlanMainDbBaseline} decided, before any container exists. */
type LegacyMainDbBaselinePlan =
  /** The cache does not apply to this run — the spec and the pipeline are untouched. */
  | { readonly kind: "uncached"; readonly state: LegacyMainDbBaselineState }
  /** Provision normally, then publish the baseline at the baseline/migrations seam. */
  | { readonly kind: "cold"; readonly state: LegacyMainDbBaselineState }
  | {
      readonly kind: "warm";
      /** Spliced into the Postgres container spec's `preStartArchives` before `docker create`. */
      readonly restoreArchive: LegacyPreStartArchive;
      readonly state: LegacyMainDbBaselineState;
      readonly tarPath: string;
      /**
       * What a failed restore degrades to — same key, same tar path, but publishing WITHOUT the
       * `skipIfPublished` dedupe: unless it was deleted as suspect, the unusable tar is still
       * sitting at that path, deliberately retained so this export atomically REPLACES it
       * (review: Codex on #6215).
       */
      readonly coldFallbackState: LegacyMainDbBaselineState;
    };

/**
 * The plan for a run the cache never even looks at — `db start --from-backup`, and every
 * non-fresh-volume restart, neither of which provisions a platform baseline at all.
 */
const LEGACY_MAIN_DB_BASELINE_UNCACHED: LegacyMainDbBaselinePlan = {
  kind: "uncached",
  state: LEGACY_BASELINE_UNCACHED,
};

/**
 * Peeks the shared tar pool and decides warm / cold / uncachable for the local `db` container,
 * WITHOUT creating anything. Runs before `docker create`, because a warm restore has to be
 * unpacked into the container between `docker create` and `docker start`.
 *
 * The `webhooks` policy is left at the config-following default: `legacySetupDatabase` on this
 * path is called with no override at all, so it resolves `toml.webhooksEnabled` from
 * `config.toml`, and the key must say the same thing (see `diff.handler.ts`'s own `webhooks`
 * comment for what goes wrong when the key and the provisioning disagree).
 *
 * The error channel is the key resolution's own `E` — a JWKS resolution failure, which a real
 * cold provision at this same input would have hit anyway inside `legacyResolveDbSetupPrelude`,
 * just a few seconds later. That is the one ordering change on a failing run: JWKS discovery now
 * fails before the container is created rather than after its health wait.
 */
const legacyPlanMainDbBaseline = <E>(
  spawner: Spawner,
  input: LegacyMainDbBaselineInput<E>,
  toml: LegacyMainDbBaselineTomlInputs,
): Effect.Effect<LegacyMainDbBaselinePlan, E, Output> =>
  Effect.gen(function* () {
    const peek = yield* legacyPeekShadowBaseline(legacyMainDbCacheInput(input, toml));
    if (peek.state === "uncachable") return LEGACY_MAIN_DB_BASELINE_UNCACHED;

    const tarPath = legacyShadowBaselineTarPath(input.path, peek.key);
    const publishing = (skipIfPublished: boolean): LegacyMainDbBaselineState => ({
      _tag: "cold",
      // The exact `roles.sql` bytes this key was hashed from — the seed runs THESE rather than
      // re-reading the file, so the published snapshot cannot disagree with its own key.
      rolesSql: peek.keyInputs.rolesSql,
      snapshotBaseline: legacyExportMainDbBaseline(
        spawner,
        input,
        peek.key,
        tarPath,
        skipIfPublished,
      ),
    });

    if (peek.state === "cold") {
      // The tar was absent at peek time, so one found at export time can only be a same-key
      // sibling's fresh publish — dedupe against it, exactly like the shadow's `!cached` path.
      return { kind: "cold", state: publishing(true) } as const;
    }

    yield* legacyRefreshShadowBaselineOnWarmHit(input, tarPath);
    const output = yield* Output;
    // Prints where `Initialising schema...` would have (`legacyResolveDbSetupPrelude`), on the
    // same channel: a warm run really does skip that step, and silence would leave the seconds
    // of `docker cp -` that replace it unexplained.
    yield* output.raw("Restoring cached baseline...\n", "stderr");
    return {
      kind: "warm",
      restoreArchive: legacyPgDataRestoreArchive(input.fs, tarPath),
      state: { _tag: "warm" },
      tarPath,
      coldFallbackState: publishing(false),
    } as const;
  });

/**
 * Creates + starts the Postgres container for `plan`, waits for it with the caller's own gate,
 * and — on a warm restore that does not come up — warns, destroys the container AND its restored
 * volume, and retries the bring-up cold. Resolves to the baseline state
 * `legacyRunFreshDbSetup` should actually run with, which is NOT `plan.state` after a fallback.
 *
 * Removing the volume is what makes the fallback a real recovery rather than a loop: the tar was
 * unpacked INTO the named PGDATA volume, so recreating the container over it would just boot the
 * same broken cluster. `legacyRemoveContainer` is intolerant of "not found" while
 * `legacyRemoveVolume`'s `-f` makes a missing volume a no-op — correct either way here, since a
 * failed archive extraction already removes the container itself (see `legacyCreateContainer`)
 * but never the named volume.
 *
 * Both warm failure shapes are covered: a corrupt tar fails the `docker cp -` inside
 * `legacyCreateContainer`; a tar that extracts but yields an unusable cluster fails `waitReady`.
 * The tar is deleted only in the SECOND case, mirroring
 * `LegacyShadowCacheUnavailable.tarSuspect` — an extraction or daemon failure says nothing about
 * the tar's contents, and the fallback's own export atomically replaces a genuinely bad one
 * anyway.
 */
const legacyCreateMainDbWithBaseline = <R>(
  spawner: Spawner,
  args: {
    readonly plan: LegacyMainDbBaselinePlan;
    /** The undecorated Postgres container spec — the warm path splices `preStartArchives` on. */
    readonly spec: LegacyStartContainerSpec;
    readonly containerOpts: LegacyContainerOpts;
    /** `localDbContainerId(projectId)` — the container's name and its volume's name. */
    readonly dbContainerId: string;
    readonly fs: FileSystem.FileSystem;
    /**
     * The caller's own readiness gate for the created container, already carrying that caller's
     * semantics (`db start --from-backup` swallows a timeout; `db reset` never does). Not
     * parameterized by container id: both callers watch the container by its stable NAME.
     */
    readonly waitReady: Effect.Effect<void, LegacyHealthCheckTimeoutError, R>;
  },
): Effect.Effect<
  LegacyMainDbBaselineState,
  | LegacyContainerError
  | LegacyHealthCheckTimeoutError
  | LegacyContainerRemoveError
  | LegacyVolumeRemoveError,
  Output | R
> =>
  Effect.gen(function* () {
    const bringUp = (
      restoreArchive: LegacyPreStartArchive | undefined,
    ): Effect.Effect<void, LegacyContainerError | LegacyHealthCheckTimeoutError, R> =>
      Effect.gen(function* () {
        const spec: LegacyStartContainerSpec =
          restoreArchive === undefined
            ? args.spec
            : { ...args.spec, preStartArchives: [restoreArchive] };
        yield* legacyCreateContainer(spawner, spec, args.containerOpts);
        yield* args.waitReady;
      });

    if (args.plan.kind !== "warm") {
      yield* bringUp(undefined);
      return args.plan.state;
    }
    const plan = args.plan;

    // Container AND volume, in that order: the tar was unpacked INTO the named PGDATA volume, and
    // `docker rm -v` does not remove a NAMED one — see this function's own doc comment.
    const discardRestored = Effect.gen(function* () {
      yield* legacyRemoveContainer(spawner, args.dbContainerId);
      yield* legacyRemoveVolume(spawner, args.dbContainerId);
    });

    const restored = yield* legacyTimeShadowPhase(
      "baseline-restore",
      bringUp(plan.restoreArchive),
    ).pipe(
      // The same guard `legacyWarmShadow` puts on its own restored cluster (`shadow-cache.ts`).
      // `onInterrupt` is the substantive half here: a Ctrl-C landing anywhere in the restore
      // must not stand the run down leaving a half-restored VOLUME behind, because the next
      // `supabase start` would find that volume already present, take it for a provisioned one,
      // skip the fresh-volume setup entirely, and run against a cluster whose baseline never
      // finished landing. Best-effort — an interrupt is already the caller's answer, so a failed
      // teardown has nowhere to go (the shadow's own remove is non-failing for the same reason).
      // `interruptible` matches the shadow's own restore and keeps the guarantee independent of
      // whether a future caller wraps this bring-up in an uninterruptible acquire, where the
      // readiness wait would otherwise pin that Ctrl-C for the whole health-timeout budget.
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          yield* Effect.ignore(legacyRemoveContainer(spawner, args.dbContainerId));
          yield* Effect.ignore(legacyRemoveVolume(spawner, args.dbContainerId));
        }),
      ),
      Effect.interruptible,
      Effect.result,
    );
    if (!Result.isFailure(restored)) return plan.state;

    const cause = restored.failure;
    const output = yield* Output;
    yield* output.raw(
      `Warning: cached database baseline unusable (${cause.message}); recreating.\n`,
      "stderr",
    );
    // The ONE failure that implicates the tar's CONTENTS: it extracted cleanly, the container
    // started, and the cluster never answered.
    if (cause._tag === "LegacyHealthCheckTimeoutError") {
      yield* legacyForgetShadowBaselineTar(args.fs, plan.tarPath);
    }
    yield* discardRestored;
    yield* bringUp(undefined);
    return plan.coldFallbackState;
  });

/**
 * The whole cache-aware bring-up of the local `db` container, as ONE call: decide (peek the tar
 * pool), create + start, wait with the caller's own gate, fall back cold if a warm restore does
 * not come up, and resolve to the baseline state `legacyRunFreshDbSetup` should run with. Both
 * compositions that create this container (`start-database.ts`'s `legacyStartDatabase` and
 * `recreate-local-database.ts`'s `legacyRecreateLocalDatabase15`) ran the identical five-call
 * sequence before this existed; everything that genuinely differs between them is a parameter
 * here — {@link cacheEligible}, the {@link waitReady} policy, and the container spec.
 *
 * Slots into both callers exactly where `docker create` used to be, because the decision has to
 * land BEFORE it: a warm restore is a `docker cp -` into the created-but-unstarted container.
 */
export const legacyBringUpMainDbWithBaseline = <E, R>(
  spawner: Spawner,
  args: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly workdir: string;
    /** `localDbContainerId(projectId)` — the container's name and its PGDATA volume's name. */
    readonly dbContainerId: string;
    readonly hostname: string;
    readonly dbPort: number;
    readonly healthTimeoutSeconds: number;
    /** The already registry-resolved `supabase/postgres` image the container runs. */
    readonly image: string;
    /** The container-spec fields the cluster's own identity depends on. */
    readonly postgresSpec: Omit<LegacyPostgresStartServiceInput, "image">;
    readonly setup: LegacyFreshDbSetupInput<E>;
    /** The caller's own already-validated `[db]` values — see {@link LegacyMainDbBaselineTomlInputs}. */
    readonly toml: LegacyMainDbBaselineTomlInputs;
    /** The built, undecorated Postgres container spec — the warm path splices the archive on. */
    readonly spec: LegacyStartContainerSpec;
    readonly containerOpts: LegacyContainerOpts;
    /**
     * Whether this run provisions a platform baseline at all: only such a run can restore or
     * publish one. `false` for `db start --from-backup` (which owns `preStartArchives` itself and
     * skips the whole baseline) and for every non-fresh-volume start; always `true` for `db
     * reset`'s PG15 recreate, which just removed the volume.
     */
    readonly cacheEligible: boolean;
    /**
     * The caller's own readiness gate, already carrying that caller's semantics (`db start
     * --from-backup` swallows a timeout; `db reset` never does).
     */
    readonly waitReady: Effect.Effect<void, LegacyHealthCheckTimeoutError, R>;
  },
): Effect.Effect<
  LegacyMainDbBaselineState,
  | E
  | LegacyContainerError
  | LegacyHealthCheckTimeoutError
  | LegacyContainerRemoveError
  | LegacyVolumeRemoveError,
  Output | R
> =>
  Effect.gen(function* () {
    const plan = args.cacheEligible
      ? yield* legacyPlanMainDbBaseline(spawner, legacyMainDbBaselineInput(args), args.toml)
      : LEGACY_MAIN_DB_BASELINE_UNCACHED;
    return yield* legacyCreateMainDbWithBaseline(spawner, {
      plan,
      spec: args.spec,
      containerOpts: args.containerOpts,
      dbContainerId: args.dbContainerId,
      fs: args.fs,
      waitReady: args.waitReady,
    });
  });

/** Adapts the main-db bring-up inputs into the shared, structurally-keyed cache input. */
const legacyMainDbCacheInput = <E>(
  input: LegacyMainDbBaselineInput<E>,
  toml: LegacyMainDbBaselineTomlInputs,
): LegacyBaselineCacheInput<E> => ({
  fs: input.fs,
  path: input.path,
  workdir: input.workdir,
  image: input.image,
  db: input.postgresSpec.db,
  experimental: input.postgresSpec.experimental,
  jwtSecret: input.postgresSpec.jwtSecret,
  jwtExpiry: input.postgresSpec.jwtExpiry,
  ...(input.postgresSpec.rootKey === undefined ? {} : { rootKey: input.postgresSpec.rootKey }),
  // Read off the connect config rather than re-derived, so the key stays pinned to the password
  // the run actually authenticates with — see {@link LegacyMainDbBaselineInput.connConfig}.
  password: input.connConfig.password,
  setup: {
    majorVersion: input.setup.majorVersion,
    config: input.setup.config,
    jwks: input.setup.jwks,
    storageTargetMigration: input.setup.storageTargetMigration,
    serviceVersionOverrides: input.setup.serviceVersionOverrides,
    projectEnvValues: input.setup.projectEnvValues,
    webhooksEnabled: toml.webhooksEnabled,
    apiAutoExposeNewTables: toml.apiAutoExposeNewTables,
    vault: toml.vault,
  },
});

/** The local `db` container's binding of {@link legacyExportBaselineSnapshot}. */
const legacyExportMainDbBaseline = <E>(
  spawner: Spawner,
  input: LegacyMainDbBaselineInput<E>,
  key: string,
  tarPath: string,
  skipIfPublished: boolean,
): Effect.Effect<void, LegacyDbSetupError, Output | LegacyDbConnection> =>
  legacyExportBaselineSnapshot(spawner, input, {
    containerId: input.dbContainerId,
    tarPath,
    key,
    skipIfPublished,
    connConfig: input.connConfig,
    healthTimeoutSeconds: input.healthTimeoutSeconds,
    image: input.image,
    warnLabel: "database",
    clusterLabel: "local database",
    readyLabel: "re-started database",
  }).pipe(
    Effect.mapError(
      (cause) => new LegacyDbSetupError({ message: cause.reason, reason: "docker_daemon" }),
    ),
  );
