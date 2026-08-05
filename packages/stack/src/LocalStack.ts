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
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { cleanupLocalStackResources } from "./cleanup.ts";
import { StackBuildError, StackNotRunningError, StackReadinessError } from "./errors.ts";
import { configureFunctionsRuntime, type FunctionsConfig } from "./functions.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import type { PortLease } from "./PortAllocator.ts";
import {
  activationTargetsForService,
  eagerServices,
  lifecycleTargetsForService,
  StackServiceActivator,
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
} from "./StackBuilder.ts";
import { resolveReadinessPolicy } from "./StackConfig.ts";
import type { ReadinessPolicy, ReadyOptions, ResolvedStackConfig } from "./StackConfig.ts";
import { changedProjectedStates, projectStackStates } from "./StackStateProjection.ts";
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

interface RuntimeState {
  readonly orchestrator: Orchestrator["Service"];
  readonly graph: ResolvedGraph;
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
  Stack | StackServiceActivator,
  StackBuildError,
  | StackBuilder
  | StackPreparation
  | ChildProcessSpawner.ChildProcessSpawner
  | StackMetadataPersistence
  | FileSystem.FileSystem
  | Path.Path
> =>
  Layer.effectContext(
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
      const lifecycleLock = Semaphore.makeUnsafe(1);

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
        Effect.forEach(
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
          disposed
            ? Effect.fail(
                new StackBuildError({
                  detail: `Cannot ${operation} after the stack has been disposed`,
                }),
              )
            : Effect.void,
        );
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
            cleanupTargets: exactCleanupTargets ?? { dockerContainerNames: [] },
            config,
          }).pipe(
            Effect.ensuring(portLease.releaseAll),
            Effect.ensuring(Ref.set(phaseRef, "disposed")),
          );
        }).pipe(withLifecycleLock);

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
      const cleanupOnStartupFailure = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => effect.pipe(Effect.onError(() => disposeOnce()));

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
            yield* waitForTargets(existing).pipe((effect) => withReadinessPolicy(effect, name));
            return;
          }
          const started = yield* Effect.gen(function* () {
            yield* requireRunningPhase;
            const concurrentlyStarted = yield* inspectStartedTargets(service);
            if (concurrentlyStarted !== undefined) return concurrentlyStarted;
            return yield* beginStartTargets(service, new Set());
          }).pipe(withLifecycleLock);
          yield* waitForTargets(started).pipe((effect) => withReadinessPolicy(effect, name));
        }).pipe(cleanupOnReadinessFailure);

      const stack = {
        getInfo: () => Effect.succeed(info),
        start: () =>
          Effect.gen(function* () {
            yield* requireMutable("start");
            yield* Ref.set(phaseRef, "starting");
            const runtime = yield* ensureRuntime;
            yield* configureFunctions(config);

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
            }
            yield* Ref.set(phaseRef, "running");
          }).pipe(
            Effect.onError(() => Ref.set(phaseRef, "stopped")),
            withLifecycleLock,
            cleanupOnStartupFailure,
          ),
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
              yield* configureFunctions(configWithFunctionOptions(opts));
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
      );
    }),
  );
