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
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
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
  type LegacyShadowAcquiredHandle,
  type LegacyShadowBaselinePeek,
  type LegacyShadowCacheOpts,
} from "../../../shared/db-bootstrap/shadow-cache.ts";
import {
  legacyBufferedShadowOutput,
  legacyResolvePlanShadowStrategy,
  legacyRunPlanShadowProvisions,
} from "./legacy-pgdelta-next-shadow.plan.ts";
import {
  legacyMemoizeSuccess,
  legacyMigrateNextShadowDatabase,
  legacyRemoveShadowDatabase,
  legacyShadowConnConfig,
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

interface ProvisionedMigrationsShadow extends LegacyPgDeltaNextMigrationsShadow {
  readonly snapshotKey: string | undefined;
}

interface ProvisionedDeclarativeShadow {
  readonly declarativeUrl: string;
  readonly restoredFromPgDataSnapshot: boolean;
  readonly snapshotKey: string | undefined;
}

/**
 * Bypass pg-delta's same-database guard when both shadows share one snapshot
 * key and the declarative side was restored from that tar. A cold-exported
 * migrations handle is still that tar's lineage.
 */
export function legacyAllowSameDatabaseIdentityForPlanShadows(opts: {
  readonly declarativeRestoredFromPgDataSnapshot: boolean;
  readonly sameSnapshotKey: boolean;
}): boolean {
  return opts.declarativeRestoredFromPgDataSnapshot && opts.sameSnapshotKey;
}

const setupRunInput = (input: NativeShadowInput, handle: LegacyShadowAcquiredHandle) => ({
  fs: input.base.fs,
  path: input.base.path,
  workdir: input.base.workdir,
  projectId: input.base.projectId,
  container: handle.containerId,
  networkId: input.base.networkId,
  connConfig: legacyShadowConnConfig(input.base),
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
        // One JWKS memo shared by every input built from this base: `provisionPlan`'s two
        // shadows must hash identical JWKS bytes or their snapshot keys can never match.
        return {
          localInputs: {
            ...localInputs,
            setup: { ...localInputs.setup, jwks: legacyMemoizeSuccess(localInputs.setup.jwks) },
          },
          image,
        } satisfies NativeShadowBase;
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
        legacyShadowConnConfig(input.base),
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
        // Baseline-handoff waits on `onBaselineSeam` before warm-restoring the declarative
        // shadow. A snapshot-cold handle reaches that seam when its export publishes the tar;
        // any other handle (warm-raced or uncached) never snapshots, so signal immediately.
        const seamWillRun = handle.snapshotRequired && !handle.baselinePresent;
        const seamHandle: LegacyShadowAcquiredHandle = seamWillRun
          ? {
              ...handle,
              snapshotBaseline: handle.snapshotBaseline.pipe(Effect.ensuring(onBaselineSeam)),
            }
          : handle;
        if (!seamWillRun) yield* onBaselineSeam;
        yield* awaitShadowReady(input, seamHandle);
        const setup = setupRunInput(input, seamHandle);
        yield* legacyMigrateNextShadowDatabase(input.spawner, setup, seamHandle);
        return {
          migrationsUrl: legacyToPostgresURL(setup.connConfig),
          snapshotKey: seamHandle.snapshotKey,
        } satisfies ProvisionedMigrationsShadow;
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
        return {
          declarativeUrl: legacyToPostgresURL(setup.connConfig),
          restoredFromPgDataSnapshot: handle.baselinePresent,
          snapshotKey: handle.snapshotKey,
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
      provisionPlan: (opts) =>
        Effect.gen(function* () {
          const migrationsPort = yield* nextPort();
          const declarativePort = yield* nextPort(migrationsPort);
          const built = yield* buildNativeBase(opts);
          const migrationsInput = buildNativeInput(opts, built, migrationsPort);
          const declarativeInput = buildNativeInput(opts, built, declarativePort);
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
          // Peeked inputs are reused only where the acquire follows the peek immediately: the
          // migrations acquire always does, the declarative one only under `parallel`. Delayed
          // declarative acquires (handoff / sequential) re-resolve so a mid-run `roles.sql`
          // edit cannot publish a baseline under a stale key. Identity still uses the acquired
          // handles' snapshot keys, so a delayed re-resolve cannot lie about lineage.
          const migrationsOpts = withPeek(cacheOpts(opts, "config"), migrationsPeek);
          const declarativeOpts =
            strategy === "parallel"
              ? withPeek(cacheOpts(opts, "disabled"), declarativePeek)
              : cacheOpts(opts, "disabled");

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
            allowSameDatabaseIdentity: legacyAllowSameDatabaseIdentityForPlanShadows({
              declarativeRestoredFromPgDataSnapshot: declarative.restoredFromPgDataSnapshot,
              sameSnapshotKey:
                migrations.snapshotKey !== undefined &&
                migrations.snapshotKey === declarative.snapshotKey,
            }),
          } satisfies LegacyPgDeltaNextPlanShadows;
        }).pipe(Effect.mapError(nextShadowError)),
    });
  }),
);
