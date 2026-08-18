import { LogBuffer, Orchestrator } from "@supabase/process-compose";
import { ServiceNotFoundError } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceReadyError } from "@supabase/process-compose";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { cleanupLocalStackResources } from "./cleanup.ts";
import {
  DockerPullError,
  StackBuildError,
  StackNotRunningError,
  StackReadinessError,
} from "./errors.ts";
import {
  clearFunctionsRuntimeConfig,
  configureFunctionsRuntime,
  resolvedFunctionsBundleSchemaForProject,
  type ResolvedFunctionsBundle,
} from "./functions.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import type { PortLease } from "./PortAllocator.ts";
import {
  activationReadinessPolicy,
  activationTargetsForService,
  eagerServices,
  lifecycleTargetsForService,
  StackServiceActivator,
} from "./ServiceActivation.ts";
import { portFieldsForService } from "./ServicePorts.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { PreparedStackArtifacts } from "./StackPreparation.ts";
import {
  enabledServicesForConfig,
  StackBuilder,
  validateResolvedConfig,
  versionsForConfig,
} from "./StackBuilder.ts";
import { resolveReadinessPolicy } from "./StackConfig.ts";
import type { ReadinessPolicy, ReadyOptions, ResolvedStackConfig } from "./StackConfig.ts";
import { projectStackStates, type StackServiceProjectionCatalog } from "./StackStateProjection.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { Stack } from "./Stack.ts";
import type { EdgeRuntimeReloadConfig, StackInfo } from "./Stack.ts";
import { SERVICE_NAMES, type ServiceName } from "./versions.ts";

type LifecyclePhase =
  | "idle"
  | "preparing"
  | "prepared"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "disposed";

type StackService = typeof Stack.Service;

/** Private signal used by the Promise adapter to close its enclosing managed runtime. */
export class LocalStackLifecycle extends Context.Service<
  LocalStackLifecycle,
  {
    readonly awaitDisposed: Effect.Effect<void>;
    readonly isDisposed: Effect.Effect<boolean>;
  }
>()("stack/LocalStackLifecycle") {}

interface RuntimeState {
  readonly orchestrator: Orchestrator["Service"];
  readonly graph: ResolvedGraph;
  readonly serviceProjection: StackServiceProjectionCatalog;
}

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
  return current.filter((state) => !Equal.equals(previousByName.get(state.name), state));
};

/**
 * The private in-process Stack implementation. Its scoped construction owns
 * lifecycle state once and publishes both public seams from that same state.
 */
export const localStackLayer = (
  config: ResolvedStackConfig,
  portLease: PortLease,
): Layer.Layer<
  Stack | StackServiceActivator | LocalStackLifecycle,
  StackBuildError,
  | StackBuilder
  | StackPreparation
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scope = yield* Effect.scope;

      const info = stackInfoFor(config);
      const enabledServices = enabledServicesForConfig(config);
      const stateRef = yield* SubscriptionRef.make(initialPublicStates(config));
      const phaseRef = yield* Ref.make<LifecyclePhase>("idle");
      const functionsBundleRef = yield* Ref.make<ResolvedFunctionsBundle | undefined>(
        config.functions === false ? undefined : config.functions,
      );
      const edgeRuntimeConfigRef = yield* Ref.make(config.edgeRuntime);
      const disposedSignal = yield* Deferred.make<void>();
      const lifecycleLock = Semaphore.makeUnsafe(1);
      const projectionLock = Semaphore.makeUnsafe(1);

      const logBufferServices = yield* Layer.buildWithScope(LogBuffer.layer, scope);
      const logBuffer = Context.get(logBufferServices, LogBuffer);

      const updateState = (nextState: StackServiceState) =>
        SubscriptionRef.update(stateRef, (current) => {
          const previous = current.find((entry) => entry.name === nextState.name);
          if (Equal.equals(previous, nextState)) {
            return current;
          }
          return current.some((entry) => entry.name === nextState.name)
            ? current.map((entry) => (entry.name === nextState.name ? nextState : entry))
            : [...current, nextState];
        });

      const syncProjectedStates = (
        orchestrator: Orchestrator["Service"],
        serviceProjection: StackServiceProjectionCatalog,
      ) =>
        Effect.gen(function* () {
          const rawStates = yield* orchestrator.getAllStates();
          yield* Effect.forEach(projectStackStates(rawStates, serviceProjection), updateState, {
            discard: true,
          });
        }).pipe(projectionLock.withPermit);

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
      let exactCleanupTargets: CleanupTargets | undefined;

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
                    reason:
                      cause instanceof DockerPullError && cause.daemonDown
                        ? "docker_not_running"
                        : "asset_preparation",
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
          exactCleanupTargets = cleanupTargets;

          const orchLayer = Orchestrator.layer(graph).pipe(
            Layer.provide(Layer.succeed(LogBuffer, logBuffer)),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          );
          const orchServices = yield* Layer.buildWithScope(orchLayer, scope);
          const orchestrator = Context.get(orchServices, Orchestrator);

          yield* syncProjectedStates(orchestrator, serviceProjection);
          yield* orchestrator.allStateChanges().pipe(
            Stream.runForEach(() => syncProjectedStates(orchestrator, serviceProjection)),
            Effect.ignore,
            Effect.forkIn(scope),
          );

          return {
            orchestrator,
            graph,
            serviceProjection,
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
      let disposing = false;
      const runtimeHost = Effect.gen(function* () {
        const prepared = yield* ensurePrepared;
        const platform = yield* detectPlatform;
        const edgeRuntimeResolution = prepared.resolutions["edge-runtime"];
        return {
          hostname:
            edgeRuntimeResolution?.type === "docker" ? dockerHostAddress(platform.os) : "127.0.0.1",
        };
      });
      const providePlatform = <A, E>(
        effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
      ): Effect.Effect<A, E> =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const decodeFunctionsBundle = (bundle: unknown) =>
        Schema.decodeUnknownEffect(resolvedFunctionsBundleSchemaForProject(config.projectDir))(
          bundle,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new StackBuildError({
                detail: "Invalid Edge Functions bundle",
                cause,
                reason: "invalid_config",
              }),
          ),
        );
      const configureFunctions = (
        nextConfig: ResolvedStackConfig,
        bundle: ResolvedFunctionsBundle | undefined,
      ): Effect.Effect<void, StackBuildError> =>
        Effect.gen(function* () {
          yield* providePlatform(configureFunctionsRuntime(nextConfig, yield* runtimeHost, bundle));
        }).pipe(
          Effect.mapError(
            (cause) =>
              new StackBuildError({
                detail: "Failed to configure Edge Functions",
                cause,
              }),
          ),
        );
      const configWithEdgeRuntimeOptions = (
        opts: EdgeRuntimeReloadConfig,
      ): Effect.Effect<ResolvedStackConfig, ServiceNotFoundError> =>
        Effect.gen(function* () {
          const currentEdgeRuntime = yield* Ref.get(edgeRuntimeConfigRef);
          if (currentEdgeRuntime === false || opts.edgeRuntime.enabled === false) {
            return yield* Effect.fail(new ServiceNotFoundError({ name: "edge-runtime" }));
          }

          return {
            ...config,
            edgeRuntime: {
              ...currentEdgeRuntime,
              enabled: opts.edgeRuntime.enabled ?? currentEdgeRuntime.enabled,
              inspectorPort: opts.edgeRuntime.inspectorPort ?? currentEdgeRuntime.inspectorPort,
              policy: opts.edgeRuntime.policy ?? currentEdgeRuntime.policy,
              env: opts.edgeRuntime.env ?? currentEdgeRuntime.env,
            },
          };
        });
      const publicAllStateChanges = () =>
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
      const withLifecycleLock = lifecycleLock.withPermit;
      const syncRuntimeProjectedStates = (runtime: RuntimeState) =>
        syncProjectedStates(runtime.orchestrator, runtime.serviceProjection);
      const serviceStartOptions = {
        beforeStart: (name: string) => portLease.reserve(portFieldsForService(name)),
        beforeSpawn: (name: string) => portLease.release(portFieldsForService(name)),
      };
      const knownServiceError = (service: string, cause: ServiceNotFoundError) =>
        new StackBuildError({
          detail: `Prepared graph does not contain enabled service ${service}`,
          cause,
        });
      const beginStartTargets = (
        root: ServiceName,
        allowExplicitlyStopped: ReadonlySet<ServiceName>,
      ) =>
        Effect.gen(function* () {
          const runtime = yield* ensureRuntime;
          const targets = activationTargetsForService(enabledServices, root);
          const targetClosure = new Set(
            targets.flatMap((target) =>
              runtime.graph.startOrderFor(target).map((definition) => definition.name),
            ),
          );

          for (const dependency of targetClosure) {
            const state = yield* runtime.orchestrator
              .getState(dependency)
              .pipe(
                Effect.catchTag("ServiceNotFoundError", (cause) =>
                  Effect.fail(knownServiceError(dependency, cause)),
                ),
              );
            const publicDependency = SERVICE_NAMES.find((candidate) => candidate === dependency);
            if (
              state.desired === "stopped" &&
              publicDependency !== undefined &&
              !allowExplicitlyStopped.has(publicDependency)
            ) {
              return yield* Effect.fail(
                new StackBuildError({
                  detail: `Cannot activate ${root} because dependency ${dependency} was explicitly stopped`,
                }),
              );
            }
          }

          for (const target of targets) {
            yield* runtime.orchestrator
              .startService(target, serviceStartOptions)
              .pipe(
                Effect.catchTag("ServiceNotFoundError", (cause) =>
                  Effect.fail(knownServiceError(target, cause)),
                ),
              );
          }
          return { runtime, targets };
        });
      const waitForTargets = ({
        runtime,
        targets,
      }: {
        readonly runtime: RuntimeState;
        readonly targets: ReadonlyArray<ServiceName>;
      }) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            targets,
            (target) =>
              runtime.orchestrator
                .waitReady(target)
                .pipe(
                  Effect.catchTag("ServiceNotFoundError", (cause) =>
                    Effect.fail(knownServiceError(target, cause)),
                  ),
                ),
            { concurrency: "unbounded", discard: true },
          );
          yield* syncRuntimeProjectedStates(runtime);
        });
      const inspectStartedTargets = (root: ServiceName) =>
        Effect.gen(function* () {
          const runtime = yield* ensureRuntime;
          const targets = activationTargetsForService(enabledServices, root);
          const states = yield* Effect.forEach(targets, (target) =>
            runtime.orchestrator
              .getState(target)
              .pipe(
                Effect.catchTag("ServiceNotFoundError", (cause) =>
                  Effect.fail(knownServiceError(target, cause)),
                ),
              ),
          );
          if (states.some((state) => state.desired !== "running")) {
            return undefined;
          }
          return {
            runtime,
            targets,
            ready: states.every(
              (state) =>
                state.status === "Healthy" || (state.status === "Stopped" && state.exitCode === 0),
            ),
          };
        });
      const requireRunningPhase = Effect.gen(function* () {
        const phase = yield* Ref.get(phaseRef);
        if (phase !== "running") {
          return yield* Effect.fail(new StackNotRunningError({ phase }));
        }
      });
      const requireMutable = (operation: string) =>
        Effect.suspend(() =>
          disposed || disposing
            ? Effect.fail(
                new StackBuildError({
                  detail: `Cannot ${operation} after stack disposal has begun`,
                }),
              )
            : Effect.void,
        );
      const disposeOnce = () =>
        Effect.suspend(() => {
          disposing = true;
          return Effect.gen(function* () {
            if (disposed) {
              return;
            }
            disposed = true;
            yield* Ref.set(phaseRef, "stopping");
            yield* cleanupLocalStackResources({
              stop: () =>
                runtimeState === undefined ? Effect.void : runtimeState.orchestrator.stop(),
              cleanupTargets: exactCleanupTargets ?? { dockerContainerNames: [] },
              config,
            }).pipe(
              Effect.ensuring(providePlatform(clearFunctionsRuntimeConfig(config.runtimeRoot))),
              Effect.ensuring(portLease.releaseAll),
              Effect.ensuring(Ref.set(phaseRef, "disposed")),
            );
          }).pipe(withLifecycleLock);
        }).pipe(
          Effect.ensuring(Deferred.succeed(disposedSignal, undefined).pipe(Effect.asVoid)),
          Effect.uninterruptible,
        );

      const withReadinessPolicy = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        target: string,
        readyOptions?: ReadyOptions,
      ): Effect.Effect<A, E | StackReadinessError, R> => {
        const policy: ReadinessPolicy = resolveReadinessPolicy({
          readyOptions,
          stackPolicy: config.readiness,
        });
        if (policy.mode === "infinite") {
          return effect;
        }
        return effect.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(policy.timeoutMs),
            orElse: () =>
              Effect.fail(
                new StackReadinessError({
                  target,
                  timeoutMs: policy.timeoutMs,
                  detail: `Timed out waiting for ${target} readiness after ${policy.timeoutMs}ms`,
                }),
              ),
          }),
        );
      };
      const cleanupOnReadinessFailure = <A, E, R>(
        effect: Effect.Effect<A, E | StackReadinessError, R>,
      ): Effect.Effect<A, E | StackReadinessError, R> =>
        effect.pipe(
          Effect.catchTag("StackReadinessError", (error) =>
            disposeOnce().pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
      yield* Effect.addFinalizer(disposeOnce);

      const activateService = (name: ServiceName) =>
        Effect.gen(function* () {
          yield* requireRunningPhase;
          const service = yield* requireKnownServiceName(name);
          const existing = yield* inspectStartedTargets(service);
          if (existing?.ready === true) {
            // Close the race with a concurrent stack stop before taking
            // the lock-free healthy-request fast path.
            yield* requireRunningPhase;
            return;
          }
          if (existing !== undefined) {
            yield* waitForTargets(existing).pipe((effect) =>
              withReadinessPolicy(
                effect,
                name,
                activationReadinessPolicy(service, config.readiness, config.readinessSource),
              ),
            );
            return;
          }
          const started = yield* Effect.gen(function* () {
            yield* requireRunningPhase;
            const concurrentlyStarted = yield* inspectStartedTargets(service);
            if (concurrentlyStarted !== undefined) return concurrentlyStarted;
            return yield* beginStartTargets(service, new Set());
          }).pipe(withLifecycleLock);
          yield* waitForTargets(started).pipe((effect) =>
            withReadinessPolicy(
              effect,
              name,
              activationReadinessPolicy(service, config.readiness, config.readinessSource),
            ),
          );
        }).pipe(cleanupOnReadinessFailure);

      const stack = {
        getInfo: () => Effect.succeed(info),
        start: () => {
          let serviceStartupBegan = false;
          return Effect.gen(function* () {
            yield* requireMutable("start");
            yield* Ref.set(phaseRef, "starting");
            const runtime = yield* ensureRuntime;
            yield* configureFunctions(config, yield* Ref.get(functionsBundleRef));
            serviceStartupBegan = true;

            if (config.startupMode === "lazy") {
              const readiness: Array<Effect.Effect<void, ServiceReadyError | StackBuildError>> = [];
              if (
                runtime.graph.startOrder.some((definition) => definition.name === "postgres-init")
              ) {
                yield* runtime.orchestrator
                  .startService("postgres-init", serviceStartOptions)
                  .pipe(
                    Effect.catchTag("ServiceNotFoundError", (cause) =>
                      Effect.fail(knownServiceError("postgres-init", cause)),
                    ),
                  );
                readiness.push(
                  runtime.orchestrator
                    .waitReady("postgres-init")
                    .pipe(
                      Effect.catchTag("ServiceNotFoundError", (cause) =>
                        Effect.fail(knownServiceError("postgres-init", cause)),
                      ),
                    ),
                );
              }
              for (const service of eagerServices(enabledServices)) {
                const started = yield* beginStartTargets(
                  service,
                  new Set(lifecycleTargetsForService(enabledServices, service)),
                );
                readiness.push(waitForTargets(started));
              }
              yield* Effect.all(readiness, { concurrency: "unbounded", discard: true }).pipe(
                (effect) => withReadinessPolicy(effect, "stack"),
              );
            } else {
              yield* runtime.orchestrator.start(serviceStartOptions);
              yield* runtime.orchestrator
                .waitAllReady()
                .pipe((effect) => withReadinessPolicy(effect, "stack"));
              yield* syncRuntimeProjectedStates(runtime);
            }
            yield* Ref.set(phaseRef, "running");
          }).pipe(
            Effect.onError(() => Ref.set(phaseRef, "stopped")),
            withLifecycleLock,
            Effect.onError(() => (serviceStartupBegan ? disposeOnce() : Effect.void)),
          );
        },
        stop: () =>
          Effect.gen(function* () {
            if (disposed) {
              return;
            }
            if (runtimeState === undefined) {
              yield* Ref.set(phaseRef, "stopped");
              return;
            }
            yield* Ref.set(phaseRef, "stopping");
            yield* runtimeState.orchestrator.stop();
            yield* Ref.set(phaseRef, "stopped");
          }).pipe(withLifecycleLock),
        dispose: disposeOnce,
        startService: (name) =>
          Effect.gen(function* () {
            const started = yield* Effect.gen(function* () {
              yield* requireMutable(`start service ${name}`);
              const service = yield* requireKnownServiceName(name);
              return yield* beginStartTargets(
                service,
                new Set(lifecycleTargetsForService(enabledServices, service)),
              );
            }).pipe(withLifecycleLock);
            yield* waitForTargets(started).pipe((effect) => withReadinessPolicy(effect, name));
          }).pipe(cleanupOnReadinessFailure),
        stopService: (name) =>
          Effect.gen(function* () {
            yield* requireMutable(`stop service ${name}`);
            const service = yield* requireKnownServiceName(name);
            const runtime = yield* ensureRuntime;
            for (const target of lifecycleTargetsForService(
              enabledServices,
              service,
            ).toReversed()) {
              yield* runtime.orchestrator.stopService(target);
            }
          }).pipe(withLifecycleLock),
        restartService: (name) =>
          Effect.gen(function* () {
            const started = yield* Effect.gen(function* () {
              yield* requireMutable(`restart service ${name}`);
              const service = yield* requireKnownServiceName(name);
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.restartService(service, serviceStartOptions);
              return { runtime, targets: [service] };
            }).pipe(withLifecycleLock);
            yield* waitForTargets(started).pipe((effect) => withReadinessPolicy(effect, name));
          }).pipe(cleanupOnReadinessFailure),
        reloadFunctions: (opts) =>
          Effect.gen(function* () {
            const started = yield* Effect.gen(function* () {
              yield* requireMutable("reload functions");
              yield* requireKnownService("edge-runtime");
              const currentBundle = yield* Ref.get(functionsBundleRef);
              const nextBundle =
                opts?.functions === undefined
                  ? currentBundle
                  : yield* decodeFunctionsBundle(opts.functions);
              yield* configureFunctions(config, nextBundle);
              yield* Ref.set(functionsBundleRef, nextBundle);
              const runtime = yield* ensureRuntime;
              const state = yield* runtime.orchestrator.getState("edge-runtime");
              if (state.desired !== "running") {
                return yield* beginStartTargets("edge-runtime", new Set(["edge-runtime"]));
              }
              yield* runtime.orchestrator.restartService("edge-runtime", serviceStartOptions);
              return { runtime, targets: ["edge-runtime"] as const };
            }).pipe(withLifecycleLock);
            yield* waitForTargets(started).pipe((effect) =>
              withReadinessPolicy(effect, "edge-runtime"),
            );
          }).pipe(cleanupOnReadinessFailure),
        reloadEdgeRuntime: (opts) =>
          Effect.gen(function* () {
            const started = yield* Effect.gen(function* () {
              yield* requireMutable("reload Edge Runtime");
              yield* requireKnownService("edge-runtime");
              const nextConfig = yield* configWithEdgeRuntimeOptions(opts);
              const currentBundle = yield* Ref.get(functionsBundleRef);
              const nextBundle =
                opts.functions === undefined
                  ? currentBundle
                  : yield* decodeFunctionsBundle(opts.functions);
              const prepared = yield* ensurePrepared;
              const runtime = yield* ensureRuntime;
              const buildResult = yield* builder.build(nextConfig, prepared);
              const edgeRuntimeDef = buildResult.graph.startOrder.find(
                (def) => def.name === "edge-runtime",
              );

              if (edgeRuntimeDef === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name: "edge-runtime" }));
              }

              yield* configureFunctions(nextConfig, nextBundle);
              yield* Ref.set(functionsBundleRef, nextBundle);
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
              yield* Ref.set(edgeRuntimeConfigRef, nextConfig.edgeRuntime);
              const state = yield* runtime.orchestrator.getState("edge-runtime");
              if (state.desired !== "running") {
                return yield* beginStartTargets("edge-runtime", new Set(["edge-runtime"]));
              }
              yield* runtime.orchestrator.restartService("edge-runtime", serviceStartOptions);
              return { runtime, targets: ["edge-runtime"] as const };
            }).pipe(withLifecycleLock);
            yield* waitForTargets(started).pipe((effect) =>
              withReadinessPolicy(effect, "edge-runtime"),
            );
          }).pipe(cleanupOnReadinessFailure),
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
            return Stream.filter(publicAllStateChanges(), (state) => state.name === name);
          }),
        allStateChanges: publicAllStateChanges,
        waitReady: (name, opts) =>
          Effect.gen(function* () {
            const phase = yield* Ref.get(phaseRef);
            if (phase !== "running") {
              return yield* Effect.fail(
                new StackBuildError({
                  detail: `Cannot wait for service ${name} while the stack is ${phase}`,
                }),
              );
            }
            yield* requireKnownServiceName(name);
            const runtime = yield* ensureRuntime;
            yield* runtime.orchestrator
              .waitReady(name)
              .pipe((effect) => withReadinessPolicy(effect, name, opts));
            yield* syncRuntimeProjectedStates(runtime);
          }).pipe(cleanupOnReadinessFailure),
        waitAllReady: (opts) =>
          Effect.gen(function* () {
            const phase = yield* Ref.get(phaseRef);
            if (phase !== "running") {
              return yield* Effect.fail(
                new StackBuildError({
                  detail: `Cannot wait for stack readiness while the stack is ${phase}`,
                }),
              );
            }
            const runtime = yield* ensureRuntime;
            yield* runtime.orchestrator
              .waitAllReady()
              .pipe((effect) => withReadinessPolicy(effect, "stack", opts));
            yield* syncRuntimeProjectedStates(runtime);
          }).pipe(cleanupOnReadinessFailure),
        subscribeLogs: (name) => logBuffer.subscribe(name),
        subscribeAllLogs: (services) =>
          services === undefined || services.length === 0
            ? logBuffer.subscribeAll()
            : logBuffer
                .subscribeAll()
                .pipe(Stream.filter((entry) => services.includes(entry.service))),
        logHistory: (name, limit) => logBuffer.history(name, limit),
        logHistoryAll: (limit, services) => logBuffer.historyAll(limit, services),
      } satisfies StackService;

      return Context.make(Stack, stack).pipe(
        Context.add(StackServiceActivator, { activate: activateService }),
        Context.add(LocalStackLifecycle, {
          awaitDisposed: Deferred.await(disposedSignal),
          isDisposed: Effect.sync(() => disposed),
        }),
      );
    }),
  );
