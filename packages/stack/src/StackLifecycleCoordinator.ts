import { LogBuffer, Orchestrator } from "@supabase/process-compose";
import { ServiceNotFoundError } from "@supabase/process-compose";
import type { LogEntry, ServiceReadyError } from "@supabase/process-compose";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  ServiceMap,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { cleanupLocalStackResources } from "./cleanup.ts";
import { StackBuildError } from "./errors.ts";
import { configureFunctionsRuntime, type FunctionsConfig } from "./functions.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import { StackMetadataPersistence } from "./StackMetadataPersistence.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { PreparedStackArtifacts } from "./StackPreparation.ts";
import {
  enabledServicesForConfig,
  StackBuilder,
  validateResolvedConfig,
  versionsForConfig,
  type ResolvedStackConfig,
} from "./StackBuilder.ts";
import { changedProjectedStates, projectStackStates } from "./StackStateProjection.ts";
import { StackServiceState } from "./StackServiceState.ts";
import type { EdgeRuntimeReloadConfig, StackInfo } from "./Stack.ts";

type LifecyclePhase =
  | "idle"
  | "preparing"
  | "prepared"
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

interface RuntimeState {
  readonly orchestrator: Orchestrator["Service"];
  readonly cleanupTargets: CleanupTargets;
}

const sameState = (a: StackServiceState | undefined, b: StackServiceState): boolean =>
  a?.name === b.name &&
  a.status === b.status &&
  a.pid === b.pid &&
  a.exitCode === b.exitCode &&
  a.restartCount === b.restartCount &&
  a.startedAt === b.startedAt &&
  a.error === b.error;

const initialPublicStates = (config: ResolvedStackConfig): ReadonlyArray<StackServiceState> =>
  enabledServicesForConfig(config).map(
    (name) =>
      new StackServiceState({
        name,
        status: "Pending",
        pid: null,
        exitCode: null,
        restartCount: 0,
        startedAt: null,
        error: null,
      }),
  );

const stackInfoFor = (config: ResolvedStackConfig): StackInfo => ({
  url: `http://127.0.0.1:${config.apiPort}`,
  dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
  publishableKey: config.publishableKey,
  secretKey: config.secretKey,
  anonJwt: config.anonJwt,
  serviceRoleJwt: config.serviceRoleJwt,
  serviceEndpoints: {
    ...(config.auth === false ? {} : { auth: `http://127.0.0.1:${config.auth.port}` }),
    ...(config.postgrest === false
      ? {}
      : { postgrest: `http://127.0.0.1:${config.postgrest.port}` }),
    ...(config.edgeRuntime === false
      ? {}
      : {
          functions: `http://127.0.0.1:${config.apiPort}/functions/v1`,
          edge_runtime: `http://127.0.0.1:${config.edgeRuntime.port}`,
        }),
    ...(config.realtime === false ? {} : { realtime: `http://127.0.0.1:${config.realtime.port}` }),
    ...(config.storage === false
      ? {}
      : {
          storage: `http://127.0.0.1:${config.storage.port}`,
          storage_s3: `http://127.0.0.1:${config.apiPort}/storage/v1/s3`,
        }),
    ...(config.imgproxy === false ? {} : { imgproxy: `http://127.0.0.1:${config.imgproxy.port}` }),
    ...(config.mailpit === false
      ? {}
      : {
          mailpit: `http://127.0.0.1:${config.mailpit.port}`,
          mailpit_smtp: `smtp://127.0.0.1:${config.mailpit.smtpPort}`,
          mailpit_pop3: `pop3://127.0.0.1:${config.mailpit.pop3Port}`,
        }),
    ...(config.pgmeta === false ? {} : { pgmeta: `http://127.0.0.1:${config.pgmeta.port}` }),
    ...(config.studio === false ? {} : { studio: `http://127.0.0.1:${config.studio.port}` }),
    ...(config.analytics === false
      ? {}
      : { analytics: `http://127.0.0.1:${config.analytics.port}` }),
    ...(config.pooler === false
      ? {}
      : {
          pooler: `postgresql://postgres:postgres@127.0.0.1:${config.pooler.port}/postgres`,
          pooler_admin: `http://127.0.0.1:${config.pooler.apiPort}`,
        }),
  },
});

const changedStatesBetween = (
  previous: ReadonlyArray<StackServiceState> | undefined,
  current: ReadonlyArray<StackServiceState>,
): ReadonlyArray<StackServiceState> => {
  if (previous === undefined) {
    return current;
  }

  const previousByName = new Map(previous.map((state) => [state.name, state] as const));
  return current.filter((state) => !sameState(previousByName.get(state.name), state));
};

export class StackLifecycleCoordinator extends ServiceMap.Service<
  StackLifecycleCoordinator,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly getCleanupTargets: () => Effect.Effect<CleanupTargets>;
    readonly start: () => Effect.Effect<void, ServiceReadyError | StackBuildError>;
    readonly stop: () => Effect.Effect<void>;
    readonly dispose: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly stopService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly reloadFunctions: (
      opts?: FunctionsConfig,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly reloadEdgeRuntime: (
      opts: EdgeRuntimeReloadConfig,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly getState: (name: string) => Effect.Effect<StackServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<StackServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<StackServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<StackServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError | StackBuildError>;
    readonly subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
    readonly subscribeAllLogs: (services?: ReadonlyArray<string>) => Stream.Stream<LogEntry>;
    readonly logHistory: (name: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly logHistoryAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LogEntry>>;
  }
>()("stack/StackLifecycleCoordinator") {
  static layer = (
    config: ResolvedStackConfig,
  ): Layer.Layer<
    StackLifecycleCoordinator,
    StackBuildError,
    | StackBuilder
    | StackPreparation
    | ChildProcessSpawner.ChildProcessSpawner
    | StackMetadataPersistence
    | FileSystem.FileSystem
    | Path.Path
  > =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const builder = yield* StackBuilder;
        const preparation = yield* StackPreparation;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const metadataPersistence = yield* StackMetadataPersistence;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scope = yield* Effect.scope;

        const info = stackInfoFor(config);
        const stateRef = yield* SubscriptionRef.make(initialPublicStates(config));
        const phaseRef = yield* Ref.make<LifecyclePhase>("idle");

        const logBufferServices = yield* Layer.buildWithScope(LogBuffer.layer, scope);
        const logBuffer = ServiceMap.get(logBufferServices, LogBuffer);

        const updateState = (nextState: StackServiceState) =>
          SubscriptionRef.update(stateRef, (current) => {
            const previous = current.find((entry) => entry.name === nextState.name);
            if (sameState(previous, nextState)) {
              return current;
            }
            return current.some((entry) => entry.name === nextState.name)
              ? current.map((entry) => (entry.name === nextState.name ? nextState : entry))
              : [...current, nextState];
          });

        const requireKnownService = (name: string) =>
          Effect.gen(function* () {
            const currentStates = SubscriptionRef.getUnsafe(stateRef);
            const match = currentStates.find((state) => state.name === name);
            if (match === undefined) {
              return yield* Effect.fail(new ServiceNotFoundError({ name }));
            }
            return match;
          });

        let preparedArtifacts: PreparedStackArtifacts | undefined;
        let prepareDeferred: Deferred.Deferred<PreparedStackArtifacts, StackBuildError> | undefined;
        let runtimeState: RuntimeState | undefined;
        let runtimeDeferred: Deferred.Deferred<RuntimeState, StackBuildError> | undefined;

        const ensurePrepared = Effect.suspend(() => {
          if (preparedArtifacts !== undefined) {
            return Effect.succeed(preparedArtifacts);
          }
          if (prepareDeferred !== undefined) {
            return Deferred.await(prepareDeferred);
          }

          const deferred = Deferred.makeUnsafe<PreparedStackArtifacts, StackBuildError>();
          prepareDeferred = deferred;

          const effect = Effect.gen(function* () {
            yield* validateResolvedConfig(config);
            yield* Ref.set(phaseRef, "preparing");

            let prepared: PreparedStackArtifacts | undefined;
            yield* preparation
              .prepareEvents({
                mode: config.mode,
                services: enabledServicesForConfig(config),
                versions: versionsForConfig(config),
              })
              .pipe(
                Stream.mapError(
                  (cause) =>
                    new StackBuildError({
                      detail: "Failed to prepare stack assets",
                      cause,
                    }),
                ),
              )
              .pipe(
                Stream.runForEach((event) => {
                  switch (event._tag) {
                    case "ServiceDownloadStarted":
                      return updateState(
                        new StackServiceState({
                          name: event.service,
                          status: "Downloading",
                          pid: null,
                          exitCode: null,
                          restartCount: 0,
                          startedAt: null,
                          error: null,
                        }),
                      );
                    case "ServiceDownloadFinished":
                      return updateState(
                        new StackServiceState({
                          name: event.service,
                          status: "Pending",
                          pid: null,
                          exitCode: null,
                          restartCount: 0,
                          startedAt: null,
                          error: null,
                        }),
                      );
                    case "PreparationCompleted":
                      return Effect.sync(() => {
                        prepared = event.artifacts;
                      });
                  }
                }),
              );

            if (prepared === undefined) {
              return yield* Effect.fail(
                new StackBuildError({
                  detail: "Stack preparation completed without prepared artifacts",
                }),
              );
            }

            yield* Ref.set(phaseRef, "prepared");
            return prepared;
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                preparedArtifacts = value;
              }),
            ),
            Effect.onError(() => Ref.set(phaseRef, "idle")),
            Effect.ensuring(
              Effect.sync(() => {
                prepareDeferred = undefined;
              }),
            ),
          );

          return Effect.gen(function* () {
            yield* Effect.forkIn(effect.pipe(Deferred.into(deferred)), scope);
            return yield* Deferred.await(deferred);
          });
        });

        const ensureRuntime = Effect.suspend(() => {
          if (runtimeState !== undefined) {
            return Effect.succeed(runtimeState);
          }
          if (runtimeDeferred !== undefined) {
            return Deferred.await(runtimeDeferred);
          }

          const deferred = Deferred.makeUnsafe<RuntimeState, StackBuildError>();
          runtimeDeferred = deferred;

          const effect = Effect.gen(function* () {
            const prepared = yield* ensurePrepared;
            const { graph, serviceProjection, cleanupTargets } = yield* builder.build(
              config,
              prepared,
            );

            yield* metadataPersistence.persistCleanupTargets(cleanupTargets);

            const orchLayer = Orchestrator.layer(graph).pipe(
              Layer.provide(Layer.succeed(LogBuffer, logBuffer)),
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
            );
            const orchServices = yield* Layer.buildWithScope(orchLayer, scope);
            const orchestrator = ServiceMap.get(orchServices, Orchestrator);

            const projectedStates = Stream.unwrap(
              Effect.gen(function* () {
                const rawInitialStates = yield* orchestrator.getAllStates();
                const initialProjected = projectStackStates(rawInitialStates, serviceProjection);
                let rawStates = new Map(
                  rawInitialStates.map((state) => [state.name, state] as const),
                );
                let projectedByName = new Map(
                  initialProjected.map((state) => [state.name, state] as const),
                );

                return Stream.concat(
                  Stream.fromIterable(initialProjected),
                  orchestrator.allStateChanges().pipe(
                    Stream.map((rawState) => {
                      rawStates.set(rawState.name, rawState);
                      const nextProjected = projectStackStates(
                        [...rawStates.values()],
                        serviceProjection,
                      );
                      const changed = changedProjectedStates(projectedByName, nextProjected);
                      projectedByName = new Map(
                        nextProjected.map((state) => [state.name, state] as const),
                      );
                      return changed;
                    }),
                    Stream.flatMap((states) => Stream.fromIterable(states)),
                  ),
                );
              }),
            );

            yield* projectedStates.pipe(
              Stream.runForEach((state) => updateState(state)),
              Effect.ignore,
              Effect.forkIn(scope),
            );

            return {
              orchestrator,
              cleanupTargets,
            } satisfies RuntimeState;
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                runtimeState = value;
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                runtimeDeferred = undefined;
              }),
            ),
          );

          return Effect.gen(function* () {
            yield* Effect.forkIn(effect.pipe(Deferred.into(deferred)), scope);
            return yield* Deferred.await(deferred);
          });
        });

        let disposed = false;
        const runtimeHost = Effect.gen(function* () {
          const prepared = yield* ensurePrepared;
          const platform = yield* detectPlatform;
          const edgeRuntimeResolution = prepared.resolutions["edge-runtime"];
          return {
            hostname:
              edgeRuntimeResolution?.type === "docker"
                ? dockerHostAddress(platform.os)
                : "127.0.0.1",
          };
        });
        const providePlatform = <A, E>(
          effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        const configureFunctions = (
          nextConfig: ResolvedStackConfig,
        ): Effect.Effect<void, StackBuildError> =>
          Effect.gen(function* () {
            yield* providePlatform(configureFunctionsRuntime(nextConfig, yield* runtimeHost));
          }).pipe(
            Effect.mapError(
              (cause) =>
                new StackBuildError({
                  detail: "Failed to configure Edge Functions",
                  cause,
                }),
            ),
          );
        const configWithFunctionOptions = (opts?: FunctionsConfig): ResolvedStackConfig => {
          if (opts === undefined) {
            return config;
          }
          const base = config.functions === false ? { noVerifyJwt: false } : config.functions;
          return {
            ...config,
            functions: {
              envFile: opts.envFile ?? base.envFile,
              noVerifyJwt: opts.noVerifyJwt ?? base.noVerifyJwt,
            },
          };
        };
        const configWithEdgeRuntimeOptions = (
          opts: EdgeRuntimeReloadConfig,
        ): Effect.Effect<ResolvedStackConfig, ServiceNotFoundError> =>
          Effect.gen(function* () {
            if (config.edgeRuntime === false || opts.edgeRuntime.enabled === false) {
              return yield* Effect.fail(new ServiceNotFoundError({ name: "edge-runtime" }));
            }

            const base = configWithFunctionOptions(opts.functions);
            return {
              ...base,
              edgeRuntime: {
                ...config.edgeRuntime,
                enabled: opts.edgeRuntime.enabled ?? config.edgeRuntime.enabled,
                inspectorPort: opts.edgeRuntime.inspectorPort ?? config.edgeRuntime.inspectorPort,
                policy: opts.edgeRuntime.policy ?? config.edgeRuntime.policy,
                env: opts.edgeRuntime.env ?? config.edgeRuntime.env,
              },
            };
          });
        const allStateChanges = () =>
          SubscriptionRef.changes(stateRef).pipe(
            Stream.mapAccum<
              ReadonlyArray<StackServiceState> | undefined,
              ReadonlyArray<StackServiceState>,
              StackServiceState
            >(
              () => undefined,
              (previous, current) => [current, changedStatesBetween(previous, current)],
            ),
          );
        const disposeOnce = () =>
          Effect.gen(function* () {
            if (disposed) {
              return;
            }
            disposed = true;
            yield* cleanupLocalStackResources({
              stop: () =>
                runtimeState === undefined ? Effect.void : runtimeState.orchestrator.stop(),
              cleanupTargets: runtimeState?.cleanupTargets ?? { dockerContainerNames: [] },
              config,
            });
          });

        yield* Effect.addFinalizer(disposeOnce);

        return {
          getInfo: () => Effect.succeed(info),
          getCleanupTargets: () =>
            Effect.succeed(runtimeState?.cleanupTargets ?? { dockerContainerNames: [] }),
          start: () =>
            Effect.gen(function* () {
              yield* Ref.set(phaseRef, "starting");
              const runtime = yield* ensureRuntime;
              yield* configureFunctions(config);
              yield* runtime.orchestrator.start();
              yield* runtime.orchestrator.waitAllReady();
              yield* Ref.set(phaseRef, "running");
            }),
          stop: () =>
            Effect.gen(function* () {
              if (runtimeState === undefined) {
                yield* Ref.set(phaseRef, "stopped");
                return;
              }
              yield* Ref.set(phaseRef, "stopping");
              yield* runtimeState.orchestrator.stop();
              yield* Ref.set(phaseRef, "stopped");
            }),
          dispose: disposeOnce,
          startService: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.startService(name);
              yield* runtime.orchestrator.waitReady(name);
            }),
          stopService: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.stopService(name);
            }),
          restartService: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.restartService(name);
            }),
          reloadFunctions: (opts) =>
            Effect.gen(function* () {
              yield* requireKnownService("edge-runtime");
              const runtime = yield* ensureRuntime;
              yield* configureFunctions(configWithFunctionOptions(opts));
              yield* runtime.orchestrator.restartService("edge-runtime");
              yield* runtime.orchestrator.waitReady("edge-runtime");
            }),
          reloadEdgeRuntime: (opts) =>
            Effect.gen(function* () {
              yield* requireKnownService("edge-runtime");
              const nextConfig = yield* configWithEdgeRuntimeOptions(opts);
              const prepared = yield* ensurePrepared;
              const runtime = yield* ensureRuntime;
              const buildResult = yield* builder.build(nextConfig, prepared);
              const edgeRuntimeDef = buildResult.graph.startOrder.find(
                (def) => def.name === "edge-runtime",
              );

              if (edgeRuntimeDef === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name: "edge-runtime" }));
              }

              yield* configureFunctions(nextConfig);
              yield* runtime.orchestrator
                .updateServiceDefinition("edge-runtime", edgeRuntimeDef)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new StackBuildError({
                        detail: "Failed to update edge-runtime service definition",
                        cause,
                      }),
                  ),
                );
              yield* runtime.orchestrator.restartService("edge-runtime");
              yield* runtime.orchestrator.waitReady("edge-runtime");
            }),
          getState: (name) =>
            Effect.gen(function* () {
              const currentStates = SubscriptionRef.getUnsafe(stateRef);
              const match = currentStates.find((state) => state.name === name);
              if (match === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              return match;
            }),
          getAllStates: () => Effect.sync(() => SubscriptionRef.getUnsafe(stateRef)),
          stateChanges: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              return Stream.filter(allStateChanges(), (state) => state.name === name);
            }),
          allStateChanges,
          waitReady: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.waitReady(name);
            }),
          waitAllReady: () =>
            Effect.gen(function* () {
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.waitAllReady();
            }),
          subscribeLogs: (name) => logBuffer.subscribe(name),
          subscribeAllLogs: (services) =>
            services === undefined || services.length === 0
              ? logBuffer.subscribeAll()
              : logBuffer
                  .subscribeAll()
                  .pipe(Stream.filter((entry) => services.includes(entry.service))),
          logHistory: (name, limit) => logBuffer.history(name, limit),
          logHistoryAll: (limit, services) => logBuffer.historyAll(limit, services),
        };
      }),
    );
}
