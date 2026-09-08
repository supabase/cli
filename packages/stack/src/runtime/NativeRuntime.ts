import { Cause, Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import type * as ChildProcessSpawnerService from "effect/unstable/process/ChildProcessSpawner";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import { LogStoreError } from "../supervisor/LogStore.ts";
import {
  RuntimeDriverError,
  type RuntimeCleanupRequest,
  type ObservedWorkload,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";
import {
  NativeProcessError,
  spawnNativeProcess,
  type NativeProcess,
  type NativeProcessLauncher,
  type NativeProcessSpec,
} from "./NativeProcess.ts";

export interface NativeRuntimeOptions {
  /**
   * Resolves the process-ownership launcher. Development defaults use the
   * bundled native-launcher entrypoint.
   */
  readonly resolveLauncher?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
  ) => Effect.Effect<NativeProcessLauncher, RuntimeDriverError>;
  /** Resolves the complete native process plan for one workload. */
  readonly resolveProcess: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
  ) => Effect.Effect<NativeProcessPlan, RuntimeDriverError>;
  /** Private readiness is resolved by the owning Supervisor/gateway seam. */
  readonly waitForReadiness: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    process: NativeProcess,
  ) => Effect.Effect<void, RuntimeDriverError>;
  /** Runs the one-shot initial database bootstrap after readiness. */
  readonly bootstrapDatabase?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    process?: NativeProcess,
  ) => Effect.Effect<void, RuntimeDriverError>;
  readonly logStore?: LogStore;
}

/** One-shot startup processes followed by the long-lived workload process. */
interface NativeProcessPlan {
  readonly startup: ReadonlyArray<NativeProcessSpec>;
  readonly main: NativeProcessSpec;
}

interface OutputAccumulator {
  readonly decoder: TextDecoder;
  remainder: string;
}

interface Resource {
  readonly key: RuntimeWorkloadKey;
  readonly workload: PlannedWorkload;
  readonly scope: Scope.Closeable;
  readonly state: Ref.Ref<ObservedWorkload>;
  readonly output: Readonly<{ stdout: OutputAccumulator; stderr: OutputAccumulator }>;
  readonly result: Deferred.Deferred<ObservedWorkload, RuntimeDriverError>;
  readonly failure: Deferred.Deferred<never, RuntimeDriverError>;
  stopRequested: boolean;
  process?: NativeProcess;
  startFiber?: Fiber.Fiber<unknown, unknown>;
}

const resourceKey = (key: RuntimeWorkloadKey): string =>
  JSON.stringify([key.stackId, key.workloadId]);

const sameKey = (left: RuntimeWorkloadKey, right: RuntimeWorkloadKey): boolean =>
  left.stackId === right.stackId && left.workloadId === right.workloadId;

const driverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  message: string,
  cause?: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message,
    stackId: key.stackId,
    workloadId: key.workloadId,
    ...(cause === undefined ? {} : { cause }),
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const processError = (
  error: unknown,
  key: RuntimeWorkloadKey,
  operation: string,
): RuntimeDriverError =>
  driverError(
    key,
    `Native ${operation} failed for ${key.workloadId}: ${errorMessage(error)}`,
    error,
  );

const appendLines = (
  logStore: LogStore,
  resource: Resource,
  stream: "stdout" | "stderr",
  bytes: Uint8Array,
): Effect.Effect<void, LogStoreError> => {
  const accumulator = resource.output[stream];
  accumulator.remainder += accumulator.decoder.decode(bytes, { stream: true });
  const lines = accumulator.remainder.split(/\r?\n/);
  accumulator.remainder = lines.pop() ?? "";
  return Effect.forEach(
    lines,
    (message) => logStore.append({ source: resource.workload.capability, stream, message }),
    { discard: true },
  );
};

const flushLines = (
  logStore: LogStore,
  resource: Resource,
  stream: "stdout" | "stderr",
): Effect.Effect<void, LogStoreError> => {
  const accumulator = resource.output[stream];
  accumulator.remainder += accumulator.decoder.decode();
  if (accumulator.remainder.length === 0) return Effect.void;
  const message = accumulator.remainder;
  accumulator.remainder = "";
  return logStore
    .append({ source: resource.workload.capability, stream, message })
    .pipe(Effect.asVoid);
};

const observeOutput = (
  logStore: LogStore,
  resource: Resource,
  process: NativeProcess,
  stream: "stdout" | "stderr",
) =>
  Stream.runForEach(process[stream], (bytes) =>
    appendLines(logStore, resource, stream, bytes),
  ).pipe(Effect.andThen(flushLines(logStore, resource, stream)));

/** Creates a Supervisor-owned native runtime with exact process identity fencing. */
export const makeNativeRuntime = (
  options: NativeRuntimeOptions,
): Effect.Effect<
  RuntimeDriver,
  RuntimeDriverError,
  ChildProcessSpawnerService.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const childSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const parentScope = yield* Scope.Scope;
    const runtimeScope = yield* Scope.fork(parentScope, "parallel");
    const registration = yield* Semaphore.make(1);
    const resources = new Map<string, Resource>();

    const cleanup = (resource: Resource): Effect.Effect<void, never> =>
      Scope.close(resource.scope, Exit.void).pipe(
        Effect.asVoid,
        Effect.andThen(
          Effect.sync(() => {
            const id = resourceKey(resource.key);
            if (resources.get(id) === resource) resources.delete(id);
          }),
        ),
      );

    const watchProcess = (
      resource: Resource,
      process: NativeProcess,
      exitCode: Effect.Effect<ExitCode, NativeProcessError>,
    ) =>
      Effect.gen(function* () {
        const result = yield* exitCode.pipe(Effect.exit);
        const next: ObservedWorkload = Exit.isSuccess(result)
          ? {
              ...resource.key,
              state: resource.stopRequested ? "stopped" : "failed",
              ...(resource.stopRequested
                ? {}
                : { error: "Native workload exited before an explicit stop" }),
            }
          : {
              ...resource.key,
              state: resource.stopRequested ? "stopped" : "failed",
              ...(resource.stopRequested ? {} : { error: Cause.pretty(result.cause) }),
            };
        yield* Ref.update(resource.state, (current): ObservedWorkload =>
          current.state === "failed" ? current : next,
        );
        if (!resource.stopRequested && Exit.isFailure(result))
          yield* Deferred.fail(
            resource.failure,
            driverError(resource.key, `Native workload exited before readiness`, result.cause),
          );
      }).pipe(Effect.ignore);

    const reportLogFailure = (
      resource: Resource,
      error: LogStoreError | NativeProcessError,
    ): Effect.Effect<void> => {
      if (resource.stopRequested) return Effect.void;
      const failure = driverError(
        resource.key,
        `Native log stream failed for ${resource.key.workloadId}: ${error.message}`,
        error,
      );
      return Ref.modify(resource.state, (current) => {
        if (current.state === "stopped" || current.state === "failed")
          return [false, current] satisfies readonly [boolean, ObservedWorkload];
        const next: ObservedWorkload = { ...current, state: "failed", error: failure.message };
        return [true, next] satisfies readonly [boolean, ObservedWorkload];
      }).pipe(
        Effect.flatMap((changed) =>
          changed ? Deferred.fail(resource.failure, failure).pipe(Effect.asVoid) : Effect.void,
        ),
      );
    };

    const attachLogs = (resource: Resource, process: NativeProcess) => {
      const logStore = options.logStore;
      if (logStore === undefined) return Effect.void;
      const runOutput = (stream: "stdout" | "stderr") =>
        observeOutput(logStore, resource, process, stream).pipe(
          Effect.catch((error) => reportLogFailure(resource, error)),
        );
      return Effect.all([runOutput("stdout"), runOutput("stderr")], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.forkIn(resource.scope), Effect.asVoid);
    };

    /** Runs one short-lived, service-owned startup process in its own scope. */
    const runStartupProcess = (
      resource: Resource,
      spec: NativeProcessSpec,
      launcher: NativeProcessLauncher | undefined,
      phase: "startup",
    ): Effect.Effect<void, RuntimeDriverError> =>
      Effect.gen(function* () {
        const startupScope = yield* Scope.fork(resource.scope, "parallel");
        let started: NativeProcess | undefined;
        const run = Effect.gen(function* () {
          const process = yield* spawnNativeProcess(spec, launcher, resource.key).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childSpawner),
            Scope.provide(startupScope),
            Effect.mapError((error) => processError(error, resource.key, `${phase} spawn`)),
          );
          started = process;
          const exitCode = yield* Effect.cached(
            process.exitCode.pipe(
              Effect.mapError((error) => processError(error, resource.key, `${phase} wait`)),
            ),
          );
          const consume =
            options.logStore === undefined
              ? Effect.all([Stream.runDrain(process.stdout), Stream.runDrain(process.stderr)], {
                  concurrency: "unbounded",
                  discard: true,
                })
              : Effect.all(
                  [
                    observeOutput(options.logStore, resource, process, "stdout"),
                    observeOutput(options.logStore, resource, process, "stderr"),
                  ],
                  { concurrency: "unbounded", discard: true },
                );
          const consumed = consume.pipe(
            Effect.mapError((error) =>
              driverError(
                resource.key,
                `Native ${phase} log stream failed for ${resource.key.workloadId}: ${errorMessage(error)}`,
                error,
              ),
            ),
          );
          const outputFiber = yield* Effect.forkIn(consumed, startupScope);
          // A one-shot process is complete only after both its exit and output
          // streams have completed. Effect.all keeps the stream drain alive
          // when the child exits before its pipes finish, while a stream
          // failure interrupts the exit waiter and startup cleanup kills the
          // exact child.
          const completed = Effect.all([exitCode.pipe(Effect.asVoid), Fiber.join(outputFiber)], {
            concurrency: "unbounded",
            discard: true,
          });
          yield* spec.timeout === undefined
            ? completed
            : completed.pipe(
                Effect.timeoutOrElse({
                  duration: spec.timeout,
                  orElse: () =>
                    Effect.fail(
                      driverError(
                        resource.key,
                        `Native ${phase} process timed out for ${resource.key.workloadId}`,
                      ),
                    ),
                }),
              );
          const result = yield* exitCode.pipe(Effect.exit);
          if (Exit.isFailure(result))
            return yield* driverError(
              resource.key,
              `Native ${phase} process failed for ${resource.key.workloadId}`,
              result.cause,
            );
          if (result.value !== 0)
            return yield* driverError(
              resource.key,
              `Native ${phase} process exited with code ${String(result.value)} for ${resource.key.workloadId}`,
            );
        });
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const result = yield* restore(run).pipe(Effect.exit);
            const terminated =
              started === undefined
                ? Exit.succeed(undefined)
                : yield* Effect.suspend(() => {
                    const child = started;
                    if (child === undefined) return Effect.void;
                    return child.isRunning.pipe(
                      Effect.mapError((error) =>
                        processError(error, resource.key, `${phase} probe`),
                      ),
                      Effect.flatMap((running) =>
                        running
                          ? child.kill.pipe(
                              Effect.mapError((error) =>
                                processError(error, resource.key, `${phase} stop`),
                              ),
                            )
                          : Effect.void,
                      ),
                    );
                  }).pipe(Effect.exit);
            const closed = yield* Scope.close(startupScope, Exit.void).pipe(Effect.exit);
            let failureCause: Cause.Cause<RuntimeDriverError> | undefined;
            for (const candidate of [result, terminated, closed]) {
              if (!Exit.isFailure(candidate)) continue;
              failureCause =
                failureCause === undefined
                  ? candidate.cause
                  : Cause.combine(failureCause, candidate.cause);
            }
            if (failureCause !== undefined) return yield* Effect.failCause(failureCause);
          }),
        );
      });

    const runStart = (resource: Resource): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { key, workload } = resource;
        const ensureNotStopped = (): Effect.Effect<void, RuntimeDriverError> =>
          resource.stopRequested
            ? Effect.fail(driverError(key, "Native workload was stopped while starting"))
            : Effect.void;
        const operation = Effect.gen(function* () {
          const launcher =
            options.resolveLauncher === undefined
              ? undefined
              : yield* options.resolveLauncher(key, workload);
          const resolved = yield* options.resolveProcess(key, workload);
          for (const startup of resolved.startup)
            yield* runStartupProcess(resource, startup, launcher, "startup");
          const process = yield* spawnNativeProcess(resolved.main, launcher, key).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childSpawner),
            Scope.provide(resource.scope),
            Effect.mapError((error) => processError(error, key, "spawn")),
          );
          resource.process = process;
          // Keep one process-exit observation owned by the resource scope. The
          // readiness race has waiter-owned fibers which may be interrupted;
          // sharing an Effect.cached waiter would let that interruption poison
          // the observation used by the long-lived workload watcher.
          const exitFiber = yield* Effect.forkIn(process.exitCode, resource.scope);
          const exitCode = Fiber.join(exitFiber);
          yield* Effect.forkIn(watchProcess(resource, process, exitCode), resource.scope);
          yield* attachLogs(resource, process);
          const readiness = options.waitForReadiness;
          const mainExit = exitCode.pipe(
            Effect.flatMap((code) =>
              Effect.fail(
                driverError(
                  key,
                  `Native workload ${key.workloadId} exited before readiness (${String(code)})`,
                ),
              ),
            ),
          );
          const preReady = Effect.gen(function* () {
            yield* readiness(key, workload, process);
            yield* ensureNotStopped();
            if (workload.bootstrap === "database") {
              if (options.bootstrapDatabase === undefined)
                return yield* driverError(key, "Database bootstrap resolver is not configured");
              yield* options
                .bootstrapDatabase(key, workload, process)
                .pipe(Effect.mapError((error) => driverError(key, error.message, error)));
            }
            yield* ensureNotStopped();
            if (yield* Deferred.isDone(resource.failure))
              return yield* Deferred.await(resource.failure);
            const ready = yield* Ref.modify(resource.state, (current) => {
              if (current.state !== "starting") return [undefined, current];
              const next: ObservedWorkload = { ...current, state: "ready" };
              return [next, next];
            });
            if (ready === undefined)
              return yield* driverError(key, "Native workload exited or stopped before readiness");
            return ready;
          });
          return yield* Effect.raceFirst(
            Effect.raceFirst(preReady, Deferred.await(resource.failure)),
            mainExit,
          );
        });
        const result = yield* operation.pipe(
          Effect.mapError((error) =>
            error instanceof RuntimeDriverError
              ? error
              : driverError(key, `Native workload ${key.workloadId} failed`, error),
          ),
          Effect.exit,
        );
        if (Exit.isFailure(result)) {
          const failed: ObservedWorkload = {
            ...resource.key,
            state: resource.stopRequested ? "stopped" : "failed",
            ...(resource.stopRequested ? {} : { error: Cause.pretty(result.cause) }),
          };
          yield* Ref.set(resource.state, failed);
          yield* cleanup(resource);
        }
        yield* Deferred.done(resource.result, result);
      });

    const start = (
      key: RuntimeWorkloadKey,
      workload: PlannedWorkload,
    ): Effect.Effect<ObservedWorkload, RuntimeDriverError> => {
      if (workload.selected.kind === "container")
        return Effect.fail(
          new RuntimeDriverError({
            message: "Native runtime cannot start a container artifact",
            stackId: key.stackId,
            workloadId: key.workloadId,
          }),
        );
      return Effect.flatMap(
        // The permit serializes registration only; process readiness and log following continue
        // after it is released, while stop/remove/cleanup hold it for their full operation.
        registration.withPermit(
          Effect.gen(function* () {
            const id = resourceKey(key);
            const existing = resources.get(id);
            if (existing !== undefined) {
              const current = yield* Ref.get(existing.state);
              if (current.state === "starting" || current.state === "ready") return existing;
              yield* cleanup(existing);
            }
            const processScope = yield* Scope.fork(runtimeScope, "parallel");
            const state = yield* Ref.make<ObservedWorkload>({ ...key, state: "starting" });
            const result = yield* Deferred.make<ObservedWorkload, RuntimeDriverError>();
            const failure = yield* Deferred.make<never, RuntimeDriverError>();
            const resource: Resource = {
              key,
              workload,
              scope: processScope,
              state,
              result,
              failure,
              output: {
                stdout: { decoder: new TextDecoder(), remainder: "" },
                stderr: { decoder: new TextDecoder(), remainder: "" },
              },
              stopRequested: false,
            };
            resources.set(id, resource);
            resource.startFiber = yield* Effect.forkIn(runStart(resource), runtimeScope);
            return resource;
          }),
        ),
        (resource) => Deferred.await(resource.result),
      );
    };

    const observe = (
      stackId: StackId,
    ): Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError> =>
      Effect.forEach(
        [...resources.values()].filter((resource) => resource.key.stackId === stackId),
        (resource) => Ref.get(resource.state),
      );

    const stopResource = (resource: Resource): Effect.Effect<void, RuntimeDriverError> =>
      Effect.gen(function* () {
        const { key } = resource;
        resource.stopRequested = true;
        if (resource.startFiber !== undefined) {
          yield* Deferred.fail(
            resource.result,
            driverError(key, "Native workload was stopped while starting"),
          );
        }
        const nativeProcess = resource.process;
        const killResult =
          nativeProcess === undefined
            ? Exit.succeed(undefined)
            : yield* nativeProcess.isRunning.pipe(
                Effect.mapError((error) => processError(error, key, "probe")),
                Effect.flatMap((running) =>
                  running
                    ? nativeProcess.kill.pipe(
                        Effect.mapError((error) => processError(error, key, "stop")),
                      )
                    : Effect.void,
                ),
                Effect.exit,
              );
        if (resource.startFiber !== undefined) yield* Fiber.interrupt(resource.startFiber);
        if (Exit.isFailure(killResult)) {
          yield* Ref.update(resource.state, (current): ObservedWorkload => ({
            ...current,
            state: "failed",
            error: Cause.pretty(killResult.cause),
          }));
          return yield* Effect.failCause(killResult.cause);
        }
        yield* Ref.update(resource.state, (current): ObservedWorkload => ({
          ...current,
          state: "stopped",
        }));
      });

    const removeResource = (resource: Resource): Effect.Effect<void, RuntimeDriverError> =>
      Effect.gen(function* () {
        resource.stopRequested = true;
        if (resource.startFiber !== undefined) yield* Fiber.interrupt(resource.startFiber);
        yield* cleanup(resource);
      });

    const stop = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      registration.withPermit(
        Effect.gen(function* () {
          const resource = resources.get(resourceKey(key));
          if (resource === undefined) return;
          if (!sameKey(resource.key, key))
            return yield* driverError(key, "Native workload identity mismatch");
          yield* stopResource(resource);
        }),
      );

    const remove = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      registration.withPermit(
        Effect.gen(function* () {
          const resource = resources.get(resourceKey(key));
          if (resource === undefined) return;
          if (!sameKey(resource.key, key))
            return yield* driverError(key, "Native workload identity mismatch");
          yield* removeResource(resource);
        }),
      );

    const cleanupRuntime = (
      request: RuntimeCleanupRequest,
    ): Effect.Effect<void, RuntimeDriverError> =>
      registration.withPermit(
        Effect.gen(function* () {
          let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
          const attempt = <A>(effect: Effect.Effect<A, RuntimeDriverError>) =>
            Effect.gen(function* () {
              const result = yield* Effect.exit(effect);
              if (Exit.isFailure(result)) cleanupCause = Cause.combine(cleanupCause, result.cause);
            });
          const owned = [...resources.values()].filter(
            (resource) => resource.key.stackId === request.stackId,
          );
          for (const resource of owned) {
            yield* attempt(stopResource(resource));
            yield* attempt(removeResource(resource));
          }
          if (cleanupCause.reasons.length > 0) return yield* Effect.failCause(cleanupCause);
        }),
      );

    return {
      observe,
      start,
      stop,
      remove,
      cleanup: cleanupRuntime,
    } satisfies RuntimeDriver;
  });
