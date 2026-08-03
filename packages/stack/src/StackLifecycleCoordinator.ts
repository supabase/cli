import { LogBuffer, Orchestrator } from "@supabase/process-compose";
import { ServiceNotFoundError } from "@supabase/process-compose";
import type { LogEntry, ResolvedGraph, ServiceReadyError } from "@supabase/process-compose";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Semaphore,
  Context,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { cleanupLocalStackResources } from "./cleanup.ts";
import { StackBuildError, StackNotRunningError } from "./errors.ts";
import { configureFunctionsRuntime, type FunctionsConfig } from "./functions.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import type { PortLease } from "./PortAllocator.ts";
import {
  activationTargetsForService,
  eagerServices,
  lifecycleTargetsForService,
} from "./ServiceActivation.ts";
import { portFieldsForService } from "./ServicePorts.ts";
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
import { SERVICE_NAMES, type ServiceName } from "./versions.ts";

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
  readonly graph: ResolvedGraph;
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

const stackInfoFor = (config: ResolvedStackConfig): StackInfo => {
  const apiUrl = `http://127.0.0.1:${config.apiPort}`;
  return {
    url: apiUrl,
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
    serviceEndpoints: {
      ...(config.auth === false ? {} : { auth: `${apiUrl}/auth/v1` }),
      ...(config.postgrest === false ? {} : { postgrest: `${apiUrl}/rest/v1` }),
      ...(config.edgeRuntime === false
        ? {}
        : {
            functions: `${apiUrl}/functions/v1`,
            edge_runtime: `${apiUrl}/functions/v1`,
          }),
      ...(config.realtime === false ? {} : { realtime: `${apiUrl}/realtime/v1` }),
      ...(config.storage === false
        ? {}
        : {
            storage: `${apiUrl}/storage/v1`,
            storage_s3: `${apiUrl}/storage/v1/s3`,
          }),
      ...(config.imgproxy === false || config.startupMode === "lazy"
        ? {}
        : { imgproxy: `http://127.0.0.1:${config.imgproxy.port}` }),
      ...(config.mailpit === false
        ? {}
        : {
            mailpit: `http://127.0.0.1:${config.mailpit.port}`,
            mailpit_smtp: `smtp://127.0.0.1:${config.mailpit.smtpPort}`,
            mailpit_pop3: `pop3://127.0.0.1:${config.mailpit.pop3Port}`,
          }),
      ...(config.pgmeta === false ? {} : { pgmeta: `${apiUrl}/pg` }),
      ...(config.studio === false ? {} : { studio: `http://127.0.0.1:${config.studio.port}` }),
      ...(config.analytics === false ? {} : { analytics: `${apiUrl}/analytics/v1` }),
      ...(config.pooler === false
        ? {}
        : {
            pooler: `postgresql://postgres:postgres@127.0.0.1:${config.pooler.port}/postgres`,
            pooler_admin: `http://127.0.0.1:${config.pooler.apiPort}`,
          }),
    },
  };
};

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

export class StackLifecycleCoordinator extends Context.Service<
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
    readonly activateService: (
      name: ServiceName,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackNotRunningError
    >;
    readonly stopService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
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
    portLease: PortLease,
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
        const enabledServices = enabledServicesForConfig(config);
        const stateRef = yield* SubscriptionRef.make(initialPublicStates(config));
        const phaseRef = yield* Ref.make<LifecyclePhase>("idle");
        const activatedServices = new Set<ServiceName>();
        const manuallyStoppedServices = new Set<ServiceName>();
        const restartIntents = new Set<ServiceName>();
        const lifecycleLock = Semaphore.makeUnsafe(1);
        const activationLocks = new Map(
          SERVICE_NAMES.map((service) => [service, Semaphore.makeUnsafe(1)] as const),
        );

        const logBufferServices = yield* Layer.buildWithScope(LogBuffer.layer, scope);
        const logBuffer = Context.get(logBufferServices, LogBuffer);

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
        const requireKnownServiceName = (
          name: string,
        ): Effect.Effect<ServiceName, ServiceNotFoundError> =>
          Effect.gen(function* () {
            yield* requireKnownService(name);
            const service = SERVICE_NAMES.find((candidate) => candidate === name);
            if (service === undefined) {
              return yield* Effect.fail(new ServiceNotFoundError({ name }));
            }
            return service;
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

            yield* metadataPersistence.persistCleanupTargets(cleanupTargets).pipe(
              Effect.mapError(
                (cause) =>
                  new StackBuildError({
                    detail: "Failed to persist stack cleanup metadata",
                    cause,
                  }),
              ),
            );

            const orchLayer = Orchestrator.layer(graph).pipe(
              Layer.provide(Layer.succeed(LogBuffer, logBuffer)),
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
            );
            const orchServices = yield* Layer.buildWithScope(orchLayer, scope);
            const orchestrator = Context.get(orchServices, Orchestrator);

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
              graph,
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
        const publicServiceClosure = (
          runtime: RuntimeState,
          services: ReadonlyArray<ServiceName>,
        ): ReadonlyArray<ServiceName> => {
          const closure = new Set<ServiceName>();
          for (const service of services) {
            for (const definition of runtime.graph.startOrderFor(service)) {
              const publicName = SERVICE_NAMES.find((candidate) => candidate === definition.name);
              if (publicName !== undefined) closure.add(publicName);
            }
          }
          return SERVICE_NAMES.filter((service) => closure.has(service));
        };
        const withActivationLocks = <A, E, R>(
          services: ReadonlyArray<ServiceName>,
          effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
          SERVICE_NAMES.filter((service) => services.includes(service)).reduceRight(
            (current, service) => {
              const lock = activationLocks.get(service);
              return lock === undefined ? current : lock.withPermit(current);
            },
            effect,
          );
        const withLifecycleLock = lifecycleLock.withPermit;
        const serviceStartOptions = {
          beforeSpawn: (name: string) => portLease.release(portFieldsForService(name)),
        };
        const startServices = <E, R>(
          services: ReadonlyArray<ServiceName>,
          beforeStart: Effect.Effect<void, E, R>,
          serializeActivation = false,
        ) =>
          Effect.gen(function* () {
            const runtime = yield* ensureRuntime;
            const closure = publicServiceClosure(runtime, services);
            const inactiveClosure = closure.filter((service) => !activatedServices.has(service));
            const beginActivation = withActivationLocks(
              inactiveClosure,
              Effect.gen(function* () {
                yield* beforeStart;
                const inactiveServices = services.filter(
                  (service) => !activatedServices.has(service),
                );
                if (inactiveServices.length === 0) {
                  return [];
                }
                const inactiveServiceClosure = publicServiceClosure(
                  runtime,
                  inactiveServices,
                ).filter((service) => !activatedServices.has(service));
                const explicitlyStoppedDependency = inactiveServiceClosure.find((service) =>
                  manuallyStoppedServices.has(service),
                );
                if (explicitlyStoppedDependency !== undefined) {
                  return yield* Effect.fail(
                    new StackBuildError({
                      detail: `Cannot activate a service whose dependency ${explicitlyStoppedDependency} was explicitly stopped`,
                    }),
                  );
                }
                for (const service of inactiveServiceClosure) {
                  activatedServices.add(service);
                }
                yield* Effect.forEach(
                  inactiveServices,
                  (service) =>
                    runtime.orchestrator.startService(service, serviceStartOptions).pipe(
                      Effect.mapError(
                        (cause) =>
                          new StackBuildError({
                            detail: `Prepared graph does not contain enabled service ${service}`,
                            cause,
                          }),
                      ),
                    ),
                  { discard: true },
                ).pipe(
                  Effect.onError(() =>
                    Effect.sync(() => {
                      for (const service of inactiveServiceClosure) {
                        activatedServices.delete(service);
                      }
                    }),
                  ),
                );
                return inactiveServiceClosure;
              }),
            );
            const newlyActivated = yield* serializeActivation
              ? beginActivation.pipe(withLifecycleLock)
              : beginActivation;
            const waitKnownReady = (service: ServiceName) =>
              runtime.orchestrator.waitReady(service).pipe(
                Effect.catchTag("ServiceNotFoundError", (cause) =>
                  Effect.fail(
                    new StackBuildError({
                      detail: `Prepared graph does not contain enabled service ${service}`,
                      cause,
                    }),
                  ),
                ),
              );
            yield* Effect.forEach(services, waitKnownReady, {
              concurrency: "unbounded",
              discard: true,
            }).pipe(
              Effect.onError(() =>
                withActivationLocks(
                  newlyActivated,
                  Effect.sync(() => {
                    for (const service of newlyActivated) {
                      activatedServices.delete(service);
                    }
                  }),
                ),
              ),
            );
          });
        const requireRunningPhase = Effect.gen(function* () {
          const phase = yield* Ref.get(phaseRef);
          if (phase !== "running") {
            return yield* Effect.fail(new StackNotRunningError({ phase }));
          }
        });
        const disposeOnce = () =>
          Effect.gen(function* () {
            if (disposed) {
              return;
            }
            disposed = true;
            yield* Ref.set(phaseRef, "stopping");
            yield* cleanupLocalStackResources({
              stop: () =>
                runtimeState === undefined ? Effect.void : runtimeState.orchestrator.stop(),
              cleanupTargets: runtimeState?.cleanupTargets ?? { dockerContainerNames: [] },
              config,
            }).pipe(
              Effect.ensuring(portLease.releaseAll),
              Effect.ensuring(Ref.set(phaseRef, "stopped")),
            );
          }).pipe(withLifecycleLock);

        yield* Effect.addFinalizer(disposeOnce);

        return {
          getInfo: () => Effect.succeed(info),
          getCleanupTargets: () =>
            Effect.succeed(runtimeState?.cleanupTargets ?? { dockerContainerNames: [] }),
          start: () =>
            Effect.gen(function* () {
              yield* Ref.set(phaseRef, "starting");
              activatedServices.clear();
              manuallyStoppedServices.clear();
              restartIntents.clear();
              const runtime = yield* ensureRuntime;
              yield* configureFunctions(config);
              if (config.startupMode === "lazy") {
                yield* SubscriptionRef.update(stateRef, (states) =>
                  states.map(
                    (state) =>
                      new StackServiceState({
                        name: state.name,
                        status: "Pending",
                        pid: null,
                        exitCode: null,
                        restartCount: 0,
                        startedAt: null,
                        error: null,
                      }),
                  ),
                );
                const eagerTargets = new Set<ServiceName>();
                for (const service of eagerServices(enabledServices)) {
                  for (const target of activationTargetsForService(enabledServices, service)) {
                    eagerTargets.add(target);
                  }
                }
                yield* startServices(
                  SERVICE_NAMES.filter((service) => eagerTargets.has(service)),
                  Effect.void,
                );
                const postgresInitStartedByEagerService = [...eagerTargets].some((service) =>
                  runtime.graph
                    .startOrderFor(service)
                    .some((definition) => definition.name === "postgres-init"),
                );
                if (
                  runtime.graph.startOrder.some((definition) => definition.name === "postgres-init")
                ) {
                  if (!postgresInitStartedByEagerService) {
                    yield* runtime.orchestrator
                      .startService("postgres-init", serviceStartOptions)
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new StackBuildError({
                              detail: "Prepared graph does not contain postgres-init",
                              cause,
                            }),
                        ),
                      );
                  }
                  yield* runtime.orchestrator.waitReady("postgres-init").pipe(
                    Effect.catchTag("ServiceNotFoundError", (cause) =>
                      Effect.fail(
                        new StackBuildError({
                          detail: "Prepared graph does not contain postgres-init",
                          cause,
                        }),
                      ),
                    ),
                  );
                }
              } else {
                for (const service of enabledServices) {
                  activatedServices.add(service);
                }
                yield* runtime.orchestrator.start(serviceStartOptions);
                yield* runtime.orchestrator.waitAllReady();
              }
              yield* Ref.set(phaseRef, "running");
            }).pipe(
              Effect.onError(() => Ref.set(phaseRef, "stopped")),
              withLifecycleLock,
            ),
          stop: () =>
            Effect.gen(function* () {
              if (runtimeState === undefined) {
                yield* Ref.set(phaseRef, "stopped");
                return;
              }
              yield* Ref.set(phaseRef, "stopping");
              yield* withActivationLocks(SERVICE_NAMES, runtimeState.orchestrator.stop());
              yield* Ref.set(phaseRef, "stopped");
            }).pipe(withLifecycleLock),
          dispose: disposeOnce,
          startService: (name) =>
            Effect.gen(function* () {
              const service = yield* requireKnownServiceName(name);
              const targets = activationTargetsForService(enabledServices, service);
              for (const target of targets) {
                manuallyStoppedServices.delete(target);
                activatedServices.delete(target);
              }
              yield* startServices(targets, Effect.void);
            }).pipe(withLifecycleLock),
          activateService: (name) =>
            Effect.gen(function* () {
              // Reject requests immediately while start/stop owns the lifecycle
              // lock, then check again after acquiring it to close the race.
              yield* requireRunningPhase;
              const service = yield* requireKnownServiceName(name);
              yield* startServices(
                activationTargetsForService(enabledServices, service),
                requireRunningPhase,
                true,
              );
            }),
          stopService: (name) =>
            Effect.gen(function* () {
              const service = yield* requireKnownServiceName(name);
              const runtime = yield* ensureRuntime;
              const targets = lifecycleTargetsForService(enabledServices, service);
              yield* withActivationLocks(
                targets,
                Effect.gen(function* () {
                  yield* Effect.forEach(
                    targets.toReversed(),
                    (target) => runtime.orchestrator.stopService(target),
                    { discard: true },
                  );
                  for (const target of targets) {
                    manuallyStoppedServices.add(target);
                    for (const activated of activatedServices) {
                      if (
                        runtime.graph
                          .startOrderFor(activated)
                          .some((definition) => definition.name === target)
                      ) {
                        restartIntents.add(activated);
                        activatedServices.delete(activated);
                      }
                    }
                  }
                }),
              );
            }).pipe(withLifecycleLock),
          restartService: (name) =>
            Effect.gen(function* () {
              const service = yield* requireKnownServiceName(name);
              const runtime = yield* ensureRuntime;
              const companionTargets = lifecycleTargetsForService(enabledServices, service);
              const interruptedTargets = SERVICE_NAMES.filter(
                (candidate) =>
                  restartIntents.has(candidate) &&
                  companionTargets.some((target) =>
                    runtime.graph
                      .startOrderFor(candidate)
                      .some((definition) => definition.name === target),
                  ),
              );
              const restartRoots = companionTargets.filter(
                (candidate) =>
                  !companionTargets.some(
                    (other) =>
                      other !== candidate &&
                      runtime.graph
                        .startOrderFor(candidate)
                        .some((definition) => definition.name === other),
                  ),
              );
              const affected = new Set<ServiceName>([...companionTargets, ...interruptedTargets]);
              for (const activated of activatedServices) {
                if (
                  companionTargets.some((target) =>
                    runtime.graph
                      .startOrderFor(activated)
                      .some((definition) => definition.name === target),
                  )
                ) {
                  affected.add(activated);
                }
              }
              const lockTargets = SERVICE_NAMES.filter((candidate) => affected.has(candidate));
              const restoreTargets = lockTargets.filter(
                (candidate) =>
                  companionTargets.includes(candidate) ||
                  activatedServices.has(candidate) ||
                  restartIntents.has(candidate),
              );
              yield* withActivationLocks(
                lockTargets,
                Effect.gen(function* () {
                  for (const target of lockTargets) {
                    activatedServices.delete(target);
                  }
                  for (const target of companionTargets) {
                    manuallyStoppedServices.delete(target);
                  }
                  for (const target of restoreTargets) {
                    restartIntents.delete(target);
                  }
                  for (const root of restartRoots) {
                    yield* runtime.orchestrator.restartService(root, serviceStartOptions);
                  }
                  yield* Effect.forEach(
                    restoreTargets,
                    (target) => runtime.orchestrator.waitReady(target),
                    { concurrency: "unbounded", discard: true },
                  );
                  for (const target of restoreTargets) {
                    activatedServices.add(target);
                  }
                }),
              );
            }).pipe(withLifecycleLock),
          reloadFunctions: (opts) =>
            Effect.gen(function* () {
              yield* requireKnownService("edge-runtime");
              yield* configureFunctions(configWithFunctionOptions(opts));
              if (config.startupMode === "lazy" && !activatedServices.has("edge-runtime")) {
                manuallyStoppedServices.delete("edge-runtime");
                yield* startServices(
                  activationTargetsForService(enabledServices, "edge-runtime"),
                  Effect.void,
                );
                return;
              }
              const runtime = yield* ensureRuntime;
              yield* withActivationLocks(
                ["edge-runtime"],
                runtime.orchestrator
                  .restartService("edge-runtime", serviceStartOptions)
                  .pipe(Effect.andThen(runtime.orchestrator.waitReady("edge-runtime"))),
              );
            }).pipe(withLifecycleLock),
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
              const updateDefinition = runtime.orchestrator
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
              if (config.startupMode === "lazy" && !activatedServices.has("edge-runtime")) {
                yield* updateDefinition;
                manuallyStoppedServices.delete("edge-runtime");
                yield* startServices(
                  activationTargetsForService(enabledServices, "edge-runtime"),
                  Effect.void,
                );
                return;
              }
              yield* withActivationLocks(
                ["edge-runtime"],
                updateDefinition.pipe(
                  Effect.andThen(
                    runtime.orchestrator.restartService("edge-runtime", serviceStartOptions),
                  ),
                  Effect.andThen(runtime.orchestrator.waitReady("edge-runtime")),
                ),
              );
            }).pipe(withLifecycleLock),
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
              if (config.startupMode === "eager") {
                yield* runtime.orchestrator.waitAllReady();
                return;
              }
              yield* Effect.forEach(
                [...activatedServices],
                (service) =>
                  runtime.orchestrator.waitReady(service).pipe(
                    Effect.catchTag("ServiceNotFoundError", (cause) =>
                      Effect.fail(
                        new StackBuildError({
                          detail: `Prepared graph does not contain enabled service ${service}`,
                          cause,
                        }),
                      ),
                    ),
                  ),
                { concurrency: "unbounded", discard: true },
              );
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
