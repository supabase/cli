import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Context,
  Option,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { buildGraph, type ResolvedGraph } from "./DependencyGraph.ts";
import { type HealthProbeCallbacks, runHealthProbe } from "./HealthProbe.ts";
import { LogBuffer } from "./LogBuffer.ts";
import { restartClosureFor } from "./RestartClosure.ts";
import {
  decideRestart,
  type LifecycleCause,
  UNHEALTHY_RESTART_EXHAUSTED_ERROR,
} from "./RestartDecision.ts";
import type {
  HookTrigger,
  OrchestratorConfig,
  ServiceDef,
  ServiceStartOptions,
} from "./ServiceDef.ts";
import { defaults } from "./ServiceDef.ts";
import { initial, ServiceState, type ServiceDesiredState } from "./ServiceState.ts";
import { makeSupervisedCommand, usesSupervisor } from "./Supervisor.ts";
import {
  CyclicDependencyError,
  MissingDependencyError,
  ServiceNotFoundError,
  ServiceReadyError,
  SpawnError,
} from "./errors.ts";
import { type ServiceEvent, transition } from "./ServiceTransition.ts";

const DIAGNOSTIC_LOG_LINES = 20;

// Some one-shot adapters report `isRunning: false` before their exit-code Effect is observable.
// Keep the compensating poll isolated here so the ordinary process-exit path remains event-driven.
const waitForProcessToStop = (handle: {
  readonly isRunning: Effect.Effect<boolean, unknown, never>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (yield* handle.isRunning.pipe(Effect.catch(() => Effect.succeed(false)))) {
      yield* Effect.sleep(Duration.millis(100));
    }
  });

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    readonly start: (options?: ServiceStartOptions) => Effect.Effect<void>;
    readonly startService: (
      name: string,
      options?: ServiceStartOptions,
    ) => Effect.Effect<void, ServiceNotFoundError>;
    readonly stop: () => Effect.Effect<void>;
    readonly stopService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly restartService: (
      name: string,
      options?: ServiceStartOptions,
    ) => Effect.Effect<void, ServiceNotFoundError>;
    readonly updateServiceDefinition: (
      name: string,
      def: ServiceDef,
    ) => Effect.Effect<void, ServiceNotFoundError | CyclicDependencyError | MissingDependencyError>;
    readonly getState: (name: string) => Effect.Effect<ServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<ServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<ServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<ServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError>;
  }
>()("process-compose/Orchestrator") {
  static layer = (
    initialGraph: ResolvedGraph,
    config?: OrchestratorConfig,
  ): Layer.Layer<Orchestrator, never, ChildProcessSpawner.ChildProcessSpawner | LogBuffer> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const logBuffer = yield* LogBuffer;
        let graph = initialGraph;

        const appendRecentServiceLogs = (
          name: string,
          header: string,
          emptyMessage: string,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            const recentLogs = yield* logBuffer.history(name, DIAGNOSTIC_LOG_LINES);
            yield* logBuffer.append(name, "stderr", header);

            if (recentLogs.length === 0) {
              yield* logBuffer.append(name, "stderr", emptyMessage);
              return;
            }

            for (const entry of recentLogs) {
              const ts = new Date(entry.timestamp).toISOString();
              yield* logBuffer.append(name, "stderr", `  | ${ts} ${entry.stream}: ${entry.line}`);
            }
          });

        interface ServiceRuntime {
          readonly state: SubscriptionRef.SubscriptionRef<ServiceState>;
        }
        const services = new Map<string, ServiceRuntime>();

        // Each service has one stable state stream for its entire lifetime.
        for (const def of graph.startOrder) {
          const stateRef = yield* SubscriptionRef.make(initial(def.name));
          services.set(def.name, {
            state: stateRef,
          });
        }

        // FiberMap to track running service fibers — auto-interrupted on scope close
        const fibers = yield* FiberMap.make<string>();
        const forceStops = new Map<string, Effect.Effect<void>>();
        const startServiceLock = Semaphore.makeUnsafe(1);

        // Helper: send a validated FSM event — only does the state transition
        const sendEvent = (
          name: string,
          event: ServiceEvent,
        ): Effect.Effect<ServiceState | null> => {
          const svc = services.get(name);
          if (svc === undefined) return Effect.succeed(null);
          return transition(svc.state, event);
        };

        const setDesired = (name: string, desired: ServiceDesiredState): Effect.Effect<void> => {
          const svc = services.get(name);
          if (svc === undefined) return Effect.void;
          return SubscriptionRef.update(svc.state, (state) =>
            state.desired === desired ? state : new ServiceState({ ...state, desired }),
          );
        };

        const waitForState = (
          service: ServiceRuntime,
          predicate: (state: ServiceState) => boolean,
        ): Effect.Effect<ServiceState> =>
          SubscriptionRef.changes(service.state).pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );

        // Helper: run all hooks for a given trigger in sequence
        const runHooks = (def: ServiceDef, trigger: HookTrigger): Effect.Effect<string | null> =>
          Effect.gen(function* () {
            const hooks = (def.hooks ?? []).filter((h) => h.on === trigger);
            for (const hook of hooks) {
              const timeout = hook.timeoutSeconds ?? defaults.hookTimeoutSeconds;
              const log = (stream: "stdout" | "stderr", line: string) =>
                logBuffer.append(def.name, stream, line);
              const result = yield* hook
                .run(log)
                .pipe(Effect.timeout(Duration.seconds(timeout)), Effect.exit);
              if (Exit.isFailure(result) && (hook.failurePolicy ?? "fail") === "fail") {
                return `Hook (on:${trigger}) failed: ${Cause.pretty(result.cause)}`;
              }
              if (Exit.isFailure(result)) {
                yield* logBuffer.append(
                  def.name,
                  "stderr",
                  `[hook-ignored] on:${trigger} hook failed: ${Cause.pretty(result.cause)}`,
                );
              }
            }
            return null;
          });

        type SpawnResult =
          | { readonly _tag: "ProcessExit"; readonly exitCode: number }
          | { readonly _tag: "Unhealthy" }
          | { readonly _tag: "HookFailed"; readonly error: string };

        // The full lifecycle loop for a single service
        const runService = (
          def: ServiceDef,
          options?: ServiceStartOptions,
        ): Effect.Effect<void, SpawnError> =>
          Effect.gen(function* () {
            let restartCount = 0;
            const maxRestarts = def.maxRestarts ?? defaults.maxRestarts;
            const restartPolicy = def.restart ?? defaults.restart;
            const prepareStart = () =>
              options
                ?.beforeStart?.(def.name)
                .pipe(
                  Effect.mapError((cause) => new SpawnError({ service: def.command, cause })),
                ) ?? Effect.void;

            yield* prepareStart();

            // Wait for all dependencies to reach their required conditions
            const timeoutSeconds =
              def.dependencyTimeoutSeconds ?? defaults.dependencyTimeoutSeconds;
            const awaitDependenciesCore = Effect.gen(function* () {
              const deps = graph.dependenciesOf(def.name);
              for (const { def: depDef, condition } of deps) {
                const dependency = services.get(depDef.name);
                if (dependency === undefined) continue;
                if (condition === "started") {
                  yield* waitForState(
                    dependency,
                    (state) =>
                      state.desired === "running" &&
                      (state.status === "Running" ||
                        state.status === "Healthy" ||
                        state.status === "Unhealthy" ||
                        (state.status === "Stopped" && state.exitCode === 0)),
                  );
                } else if (condition === "healthy") {
                  const ready = yield* waitForState(
                    dependency,
                    (state) =>
                      state.desired === "running" &&
                      (state.status === "Healthy" || state.status === "Failed"),
                  );
                  if (ready.status === "Failed") {
                    yield* sendEvent(def.name, {
                      _tag: "DependencyFailed",
                      error: `Dependency ${depDef.name} failed: ${ready.error ?? "unknown failure"}`,
                    });
                    return;
                  }
                } else if (condition === "completed") {
                  const completed = yield* waitForState(
                    dependency,
                    (state) =>
                      state.status === "Failed" ||
                      (state.status === "Stopped" && state.exitCode !== null),
                  );
                  if (completed.status === "Failed") {
                    yield* sendEvent(def.name, {
                      _tag: "DependencyFailed",
                      error: `Dependency ${depDef.name} failed: ${completed.error ?? "unknown failure"}`,
                    });
                    return;
                  }
                  if (completed.exitCode !== 0) {
                    yield* sendEvent(def.name, {
                      _tag: "DependencyFailed",
                      error: `Dependency ${depDef.name} exited with code ${completed.exitCode}`,
                    });
                    return;
                  }
                }
              }
            });
            const awaitDependencies = awaitDependenciesCore.pipe(
              Effect.timeout(Duration.seconds(timeoutSeconds)),
              Effect.catch(() =>
                sendEvent(def.name, {
                  _tag: "DependencyFailed",
                  error: `Timed out after ${timeoutSeconds}s waiting for dependencies`,
                }).pipe(Effect.asVoid),
              ),
            );

            // Run a single spawn-and-wait cycle; returns exit code or unhealthy restart signal.
            // Caller must transition to Starting before calling this.
            const spawnOnce = (): Effect.Effect<SpawnResult, SpawnError> =>
              Effect.scoped(
                Effect.gen(function* () {
                  const generationResult = Deferred.makeUnsafe<SpawnResult>();
                  const supervised = usesSupervisor(def);

                  // Build command
                  const cmd = supervised
                    ? makeSupervisedCommand(def)
                    : ChildProcess.make(def.command, def.args ?? [], {
                        cwd: def.cwd,
                        env: def.env,
                        extendEnv: true,
                        stdin: "ignore",
                      });

                  // Release external resources such as port reservations only
                  // once dependencies are satisfied and spawning is imminent.
                  // For supervised external processes, this can still leave a wider
                  // spawn-to-bind window because the supervisor starts before its
                  // child binds published ports. Closing that gap would require an
                  // explicit supervisor/child handshake.
                  yield* options?.beforeSpawn?.(def.name) ?? Effect.void;

                  // Spawn the process
                  const handle = yield* spawner
                    .spawn(cmd)
                    .pipe(
                      Effect.mapError((cause) => new SpawnError({ service: def.command, cause })),
                    );

                  const waitForHandleExit = handle.exitCode.pipe(
                    Effect.asVoid,
                    Effect.catch(() => Effect.void),
                  );

                  const sendSignal = (signal: ChildProcess.Signal): Effect.Effect<void> =>
                    handle
                      .kill({ killSignal: signal })
                      .pipe(Effect.asVoid, Effect.ignore, Effect.andThen(waitForHandleExit));

                  forceStops.set(def.name, sendSignal("SIGKILL"));

                  const runCleanup = () =>
                    def.cleanup == null
                      ? Effect.void
                      : def.cleanup.pipe(
                          Effect.catchCause((cause) =>
                            logBuffer.append(
                              def.name,
                              "stderr",
                              `[cleanup-failed] ${Cause.pretty(cause)}`,
                            ),
                          ),
                        );

                  // Register finalizer: graceful shutdown then SIGKILL fallback.
                  // Tree teardown for supervised services is owned by the supervisor.
                  yield* Effect.addFinalizer(() =>
                    sendSignal(def.shutdown?.signal ?? defaults.shutdown.signal).pipe(
                      Effect.timeout(
                        Duration.seconds(
                          def.shutdown?.timeoutSeconds ?? defaults.shutdown.timeoutSeconds,
                        ),
                      ),
                      Effect.catch(() =>
                        sendSignal("SIGKILL").pipe(
                          Effect.andThen(
                            logBuffer.append(
                              def.name,
                              "stderr",
                              "Shutdown timed out, sent SIGKILL",
                            ),
                          ),
                        ),
                      ),
                      Effect.catch(() => Effect.void),
                      Effect.andThen(runCleanup()),
                      Effect.ensuring(Effect.sync(() => forceStops.delete(def.name))),
                    ),
                  );

                  // Keep the service in Starting until its started hooks pass,
                  // so Running is the stable dependency signal.
                  const startedHookError = yield* runHooks(def, "started");
                  if (startedHookError !== null) {
                    return { _tag: "HookFailed", error: startedHookError };
                  }
                  yield* sendEvent(def.name, {
                    _tag: "ProcessSpawned",
                    pid: handle.pid,
                    startedAt: Date.now(),
                  });

                  // Fork log streaming (stdout + stderr) — decode binary to text lines
                  yield* handle.stdout
                    .pipe(
                      Stream.decodeText,
                      Stream.splitLines,
                      Stream.runForEach((line) => logBuffer.append(def.name, "stdout", line)),
                    )
                    .pipe(
                      Effect.catch(() => Effect.void),
                      Effect.forkChild,
                    );

                  yield* handle.stderr
                    .pipe(
                      Stream.decodeText,
                      Stream.splitLines,
                      Stream.runForEach((line) => logBuffer.append(def.name, "stderr", line)),
                    )
                    .pipe(
                      Effect.catch(() => Effect.void),
                      Effect.forkChild,
                    );

                  // Health checking
                  if (def.healthCheck) {
                    const callbacks: HealthProbeCallbacks = {
                      onHealthy: () =>
                        Effect.gen(function* () {
                          const service = services.get(def.name);
                          if (service === undefined) return;
                          const current = SubscriptionRef.getUnsafe(service.state);
                          if (current.status === "Running" || current.status === "Unhealthy") {
                            const healthyHookError = yield* runHooks(def, "healthy");
                            if (healthyHookError !== null) {
                              yield* Deferred.succeed(generationResult, {
                                _tag: "HookFailed",
                                error: healthyHookError,
                              });
                              return;
                            }
                          }
                          yield* sendEvent(def.name, { _tag: "HealthCheckPassed" });
                        }).pipe(Effect.asVoid),
                      onUnhealthy: () =>
                        Effect.gen(function* () {
                          yield* sendEvent(def.name, { _tag: "HealthCheckFailed" });
                          yield* appendRecentServiceLogs(
                            def.name,
                            `[health-check-failed] Service "${def.name}" became unhealthy. Recent output:`,
                            `[health-check-failed] Service "${def.name}" became unhealthy (no recent log output).`,
                          );
                          if (restartPolicy !== "no") {
                            yield* Deferred.succeed(generationResult, { _tag: "Unhealthy" });
                          }
                        }),
                    };
                    yield* runHealthProbe({
                      name: def.name,
                      healthCheck: def.healthCheck,
                      callbacks,
                    }).pipe(
                      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                      Effect.forkChild,
                    );
                  } else {
                    const healthyHookError = yield* runHooks(def, "healthy");
                    if (healthyHookError !== null) {
                      return { _tag: "HookFailed", error: healthyHookError };
                    }
                    yield* sendEvent(def.name, { _tag: "HealthCheckPassed" });
                  }

                  // Race process exit against unhealthy restart signal.
                  // handle.exitCode fails when the process is killed by a signal
                  // (code is null, only signal is set), so we catch and treat it
                  // as exit code 143 (128 + SIGTERM).
                  const waitForExit = handle.exitCode.pipe(
                    Effect.map(
                      (code): SpawnResult => ({ _tag: "ProcessExit", exitCode: Number(code) }),
                    ),
                    Effect.catch(
                      (): Effect.Effect<SpawnResult> =>
                        Effect.succeed({ _tag: "ProcessExit", exitCode: 143 }),
                    ),
                  );
                  const waitForObservedOneShotExit =
                    restartPolicy === "no" && def.healthCheck == null
                      ? waitForProcessToStop(handle).pipe(
                          Effect.andThen(
                            waitForExit.pipe(
                              Effect.timeout(Duration.millis(100)),
                              Effect.catch(
                                (): Effect.Effect<SpawnResult> =>
                                  Effect.succeed({ _tag: "ProcessExit", exitCode: 0 }),
                              ),
                            ),
                          ),
                        )
                      : Effect.never;

                  return yield* Effect.raceAll([
                    waitForExit,
                    waitForObservedOneShotExit,
                    Deferred.await(generationResult),
                  ]);
                }),
              );

            // Main lifecycle: await deps, then run with optional restart loop
            yield* awaitDependencies;

            // Check if we should even start (dependency might have set us Failed)
            const currentState = SubscriptionRef.getUnsafe(services.get(def.name)!.state);
            if (currentState.status === "Failed" || currentState.desired !== "running") return;

            // Transition Pending → Starting
            yield* sendEvent(def.name, { _tag: "DependenciesSatisfied" });

            let result = yield* spawnOnce();

            // Handle spawn result
            const handleResult = (r: SpawnResult) =>
              Effect.gen(function* () {
                if (r._tag === "ProcessExit") {
                  if (r.exitCode !== 0 && r.exitCode !== 143) {
                    yield* appendRecentServiceLogs(
                      def.name,
                      `[process-exited] Service "${def.name}" exited with code ${r.exitCode}. Recent output:`,
                      `[process-exited] Service "${def.name}" exited with code ${r.exitCode} (no recent log output).`,
                    );
                  }
                  yield* sendEvent(def.name, { _tag: "ProcessExited", exitCode: r.exitCode });
                } else if (r._tag === "HookFailed") {
                  yield* sendEvent(def.name, { _tag: "HookFailed", error: r.error });
                } else {
                  yield* sendEvent(def.name, { _tag: "ProcessTerminated" });
                }
                // Unhealthy is already recorded by the probe. Scope finalization
                // terminates its process without inventing a process exit code.
              });
            yield* handleResult(result);

            const restartDecision = (r: SpawnResult) => {
              const svc = services.get(def.name);
              const desired =
                svc === undefined ? "inactive" : SubscriptionRef.getUnsafe(svc.state).desired;
              if (r._tag === "HookFailed") {
                return { _tag: "Terminate", reason: "PolicyDisabled" } as const;
              }
              const cause: LifecycleCause =
                r._tag === "ProcessExit"
                  ? { _tag: "ProcessExit", exitCode: r.exitCode }
                  : { _tag: "Unhealthy" };
              return decideRestart({
                cause,
                policy: restartPolicy,
                restartCount,
                maxRestarts,
                desired,
              });
            };

            let decision = restartDecision(result);
            while (decision._tag === "Restart") {
              restartCount = decision.restartCount;

              yield* sendEvent(def.name, { _tag: "RestartTriggered", restartCount });

              // The previous process scope has closed, so external resources can
              // be reserved safely for the duration of this restart's backoff.
              yield* prepareStart();

              if (result._tag === "Unhealthy") {
                yield* appendRecentServiceLogs(
                  def.name,
                  `[restart] Service "${def.name}" is restarting after an unhealthy health check. Recent output:`,
                  `[restart] Service "${def.name}" is restarting after an unhealthy health check (no recent log output).`,
                );
              }

              // Exponential-ish backoff: min(30s, 2^(n-1) seconds)
              const backoffSeconds = Math.min(30, Math.pow(2, restartCount - 1));
              yield* Effect.sleep(Duration.seconds(backoffSeconds));

              // Transition Restarting → Starting. State subscribers remain
              // attached across every restart generation.
              yield* sendEvent(def.name, { _tag: "BackoffElapsed" });

              result = yield* spawnOnce();
              yield* handleResult(result);
              decision = restartDecision(result);
            }

            if (
              result._tag === "Unhealthy" &&
              decision._tag === "Terminate" &&
              decision.reason === "BudgetExhausted"
            ) {
              yield* sendEvent(def.name, {
                _tag: "UnhealthyRestartExhausted",
                error: UNHEALTHY_RESTART_EXHAUSTED_ERROR,
              });
            }
          });

        const runServiceSafe = (def: ServiceDef, options?: ServiceStartOptions) =>
          runService(def, options).pipe(
            Effect.catch((error) =>
              sendEvent(def.name, {
                _tag: "SpawnFailed",
                error: `Spawn failed: ${error.service} - ${String(error.cause)}`,
              }).pipe(Effect.asVoid),
            ),
          );

        const lookupDef = (name: string): ServiceDef | undefined =>
          graph.startOrder.find((d) => d.name === name);

        const resetService = (name: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            const svc = services.get(name);
            if (svc) {
              const desired = SubscriptionRef.getUnsafe(svc.state).desired;
              yield* SubscriptionRef.set(svc.state, initial(name, desired));
            }
          });

        const stopForRestart = (name: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* sendEvent(name, { _tag: "StopRequested" });
            yield* FiberMap.remove(fibers, name);
            yield* sendEvent(name, { _tag: "ProcessExited", exitCode: 143 });
          });

        const restartClosure = (name: string): ReadonlyArray<ServiceDef> => {
          const activeServices = new Set(
            graph.startOrder
              .filter((def) => {
                const service = services.get(def.name);
                return (
                  FiberMap.hasUnsafe(fibers, def.name) ||
                  (service !== undefined &&
                    SubscriptionRef.getUnsafe(service.state).desired === "running")
                );
              })
              .map((def) => def.name),
          );
          const closure = new Set(
            restartClosureFor(
              {
                order: graph.startOrder.map((def) => def.name),
                dependentsOf: (service) => graph.dependentsOf(service).map((def) => def.name),
              },
              name,
              activeServices,
            ),
          );
          return graph.startOrder.filter((def) => closure.has(def.name));
        };

        const waitReadySingle = (def: ServiceDef): Effect.Effect<void, ServiceReadyError> =>
          Effect.suspend(() => {
            const svc = services.get(def.name);
            if (!svc) return Effect.void;
            const willRestartAfterExit = (state: ServiceState): boolean => {
              if (state.exitCode === null) return false;
              return (
                decideRestart({
                  cause: { _tag: "ProcessExit", exitCode: state.exitCode },
                  policy: def.restart ?? defaults.restart,
                  restartCount: state.restartCount,
                  maxRestarts: def.maxRestarts ?? defaults.maxRestarts,
                  desired: state.desired,
                })._tag === "Restart"
              );
            };

            const current = SubscriptionRef.getUnsafe(svc.state);
            if (current.desired !== "running") {
              return Effect.fail(
                new ServiceReadyError({
                  name: def.name,
                  reason:
                    current.desired === "inactive"
                      ? "Service has not been started"
                      : "Service was explicitly stopped",
                }),
              );
            }
            if (current.status === "Failed" && !willRestartAfterExit(current)) {
              return Effect.fail(
                new ServiceReadyError({
                  name: def.name,
                  reason: current.error ?? "Service entered Failed state",
                }),
              );
            }

            if ((def.restart ?? defaults.restart) === "no" && def.healthCheck == null) {
              return waitForState(
                svc,
                (state) => state.status === "Failed" || state.status === "Stopped",
              ).pipe(
                Effect.flatMap((terminal) =>
                  terminal.status === "Stopped" && terminal.exitCode === 0
                    ? Effect.void
                    : Effect.fail(
                        new ServiceReadyError({
                          name: def.name,
                          reason:
                            terminal.exitCode === null
                              ? (terminal.error ?? "Service entered Failed state")
                              : `One-shot service exited with code ${terminal.exitCode}`,
                          ...(terminal.exitCode === null ? {} : { exitCode: terminal.exitCode }),
                        }),
                      ),
                ),
              );
            }

            return waitForState(
              svc,
              (state) =>
                state.status === "Healthy" ||
                ((state.status === "Failed" || state.status === "Stopped") &&
                  !willRestartAfterExit(state)),
            ).pipe(
              Effect.flatMap((ready) => {
                if (ready.status === "Healthy") return Effect.void;
                return Effect.fail(
                  new ServiceReadyError({
                    name: def.name,
                    reason:
                      ready.status === "Stopped"
                        ? "Service stopped before becoming ready"
                        : (ready.error ?? "Service entered Failed state"),
                  }),
                );
              }),
            );
          });

        return {
          start: (options) =>
            Effect.gen(function* () {
              for (const def of graph.startOrder) {
                yield* setDesired(def.name, "running");
                yield* FiberMap.run(fibers, def.name, runServiceSafe(def, options));
              }
            }),

          startService: (name: string, options) =>
            Effect.gen(function* () {
              const def = lookupDef(name);
              if (def === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              const order = graph.startOrderFor(name);
              for (const d of order) {
                const service = services.get(d.name);
                const state = service?.state;
                const status =
                  state === undefined ? undefined : SubscriptionRef.getUnsafe(state).status;
                const restartPolicy = d.restart ?? defaults.restart;

                // A successful one-shot remains a satisfied dependency after its
                // process exits. Naturally stopped long-running services can be
                // started again even when their restart policy did not relaunch them.
                if (
                  status === "Stopped" &&
                  d.name !== name &&
                  service !== undefined &&
                  SubscriptionRef.getUnsafe(service.state).desired !== "stopped" &&
                  restartPolicy === "no"
                ) {
                  continue;
                }

                if (status === "Failed") {
                  // The failed fiber may still be unwinding its process scope.
                  // Remove it before resetting the state used by the retry.
                  yield* FiberMap.remove(fibers, d.name);
                  yield* resetService(d.name);
                } else if (status === "Stopped") {
                  yield* FiberMap.remove(fibers, d.name);
                  yield* resetService(d.name);
                }
                yield* setDesired(d.name, "running");
                yield* FiberMap.run(fibers, d.name, runServiceSafe(d, options), {
                  onlyIfMissing: true,
                });
              }
            }).pipe(startServiceLock.withPermit),

          stop: () =>
            Effect.gen(function* () {
              const timeoutSecs = config?.shutdownTimeoutSeconds ?? defaults.shutdownTimeoutSeconds;
              const desiredBeforeStop = new Map(
                graph.startOrder.map((def) => {
                  const svc = services.get(def.name);
                  return [
                    def.name,
                    svc === undefined ? "inactive" : SubscriptionRef.getUnsafe(svc.state).desired,
                  ] as const;
                }),
              );

              yield* Effect.forEach(
                graph.startOrder.filter((def) => desiredBeforeStop.get(def.name) === "running"),
                (def) => setDesired(def.name, "stopped"),
                { discard: true },
              );

              const stopAll = Effect.gen(function* () {
                const waitUntilStopped = (name: string) => {
                  const service = services.get(name);
                  return service === undefined
                    ? Effect.void
                    : waitForState(
                        service,
                        (state) => state.desired === "inactive" || state.status === "Stopped",
                      ).pipe(Effect.asVoid);
                };
                const stopOne = (def: ServiceDef) =>
                  Effect.gen(function* () {
                    if (desiredBeforeStop.get(def.name) === "inactive") {
                      return;
                    }
                    // Wait for all dependents to be stopped first
                    const dependents = graph.dependentsOf(def.name);
                    for (const dep of dependents) {
                      yield* waitUntilStopped(dep.name);
                    }

                    // Now safe to stop this service
                    yield* sendEvent(def.name, { _tag: "StopRequested" });
                    yield* FiberMap.remove(fibers, def.name);
                    // Force Stopped if still in Stopping (fiber was interrupted before ProcessExited)
                    yield* sendEvent(def.name, { _tag: "ProcessExited", exitCode: 143 });
                  });

                // Fork all stop effects in parallel
                yield* Effect.all(
                  graph.startOrder.map((def) => stopOne(def)),
                  { concurrency: "unbounded" },
                );
              });

              const stopFiber = yield* Effect.forkChild(stopAll);
              const stoppedInTime = yield* Effect.race(
                Fiber.await(stopFiber).pipe(Effect.as(true)),
                Effect.sleep(Duration.seconds(timeoutSecs)).pipe(Effect.as(false)),
              );

              if (!stoppedInTime) {
                for (const def of graph.startOrder) {
                  yield* logBuffer.append(
                    def.name,
                    "stderr",
                    `[shutdown-timeout] Global shutdown timed out after ${timeoutSecs}s, force-interrupting`,
                  );
                }
                yield* Effect.all(forceStops.values(), { concurrency: "unbounded" });
                yield* Fiber.await(stopFiber);
              }
            }),

          stopService: (name: string) =>
            Effect.gen(function* () {
              if (lookupDef(name) === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              const affected = restartClosure(name);
              for (const affectedDef of [...affected].reverse()) {
                yield* setDesired(affectedDef.name, "stopped");
                yield* sendEvent(affectedDef.name, { _tag: "StopRequested" });
                yield* FiberMap.remove(fibers, affectedDef.name);
                yield* sendEvent(affectedDef.name, { _tag: "ProcessExited", exitCode: 143 });
              }
            }),

          restartService: (name: string, options) =>
            Effect.gen(function* () {
              const def = lookupDef(name);
              if (def === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              const affected = restartClosure(name);

              for (const affectedDef of [...affected].reverse()) {
                yield* stopForRestart(affectedDef.name);
              }
              for (const affectedDef of affected) {
                yield* resetService(affectedDef.name);
                yield* setDesired(affectedDef.name, "running");
              }
              for (const affectedDef of affected) {
                yield* FiberMap.run(fibers, affectedDef.name, runServiceSafe(affectedDef, options));
              }
            }),

          updateServiceDefinition: (name: string, def: ServiceDef) =>
            Effect.gen(function* () {
              const existing = lookupDef(name);
              if (existing === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }

              const replacement = def.name === name ? def : { ...def, name };
              const nextGraph = yield* buildGraph(
                graph.startOrder.map((current) => (current.name === name ? replacement : current)),
              );
              graph = nextGraph;
            }),

          getState: (name: string) =>
            Effect.gen(function* () {
              const svc = services.get(name);
              if (svc === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              return SubscriptionRef.getUnsafe(svc.state);
            }),

          getAllStates: () =>
            Effect.sync(() =>
              graph.startOrder.map((def) => {
                const svc = services.get(def.name);
                return svc ? SubscriptionRef.getUnsafe(svc.state) : initial(def.name);
              }),
            ),

          stateChanges: (name: string) =>
            Effect.gen(function* () {
              const svc = services.get(name);
              if (svc === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              return SubscriptionRef.changes(svc.state);
            }),

          allStateChanges: () => {
            const streams = graph.startOrder.map((def) => {
              const svc = services.get(def.name);
              return svc ? SubscriptionRef.changes(svc.state) : Stream.empty;
            });
            return Stream.mergeAll(streams, { concurrency: "unbounded" });
          },

          waitReady: (name: string) =>
            Effect.gen(function* () {
              const def = lookupDef(name);
              if (def === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              yield* waitReadySingle(def);
            }),

          waitAllReady: () =>
            Effect.all(
              graph.startOrder
                .filter((def) => {
                  const svc = services.get(def.name);
                  return (
                    svc !== undefined && SubscriptionRef.getUnsafe(svc.state).desired === "running"
                  );
                })
                .map(waitReadySingle),
              { concurrency: "unbounded" },
            ).pipe(Effect.asVoid),
        };
      }),
    );
}
