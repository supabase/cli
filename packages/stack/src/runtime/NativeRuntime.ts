import { Cause, Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import type * as ChildProcessSpawnerService from "effect/unstable/process/ChildProcessSpawner";
import type { DatabaseBootstrapOptions, DatabaseSession } from "../model/DatabaseBootstrap.ts";
import { runDatabaseBootstrap } from "../model/DatabaseBootstrap.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import { LogStoreError } from "../supervisor/LogStore.ts";
import {
  RuntimeDriverError,
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

export type NativeWorkload = PlannedWorkload;

export interface NativeRuntimeOptions {
  /**
   * Resolves the process-ownership launcher. Development defaults use the
   * bundled native-launcher entrypoint; packaged CLIs can provide their own
   * command/entrypoint without changing process ownership semantics.
   */
  readonly resolveLauncher?: (
    key: RuntimeWorkloadKey,
    workload: NativeWorkload,
  ) => Effect.Effect<NativeProcessLauncher, RuntimeDriverError>;
  /** Resolves the complete native process command for one workload. */
  readonly resolveProcess: (
    key: RuntimeWorkloadKey,
    workload: NativeWorkload,
  ) => Effect.Effect<NativeProcessSpec, RuntimeDriverError>;
  /** Private readiness is resolved by the owning Supervisor/gateway seam. */
  readonly waitForReadiness: (
    key: RuntimeWorkloadKey,
    workload: NativeWorkload,
    process: NativeProcess,
  ) => Effect.Effect<void, RuntimeDriverError>;
  /** A ready-database session is required for the database bootstrap marker. */
  readonly resolveDatabaseSession?: (
    key: RuntimeWorkloadKey,
    workload: NativeWorkload,
    process: NativeProcess,
  ) => Effect.Effect<DatabaseSession | undefined, RuntimeDriverError>;
  readonly resolveDatabaseBootstrap?: (
    key: RuntimeWorkloadKey,
    workload: NativeWorkload,
  ) => Effect.Effect<DatabaseBootstrapOptions, RuntimeDriverError>;
  readonly logStore?: LogStore;
}

interface OutputAccumulator {
  readonly decoder: TextDecoder;
  remainder: string;
}

interface Resource {
  readonly key: RuntimeWorkloadKey;
  readonly workload: NativeWorkload;
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
  JSON.stringify([key.stackId, key.desiredGeneration, key.workloadId, key.specHash]);

const sameKey = (left: RuntimeWorkloadKey, right: RuntimeWorkloadKey): boolean =>
  left.stackId === right.stackId &&
  left.desiredGeneration === right.desiredGeneration &&
  left.workloadId === right.workloadId &&
  left.specHash === right.specHash;

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
    const lifecycle = yield* Semaphore.make(1);
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
        if (Exit.isFailure(result) && !resource.stopRequested) {
          yield* Deferred.fail(
            resource.failure,
            driverError(resource.key, `Native workload exited before readiness`, result.cause),
          );
        }
      }).pipe(Effect.ignore);

    const reportLogFailure = (
      resource: Resource,
      error: LogStoreError | NativeProcessError,
    ): Effect.Effect<void> => {
      const failure = driverError(
        resource.key,
        `Native log stream failed for ${resource.key.workloadId}: ${error.message}`,
        error,
      );
      return Ref.update(resource.state, (current): ObservedWorkload =>
        current.state === "stopped" || current.state === "failed"
          ? current
          : { ...current, state: "failed", error: failure.message },
      ).pipe(Effect.andThen(Deferred.fail(resource.failure, failure)));
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

    const runStart = (resource: Resource): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { key, workload } = resource;
        const operation = Effect.gen(function* () {
          const launcher =
            options.resolveLauncher === undefined
              ? undefined
              : yield* options.resolveLauncher(key, workload);
          const process = yield* options.resolveProcess(key, workload).pipe(
            Effect.flatMap((spec) => spawnNativeProcess(spec, launcher)),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childSpawner),
            Scope.provide(resource.scope),
            Effect.mapError((error) => processError(error, key, "spawn")),
          );
          resource.process = process;
          const exitCode = yield* Effect.cached(process.exitCode);
          yield* Effect.forkIn(watchProcess(resource, process, exitCode), resource.scope);
          yield* attachLogs(resource, process);
          const readiness = options.waitForReadiness;
          const exitedBeforeReady = exitCode.pipe(
            Effect.flatMap((code) =>
              Effect.fail(
                driverError(
                  key,
                  `Native workload ${key.workloadId} exited before readiness (${String(code)})`,
                ),
              ),
            ),
          );
          yield* Effect.raceFirst(
            Effect.raceFirst(readiness(key, workload, process), Deferred.await(resource.failure)),
            exitedBeforeReady,
          );
          const running = yield* process.isRunning.pipe(
            Effect.mapError((error) => processError(error, key, "probe")),
          );
          if (!running)
            return yield* driverError(
              key,
              `Native workload ${key.workloadId} exited before readiness`,
            );
          if (resource.stopRequested)
            return yield* driverError(key, "Native workload was stopped while starting");
          if (workload.bootstrap === "database") {
            if (options.resolveDatabaseSession === undefined)
              return yield* driverError(
                key,
                "Database bootstrap session resolver is not configured",
              );
            if (options.resolveDatabaseBootstrap === undefined)
              return yield* driverError(key, "Database bootstrap plan resolver is not configured");
            const session = yield* options.resolveDatabaseSession(key, workload, process);
            if (session === undefined)
              return yield* driverError(key, "Database bootstrap session is unavailable");
            const plan = yield* options.resolveDatabaseBootstrap(key, workload);
            yield* runDatabaseBootstrap(session, plan).pipe(
              Effect.mapError((error) => driverError(key, error.message, error)),
            );
          }
          if (resource.stopRequested)
            return yield* driverError(key, "Native workload was stopped while starting");
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
      workload: NativeWorkload,
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
        lifecycle.withPermit(
          Effect.gen(function* () {
            const id = resourceKey(key);
            const existing = resources.get(id);
            if (existing !== undefined) {
              const current = yield* Ref.get(existing.state);
              if (current.state !== "stopped" && current.state !== "failed") return existing;
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

    const stop = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const resource = resources.get(resourceKey(key));
          if (resource === undefined) return;
          if (!sameKey(resource.key, key))
            return yield* driverError(key, "Native workload identity mismatch");
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
          if (resource.startFiber !== undefined) {
            yield* Fiber.interrupt(resource.startFiber);
          }
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
        }),
      );

    const remove = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const resource = resources.get(resourceKey(key));
          if (resource === undefined) return;
          if (!sameKey(resource.key, key))
            return yield* driverError(key, "Native workload identity mismatch");
          resource.stopRequested = true;
          if (resource.startFiber !== undefined) {
            yield* Fiber.interrupt(resource.startFiber);
          }
          yield* cleanup(resource);
        }),
      );

    return { observe, start, stop, remove } satisfies RuntimeDriver;
  });

export const makeNativeRuntimeDriver = makeNativeRuntime;
