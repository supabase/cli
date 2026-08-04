import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Context,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { buildGraph, type ResolvedGraph } from "./DependencyGraph.ts";
import { type HealthProbeCallbacks, runHealthProbe } from "./HealthProbe.ts";
import { LogBuffer } from "./LogBuffer.ts";
import type { HookTrigger, OrchestratorConfig, RestartPolicy, ServiceDef } from "./ServiceDef.ts";
import { defaults } from "./ServiceDef.ts";
import { initial } from "./ServiceState.ts";
import { makeSupervisedCommand, usesSupervisor } from "./Supervisor.ts";
import type { ServiceState } from "./ServiceState.ts";
import {
  CyclicDependencyError,
  MissingDependencyError,
  ServiceNotFoundError,
  ServiceReadyError,
  SpawnError,
} from "./errors.ts";
import { type ServiceEvent, transition } from "./ServiceTransition.ts";

const DIAGNOSTIC_LOG_LINES = 20;

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
    readonly start: () => Effect.Effect<void>;
    readonly startService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly stop: () => Effect.Effect<void>;
    readonly stopService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly restartService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
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

        interface ServiceSignals {
          readonly state: SubscriptionRef.SubscriptionRef<ServiceState>;
          started: Deferred.Deferred<void>;
          healthy: Deferred.Deferred<void>;
          completed: Deferred.Deferred<number>;
          stopped: Deferred.Deferred<void>;
          readonly readinessWaiters: Set<Deferred.Deferred<void>>;
          readonly completionWaiters: Set<Deferred.Deferred<number>>;
          stoppedByUser: boolean;
          requested: boolean;
        }
        const services = new Map<string, ServiceSignals>();

        // Initialize all signal maps for all services in the graph
        for (const def of graph.startOrder) {
          const stateRef = yield* SubscriptionRef.make(initial(def.name));
          services.set(def.name, {
            state: stateRef,
            started: Deferred.makeUnsafe<void>(),
            healthy: Deferred.makeUnsafe<void>(),
            completed: Deferred.makeUnsafe<number>(),
            stopped: Deferred.makeUnsafe<void>(),
            readinessWaiters: new Set(),
            completionWaiters: new Set(),
            stoppedByUser: false,
            requested: false,
          });
        }

        // FiberMap to track running service fibers — auto-interrupted on scope close
        const fibers = yield* FiberMap.make<string>();
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

        const signalHealthy = (svc: ServiceSignals): Effect.Effect<void> =>
          Effect.forEach(
            [svc.healthy, ...svc.readinessWaiters],
            (waiter) => Deferred.succeed(waiter, void 0),
            { discard: true },
          );

        // Helper: run all hooks for a given trigger in sequence
        const runHooks = (def: ServiceDef, trigger: HookTrigger): Effect.Effect<void> =>
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
                yield* sendEvent(def.name, {
                  _tag: "HookFailed",
                  error: `Hook (on:${trigger}) failed: ${Cause.pretty(result.cause)}`,
                });
                return;
              }
              if (Exit.isFailure(result)) {
                yield* logBuffer.append(
                  def.name,
                  "stderr",
                  `[hook-ignored] on:${trigger} hook failed: ${Cause.pretty(result.cause)}`,
                );
              }
            }
          });

        type SpawnResult =
          | { readonly _tag: "Exited"; readonly exitCode: number }
          | { readonly _tag: "UnhealthyRestart" };

        const shouldRestartOnUnhealthy = (policy: RestartPolicy): boolean => policy !== "no";

        // The full lifecycle loop for a single service
        const runService = (def: ServiceDef): Effect.Effect<void, SpawnError> =>
          Effect.gen(function* () {
            let restartCount = 0;
            const maxRestarts = def.maxRestarts ?? defaults.maxRestarts;
            const restartPolicy = def.restart ?? defaults.restart;

            // Re-create signals on each run (needed for restarts)
            const resetSignals = Effect.sync(() => {
              const svc = services.get(def.name);
              if (svc) {
                svc.started = Deferred.makeUnsafe<void>();
                svc.healthy = Deferred.makeUnsafe<void>();
                svc.completed = Deferred.makeUnsafe<number>();
                svc.stopped = Deferred.makeUnsafe<void>();
              }
            });

            // Wait for all dependencies to reach their required conditions
            const timeoutSeconds =
              def.dependencyTimeoutSeconds ?? defaults.dependencyTimeoutSeconds;
            const awaitDependenciesCore = Effect.gen(function* () {
              const deps = graph.dependenciesOf(def.name);
              for (const { def: depDef, condition } of deps) {
                if (condition === "started") {
                  const sig = services.get(depDef.name)?.started;
                  if (sig) yield* Deferred.await(sig);
                } else if (condition === "healthy") {
                  const sig = services.get(depDef.name)?.healthy;
                  if (sig) yield* Deferred.await(sig);
                } else if (condition === "completed") {
                  const sig = services.get(depDef.name)?.completed;
                  if (sig) {
                    const code = yield* Deferred.await(sig);
                    if (code !== 0) {
                      yield* sendEvent(def.name, {
                        _tag: "DependencyFailed",
                        error: `Dependency ${depDef.name} exited with code ${code}`,
                      });
                      return;
                    }
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
                  const unhealthyRestart = Deferred.makeUnsafe<void>();
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
                    ),
                  );

                  // Transition to Running
                  yield* sendEvent(def.name, {
                    _tag: "ProcessSpawned",
                    pid: handle.pid,
                    startedAt: Date.now(),
                  });

                  // Run "started" hooks before signaling dependents
                  yield* runHooks(def, "started");
                  // Check if hooks failed the service
                  const stateAfterStartedHooks = SubscriptionRef.getUnsafe(
                    services.get(def.name)!.state,
                  );
                  if (stateAfterStartedHooks.status === "Failed") {
                    return { _tag: "Exited", exitCode: 1 } as SpawnResult;
                  }
                  // Signal "started" Deferred
                  const svcStartedSig = services.get(def.name);
                  if (svcStartedSig) yield* Deferred.succeed(svcStartedSig.started, void 0);

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
                          yield* sendEvent(def.name, { _tag: "HealthCheckPassed" });
                          // Only run hooks and signal on first transition to Healthy
                          const svcSig = services.get(def.name);
                          if (svcSig) {
                            const alreadyHealthy = yield* Deferred.isDone(svcSig.healthy);
                            if (!alreadyHealthy) {
                              yield* runHooks(def, "healthy");
                              const current = SubscriptionRef.getUnsafe(svcSig.state);
                              if (current.status !== "Failed") {
                                yield* signalHealthy(svcSig);
                              }
                            }
                          }
                        }).pipe(Effect.asVoid),
                      onUnhealthy: () =>
                        Effect.gen(function* () {
                          yield* sendEvent(def.name, { _tag: "HealthCheckFailed" });
                          yield* appendRecentServiceLogs(
                            def.name,
                            `[health-check-failed] Service "${def.name}" became unhealthy. Recent output:`,
                            `[health-check-failed] Service "${def.name}" became unhealthy (no recent log output).`,
                          );
                          if (shouldRestartOnUnhealthy(restartPolicy)) {
                            yield* Deferred.succeed(unhealthyRestart, void 0);
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
                    yield* sendEvent(def.name, { _tag: "HealthCheckPassed" });
                    yield* runHooks(def, "healthy");
                    const svcSig = services.get(def.name);
                    if (svcSig) {
                      const current = SubscriptionRef.getUnsafe(svcSig.state);
                      if (current.status !== "Failed") {
                        yield* signalHealthy(svcSig);
                      }
                    }
                  }

                  // Race process exit against unhealthy restart signal.
                  // handle.exitCode fails when the process is killed by a signal
                  // (code is null, only signal is set), so we catch and treat it
                  // as exit code 143 (128 + SIGTERM).
                  const waitForExit = handle.exitCode.pipe(
                    Effect.map(
                      (code): SpawnResult => ({ _tag: "Exited", exitCode: code as number }),
                    ),
                    Effect.catch(
                      (): Effect.Effect<SpawnResult> =>
                        Effect.succeed({ _tag: "Exited", exitCode: 143 }),
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
                                  Effect.succeed({ _tag: "Exited", exitCode: 0 }),
                              ),
                            ),
                          ),
                        )
                      : Effect.never;

                  return yield* Effect.raceAll([
                    waitForExit,
                    waitForObservedOneShotExit,
                    Deferred.await(unhealthyRestart).pipe(
                      Effect.map((): SpawnResult => ({ _tag: "UnhealthyRestart" })),
                    ),
                  ]);
                }),
              );

            // Main lifecycle: await deps, then run with optional restart loop
            yield* awaitDependencies;

            // Check if we should even start (dependency might have set us Failed)
            const currentState = SubscriptionRef.getUnsafe(services.get(def.name)!.state);
            if (currentState.status === "Failed") return;

            // Transition Pending → Starting
            yield* sendEvent(def.name, { _tag: "DependenciesSatisfied" });

            let result = yield* spawnOnce();

            // Handle spawn result
            const handleResult = (r: SpawnResult) =>
              Effect.gen(function* () {
                if (r._tag === "Exited") {
                  const service = services.get(def.name);
                  if (service !== undefined) {
                    yield* Effect.forEach(
                      [service.completed, ...service.completionWaiters],
                      (waiter) => Deferred.succeed(waiter, r.exitCode),
                      { discard: true },
                    );
                  }
                  if (r.exitCode !== 0 && r.exitCode !== 143) {
                    yield* appendRecentServiceLogs(
                      def.name,
                      `[process-exited] Service "${def.name}" exited with code ${r.exitCode}. Recent output:`,
                      `[process-exited] Service "${def.name}" exited with code ${r.exitCode} (no recent log output).`,
                    );
                  }
                  yield* sendEvent(def.name, { _tag: "ProcessExited", exitCode: r.exitCode });
                }
                // UnhealthyRestart: process killed by scope closure, skip ProcessExited
              });
            yield* handleResult(result);

            // Restart loop
            const shouldRestart = (r: SpawnResult): boolean => {
              if (r._tag === "UnhealthyRestart") return true;
              if (restartPolicy === "no") return false;
              if (restartPolicy === "always") return true;
              if (restartPolicy === "unless-stopped") {
                const svc = services.get(def.name);
                return svc ? !svc.stoppedByUser : false;
              }
              if (restartPolicy === "on-failure") return r.exitCode !== 0;
              return false;
            };

            while (shouldRestart(result) && (maxRestarts === 0 || restartCount < maxRestarts)) {
              restartCount++;

              if (result._tag === "UnhealthyRestart") {
                yield* appendRecentServiceLogs(
                  def.name,
                  `[restart] Service "${def.name}" is restarting after an unhealthy health check. Recent output:`,
                  `[restart] Service "${def.name}" is restarting after an unhealthy health check (no recent log output).`,
                );
              }

              yield* sendEvent(def.name, { _tag: "RestartTriggered", restartCount });

              // Exponential-ish backoff: min(30s, 2^(n-1) seconds)
              const backoffSeconds = Math.min(30, Math.pow(2, restartCount - 1));
              yield* Effect.sleep(Duration.seconds(backoffSeconds));

              // Reset signals and transition Restarting → Starting
              yield* resetSignals;
              yield* sendEvent(def.name, { _tag: "BackoffElapsed" });

              result = yield* spawnOnce();
              yield* handleResult(result);
            }
          });

        const runServiceSafe = (def: ServiceDef) =>
          runService(def).pipe(
            Effect.catch((error) =>
              sendEvent(def.name, {
                _tag: "DependencyFailed",
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
              yield* SubscriptionRef.set(svc.state, initial(name));
              svc.started = Deferred.makeUnsafe<void>();
              svc.healthy = Deferred.makeUnsafe<void>();
              svc.completed = Deferred.makeUnsafe<number>();
              svc.stopped = Deferred.makeUnsafe<void>();
              svc.stoppedByUser = false;
            }
          });

        const stopForRestart = (name: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* sendEvent(name, { _tag: "StopRequested" });
            yield* FiberMap.remove(fibers, name);
            yield* sendEvent(name, { _tag: "ProcessExited", exitCode: 143 });
          });

        const restartClosureFor = (name: string): ReadonlyArray<ServiceDef> => {
          const names = new Set<string>([name]);
          const collectDependents = (current: string): void => {
            for (const dependent of graph.dependentsOf(current)) {
              if (names.has(dependent.name)) continue;
              names.add(dependent.name);
              collectDependents(dependent.name);
            }
          };
          collectDependents(name);
          return graph.startOrder.filter((def) => {
            const service = services.get(def.name);
            return (
              names.has(def.name) &&
              (def.name === name ||
                FiberMap.hasUnsafe(fibers, def.name) ||
                (service?.requested === true && service.stoppedByUser !== true))
            );
          });
        };

        const waitReadySingle = (def: ServiceDef): Effect.Effect<void, ServiceReadyError> =>
          Effect.suspend(() => {
            const svc = services.get(def.name);
            if (!svc) return Effect.void;
            const restartPolicy = def.restart ?? defaults.restart;

            const current = SubscriptionRef.getUnsafe(svc.state);
            if (current.status === "Failed") {
              return Effect.fail(
                new ServiceReadyError({
                  name: def.name,
                  reason: current.error ?? "Service entered Failed state",
                }),
              );
            }

            if (restartPolicy === "no") {
              const completion = Deferred.makeUnsafe<number>();
              svc.completionWaiters.add(completion);
              return Deferred.isDone(svc.completed).pipe(
                Effect.flatMap((alreadyCompleted) =>
                  alreadyCompleted
                    ? Deferred.await(svc.completed).pipe(
                        Effect.flatMap((exitCode) => Deferred.succeed(completion, exitCode)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(Deferred.await(completion)),
                Effect.flatMap((exitCode) =>
                  exitCode === 0
                    ? Effect.void
                    : Effect.fail(
                        new ServiceReadyError({
                          name: def.name,
                          reason: `One-shot service exited with code ${exitCode}`,
                          exitCode,
                        }),
                      ),
                ),
                Effect.ensuring(Effect.sync(() => svc.completionWaiters.delete(completion))),
              );
            }

            if (current.status === "Stopped") {
              return Effect.fail(
                new ServiceReadyError({
                  name: def.name,
                  reason: "Service stopped before becoming ready",
                }),
              );
            }

            // A waiter belongs to the readiness request, not to one service signal
            // generation. Dependency retries may replace svc.healthy while this
            // request is pending, so signal the stable waiter from any generation.
            const readiness = Deferred.makeUnsafe<void>();
            svc.readinessWaiters.add(readiness);
            return Deferred.isDone(svc.healthy).pipe(
              Effect.flatMap((alreadyHealthy) =>
                alreadyHealthy ? Deferred.succeed(readiness, void 0) : Effect.void,
              ),
              Effect.andThen(
                Effect.race(
                  Deferred.await(readiness),
                  SubscriptionRef.changes(svc.state).pipe(
                    Stream.filter(
                      (state) => state.status === "Failed" || state.status === "Stopped",
                    ),
                    Stream.take(1),
                    Stream.runDrain,
                    Effect.andThen(
                      Deferred.isDone(readiness).pipe(
                        Effect.flatMap((ready) => {
                          if (ready) return Effect.void;
                          const terminal = SubscriptionRef.getUnsafe(svc.state);
                          return Effect.fail(
                            new ServiceReadyError({
                              name: def.name,
                              reason:
                                terminal.status === "Stopped"
                                  ? "Service stopped before becoming ready"
                                  : (terminal.error ?? "Service entered Failed state"),
                            }),
                          );
                        }),
                      ),
                    ),
                  ),
                ),
              ),
              Effect.ensuring(Effect.sync(() => svc.readinessWaiters.delete(readiness))),
            );
          });

        return {
          start: () =>
            Effect.gen(function* () {
              for (const def of graph.startOrder) {
                const service = services.get(def.name);
                if (service !== undefined) service.requested = true;
                yield* FiberMap.run(fibers, def.name, runServiceSafe(def));
              }
            }),

          startService: (name: string) =>
            Effect.gen(function* () {
              const def = lookupDef(name);
              if (def === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              const order = graph.startOrderFor(name);
              const orderNames = new Set(order.map((service) => service.name));
              const resetNames = new Set<string>();
              let dependencySignalsReset = false;
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
                  service?.stoppedByUser !== true &&
                  restartPolicy === "no"
                ) {
                  continue;
                }

                if (status === "Failed") {
                  // The failed fiber may still be unwinding its process scope.
                  // Remove it before replacing the signals used by the retry.
                  yield* FiberMap.remove(fibers, d.name);
                  yield* resetService(d.name);
                  resetNames.add(d.name);
                  dependencySignalsReset = true;
                } else if (status === "Stopped") {
                  yield* FiberMap.remove(fibers, d.name);
                  yield* resetService(d.name);
                  resetNames.add(d.name);
                  dependencySignalsReset = true;
                } else if (dependencySignalsReset && status === "Pending") {
                  // This fiber may be waiting on Deferreds replaced by a retried dependency.
                  // Relaunch it so it observes the dependency's new signal generation.
                  yield* FiberMap.remove(fibers, d.name);
                  yield* resetService(d.name);
                  resetNames.add(d.name);
                }
                if (service !== undefined) service.requested = true;
                yield* FiberMap.run(fibers, d.name, runServiceSafe(d), { onlyIfMissing: true });
              }

              // A caller may retry a dependency directly while dependents started by an
              // earlier request are still waiting on its old Deferred generation.
              for (const d of graph.startOrder) {
                if (orderNames.has(d.name)) continue;
                const dependsOnResetService = graph
                  .startOrderFor(d.name)
                  .some((dependency) => resetNames.has(dependency.name));
                const service = services.get(d.name);
                if (
                  dependsOnResetService &&
                  service !== undefined &&
                  FiberMap.hasUnsafe(fibers, d.name) &&
                  SubscriptionRef.getUnsafe(service.state).status === "Pending"
                ) {
                  yield* FiberMap.remove(fibers, d.name);
                  yield* resetService(d.name);
                  service.requested = true;
                  yield* FiberMap.run(fibers, d.name, runServiceSafe(d), {
                    onlyIfMissing: true,
                  });
                }
              }
            }).pipe(startServiceLock.withPermit),

          stop: () =>
            Effect.gen(function* () {
              const timeoutSecs = config?.shutdownTimeoutSeconds ?? defaults.shutdownTimeoutSeconds;

              const stopAll = Effect.gen(function* () {
                const stopOne = (def: ServiceDef) =>
                  Effect.gen(function* () {
                    // Wait for all dependents to be stopped first
                    const dependents = graph.dependentsOf(def.name);
                    for (const dep of dependents) {
                      const sig = services.get(dep.name)?.stopped;
                      if (sig) yield* Deferred.await(sig);
                    }

                    // Mark as user-stopped so restart loop won't re-spawn
                    const svc = services.get(def.name);
                    if (svc) svc.stoppedByUser = true;

                    // Now safe to stop this service
                    yield* sendEvent(def.name, { _tag: "StopRequested" });
                    yield* FiberMap.remove(fibers, def.name);
                    // Force Stopped if still in Stopping (fiber was interrupted before ProcessExited)
                    yield* sendEvent(def.name, { _tag: "ProcessExited", exitCode: 143 });

                    // Signal that this service is stopped
                    const sig = services.get(def.name)?.stopped;
                    if (sig) yield* Deferred.succeed(sig, void 0);
                  });

                // Fork all stop effects in parallel
                yield* Effect.all(
                  graph.startOrder.map((def) => stopOne(def)),
                  { concurrency: "unbounded" },
                );
              });

              yield* stopAll.pipe(
                Effect.timeout(Duration.seconds(timeoutSecs)),
                Effect.catch(() =>
                  Effect.gen(function* () {
                    for (const def of graph.startOrder) {
                      yield* logBuffer.append(
                        def.name,
                        "stderr",
                        `[shutdown-timeout] Global shutdown timed out after ${timeoutSecs}s, force-interrupting`,
                      );
                    }
                    yield* FiberMap.clear(fibers);
                  }),
                ),
              );
            }),

          stopService: (name: string) =>
            Effect.gen(function* () {
              if (lookupDef(name) === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              const svc = services.get(name);
              if (svc) svc.stoppedByUser = true;
              yield* sendEvent(name, { _tag: "StopRequested" });
              yield* FiberMap.remove(fibers, name);
              // Force Stopped if still in Stopping (fiber was interrupted before ProcessExited)
              yield* sendEvent(name, { _tag: "ProcessExited", exitCode: 143 });
            }),

          restartService: (name: string) =>
            Effect.gen(function* () {
              const def = lookupDef(name);
              if (def === undefined) {
                return yield* Effect.fail(new ServiceNotFoundError({ name }));
              }
              const affected = restartClosureFor(name);

              for (const affectedDef of [...affected].reverse()) {
                yield* stopForRestart(affectedDef.name);
              }
              for (const affectedDef of affected) {
                yield* resetService(affectedDef.name);
              }
              for (const affectedDef of affected) {
                const service = services.get(affectedDef.name);
                if (service !== undefined) service.requested = true;
                yield* FiberMap.run(fibers, affectedDef.name, runServiceSafe(affectedDef));
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
            Effect.all(graph.startOrder.map(waitReadySingle), {
              concurrency: "unbounded",
            }).pipe(Effect.asVoid),
        };
      }),
    );
}
