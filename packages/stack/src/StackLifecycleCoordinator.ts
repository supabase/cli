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
  Context,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { cleanupLocalStackResources } from "./cleanup.ts";
import { configureExtensionPreload } from "./extensionPreload.ts";
import { StackBuildError } from "./errors.ts";
import { configureFunctionsRuntime, type FunctionsConfig } from "./functions.ts";
import { detectPlatform, dockerHostAddress } from "./Platform.ts";
import { postgresConnectionUrl } from "./postgresCredentials.ts";
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
import type { ServiceName } from "./versions.ts";

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
  cleanupTargets: CleanupTargets;
  graph: ResolvedGraph;
}

const serviceDependencies: Partial<Record<ServiceName, ReadonlyArray<ServiceName>>> = {
  imgproxy: ["storage"],
  vector: ["analytics"],
  studio: ["pgmeta"],
};

const dependencyClosure = (services: ReadonlyArray<ServiceName>): ReadonlyArray<ServiceName> => {
  const included = new Set<ServiceName>(["postgres"]);
  const visit = (service: ServiceName): void => {
    if (included.has(service)) return;
    for (const dependency of serviceDependencies[service] ?? []) visit(dependency);
    included.add(service);
  };
  for (const service of services) visit(service);
  return [...included];
};

// postgres/postgres-init are always installed first, so ServiceNotFoundError cannot occur when
// the coordinator starts them. Map it to StackBuildError only to preserve the lifecycle error
// boundary if the graph invariant is ever broken.
const eagerStartService = (
  orchestrator: Orchestrator["Service"],
  name: string,
): Effect.Effect<void, StackBuildError> =>
  orchestrator.startService(name).pipe(
    Effect.catchTag(
      "ServiceNotFoundError",
      (error) =>
        new StackBuildError({
          detail: `eager start: unexpected missing service "${error.name}"`,
        }),
    ),
  );

// Names come from installed graph definitions or from a service already validated by the
// coordinator. Map an impossible ServiceNotFoundError to StackBuildError at this boundary.
const waitReadyKnownService = (
  orchestrator: Orchestrator["Service"],
  name: string,
): Effect.Effect<void, StackBuildError | ServiceReadyError> =>
  orchestrator.waitReady(name).pipe(
    Effect.catchTag(
      "ServiceNotFoundError",
      (error) =>
        new StackBuildError({
          detail: `waitReady: unexpected missing service "${error.name}"`,
        }),
    ),
  );

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
  dbUrl: postgresConnectionUrl({
    user: "postgres",
    password: config.postgres.password,
    host: "127.0.0.1",
    port: config.dbPort,
    database: "postgres",
  }),
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
          pooler: postgresConnectionUrl({
            user: "postgres",
            password: config.postgres.password,
            host: "127.0.0.1",
            port: config.pooler.port,
            database: "postgres",
          }),
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
    readonly stopService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly ensureExtensionPreload: (
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
        const startInFlightRef = yield* Ref.make(false);
        const ensureExtensionPreloadLock = yield* Semaphore.make(1);
        const disposeLock = yield* Semaphore.make(1);
        // Tracks services that have actually been asked to start. waitAllReady() only waits on
        // this set because an available but never-requested sidecar intentionally has no running
        // process and therefore cannot resolve an orchestrator readiness signal.
        const startedServicesRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        const markStarted = (names: Iterable<string>) =>
          Ref.update(startedServicesRef, (current) => new Set([...current, ...names]));
        const markStopped = (names: Iterable<string>) =>
          Ref.update(startedServicesRef, (current) => {
            const next = new Set(current);
            for (const name of names) next.delete(name);
            return next;
          });

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
        const requireRunningForServiceStart = (name: string) =>
          Effect.gen(function* () {
            const phase = yield* Ref.get(phaseRef);
            if (phase !== "running") {
              return yield* Effect.fail(
                new StackBuildError({
                  detail: `Cannot start service "${name}" while the stack is ${phase}. Call start() first and retry after it finishes.`,
                }),
              );
            }
          });

        let preparedArtifacts: PreparedStackArtifacts = { resolutions: {} };
        const preparationLock = yield* Semaphore.make(1);
        let runtimeState: RuntimeState | undefined;
        let runtimeDeferred: Deferred.Deferred<RuntimeState, StackBuildError> | undefined;

        const ensureServicesPrepared = (requested: ReadonlyArray<ServiceName>) =>
          preparationLock.withPermits(1)(
            Effect.gen(function* () {
              const configured = new Set(enabledServicesForConfig(config));
              const missing = [...new Set(requested)].filter(
                (service) =>
                  configured.has(service) && preparedArtifacts.resolutions[service] === undefined,
              );
              if (missing.length === 0) return preparedArtifacts;

              const priorPhase = yield* Ref.get(phaseRef);
              const initialPreparation = priorPhase === "idle";
              if (initialPreparation) yield* Ref.set(phaseRef, "preparing");
              yield* validateResolvedConfig(config);

              let prepared: PreparedStackArtifacts | undefined;
              yield* preparation
                .prepareEvents({
                  mode: config.mode,
                  services: missing,
                  versions: versionsForConfig(config),
                })
                .pipe(
                  Stream.mapError(
                    (cause) =>
                      new StackBuildError({
                        detail: `Failed to prepare stack assets: ${missing.join(", ")}`,
                        cause,
                      }),
                  ),
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

              preparedArtifacts = {
                resolutions: {
                  ...preparedArtifacts.resolutions,
                  ...prepared.resolutions,
                },
              };
              if (initialPreparation) yield* Ref.set(phaseRef, "prepared");
              return preparedArtifacts;
            }).pipe(
              Effect.onError(() =>
                Effect.gen(function* () {
                  if ((yield* Ref.get(phaseRef)) === "preparing") {
                    yield* Ref.set(phaseRef, "idle");
                  }
                }),
              ),
            ),
          );

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
            const prepared = yield* ensureServicesPrepared(["postgres"]);
            const { graph, serviceProjection, cleanupTargets } = yield* builder.build(
              config,
              prepared,
              ["postgres"],
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
              cleanupTargets,
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

        const activationLock = yield* Semaphore.make(1);
        const activateServices = (runtime: RuntimeState, requested: ReadonlyArray<string>) =>
          activationLock.withPermits(1)(
            Effect.gen(function* () {
              const configured = new Set(enabledServicesForConfig(config));
              const normalized = enabledServicesForConfig(config).filter((service) =>
                requested.includes(service),
              );
              const closure = dependencyClosure(normalized).filter((service) =>
                configured.has(service),
              );
              yield* ensureServicesPrepared(closure);

              const preparedServices = enabledServicesForConfig(config).filter(
                (service) => preparedArtifacts.resolutions[service] !== undefined,
              );
              const buildResult = yield* builder.build(config, preparedArtifacts, preparedServices);
              const installed = new Set(runtime.graph.startOrder.map((def) => def.name));
              const additions = buildResult.graph.startOrder.filter(
                (def) => !installed.has(def.name),
              );
              yield* runtime.orchestrator.addServiceDefinitions(additions).pipe(
                Effect.mapError(
                  (cause) =>
                    new StackBuildError({
                      detail: "Failed to install prepared service definitions",
                      cause,
                    }),
                ),
              );
              runtime.graph = buildResult.graph;
              runtime.cleanupTargets = buildResult.cleanupTargets;
              yield* metadataPersistence.persistCleanupTargets(runtime.cleanupTargets).pipe(
                Effect.mapError(
                  (cause) =>
                    new StackBuildError({
                      detail: "Failed to persist stack cleanup metadata",
                      cause,
                    }),
                ),
              );
            }),
          );

        let disposed = false;
        const runtimeHost = Effect.gen(function* () {
          const platform = yield* detectPlatform;
          const edgeRuntimeResolution = preparedArtifacts.resolutions["edge-runtime"];
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
          disposeLock.withPermits(1)(
            Effect.gen(function* () {
              if (disposed) {
                return;
              }
              yield* cleanupLocalStackResources({
                stop: () =>
                  runtimeState === undefined ? Effect.void : runtimeState.orchestrator.stop(),
                cleanupTargets: runtimeState?.cleanupTargets ?? { dockerContainerNames: [] },
                config,
              });
              // Only certify disposal after every cleanup stage succeeds. A
              // failed attempt remains retryable through StackHandle.dispose().
              disposed = true;
            }),
          );

        yield* Effect.addFinalizer(disposeOnce);

        return {
          getInfo: () => Effect.succeed(info),
          getCleanupTargets: () =>
            Effect.succeed(runtimeState?.cleanupTargets ?? { dockerContainerNames: [] }),
          start: () =>
            Effect.gen(function* () {
              yield* Ref.set(startInFlightRef, true);
              yield* Ref.set(phaseRef, "starting");
              const runtime = yield* ensureRuntime;
              if (config.startServices.length > 0) {
                yield* activateServices(runtime, config.startServices);
              }
              yield* Ref.set(phaseRef, "starting");
              if (config.startServices.includes("edge-runtime")) {
                yield* configureFunctions(config);
              }
              const eagerNames = new Set<string>(["postgres", "postgres-init"]);
              for (const service of config.startServices) {
                for (const def of runtime.graph.startOrderFor(service)) eagerNames.add(def.name);
              }
              const eagerServices = runtime.graph.startOrder
                .map((def) => def.name)
                .filter((name) => eagerNames.has(name));
              for (const name of eagerServices) {
                yield* eagerStartService(runtime.orchestrator, name);
              }
              yield* markStarted(eagerServices);
              yield* Effect.forEach(
                eagerServices,
                (name) => waitReadyKnownService(runtime.orchestrator, name),
                { concurrency: "unbounded" },
              );
              yield* Ref.set(phaseRef, "running");
            }).pipe(
              Effect.onError(() => Ref.set(phaseRef, "stopped")),
              Effect.ensuring(Ref.set(startInFlightRef, false)),
            ),
          stop: () =>
            Effect.gen(function* () {
              if (runtimeState === undefined) {
                yield* Ref.set(phaseRef, "stopped");
                return;
              }
              yield* Ref.set(phaseRef, "stopping");
              yield* runtimeState.orchestrator.stop();
              yield* Ref.set(startedServicesRef, new Set());
              yield* Ref.set(phaseRef, "stopped");
            }),
          dispose: disposeOnce,
          startService: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              yield* requireRunningForServiceStart(name);
              const runtime = yield* ensureRuntime;
              yield* activateServices(runtime, [name]);
              if (name === "edge-runtime") yield* configureFunctions(config);
              yield* runtime.orchestrator.startService(name);
              // The orchestrator starts the full dependency closure of `name`,
              // so the started set must record every service it brought up —
              // otherwise waitAllReady()'s lazy semantics would ignore a
              // failing dependency (e.g. pgmeta started implicitly by studio).
              yield* markStarted(runtime.graph.startOrderFor(name).map((def) => def.name));
              yield* runtime.orchestrator.waitReady(name);
            }),
          stopService: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.stopService(name);
              yield* markStopped([name]);
            }),
          restartService: (name) =>
            Effect.gen(function* () {
              yield* requireKnownService(name);
              // Restart only restarts the target and its dependents, never the
              // dependency closure — a never-started lazy service would come up
              // waiting on dependencies that stay Pending forever. Reject it,
              // mirroring the waitReady guard; callers want startService here.
              const startedServices = yield* Ref.get(startedServicesRef);
              if (!startedServices.has(name)) {
                return yield* Effect.fail(
                  new StackBuildError({
                    detail: `Cannot restart service "${name}": it has not been started yet.`,
                  }),
                );
              }
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.restartService(name);
              // Idempotent: the service was necessarily already in the started set (you can't
              // restart something that was never started), but marking again is harmless and
              // keeps this call site self-contained if that invariant ever changes.
              yield* markStarted([name]);
            }),
          ensureExtensionPreload: (name) =>
            ensureExtensionPreloadLock.withPermits(1)(
              Effect.gen(function* () {
                const startInFlight = yield* Ref.get(startInFlightRef);
                if (startInFlight || (yield* Ref.get(phaseRef)) === "starting") {
                  return yield* Effect.fail(
                    new StackBuildError({
                      detail: `Cannot configure preload for extension "${name}" while the stack is starting. Wait for start() to finish and retry.`,
                    }),
                  );
                }
                // PGDATA I/O failures (missing dir, bad permissions) surface as
                // typed StackBuildErrors so daemon routes serialize them instead
                // of dying with an unstructured 500.
                const podConfIo = <A>(detail: string, io: () => Promise<A>) =>
                  Effect.tryPromise({
                    try: io,
                    catch: (cause) => new StackBuildError({ detail, cause }),
                  });
                const result = yield* podConfIo(
                  `Failed to configure preload for extension "${name}"`,
                  () => configureExtensionPreload(config.postgres.dataDir, name),
                );
                if (result !== "updated") {
                  return;
                }
                if ((yield* Ref.get(phaseRef)) !== "running") {
                  return;
                }
                yield* requireKnownService("postgres");
                const runtime = yield* ensureRuntime;
                yield* runtime.orchestrator.restartService("postgres");
                yield* markStarted(["postgres"]);
                yield* runtime.orchestrator.waitReady("postgres");
              }),
            ),
          reloadFunctions: (opts) =>
            Effect.gen(function* () {
              yield* requireKnownService("edge-runtime");
              const runtime = yield* ensureRuntime;
              yield* activateServices(runtime, ["edge-runtime"]);
              yield* configureFunctions(configWithFunctionOptions(opts));
              const started = yield* Ref.get(startedServicesRef);
              if (started.has("edge-runtime")) {
                yield* runtime.orchestrator.restartService("edge-runtime");
              } else {
                yield* runtime.orchestrator.startService("edge-runtime");
              }
              yield* markStarted(["edge-runtime"]);
              yield* runtime.orchestrator.waitReady("edge-runtime");
            }),
          reloadEdgeRuntime: (opts) =>
            Effect.gen(function* () {
              yield* requireKnownService("edge-runtime");
              const nextConfig = yield* configWithEdgeRuntimeOptions(opts);
              const runtime = yield* ensureRuntime;
              yield* activateServices(runtime, ["edge-runtime"]);
              const preparedServices = enabledServicesForConfig(config).filter(
                (service) => preparedArtifacts.resolutions[service] !== undefined,
              );
              const buildResult = yield* builder.build(
                nextConfig,
                preparedArtifacts,
                preparedServices,
              );
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
              const started = yield* Ref.get(startedServicesRef);
              if (started.has("edge-runtime")) {
                yield* runtime.orchestrator.restartService("edge-runtime");
              } else {
                yield* runtime.orchestrator.startService("edge-runtime");
              }
              yield* markStarted(["edge-runtime"]);
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
              const startedServices = yield* Ref.get(startedServicesRef);
              if (!startedServices.has(name)) {
                return yield* Effect.fail(
                  new StackBuildError({
                    detail: `Service "${name}" has not been started yet.`,
                  }),
                );
              }
              const runtime = yield* ensureRuntime;
              yield* runtime.orchestrator.waitReady(name);
            }),
          waitAllReady: () =>
            Effect.gen(function* () {
              const runtime = yield* ensureRuntime;
              // Readiness is only meaningful once start() has completed: before that the
              // started set may still be empty (start() records the eager postgres set only
              // after launching it), so an early snapshot would vacuously report "ready" while
              // postgres is still coming up. Fail instead — the daemon /ready route serializes
              // this as a 500, which is what a health poller should see mid-start (or after
              // stop).
              const phase = yield* Ref.get(phaseRef);
              if (phase !== "running") {
                return yield* Effect.fail(
                  new StackBuildError({
                    detail: `Stack is not running (phase: "${phase}"); readiness is only defined once start() has completed.`,
                  }),
                );
              }
              // Lazy: "ready" means "every service that has been started is ready". Services
              // that were never started (e.g. postgrest, still Pending until the ApiProxy's
              // ensureService calls startService on demand) never resolve their `healthy`
              // deferred and never emit a Failed state either, so waiting on them would hang
              // forever. Snapshot the started set at call time — if a service starts
              // concurrently between this read and the wait below, it's acceptable to not wait
              // on it; callers that need to observe it can call waitReady/waitAllReady again.
              const startedServices = yield* Ref.get(startedServicesRef);
              yield* Effect.forEach(
                startedServices,
                (name) => waitReadyKnownService(runtime.orchestrator, name),
                { concurrency: "unbounded" },
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
