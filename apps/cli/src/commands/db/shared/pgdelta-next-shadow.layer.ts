import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Net from "node:net";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  resolveDebugWithProjectEnv,
} from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { DockerRun } from "../../../command-internal/docker-run.service.ts";
import { toPostgresURL } from "../../../command-internal/postgres-url.ts";
import {
  buildLocalDbContainerInputs,
  type LocalDbContainerInputs,
} from "../../../command-internal/db-bootstrap/local-container-inputs.ts";
import { waitForShadowReady } from "../../../command-internal/db-bootstrap/health-check.ts";
import {
  acquireShadowDatabase,
  peekShadowBaseline,
  type ShadowAcquiredHandle,
  type ShadowBaselinePeek,
  type ShadowCacheOpts,
} from "../../../command-internal/db-bootstrap/shadow-cache.ts";
import {
  bufferedShadowOutput,
  resolvePlanShadowStrategy,
  runPlanShadowProvisions,
} from "./pgdelta-next-shadow.plan.ts";
import {
  memoizeSuccess,
  migrateNextShadowDatabase,
  removeShadowDatabase,
  shadowConnConfig,
  shadowRunInputFromLocalContainerInputs,
  setupShadowDatabase,
} from "../../../command-internal/db-bootstrap/shadow-database.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  PgDeltaNextShadow,
  type PgDeltaNextDeclarativeShadow,
  type PgDeltaNextMigrationsShadow,
  type PgDeltaNextPlanShadows,
  type PgDeltaNextShadowInput,
} from "./pgdelta-next-shadow.service.ts";
import { DeclarativeShadowDbError } from "./pgdelta.errors.ts";

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
  cause instanceof DeclarativeShadowDbError
    ? cause
    : new DeclarativeShadowDbError({
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
  readonly localInputs: LocalDbContainerInputs;
  readonly base: ReturnType<typeof shadowRunInputFromLocalContainerInputs>;
}

interface NativeShadowBase {
  readonly localInputs: LocalDbContainerInputs;
  readonly image: string;
}

interface ProvisionedMigrationsShadow extends PgDeltaNextMigrationsShadow {
  readonly snapshotKey: string | undefined;
}

interface ProvisionedDeclarativeShadow {
  readonly declarativeUrl: string;
  readonly restoredFromPgDataSnapshot: boolean;
  readonly snapshotKey: string | undefined;
}

/**
 * Bypass pg-delta's same-database guard when both shadows share one snapshot key and the
 * declarative side was restored from that tar — a cold-exported migrations handle is still
 * that tar's lineage.
 */
export function allowSameDatabaseIdentityForPlanShadows(opts: {
  readonly declarativeRestoredFromPgDataSnapshot: boolean;
  readonly sameSnapshotKey: boolean;
}): boolean {
  return opts.declarativeRestoredFromPgDataSnapshot && opts.sameSnapshotKey;
}

const setupRunInput = (input: NativeShadowInput, handle: ShadowAcquiredHandle) => ({
  fs: input.base.fs,
  path: input.base.path,
  workdir: input.base.workdir,
  projectId: input.base.projectId,
  container: handle.containerId,
  networkId: input.base.networkId,
  connConfig: shadowConnConfig(input.base),
  setup: input.base.setup,
});

/** Scoped, native TypeScript shadow orchestration for pg-delta next. */
export const pgDeltaNextShadowLayer = Layer.effect(
  PgDeltaNextShadow,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* NetworkIdFlag;
    const debugFlag = yield* DebugFlag;
    const experimentalFlag = yield* ExperimentalFlag;
    const cliArgs = yield* CliArgs;
    const output = yield* Output;
    const docker = yield* DockerRun;
    const dbConnection = yield* DbConnection;
    const httpClient = yield* HttpClient.HttpClient;

    const runtimeWith = (outputService: typeof Output.Service) =>
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, fs),
        Layer.succeed(Path.Path, path),
        Layer.succeed(DebugFlag, debugFlag),
        Layer.succeed(ExperimentalFlag, experimentalFlag),
        Layer.succeed(NetworkIdFlag, networkIdFlag),
        Layer.succeed(CliArgs, cliArgs),
        Layer.succeed(Output, outputService),
        Layer.succeed(RuntimeInfo, runtimeInfo),
        Layer.succeed(DockerRun, docker),
        Layer.succeed(DbConnection, dbConnection),
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
          new DeclarativeShadowDbError({
            message:
              excluded === undefined
                ? "failed to allocate a host port for pg-delta shadow database"
                : `failed to allocate a host port distinct from ${excluded}`,
          }),
        );
      });

    const buildNativeBase = (request: PgDeltaNextShadowInput) =>
      Effect.gen(function* () {
        const debug = yield* resolveDebugWithProjectEnv(request.toml.projectEnv);
        const localInputs = yield* buildLocalDbContainerInputs(
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
            setup: { ...localInputs.setup, jwks: memoizeSuccess(localInputs.setup.jwks) },
          },
          image,
        } satisfies NativeShadowBase;
      }).pipe(Effect.provide(runtime));

    const buildNativeInput = (
      request: PgDeltaNextShadowInput,
      built: NativeShadowBase,
      port: number,
    ): NativeShadowInput => ({
      spawner,
      localInputs: built.localInputs,
      base: shadowRunInputFromLocalContainerInputs(
        built.localInputs,
        built.image,
        { ...request.toml, shadowPort: port },
        fs,
        path,
      ),
    });

    /**
     * Cache-aware acquire, released when the current scope closes — next returns a URL the
     * engine keeps using after provision, so this cannot be `withShadowDatabase`
     * (that wrapper removes the container when `use` returns).
     */
    const acquireShadow = (input: NativeShadowInput, opts: ShadowCacheOpts) =>
      Effect.acquireRelease(acquireShadowDatabase(input.spawner, input.base, opts), (handle) =>
        removeShadowDatabase(input.spawner, handle.containerId).pipe(
          Effect.provideService(Output, output),
        ),
      );

    const awaitShadowReady = (input: NativeShadowInput, handle: ShadowAcquiredHandle) =>
      waitForShadowReady(input.spawner, handle.containerId, shadowConnConfig(input.base), {
        timeoutSeconds: input.base.healthTimeoutSeconds,
        image: input.base.image,
      });

    const provisionMigrations = (
      input: NativeShadowInput,
      opts: ShadowCacheOpts,
      onBaselineSeam: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input, opts);
        // Baseline-handoff waits on `onBaselineSeam` before warm-restoring the declarative
        // shadow. A snapshot-cold handle reaches that seam when its export publishes the tar;
        // any other handle (warm-raced or uncached) never snapshots, so signal immediately.
        const seamWillRun = handle.snapshotRequired && !handle.baselinePresent;
        const seamHandle: ShadowAcquiredHandle = seamWillRun
          ? {
              ...handle,
              snapshotBaseline: handle.snapshotBaseline.pipe(Effect.ensuring(onBaselineSeam)),
            }
          : handle;
        if (!seamWillRun) yield* onBaselineSeam;
        yield* awaitShadowReady(input, seamHandle);
        const setup = setupRunInput(input, seamHandle);
        yield* migrateNextShadowDatabase(input.spawner, setup, seamHandle);
        return {
          migrationsUrl: toPostgresURL(setup.connConfig),
          snapshotKey: seamHandle.snapshotKey,
        } satisfies ProvisionedMigrationsShadow;
      }).pipe(Effect.provide(runtime), Effect.mapError(nextShadowError));

    const provisionDeclarativeShadow = (
      input: NativeShadowInput,
      opts: ShadowCacheOpts,
      outputService: typeof Output.Service = output,
    ) =>
      Effect.gen(function* () {
        const handle = yield* acquireShadow(input, opts);
        yield* awaitShadowReady(input, handle);
        const setup = setupRunInput(input, handle);
        yield* setupShadowDatabase(input.spawner, setup, { webhooks: "disabled" }, handle);
        return {
          declarativeUrl: toPostgresURL(setup.connConfig),
          restoredFromPgDataSnapshot: handle.baselinePresent,
          snapshotKey: handle.snapshotKey,
        } satisfies ProvisionedDeclarativeShadow;
      }).pipe(Effect.provide(runtimeWith(outputService)), Effect.mapError(nextShadowError));

    const cacheOpts = (
      opts: PgDeltaNextShadowInput,
      webhooks: NonNullable<ShadowCacheOpts["webhooks"]>,
    ): ShadowCacheOpts => ({
      webhooks,
      ...(opts.bypassCache === true ? { bypassCache: true } : {}),
    });

    return PgDeltaNextShadow.of({
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
          return yield* provisionDeclarativeShadow(input, cacheOpts(opts, "disabled"));
        }).pipe(
          Effect.map(
            ({ declarativeUrl }) => ({ declarativeUrl }) satisfies PgDeltaNextDeclarativeShadow,
          ),
          Effect.mapError(nextShadowError),
        ),
      provisionPlan: (opts) =>
        Effect.gen(function* () {
          const migrationsPort = yield* nextPort();
          const declarativePort = yield* nextPort(migrationsPort);
          const built = yield* buildNativeBase(opts);
          const migrationsInput = buildNativeInput(opts, built, migrationsPort);
          const declarativeInput = buildNativeInput(opts, built, declarativePort);
          const [migrationsPeek, declarativePeek] = yield* Effect.all([
            peekShadowBaseline(migrationsInput.base, cacheOpts(opts, "config")),
            peekShadowBaseline(declarativeInput.base, cacheOpts(opts, "disabled")),
          ]);
          const withPeek = (cache: ShadowCacheOpts, peek: ShadowBaselinePeek): ShadowCacheOpts =>
            peek.state === "uncachable"
              ? cache
              : { ...cache, precomputedKeyInputs: peek.keyInputs };
          const strategy = resolvePlanShadowStrategy(migrationsPeek, declarativePeek);
          // Peeked inputs are reused only when acquire immediately follows peek: always for
          // migrations, only under `parallel` for declarative. Delayed declarative acquires
          // re-resolve so a mid-run `roles.sql` edit can't publish under a stale key — identity
          // still comes from the acquired handles' snapshot keys, so this can't lie about lineage.
          const migrationsOpts = withPeek(cacheOpts(opts, "config"), migrationsPeek);
          const declarativeOpts =
            strategy === "parallel"
              ? withPeek(cacheOpts(opts, "disabled"), declarativePeek)
              : cacheOpts(opts, "disabled");

          const buffered = strategy === "sequential" ? undefined : bufferedShadowOutput(output);
          const provisions = runPlanShadowProvisions({
            strategy,
            provisionMigrations: (onBaselineSeam) =>
              provisionMigrations(migrationsInput, migrationsOpts, onBaselineSeam),
            provisionDeclarative: provisionDeclarativeShadow(
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
            allowSameDatabaseIdentity: allowSameDatabaseIdentityForPlanShadows({
              declarativeRestoredFromPgDataSnapshot: declarative.restoredFromPgDataSnapshot,
              sameSnapshotKey:
                migrations.snapshotKey !== undefined &&
                migrations.snapshotKey === declarative.snapshotKey,
            }),
          } satisfies PgDeltaNextPlanShadows;
        }).pipe(Effect.mapError(nextShadowError)),
    });
  }),
);
