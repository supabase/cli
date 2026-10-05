import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Scope,
  Semaphore,
  SubscriptionRef,
} from "effect";
import type { Stream } from "effect";
import { LifecycleEvent } from "./Lifecycle.ts";

/** The execution step a service is performing right now, for status reporting. */
type ServiceOperation = "start" | "stop" | "restart" | "storage" | "destroy" | "sleep";

/**
 * Execution facts about one service: its configuration and the outcome of its last launch, check,
 * exit or cleanup. Lifecycle phase and health come from the lifecycle reducer, not from here.
 */
export interface ServiceObservation<Config> {
  readonly id: string;
  readonly config: Config;
  readonly error: ServiceError | undefined;
  readonly cleanupError: ServiceError | undefined;
  readonly exit: Exit.Exit<void, ServiceError> | undefined;
  readonly currentOperation: ServiceOperation | undefined;
  readonly registered: boolean;
}

export class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The exact runtime resources owned by one service launch. */
export interface RuntimeSession {
  /** The initial readiness program for this session. */
  readonly health: Effect.Effect<void, ServiceError>;
  /** Bounded re-check for a running session whose last check failed; without it the failure is final. */
  readonly probe?: Effect.Effect<void, ServiceError>;
  /** Resolves with the runtime's terminal result and remains attached to this session. */
  readonly exit: Effect.Effect<Exit.Exit<void, ServiceError>>;
  readonly stop: Effect.Effect<void, ServiceError>;
  /** Skips a clean checkpoint. Used when the data directory is about to be deleted. */
  readonly discard?: Effect.Effect<void, ServiceError>;
  readonly remove: Effect.Effect<void, ServiceError>;
}

/** Retains cleanup authority when launch fails after acquiring runtime resources. */
export class ServiceLaunchError extends Data.TaggedError("ServiceLaunchError")<{
  readonly failure: ServiceError;
  readonly runtime: RuntimeSession;
}> {}

export interface ServiceDefinition<Config> {
  /** Idempotent preparation (artifacts, images) run at the start of every launch. */
  readonly prepare?: (config: Config) => Effect.Effect<void, ServiceError>;
  /** Failures after resource acquisition carry the session for ordinary cleanup. */
  readonly launch: (
    context: ServiceInstanceContext<Config>,
  ) => Effect.Effect<RuntimeSession, ServiceError | ServiceLaunchError>;
  readonly removeData: (
    context: ServiceInstanceContext<Config>,
  ) => Effect.Effect<void, ServiceError>;
}

export interface ServiceInstanceContext<Config> {
  readonly id: string;
  readonly config: Config;
  /** Owns auxiliary session resources; runtime stop/remove retain cleanup authority. */
  readonly scope: Scope.Closeable;
}

/**
 * The execution boundary for one service: it runs the launches, checks and stops the lifecycle
 * reducer commands for a generation, holds that generation's resources until their cleanup is
 * confirmed, and reports every outcome back as a generation-tagged event.
 */
export interface ServiceInstance<Config> {
  readonly id: string;
  readonly observation: Stream.Stream<ServiceObservation<Config>>;
  readonly get: Effect.Effect<ServiceObservation<Config>>;
  readonly prepare: (config: Config) => Effect.Effect<void, ServiceError>;
  /** Runs generation `generation`'s launch and readiness check; outcomes are reported, never returned. */
  readonly launch: (generation: number, config: Config) => Effect.Effect<void>;
  /**
   * Stops `generation`'s session, never a newer one, and reports `Exited` once cleanup is
   * confirmed or `StopFailed` while its resources are still held.
   */
  readonly stop: (
    generation: number,
    options: { readonly operation: ServiceOperation; readonly discard: boolean },
  ) => Effect.Effect<void>;
  /** Re-runs a failed readiness check of `generation`'s live session and reports the result. */
  readonly reprobe: (generation: number) => Effect.Effect<void>;
  /** Runs instance-owned storage work; the lifecycle reservation keeps the service stopped. */
  readonly storage: <A>(
    operation: Effect.Effect<A, ServiceError>,
  ) => Effect.Effect<A, ServiceError>;
  /**
   * Removes the instance's data and marks it unregistered; the service must already be stopped.
   * `confirm`, when given, runs inside the same execution lock once resources are confirmed
   * removed and before the instance is marked unregistered — destroy's registration publication.
   * Omitting it (abandonment) reuses the identical confirmed, serialized cleanup without touching
   * any registration.
   */
  readonly removeData: (
    confirm?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, ServiceError>;
}

interface SessionRecord {
  readonly generation: number;
  readonly runtime: RuntimeSession;
  /** The execution handle's scope, closed only after the runtime's stop and removal succeed. */
  readonly scope: Scope.Closeable;
  readonly healthScope: Scope.Closeable;
  readonly stopped: Ref.Ref<boolean>;
  readonly removed: Ref.Ref<boolean>;
}

interface Attempt {
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void>;
}

const exitError = (
  operation: string,
  exit: Exit.Exit<unknown, ServiceError>,
): ServiceError | undefined =>
  Exit.isSuccess(exit)
    ? undefined
    : Option.getOrElse(
        Cause.findErrorOption(exit.cause),
        () =>
          new ServiceError({
            operation,
            message: "Runtime session failed",
            cause: exit.cause,
          }),
      );

const destroyedError = (id: string) =>
  new ServiceError({ operation: "launch", message: `Service ${id} was destroyed` });

/** Creates one service's execution boundary; launches and cleanups run in the current scope. */
export const makeService = <Config>(
  definition: ServiceDefinition<Config>,
  options: {
    readonly id: string;
    readonly config: Config;
    /** Delivers an execution outcome to the lifecycle authority. */
    readonly report: (event: LifecycleEvent) => Effect.Effect<void>;
  },
): Effect.Effect<ServiceInstance<Config>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* Scope.Scope;
    const { id, report } = options;
    // Serializes every step that touches runtime resources: a launch's acquisition, a stop, an
    // exit's cleanup, storage work and data removal.
    const execution = yield* Semaphore.make(1);
    const current = yield* Ref.make<SessionRecord | undefined>(undefined);
    const attempt = yield* Ref.make<Attempt | undefined>(undefined);
    // The highest generation already stopped: a launch for it, admitted late, must never run.
    const stoppedThrough = yield* Ref.make(0);
    const config = yield* Ref.make(options.config);
    const observations = yield* SubscriptionRef.make<ServiceObservation<Config>>({
      id,
      config: options.config,
      error: undefined,
      cleanupError: undefined,
      exit: undefined,
      currentOperation: undefined,
      registered: true,
    });

    const update = (change: Partial<ServiceObservation<Config>>) =>
      SubscriptionRef.update(observations, (value) => ({ ...value, ...change }));
    const recordCleanupError = (error: ServiceError) =>
      SubscriptionRef.update(observations, (value) => ({
        ...value,
        error: value.error ?? error,
        cleanupError: error,
      }));

    /** Halts and removes one session, retrying only the steps a previous attempt didn't finish. */
    const stopRecord = Effect.fn("Service.stopRecord")(function* (
      record: SessionRecord,
      discard: boolean,
    ) {
      yield* Effect.annotateCurrentSpan({ member_id: id, generation: record.generation });
      yield* Scope.close(record.healthScope, Exit.void);
      if (!(yield* Ref.get(record.stopped))) {
        const halt =
          discard && record.runtime.discard !== undefined
            ? record.runtime.discard
            : record.runtime.stop;
        yield* halt.pipe(Effect.tapError(recordCleanupError));
        yield* Ref.set(record.stopped, true);
      }
      if (!(yield* Ref.get(record.removed))) {
        yield* record.runtime.remove.pipe(Effect.tapError(recordCleanupError));
        yield* Ref.set(record.removed, true);
      }
      yield* Scope.close(record.scope, Exit.void);
      yield* Ref.update(current, (value) => (value === record ? undefined : value));
      yield* update({ cleanupError: undefined });
    });

    /** Runs one readiness program in the session's health scope; interruption yields `undefined`. */
    const check = (record: SessionRecord, program: Effect.Effect<void, ServiceError>) =>
      Effect.forkIn(program, record.healthScope, { startImmediately: true }).pipe(
        Effect.flatMap(Fiber.await),
        Effect.map((exit) =>
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? undefined : exit,
        ),
      );

    const settleCheck = Effect.fn("Service.settleCheck")(function* (
      record: SessionRecord,
      exit: Exit.Exit<void, ServiceError>,
      recovered: boolean,
    ) {
      const error = exitError("health", exit);
      yield* Effect.annotateCurrentSpan({ healthy: error === undefined });
      if ((yield* Ref.get(current)) !== record) return;
      yield* update({ error });
      const generation = record.generation;
      yield* report(
        error !== undefined
          ? LifecycleEvent.ReadinessLost({ id, generation, cause: error })
          : recovered
            ? LifecycleEvent.ReadinessRecovered({ id, generation })
            : LifecycleEvent.LaunchSucceeded({ id, generation }),
      );
    });

    /** Cleans a session whose runtime exited on its own, then reports the exit. */
    const observeExit = Effect.fn("Service.observeExit")(function* (
      record: SessionRecord,
      exit: Exit.Exit<void, ServiceError>,
    ) {
      yield* Effect.annotateCurrentSpan({ member_id: id, generation: record.generation });
      const error =
        exitError("exit", exit) ??
        new ServiceError({ operation: "exit", message: "Runtime exited unexpectedly" });
      const cleaned = yield* execution.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(current)) !== record) return undefined;
          yield* update({ error, exit, currentOperation: "stop" });
          return yield* stopRecord(record, false).pipe(
            Effect.exit,
            Effect.ensuring(update({ currentOperation: undefined })),
          );
        }),
      );
      if (cleaned === undefined) return;
      const generation = record.generation;
      yield* report(
        Exit.isSuccess(cleaned)
          ? LifecycleEvent.Exited({ id, generation, cause: error, requested: false })
          : LifecycleEvent.StopFailed({
              id,
              generation,
              cause: Cause.squash(cleaned.cause),
              failure: error,
            }),
      );
    });

    /** Acquires one generation's runtime; on failure, its retained resources are cleaned first. */
    const acquire = Effect.fn("Service.acquire")(function* (
      generation: number,
      launchConfig: Config,
      handle: Scope.Closeable,
    ) {
      if (generation <= (yield* Ref.get(stoppedThrough))) return { _tag: "Fenced" } as const;
      const observation = yield* SubscriptionRef.get(observations);
      if (!observation.registered) return { _tag: "Failed", error: destroyedError(id) } as const;
      // The lifecycle launches only once the previous session's cleanup is confirmed.
      if ((yield* Ref.get(current)) !== undefined)
        return {
          _tag: "Failed",
          error: new ServiceError({
            operation: "launch",
            message: `Service ${id} still holds a previous session`,
          }),
        } as const;
      yield* Ref.set(config, launchConfig);
      yield* update({ config: launchConfig, exit: undefined, currentOperation: "start" });
      const launched = yield* Effect.exit(
        definition.launch({ id, config: launchConfig, scope: handle }).pipe(
          Effect.map((runtime) => ({ runtime, failure: undefined })),
          Effect.catchTag("ServiceLaunchError", ({ runtime, failure }) =>
            Effect.succeed({ runtime, failure }),
          ),
        ),
      );
      if (Exit.isFailure(launched)) {
        yield* Scope.close(handle, launched);
        return {
          _tag: "Failed",
          error:
            exitError("launch", launched) ??
            new ServiceError({ operation: "launch", message: "Launch failed" }),
        } as const;
      }
      const { runtime, failure } = launched.value;
      const record: SessionRecord = {
        generation,
        runtime,
        scope: handle,
        healthScope: yield* Scope.fork(handle, "parallel"),
        stopped: yield* Ref.make(false),
        removed: yield* Ref.make(false),
      };
      yield* Ref.set(current, record);
      if (failure !== undefined) {
        const cleaned = yield* stopRecord(record, false).pipe(Effect.result);
        return cleaned._tag === "Failure"
          ? ({ _tag: "Retained", error: failure, cleanup: cleaned.failure } as const)
          : ({ _tag: "Failed", error: failure } as const);
      }
      yield* Effect.forkIn(
        runtime.exit.pipe(
          // Recorded at once, so a requested stop's exit is visible when the stop completes.
          Effect.tap((exit) =>
            Ref.get(current).pipe(
              Effect.flatMap((live) => (live === record ? update({ exit }) : Effect.void)),
            ),
          ),
          // Cleanup closes this session's scope, so it runs on the owner's fiber instead.
          Effect.flatMap((exit) =>
            Effect.forkIn(observeExit(record, exit), owner, { startImmediately: true }),
          ),
        ),
        handle,
        { startImmediately: true },
      );
      return { _tag: "Live", record } as const;
    });

    const run = Effect.fn("Service.launch")(function* (
      generation: number,
      launchConfig: Config,
      handle: Scope.Closeable,
    ) {
      yield* Effect.annotateCurrentSpan({ member_id: id, generation });
      yield* update({ error: undefined });
      const prepared = yield* (definition.prepare?.(launchConfig) ?? Effect.void).pipe(Effect.exit);
      if (Exit.isFailure(prepared)) {
        // A stopped generation's late failure must not mark the observation of its successor.
        if (generation <= (yield* Ref.get(stoppedThrough))) return;
        const error = exitError("prepare", prepared);
        yield* update({ error });
        yield* report(LifecycleEvent.LaunchFailed({ id, generation, cause: error }));
        return;
      }
      yield* report(LifecycleEvent.StageChanged({ id, generation, stage: "launching" }));
      const acquired = yield* execution.withPermit(
        acquire(generation, launchConfig, handle).pipe(
          Effect.ensuring(update({ currentOperation: undefined })),
        ),
      );
      if (acquired._tag === "Fenced") return;
      if (acquired._tag === "Retained") {
        yield* update({ error: acquired.error });
        yield* report(
          LifecycleEvent.StopFailed({
            id,
            generation,
            cause: acquired.cleanup,
            failure: acquired.error,
          }),
        );
        return;
      }
      if (acquired._tag === "Failed") {
        yield* update({ error: acquired.error });
        yield* report(LifecycleEvent.LaunchFailed({ id, generation, cause: acquired.error }));
        return;
      }
      yield* report(LifecycleEvent.SessionAvailable({ id, generation }));
      const healthy = yield* check(acquired.record, acquired.record.runtime.health);
      if (healthy !== undefined) yield* settleCheck(acquired.record, healthy, false);
    });

    const launch = Effect.fn("Service.launchAttempt")(function* (
      generation: number,
      launchConfig: Config,
    ) {
      // Created before preparation so a stopped or abandoned attempt still has a scope to close;
      // once a session holds it, only `stopRecord` closes it.
      const handle = yield* Scope.fork(owner, "parallel");
      const releaseUnlessHeld = Ref.get(current).pipe(
        Effect.flatMap((record) =>
          record?.scope === handle ? Effect.void : Scope.close(handle, Exit.void),
        ),
      );
      const fiber = yield* Effect.forkIn(
        run(generation, launchConfig, handle).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : report(LifecycleEvent.LaunchFailed({ id, generation, cause: Cause.squash(cause) })),
          ),
          Effect.ensuring(releaseUnlessHeld),
          Effect.ensuring(
            Ref.update(attempt, (value) => (value?.generation === generation ? undefined : value)),
          ),
        ),
        owner,
        { startImmediately: true, uninterruptible: false },
      );
      yield* Ref.set(attempt, { generation, fiber });
      yield* Fiber.await(fiber);
    });

    const stop = Effect.fn("Service.stop")(function* (
      generation: number,
      stopOptions: { readonly operation: ServiceOperation; readonly discard: boolean },
    ) {
      yield* Effect.annotateCurrentSpan({ member_id: id, generation });
      // Fencing under the execution lock waits out an acquisition already in progress, so its
      // session is visible below, and makes any later acquisition for this generation a no-op.
      // Only then is the attempt interrupted, while it prepares or checks readiness.
      yield* execution.withPermit(
        Ref.update(stoppedThrough, (value) => Math.max(value, generation)),
      );
      const pending = yield* Ref.get(attempt);
      if (pending !== undefined && pending.generation <= generation)
        yield* Fiber.interrupt(pending.fiber);
      const stopped = yield* execution
        .withPermit(
          Effect.gen(function* () {
            const record = yield* Ref.get(current);
            // A newer session belongs to a later generation's own stop.
            if (record === undefined || record.generation > generation) return;
            yield* update({ currentOperation: stopOptions.operation });
            yield* stopRecord(record, stopOptions.discard).pipe(
              Effect.ensuring(update({ currentOperation: undefined })),
            );
          }),
        )
        .pipe(Effect.exit);
      yield* report(
        Exit.isSuccess(stopped)
          ? LifecycleEvent.Exited({ id, generation, cause: undefined, requested: true })
          : LifecycleEvent.StopFailed({ id, generation, cause: Cause.squash(stopped.cause) }),
      );
    });

    const reprobe = Effect.fn("Service.reprobe")(function* (generation: number) {
      yield* Effect.annotateCurrentSpan({ member_id: id, generation });
      const record = yield* Ref.get(current);
      if (record?.generation !== generation) return;
      const probe = record.runtime.probe;
      if (probe === undefined) {
        const error =
          (yield* SubscriptionRef.get(observations)).error ??
          new ServiceError({ operation: "health", message: `Service ${id} is not ready` });
        yield* report(LifecycleEvent.ReadinessLost({ id, generation, cause: error }));
        return;
      }
      const result = yield* check(record, probe);
      if (result !== undefined) yield* settleCheck(record, result, true);
    });

    const storage = <A>(operation: Effect.Effect<A, ServiceError>) =>
      execution
        .withPermit(
          update({ currentOperation: "storage" }).pipe(
            Effect.andThen(operation),
            Effect.ensuring(update({ currentOperation: undefined })),
          ),
        )
        .pipe(Effect.withSpan("Service.storage", { attributes: { member_id: id } }));

    const removeData = Effect.fn("Service.removeData")(function* (
      confirm: Effect.Effect<void, ServiceError> = Effect.void,
    ) {
      yield* Effect.annotateCurrentSpan({ member_id: id });
      yield* execution.withPermit(
        Effect.gen(function* () {
          if (!(yield* SubscriptionRef.get(observations)).registered) return;
          yield* update({ currentOperation: "destroy" });
          yield* Effect.gen(function* () {
            const leftover = yield* Ref.get(current);
            if (leftover !== undefined) {
              yield* stopRecord(leftover, true);
              // A previous stop attempt may have failed and reported `StopFailed`, leaving the
              // reducer in `Stopping` forever; this retry's own confirmed termination must reach it
              // too, the same way `stop`'s own successful path does, or the reducer (and anything
              // gated on it, such as `NetworkNamespace.release`'s endpoint check) never learns.
              yield* report(
                LifecycleEvent.Exited({
                  id,
                  generation: leftover.generation,
                  cause: undefined,
                  requested: true,
                }),
              );
            }
            const dataScope = yield* Scope.fork(owner, "parallel");
            yield* definition
              .removeData({ id, config: yield* Ref.get(config), scope: dataScope })
              .pipe(
                Effect.tapError((error) => update({ error })),
                Effect.ensuring(Scope.close(dataScope, Exit.void)),
              );
            yield* confirm;
            yield* update({ registered: false });
          }).pipe(Effect.ensuring(update({ currentOperation: undefined })));
        }),
      );
    });

    return {
      id,
      observation: SubscriptionRef.changes(observations),
      get: SubscriptionRef.get(observations),
      prepare: (candidate) => definition.prepare?.(candidate) ?? Effect.void,
      launch,
      stop,
      reprobe,
      storage,
      removeData,
    };
  });
