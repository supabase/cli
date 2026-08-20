import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Net from "node:net";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  legacyResolveDebugWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import {
  legacyBuildLocalDbContainerInputs,
  type LegacyLocalDbContainerInputs,
} from "../../../shared/db-bootstrap/local-container-inputs.ts";
import { legacyWaitForShadowReady } from "../../../shared/db-bootstrap/health-check.ts";
import {
  legacyAcquireShadowDatabase,
  legacyPeekShadowBaseline,
  type LegacyShadowBaselinePeek,
  type LegacyShadowCacheOpts,
  type LegacyShadowAcquiredHandle,
} from "../../../shared/db-bootstrap/shadow-cache.ts";
import {
  legacyBufferedShadowOutput,
  legacyResolvePlanShadowStrategy,
  legacyRunPlanShadowProvisions,
} from "./legacy-pgdelta-next-shadow.plan.ts";
import {
  legacyConnectShadowDatabase,
  legacyMigrateNextShadowDatabase,
  legacyRemoveShadowDatabase,
  legacyShadowRunInputFromLocalContainerInputs,
  legacySetupShadowDatabase,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  LegacyPgDeltaNextShadow,
  type LegacyPgDeltaNextMigrationsShadow,
  type LegacyPgDeltaNextPlanShadows,
  type LegacyPgDeltaNextShadowInput,
} from "./legacy-pgdelta-next-shadow.service.ts";
import {
  DECLARATIVE_SHADOW_PREP_FAILURE_SUGGESTION,
  declarativeBaselinePrepStatements,
} from "../../../../shared/schema/prepare-declarative-shadow.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

const allocateFreeHostPort = Effect.callback<Option.Option<number>>((resume) => {
  const server = Net.createServer();
  server.once("error", () => resume(Effect.succeed(Option.none())));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port > 0 ? Option.some(port) : Option.none())));
  });
});

const nextShadowError = (cause: unknown) =>
  cause instanceof LegacyDeclarativeShadowDbError
    ? cause
    : new LegacyDeclarativeShadowDbError({
        message:
          typeof cause === "object" &&
          cause !== null &&
          typeof Reflect.get(cause, "message") === "string"
            ? String(Reflect.get(cause, "message"))
            : String(cause),
        ...(typeof cause === "object" &&
        cause !== null &&
        Reflect.get(cause, "reason") === "docker_daemon"
          ? { docker: "daemon" as const }
          : {}),
      });

interface NativeShadowInput {
  readonly spawner: ChildProcessSpawnerType["Service"];
  readonly localInputs: LegacyLocalDbContainerInputs;
  readonly base: ReturnType<typeof legacyShadowRunInputFromLocalContainerInputs>;
}

interface NativeShadowBase {
  readonly localInputs: LegacyLocalDbContainerInputs;
  readonly image: string;
}

interface ProvisionedDeclarativeShadow {
  readonly declarativeUrl: string;
  readonly restoredFromPgDataSnapshot: boolean;
}

/**
 * Whether pg-delta's same-database guard must be bypassed for this plan's two shadows — i.e.
 * whether they can legitimately report the same PostgreSQL identity (system identifier +
 * database OID). That happens exactly when the declarative shadow was physically RESTORED from
 * the same snapshot key that also produced the migrations shadow's cluster: same key means same
 * tar, and the migrations side is that tar's lineage whether it warm-restored FROM the tar or
 * cold-exported it this very run — the baseline handoff, where requiring the migrations handle
 * itself to be a warm restore would leave the guard armed against its own clone and fail the
 * first cold plan (review: Codex on #6215, P1). A freshly initdb'd declarative shadow always
 * carries its own new identity, and different keys mean tars exported from different clusters,
 * so both of those stay `false` and keep the guard armed. A `true` alongside identities that
 * happen to differ is harmless by design: pg-delta's bypass only takes effect on an exact
 * identity match (`schema-plan.ts`'s `trustedCloneBypass`), never on a same-lineage sibling.
 */
export function legacyAllowSameDatabaseIdentityForPlanShadows(opts: {
  readonly declarativeRestoredFromPgDataSnapshot: boolean;
  readonly sameSnapshotKey: boolean;
}): boolean {
  return opts.declarativeRestoredFromPgDataSnapshot && opts.sameSnapshotKey;
}

/**
 * Strip implicit platform extensions so the declarative shadow only keeps what
 * schema files declare. `pgjwt` still ships in the PG15+ image and DEPENDS ON
 * `pgcrypto`; PG14 also needs `storage.objects.id` detached from `uuid-ossp`.
 */
export const legacyPreparePgDeltaNextDeclarativeBaseline = Effect.fnUntraced(function* (
  session: Pick<LegacyDbSession, "exec">,
  majorVersion: number,
) {
  for (const sql of declarativeBaselinePrepStatements(majorVersion)) {
    yield* session.exec(sql).pipe(
      Effect.mapError((error) => {
        const detail =
          error.detail !== undefined && error.detail.length > 0 ? `\n  Detail: ${error.detail}` : "";
        return new LegacyDeclarativeShadowDbError({
          message: `Failed to prepare the isolated declaration shadow (${sql}): ${error.message}${detail}`,
          suggestion: DECLARATIVE_SHADOW_PREP_FAILURE_SUGGESTION,
        });
      }),
    );
  }
});

const setupRunInput = (input: NativeShadowInput, handle: LegacyShadowAcquiredHandle) => ({
  fs: input.base.fs,
  path: input.base.path,
  workdir: input.base.workdir,
  projectId: input.base.projectId,
  container: handle.containerId,
  networkId: input.base.networkId,
  connConfig: {
    host: input.base.hostname,
    port: input.base.shadowPort,
    user: "postgres",
    password: input.base.password,
    database: "postgres",
  },
  setup: input.base.setup,
});

/**
 * Scoped, native TypeScript shadow orchestration for pg-delta next. The command
 * workflows and this specialized two-shadow planner share the same bootstrap
 * primitives; no Go command or shadow handoff protocol is involved.
 */
export const legacyPgDeltaNextShadowLayer = Layer.effect(
  LegacyPgDeltaNextShadow,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* LegacyNetworkIdFlag;
    const debugFlag = yield* LegacyDebugFlag;
    const experimentalFlag = yield* LegacyExperimentalFlag;
    const cliArgs = yield* CliArgs;
    const output = yield* Output;
    const docker = yield* LegacyDockerRun;
    const dbConnection = yield* LegacyDbConnection;
    const httpClient = yield* HttpClient.HttpClient;

    // Parameterized on the Output service so `provisionPlan` can hand a concurrently running
    // provision a buffering decorator (`legacyBufferedShadowOutput`) instead of the live one.
    const runtimeWith = (outputService: typeof Output.Service) =>
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, fs),
        Layer.succeed(Path.Path, path),
        Layer.succeed(LegacyDebugFlag, debugFlag),
        Layer.succeed(LegacyExperimentalFlag, experimentalFlag),
        Layer.succeed(LegacyNetworkIdFlag, networkIdFlag),
        Layer.succeed(CliArgs, cliArgs),
        Layer.succeed(Output, outputService),
        Layer.succeed(RuntimeInfo, runtimeInfo),
        Layer.succeed(LegacyDockerRun, docker),
        Layer.succeed(LegacyDbConnection, dbConnection),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      );
    const runtime = runtimeWith(output);

    const nextPort = (excluded?: number) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate = yield* allocateFreeHostPort;
          if (Option.isSome(candidate) && candidate.value !== excluded) return candidate.value;
        }
        return yield* Effect.fail(
          new LegacyDeclarativeShadowDbError({
            message:
              excluded === undefined
                ? "failed to allocate a host port for pg-delta shadow database"
                : `failed to allocate a host port distinct from ${excluded}`,
          }),
        );
      });

    const buildNativeBase = (request: LegacyPgDeltaNextShadowInput) =>
      Effect.gen(function* () {
        const debug = yield* legacyResolveDebugWithProjectEnv(request.toml.projectEnv);
        const localInputs = yield* legacyBuildLocalDbContainerInputs(
          spawner,
          request.context.cwd,
          networkIdFlag,
          runtimeInfo.platform,
          debug,
          request.projectRef,
          request.toml.remoteOverrideKeys,
        );
        const image = yield* localInputs.resolvePostgresImage;
        return { localInputs, image } satisfies NativeShadowBase;
      }).pipe(Effect.provide(runtime));

    const buildNativeInput = (
      request: LegacyPgDeltaNextShadowInput,
      built: NativeShadowBase,
      port: number,
    ): NativeShadowInput => ({
      spawner,
      localInputs: built.localInputs,
      base: legacyShadowRunInputFromLocalContainerInputs(
        built.localInputs,
        built.image,
        { ...request.toml, shadowPort: port },
        fs,
        path,
      ),
    });

    /**
     * Cache-aware acquire, released when the current scope closes — next returns a URL the
     * engine keeps using after provision, so this cannot be `legacyWithShadowDatabase`
     * (that wrapper removes the container when `use` returns).
     */
    const acquireShadow = (input: NativeShadowInput, opts: LegacyShadowCacheOpts) =>
      Effect.acquireRelease(
        legacyAcquireShadowDatabase(input.spawner, input.base, opts),
        (handle) =>
          legacyRemoveShadowDatabase(input.spawner, handle.containerId).pipe(
            Effect.provideService(Output, output),
          ),
      );

    const awaitShadowReady = (input: NativeShadowInput, handle: LegacyShadowAcquiredHandle) =>
      legacyWaitForShadowReady(
        input.spawner,
        handle.containerId,
        {
          host: input.base.hostname,
          port: input.base.shadowPort,
          user: "postgres",
          password: input.base.password,
          database: "postgres",
        },
        {
          timeoutSeconds: input.base.healthTimeoutSeconds,
          image: input.base.image,
        },
      );

    const provisionMigrations = (
      input: NativeShadowInput,
      opts: LegacyShadowCacheOpts,
      onBaselineSeam: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input, opts);
        // The baseline-handoff strategy (`legacy-pgdelta-next-shadow.plan.ts`) waits on
        // `onBaselineSeam` before warm-restoring the declarative shadow. A snapshot-cold handle
        // reaches that seam when its export publishes the tar; any other handle (warm because
        // another process published between peek and acquire, or uncached) never runs a
        // snapshot, so signal immediately — the waiter then just re-peeks current disk state.
        const seamHandle: LegacyShadowAcquiredHandle =
          handle._tag === "cold"
            ? {
                ...handle,
                snapshotBaseline: handle.snapshotBaseline.pipe(Effect.ensuring(onBaselineSeam)),
              }
            : handle;
        if (handle._tag !== "cold") yield* onBaselineSeam;
        yield* awaitShadowReady(input, seamHandle);
        const setup = setupRunInput(input, seamHandle);
        yield* legacyMigrateNextShadowDatabase(input.spawner, setup, seamHandle);
        return {
          migrationsUrl: legacyToPostgresURL(setup.connConfig),
        } satisfies LegacyPgDeltaNextMigrationsShadow;
      }).pipe(Effect.provide(runtime), Effect.mapError(nextShadowError));

    const provisionDeclarative = (
      input: NativeShadowInput,
      opts: LegacyShadowCacheOpts,
      outputService: typeof Output.Service = output,
    ) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input, opts);
        yield* awaitShadowReady(input, handle);
        const setup = setupRunInput(input, handle);
        yield* legacySetupShadowDatabase(input.spawner, setup, { webhooks: "disabled" }, handle);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* legacyConnectShadowDatabase(setup.connConfig);
            yield* legacyPreparePgDeltaNextDeclarativeBaseline(
              session,
              input.base.setup.majorVersion,
            );
          }),
        );
        return {
          declarativeUrl: legacyToPostgresURL(setup.connConfig),
          restoredFromPgDataSnapshot: handle._tag === "warm",
        } satisfies ProvisionedDeclarativeShadow;
      }).pipe(Effect.provide(runtimeWith(outputService)), Effect.mapError(nextShadowError));

    const cacheOpts = (
      opts: LegacyPgDeltaNextShadowInput,
      webhooks: NonNullable<LegacyShadowCacheOpts["webhooks"]>,
    ): LegacyShadowCacheOpts => ({
      webhooks,
      ...(opts.bypassCache === true ? { bypassCache: true } : {}),
    });

    return LegacyPgDeltaNextShadow.of({
      provisionMigrations: (opts) =>
        Effect.gen(function* () {
          const port = yield* nextPort();
          const built = yield* buildNativeBase(opts);
          const input = buildNativeInput(opts, built, port);
          return yield* provisionMigrations(input, cacheOpts(opts, "config"));
        }).pipe(Effect.mapError(nextShadowError)),
      provisionDeclarative: (opts) =>
        Effect.gen(function* () {
          const port = yield* nextPort();
          const built = yield* buildNativeBase(opts);
          const input = buildNativeInput(opts, built, port);
          return yield* provisionDeclarative(input, cacheOpts(opts, "disabled"));
        }).pipe(Effect.mapError(nextShadowError)),
      provisionPlan: (opts) =>
        Effect.gen(function* () {
          const migrationsPort = yield* nextPort();
          const declarativePort = yield* nextPort(migrationsPort);
          const built = yield* buildNativeBase(opts);
          const migrationsInput = buildNativeInput(opts, built, migrationsPort);
          const declarativeInput = buildNativeInput(opts, built, declarativePort);
          // The two shadows are independent — anonymous containers on the distinct host ports
          // allocated above, per-invocation scoped temp dirs, and a race-tolerant network
          // ensure — so warm provisions run fully concurrently. How much can safely overlap
          // when a baseline still has to be BUILT is the strategy question: peek both cache
          // states up front and dispatch (see `legacy-pgdelta-next-shadow.plan.ts` for the
          // three strategies and their transcript guarantees). The peeks also resolve the
          // cache-key inputs once; passing them back through `precomputedKeyInputs` keeps the
          // acquire from repeating a live JWKS discovery request.
          const [migrationsPeek, declarativePeek] = yield* Effect.all([
            legacyPeekShadowBaseline(migrationsInput.base, cacheOpts(opts, "config")),
            legacyPeekShadowBaseline(declarativeInput.base, cacheOpts(opts, "disabled")),
          ]);
          const withPeek = (
            cache: LegacyShadowCacheOpts,
            peek: LegacyShadowBaselinePeek,
          ): LegacyShadowCacheOpts =>
            peek.state === "uncachable"
              ? cache
              : { ...cache, precomputedKeyInputs: peek.keyInputs };
          const strategy = legacyResolvePlanShadowStrategy(migrationsPeek, declarativePeek);
          // Peeked inputs are only reused where the acquire follows the peek IMMEDIATELY: the
          // migrations acquire always does, the declarative one only under `parallel`. In the
          // handoff (waits for the seam) and sequential (waits for the whole migrations
          // provision) strategies the declarative acquire is DELAYED, and the key hashes
          // `supabase/roles.sql` while the cold setup re-reads that file at its own time —
          // reusing a stale peek there could publish a baseline under a key that no longer
          // describes it (review: Codex on #6215). Re-resolving at acquire time also
          // self-corrects a handoff whose key genuinely changed mid-run: the recomputed key
          // misses the just-exported tar and the declarative side correctly cold-provisions
          // with the current inputs. The key's OTHER live input, the JWKS resolver, is
          // deliberately exempt from this refresh: it is memoized per shadow input
          // (`legacyShadowRunInputFromLocalContainerInputs`), so the key and the baked baseline
          // always carry the SAME value and cannot diverge; a delayed acquire keeps the
          // command-start JWKS, well inside the staleness the snapshot cache accepts by design
          // (a warm hit serves a tar up to 14 days old under its matching key).
          const migrationsOpts = withPeek(cacheOpts(opts, "config"), migrationsPeek);
          const declarativeOpts =
            strategy === "parallel"
              ? withPeek(cacheOpts(opts, "disabled"), declarativePeek)
              : cacheOpts(opts, "disabled");

          // In the concurrent strategies the declarative fiber's writes are buffered and
          // flushed after the join, so nothing can land between two of the migrations fiber's
          // live lines; sequential needs no buffer (one fiber at a time). `Effect.ensuring` on
          // the JOIN (not the declarative fiber, which can finish first) so anomaly warnings
          // survive failures without ever interleaving.
          const buffered =
            strategy === "sequential" ? undefined : legacyBufferedShadowOutput(output);
          const provisions = legacyRunPlanShadowProvisions({
            strategy,
            provisionMigrations: (onBaselineSeam) =>
              provisionMigrations(migrationsInput, migrationsOpts, onBaselineSeam),
            provisionDeclarative: provisionDeclarative(
              declarativeInput,
              declarativeOpts,
              buffered === undefined ? output : buffered.output,
            ),
          });
          const [migrations, declarative] = yield* buffered === undefined
            ? provisions
            : provisions.pipe(Effect.ensuring(buffered.flush));
          return {
            migrationsUrl: migrations.migrationsUrl,
            declarativeUrl: declarative.declarativeUrl,
            // Key equality comes from the peeks (deterministic over inputs, not disk state),
            // so a between-fibers eviction or publish cannot make it lie about lineage.
            allowSameDatabaseIdentity: legacyAllowSameDatabaseIdentityForPlanShadows({
              declarativeRestoredFromPgDataSnapshot: declarative.restoredFromPgDataSnapshot,
              sameSnapshotKey:
                migrationsPeek.state !== "uncachable" &&
                declarativePeek.state !== "uncachable" &&
                migrationsPeek.key === declarativePeek.key,
            }),
          } satisfies LegacyPgDeltaNextPlanShadows;
        }).pipe(Effect.mapError(nextShadowError)),
    });
  }),
);
