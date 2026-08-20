import { LogBuffer, Orchestrator } from "@supabase/process-compose";
import { ServiceNotFoundError } from "@supabase/process-compose";
import type { ResolvedGraph, ServiceReadyError } from "@supabase/process-compose";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
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
import {
  PreparationCompleted,
  preparationClosure,
  ServiceDownloadStarted,
  ServiceDownloadFinished,
  StackPreparation,
} from "./StackPreparation.ts";
import type { PreparedStackArtifacts, StackPreparationInput } from "./StackPreparation.ts";
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

type LifecyclePhase = "idle" | "starting" | "running" | "stopping" | "stopped" | "disposed";

type StackService = typeof Stack.Service;

const READINESS_DIAGNOSTIC_LOG_LIMIT = 20;
const READINESS_DIAGNOSTIC_LINE_LIMIT = 512;

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
      ...(config.imgproxy === false || config.servicePolicies.imgproxy !== "eager"
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
      const preparationScope = yield* Scope.fork(scope, "parallel");

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

      const markDownloading = (service: ServiceName) =>
        SubscriptionRef.update(stateRef, (current) => {
          const index = current.findIndex((entry) => entry.name === service);
          if (index === -1 || current[index]?.status === "Downloading") return current;
          return current.map((entry, entryIndex) =>
            entryIndex === index
              ? new StackServiceState({ ...entry, status: "Downloading" })
              : entry,
          );
        });

      const restoreStateIfDownloading = (
        service: ServiceName,
        previous: StackServiceState | undefined,
      ) =>
        previous === undefined
          ? Effect.void
          : SubscriptionRef.update(stateRef, (current) => {
              const index = current.findIndex((entry) => entry.name === service);
              if (index === -1 || current[index]?.status !== "Downloading") return current;
              return current.map((entry, entryIndex) => (entryIndex === index ? previous : entry));
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

      let plannedArtifacts: PreparedStackArtifacts | undefined;
      let planDeferred: Deferred.Deferred<PreparedStackArtifacts, StackBuildError> | undefined;
      const preparedResolutions: Partial<PreparedStackArtifacts["resolutions"]> = {};
      const preparationInFlight = new Map<
        string,
        Deferred.Deferred<PreparedStackArtifacts, StackBuildError>
      >();
      let runtimeState: RuntimeState | undefined;
      let runtimeDeferred: Deferred.Deferred<RuntimeState, StackBuildError> | undefined;
      let exactCleanupTargets: CleanupTargets | undefined;

      const preparationInput = (
        services: ReadonlyArray<ServiceName>,
      ): Effect.Effect<StackPreparationInput, StackBuildError> => {
        const shared = {
          services,
          enabledServices,
          versions: versionsForConfig(config),
        };
        if (config.mode === "native") return Effect.succeed({ ...shared, mode: "native" });
        return config.containerRuntime === null
          ? Effect.fail(
              new StackBuildError({
                detail: "Docker mode requires a selected Docker or Podman runtime",
                reason: "invalid_config",
              }),
            )
          : Effect.succeed({
              ...shared,
              mode: "docker",
              containerRuntime: config.containerRuntime,
            });
      };

      const ensurePlanned = Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (disposed || disposing) {
            return Effect.fail(
              new StackBuildError({
                detail: "Cannot plan stack assets after stack disposal has begun",
              }),
            );
          }
          if (plannedArtifacts !== undefined) return Effect.succeed(plannedArtifacts);
          if (planDeferred !== undefined) return restore(Deferred.await(planDeferred));
          const deferred = Deferred.makeUnsafe<PreparedStackArtifacts, StackBuildError>();
          planDeferred = deferred;
          const effect = Effect.gen(function* () {
            yield* validateResolvedConfig(config);
            const input = yield* preparationInput(enabledServicesForConfig(config));
            return yield* preparation.plan(input).pipe(
              Effect.mapError(
                (cause) =>
                  new StackBuildError({
                    detail: "Failed to plan stack assets",
                    cause,
                    reason: "asset_preparation",
                  }),
              ),
            );
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                plannedArtifacts = value;
              }),
            ),
            Effect.ensuring(Effect.sync(() => (planDeferred = undefined))),
          );
          return Effect.gen(function* () {
            yield* Effect.forkIn(effect.pipe(Deferred.into(deferred)), preparationScope);
            return yield* restore(Deferred.await(deferred));
          });
        }),
      );

      const prepareServices = (services: ReadonlyArray<ServiceName>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            if (disposed || disposing) {
              return Effect.fail(
                new StackBuildError({
                  detail: "Cannot prepare stack assets after disposal has begun",
                }),
              );
            }
            const targets = [
              ...new Set(
                services.flatMap((service) =>
                  activationTargetsForService(enabledServices, service),
                ),
              ),
            ];
            const preparationTargets = preparationClosure(targets, enabledServices);
            const pending = preparationTargets.filter(
              (service) => preparedResolutions[service] === undefined,
            );
            if (pending.length === 0) {
              return Effect.succeed({
                resolutions: preparedResolutions,
              } satisfies PreparedStackArtifacts);
            }
            const key = pending.toSorted().join(",");
            const existing = preparationInFlight.get(key);
            if (existing !== undefined) return restore(Deferred.await(existing));
            const previousStates = new Map(
              preparationTargets.flatMap((service) => {
                const state = SubscriptionRef.getUnsafe(stateRef).find(
                  (entry) => entry.name === service,
                );
                return state === undefined ? [] : [[service, state] as const];
              }),
            );
            const deferred = Deferred.makeUnsafe<PreparedStackArtifacts, StackBuildError>();
            preparationInFlight.set(key, deferred);
            const effect = preparationInput(pending).pipe(
              Effect.flatMap((input) =>
                Stream.runFoldEffect(
                  preparation.prepareEvents(input),
                  () => ({ resolutions: {} }) satisfies PreparedStackArtifacts,
                  (current, event) =>
                    Effect.gen(function* () {
                      if (event instanceof ServiceDownloadStarted) {
                        yield* markDownloading(event.service);
                      }
                      if (event instanceof ServiceDownloadFinished) {
                        yield* restoreStateIfDownloading(
                          event.service,
                          previousStates.get(event.service),
                        );
                      }
                      return event instanceof PreparationCompleted ? event.artifacts : current;
                    }),
                ),
              ),
              Effect.mapError(
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
              Effect.tapError(() =>
                Effect.forEach(
                  preparationTargets,
                  (service) => {
                    return restoreStateIfDownloading(service, previousStates.get(service));
                  },
                  { discard: true, concurrency: "unbounded" },
                ),
              ),
              Effect.tap((value) =>
                Effect.sync(() => Object.assign(preparedResolutions, value.resolutions)),
              ),
              Effect.ensuring(Effect.sync(() => preparationInFlight.delete(key))),
            );
            return Effect.gen(function* () {
              yield* Effect.forkIn(effect.pipe(Deferred.into(deferred)), preparationScope);
              return yield* restore(Deferred.await(deferred));
            });
          }),
        );

      const ensureRuntime = Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (disposed || disposing) {
            return Effect.fail(
              new StackBuildError({
                detail: "Cannot ensure stack runtime after stack disposal has begun",
              }),
            );
          }
          if (runtimeState !== undefined) {
            return Effect.succeed(runtimeState);
          }
          if (runtimeDeferred !== undefined) return restore(Deferred.await(runtimeDeferred));

          const deferred = Deferred.makeUnsafe<RuntimeState, StackBuildError>();
          runtimeDeferred = deferred;

          const effect = Effect.gen(function* () {
            const prepared = yield* ensurePlanned;
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
            yield* Effect.forkIn(effect.pipe(Deferred.into(deferred)), preparationScope);
            return yield* restore(Deferred.await(deferred));
          });
        }),
      );

      let disposed = false;
      let disposing = false;
      const runtimeHost = Effect.gen(function* () {
        const prepared = yield* ensurePlanned;
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
        // Reservation may yield while disposal flips the lifecycle state.
        beforeStart: (name: string) =>
          portLease
            .reserve(portFieldsForService(name))
            .pipe(Effect.andThen(requireMutable(`start service ${name}`))),
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
          const preparationError = new StackBuildError({
            detail: "Stack disposed during asset preparation",
          });
          const failInFlight = Effect.gen(function* () {
            if (planDeferred !== undefined) {
              yield* Deferred.fail(planDeferred, preparationError);
            }
            for (const deferred of preparationInFlight.values()) {
              yield* Deferred.fail(deferred, preparationError);
            }
            if (runtimeDeferred !== undefined) {
              yield* Deferred.fail(runtimeDeferred, preparationError);
            }
          });
          const cleanup = Effect.gen(function* () {
            if (disposed) {
              return;
            }
            disposed = true;
            yield* Ref.set(phaseRef, "stopping");
            yield* Scope.close(preparationScope, Exit.void);
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
          return failInFlight.pipe(Effect.andThen(cleanup));
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
      const readinessErrorWithDiagnostics = (
        error: StackReadinessError,
      ): Effect.Effect<StackReadinessError> =>
        Effect.gen(function* () {
          if (runtimeState === undefined) return error;

          const [states, logs] = yield* Effect.all([
            runtimeState.orchestrator.getAllStates(),
            logBuffer.historyAll(READINESS_DIAGNOSTIC_LOG_LIMIT),
          ]);
          const nonReadyStates = states.filter(
            (state) =>
              state.status !== "Healthy" && !(state.status === "Stopped" && state.exitCode === 0),
          );
          const stateDetail =
            nonReadyStates.length === 0
              ? "none"
              : nonReadyStates
                  .map((state) => {
                    const errorDetail =
                      state.error === null
                        ? ""
                        : `, error=${state.error.slice(0, READINESS_DIAGNOSTIC_LINE_LIMIT)}`;
                    return `${state.name}: ${state.status} (desired=${state.desired}, restarts=${state.restartCount}${errorDetail})`;
                  })
                  .join("; ");
          const logDetail =
            logs.length === 0
              ? "none"
              : logs
                  .map(
                    (entry) =>
                      `[${entry.service}/${entry.stream}] ${entry.line.slice(0, READINESS_DIAGNOSTIC_LINE_LIMIT)}`,
                  )
                  .join("\n");

          return new StackReadinessError({
            target: error.target,
            timeoutMs: error.timeoutMs,
            detail: `${error.detail}\nNon-ready services: ${stateDetail}\nRecent logs:\n${logDetail}`,
          });
        }).pipe(Effect.catchCause(() => Effect.succeed(error)));
      const cleanupOnReadinessFailure = <A, E, R>(
        effect: Effect.Effect<A, E | StackReadinessError, R>,
      ): Effect.Effect<A, E | StackReadinessError, R> =>
        effect.pipe(
          Effect.catchIf(
            (error): error is StackReadinessError => error instanceof StackReadinessError,
            (error) =>
              readinessErrorWithDiagnostics(error).pipe(
                Effect.flatMap((diagnosticError) =>
                  disposeOnce().pipe(Effect.andThen(Effect.fail(diagnosticError))),
                ),
              ),
          ),
        );
      yield* Effect.addFinalizer(disposeOnce);

      const activateService = (name: ServiceName) =>
        Effect.gen(function* () {
          yield* requireMutable(`activate service ${name}`);
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
          yield* prepareServices([service]);
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

            const eager = eagerServices(enabledServices, config.servicePolicies);
            const allServicesEager = eager.length === enabledServices.length;
            if (!allServicesEager) {
              const readiness: Array<Effect.Effect<void, ServiceReadyError | StackBuildError>> = [];
              yield* prepareServices(["postgres", ...eager]);
              yield* requireMutable("start");
              if (
                runtime.graph.startOrder.some((definition) => definition.name === "postgres-init")
              ) {
                serviceStartupBegan = true;
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
              for (const service of eager) {
                yield* requireMutable("start");
                serviceStartupBegan = true;
                const started = yield* beginStartTargets(
                  service,
                  new Set(activationTargetsForService(enabledServices, service)),
                );
                readiness.push(waitForTargets(started));
              }
              yield* Effect.all(readiness, { concurrency: "unbounded", discard: true }).pipe(
                (effect) => withReadinessPolicy(effect, "stack"),
              );
              yield* syncRuntimeProjectedStates(runtime);
            } else {
              yield* prepareServices(enabledServices);
              yield* requireMutable("start");
              serviceStartupBegan = true;
              yield* runtime.orchestrator.start(serviceStartOptions);
              yield* runtime.orchestrator
                .waitAllReady()
                .pipe((effect) => withReadinessPolicy(effect, "stack"));
              yield* syncRuntimeProjectedStates(runtime);
            }
            yield* requireMutable("start");
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
            yield* requireMutable(`start service ${name}`);
            yield* requireRunningPhase;
            const service = yield* requireKnownServiceName(name);
            yield* prepareServices([service]);
            const started = yield* Effect.gen(function* () {
              yield* requireMutable(`start service ${name}`);
              yield* requireRunningPhase;
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
            yield* requireRunningPhase;
            const service = yield* requireKnownServiceName(name);
            const runtime = yield* ensureRuntime;
            for (const target of lifecycleTargetsForService(
              enabledServices,
              service,
            ).toReversed()) {
              yield* runtime.orchestrator.stopService(target);
            }
            // Settle the public projection before returning so callers observe
            // the stop immediately, matching the start/restart/waitReady paths.
            yield* syncRuntimeProjectedStates(runtime);
          }).pipe(withLifecycleLock),
        restartService: (name) =>
          Effect.gen(function* () {
            yield* requireMutable(`restart service ${name}`);
            yield* requireRunningPhase;
            const service = yield* requireKnownServiceName(name);
            yield* prepareServices([service]);
            const started = yield* Effect.gen(function* () {
              yield* requireMutable(`restart service ${name}`);
              yield* requireRunningPhase;
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.restartService(service, serviceStartOptions);
              return { runtime, targets: [service] };
            }).pipe(withLifecycleLock);
            yield* waitForTargets(started).pipe((effect) => withReadinessPolicy(effect, name));
          }).pipe(cleanupOnReadinessFailure),
        reloadFunctions: (opts) =>
          Effect.gen(function* () {
            yield* requireMutable("reload functions");
            yield* requireRunningPhase;
            yield* requireKnownService("edge-runtime");
            const requestedBundle =
              opts?.functions === undefined
                ? undefined
                : yield* decodeFunctionsBundle(opts.functions);
            yield* prepareServices(["edge-runtime"]);
            const started = yield* Effect.gen(function* () {
              yield* requireMutable("reload functions");
              yield* requireRunningPhase;
              const currentBundle = yield* Ref.get(functionsBundleRef);
              const nextBundle = requestedBundle ?? currentBundle;
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
            yield* requireMutable("reload Edge Runtime");
            yield* requireRunningPhase;
            yield* requireKnownService("edge-runtime");
            if (opts.edgeRuntime.enabled === false) {
              return yield* Effect.fail(new ServiceNotFoundError({ name: "edge-runtime" }));
            }
            const requestedBundle =
              opts.functions === undefined
                ? undefined
                : yield* decodeFunctionsBundle(opts.functions);
            yield* prepareServices(["edge-runtime"]);
            const started = yield* Effect.gen(function* () {
              yield* requireMutable("reload Edge Runtime");
              yield* requireRunningPhase;
              const nextConfig = yield* configWithEdgeRuntimeOptions(opts);
              const currentBundle = yield* Ref.get(functionsBundleRef);
              const nextBundle = requestedBundle ?? currentBundle;
              const prepared = yield* ensurePlanned;
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
