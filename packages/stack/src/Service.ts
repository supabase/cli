import {
  Cause,
  Data,
  Deferred,
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

type ServiceLifecycle = "stopped" | "starting" | "running" | "stopping";
type ServiceHealth = "starting" | "healthy" | "unhealthy";
type ServiceOperation = "start" | "stop" | "restart" | "storage" | "destroy" | "sleep";
export type ServiceAdmission = ServiceOperation | "arm";

export interface ServiceObservation<Config> {
  readonly id: string;
  readonly config: Config;
  readonly lifecycle: ServiceLifecycle;
  readonly health: ServiceHealth | undefined;
  readonly error: ServiceError | undefined;
  readonly cleanupError: ServiceError | undefined;
  readonly exit: Exit.Exit<void, ServiceError> | undefined;
  readonly currentOperation: ServiceOperation | undefined;
  readonly launchId: number | undefined;
  readonly intentRevision: number;
  readonly wakeEnabled: boolean;
  readonly registered: boolean;
}

export class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ServiceDestroyed extends Data.TaggedError("ServiceDestroyed")<{
  readonly id: string;
}> {}

export class ServiceNotRunning extends Data.TaggedError("ServiceNotRunning")<{
  readonly id: string;
}> {}

class ServiceNotStopped extends Data.TaggedError("ServiceNotStopped")<{
  readonly id: string;
  readonly lifecycle: ServiceLifecycle;
  readonly message: string;
}> {}

export class ServiceStaleLaunch extends Data.TaggedError("ServiceStaleLaunch")<{
  readonly id: string;
  readonly launchId: number;
}> {}

/** The exact runtime resources owned by one service launch. */
export interface RuntimeSession {
  /** The one readiness program for this session. */
  readonly health: Effect.Effect<void, ServiceError>;
  /** Resolves with the runtime's terminal result and remains attached to this session. */
  readonly exit: Effect.Effect<Exit.Exit<void, ServiceError>>;
  readonly stop: Effect.Effect<void, ServiceError>;
  readonly remove: Effect.Effect<void, ServiceError>;
}

/** Retains cleanup authority when launch fails after acquiring runtime resources. */
export class ServiceLaunchError extends Data.TaggedError("ServiceLaunchError")<{
  readonly failure: ServiceError;
  readonly runtime: RuntimeSession;
}> {}

export interface ServiceDefinition<Config> {
  /** Preparation is performed before lifecycle admission. */
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

export interface ServiceInstance<Config> {
  readonly id: string;
  readonly observation: Stream.Stream<ServiceObservation<Config>>;
  readonly get: Effect.Effect<ServiceObservation<Config>>;
  readonly start: Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly startAt: (
    revision: number,
    config?: Config,
    wake?: boolean,
    guard?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly arm: Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly armAt: (
    revision: number,
    guard?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly sleep: Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly stop: Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly restart: (
    config?: Config,
    revision?: number,
    guard?: Effect.Effect<void, ServiceError>,
  ) => Effect.Effect<void, ServiceError | ServiceDestroyed>;
  readonly ready: Effect.Effect<
    void,
    ServiceError | ServiceDestroyed | ServiceNotRunning | ServiceStaleLaunch
  >;
  /** Runs instance-owned storage work only while the instance is stopped. */
  readonly storage: <A>(
    operation: Effect.Effect<A, ServiceError>,
  ) => Effect.Effect<A, ServiceError | ServiceDestroyed | ServiceNotStopped>;
  readonly destroy: Effect.Effect<void, ServiceError | ServiceDestroyed>;
}

interface SessionRecord {
  readonly launchId: number;
  readonly runtime: RuntimeSession;
  readonly scope: Scope.Closeable;
  readonly healthScope: Scope.Closeable;
  readonly health: Deferred.Deferred<Exit.Exit<void, ServiceError>>;
  readonly stopped: Ref.Ref<boolean>;
  readonly removed: Ref.Ref<boolean>;
}

const contextFor = <Config>(
  id: string,
  config: Config,
  scope: Scope.Closeable,
): ServiceInstanceContext<Config> => ({
  id,
  config,
  scope,
});

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

/** Creates one independently serialized service instance. */
export const makeService = <Config>(
  definition: ServiceDefinition<Config>,
  options: {
    readonly id: string;
    readonly config: Config;
    readonly coordinate?: (
      operation: ServiceAdmission,
      transition: Effect.Effect<void, ServiceError>,
    ) => Effect.Effect<void, ServiceError>;
  },
): Effect.Effect<ServiceInstance<Config>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    const revision = yield* Ref.make(0);
    const launchCounter = yield* Ref.make(0);
    const current = yield* Ref.make<SessionRecord | undefined>(undefined);
    const config = yield* Ref.make(options.config);
    const observations = yield* SubscriptionRef.make<ServiceObservation<Config>>({
      id: options.id,
      config: options.config,
      lifecycle: "stopped",
      health: undefined,
      error: undefined,
      cleanupError: undefined,
      exit: undefined,
      currentOperation: undefined,
      launchId: undefined,
      intentRevision: 0,
      wakeEnabled: false,
      registered: true,
    });

    const update = (change: Partial<ServiceObservation<Config>>) =>
      SubscriptionRef.update(observations, (value) => ({ ...value, ...change }));

    const setOperation = (operation: ServiceOperation | undefined) =>
      update({ currentOperation: operation });
    const coordinate =
      options.coordinate ??
      ((_operation: ServiceAdmission, transition: Effect.Effect<void, ServiceError>) => transition);

    // Mask only the permit handoff; admitted work belongs to the host scope.
    const run = Effect.fn("Service.run")(function* <
      A,
      E extends ServiceError | ServiceDestroyed | ServiceNotStopped,
    >(operation: Effect.Effect<A, E>) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(gate.take(1));
          const fiber = yield* Effect.forkIn(
            operation.pipe(Effect.ensuring(gate.release(1))),
            owner,
            { uninterruptible: false },
          );
          return yield* restore(Fiber.join(fiber));
        }),
      );
    });

    const stopNow = Effect.fn("Service.stopNow")(function* (
      expected?: SessionRecord,
      retainWake = false,
    ) {
      yield* Effect.gen(function* () {
        const record = yield* Ref.get(current);
        if (expected !== undefined && record !== expected) return;
        if (record === undefined) {
          yield* update({ lifecycle: "stopped", health: undefined });
          return;
        }

        yield* update({ lifecycle: "stopping", health: undefined, wakeEnabled: retainWake });
        yield* Deferred.succeed(
          record.health,
          Exit.fail(new ServiceError({ operation: "health", message: "Session stopped" })),
        );
        yield* Scope.close(record.healthScope, Exit.void);
        if (!(yield* Ref.get(record.stopped))) {
          yield* record.runtime.stop.pipe(
            Effect.tapError((error) =>
              SubscriptionRef.update(observations, (value) => ({
                ...value,
                error: value.error ?? error,
                cleanupError: error,
              })),
            ),
          );
          yield* Ref.set(record.stopped, true);
        }
        if (!(yield* Ref.get(record.removed))) {
          yield* record.runtime.remove.pipe(
            Effect.tapError((error) =>
              SubscriptionRef.update(observations, (value) => ({
                ...value,
                error: value.error ?? error,
                cleanupError: error,
              })),
            ),
          );
          yield* Ref.set(record.removed, true);
        }
        yield* Scope.close(record.scope, Exit.void);

        yield* Ref.set(current, undefined);
        yield* update({
          lifecycle: "stopped",
          health: undefined,
          launchId: undefined,
          cleanupError: undefined,
        });
      });
    });

    const launchNow = Effect.fn("Service.launchNow")(function* (
      guard: Effect.Effect<void, ServiceError>,
    ) {
      yield* Effect.gen(function* () {
        let observation = yield* SubscriptionRef.get(observations);
        if (!observation.registered) return yield* new ServiceDestroyed({ id: options.id });
        if (observation.lifecycle === "running" || observation.lifecycle === "starting") return;
        if (observation.lifecycle === "stopping") {
          yield* stopNow(undefined, observation.wakeEnabled);
          observation = yield* SubscriptionRef.get(observations);
          if (observation.lifecycle !== "stopped") return;
        }

        const launchId = yield* Ref.updateAndGet(launchCounter, (value) => value + 1);
        yield* coordinate(
          "start",
          guard.pipe(
            Effect.andThen(
              update({
                lifecycle: "starting",
                health: "starting",
                error: undefined,
                cleanupError: undefined,
                exit: undefined,
                wakeEnabled: observation.wakeEnabled,
                launchId,
              }),
            ),
          ),
        );
        const runtimeScope = yield* Scope.fork(owner, "parallel");
        const launchExit = yield* Effect.exit(
          definition.launch(contextFor(options.id, yield* Ref.get(config), runtimeScope)).pipe(
            Effect.map((runtime) => ({ runtime, failure: undefined })),
            Effect.catchTag("ServiceLaunchError", ({ runtime, failure }) =>
              Effect.succeed({ runtime, failure }),
            ),
          ),
        );
        if (Exit.isFailure(launchExit)) {
          yield* Scope.close(runtimeScope, launchExit);
          yield* update({
            lifecycle: "stopped",
            health: undefined,
            wakeEnabled: observation.wakeEnabled,
            error: exitError("launch", launchExit),
            launchId: undefined,
          });
          return yield* Effect.failCause(launchExit.cause);
        }
        const { runtime, failure: launchFailure } = launchExit.value;
        const health = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
        const record: SessionRecord = {
          launchId,
          runtime,
          scope: runtimeScope,
          healthScope: yield* Scope.fork(runtimeScope, "parallel"),
          health,
          stopped: yield* Ref.make(false),
          removed: yield* Ref.make(false),
        };
        yield* Ref.set(current, record);
        yield* update({
          lifecycle: launchFailure === undefined ? "running" : "stopping",
          health: launchFailure === undefined ? "starting" : undefined,
          error: launchFailure,
          launchId,
          config: yield* Ref.get(config),
        });

        const observeHealth = runtime.health.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* SubscriptionRef.update(
                observations,
                (observation): ServiceObservation<Config> => {
                  if (observation.launchId !== launchId || observation.lifecycle !== "running")
                    return observation;
                  const error = exitError("health", exit);
                  return {
                    ...observation,
                    health: Exit.isSuccess(exit) ? "healthy" : "unhealthy",
                    error,
                  };
                },
              );
              yield* Deferred.succeed(record.health, exit);
            }),
          ),
        );
        const observeExit = record.runtime.exit.pipe(
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if ((yield* Ref.get(current)) !== record) return;
              const observation = yield* SubscriptionRef.get(observations);
              const error =
                observation.lifecycle === "stopping"
                  ? observation.error
                  : (exitError("exit", exit) ??
                    new ServiceError({
                      operation: "exit",
                      message: "Runtime exited unexpectedly",
                    }));
              yield* update({
                lifecycle: "stopping",
                health: undefined,
                error,
                exit,
                wakeEnabled: observation.lifecycle === "stopping" && observation.wakeEnabled,
              });
              yield* run(
                Effect.gen(function* () {
                  if ((yield* Ref.get(current)) !== record) return;
                  yield* setOperation("stop");
                  const live = yield* SubscriptionRef.get(observations);
                  yield* stopNow(record, live.wakeEnabled).pipe(
                    Effect.ensuring(setOperation(undefined)),
                  );
                }),
              );
            }),
          ),
        );
        if (launchFailure === undefined)
          yield* Effect.forkIn(observeHealth, record.healthScope, { uninterruptible: false });
        yield* Effect.forkIn(observeExit, runtimeScope, { uninterruptible: false });
        if (launchFailure !== undefined) {
          yield* Deferred.succeed(record.health, Exit.fail(launchFailure));
          yield* stopNow(undefined, observation.wakeEnabled);
          return yield* launchFailure;
        }
      });
    });

    const startAt = Effect.fn("Service.startAt")(function* (
      expectedRevision: number,
      candidate?: Config,
      wake = false,
      guard: Effect.Effect<void, ServiceError> = Effect.void,
    ) {
      let existing = yield* SubscriptionRef.get(observations);
      if (!existing.registered) return yield* new ServiceDestroyed({ id: options.id });
      if (existing.lifecycle === "running") return;
      if (existing.lifecycle === "starting") {
        yield* run(Effect.void);
        existing = yield* SubscriptionRef.get(observations);
        if (!existing.registered) return yield* new ServiceDestroyed({ id: options.id });
        if (existing.lifecycle === "running") return;
      }
      const nextConfig = candidate ?? (yield* Ref.get(config));
      if (definition.prepare !== undefined) yield* definition.prepare(nextConfig);
      yield* run(
        Effect.gen(function* () {
          const observation = yield* SubscriptionRef.get(observations);
          if (!observation.registered) return yield* new ServiceDestroyed({ id: options.id });
          if (observation.lifecycle === "running" || observation.lifecycle === "starting") return;
          if ((yield* Ref.get(revision)) !== expectedRevision || (wake && !observation.wakeEnabled))
            return yield* new ServiceError({
              operation: "admission",
              message: "Service intent changed before admission",
            });
          yield* setOperation("start");
          yield* launchNow(
            guard.pipe(
              Effect.andThen(Ref.set(config, nextConfig)),
              Effect.andThen(update({ config: nextConfig })),
            ),
          ).pipe(Effect.ensuring(setOperation(undefined)));
        }),
      );
    });
    const start = Ref.get(revision).pipe(Effect.flatMap((revision) => startAt(revision)));

    const invalidate = Effect.fn("Service.invalidate")(function* () {
      const next = yield* Ref.updateAndGet(revision, (value) => value + 1);
      const record = yield* Ref.get(current);
      yield* update({
        intentRevision: next,
        wakeEnabled: false,
        lifecycle: record === undefined ? "stopped" : "stopping",
        health: undefined,
      });
    });

    const armAt = Effect.fn("Service.armAt")(function* (
      expectedRevision: number,
      guard: Effect.Effect<void, ServiceError> = Effect.void,
    ) {
      yield* run(
        Effect.gen(function* () {
          if (!(yield* SubscriptionRef.get(observations)).registered)
            return yield* new ServiceDestroyed({ id: options.id });
          if ((yield* Ref.get(revision)) !== expectedRevision)
            return yield* new ServiceError({
              operation: "admission",
              message: "Service intent changed before admission",
            });
          yield* coordinate("arm", guard.pipe(Effect.andThen(update({ wakeEnabled: true }))));
        }),
      );
    });
    const arm = Ref.get(revision).pipe(Effect.flatMap((revision) => armAt(revision)));

    const sleep = Effect.fn("Service.sleep")(function* () {
      yield* run(
        Effect.gen(function* () {
          const observation = yield* SubscriptionRef.get(observations);
          if (!observation.registered) return yield* new ServiceDestroyed({ id: options.id });
          if (observation.lifecycle !== "running" || !observation.wakeEnabled) return;
          yield* coordinate(
            "sleep",
            update({ lifecycle: "stopping", health: undefined, currentOperation: "sleep" }),
          );
          yield* stopNow(undefined, true).pipe(Effect.ensuring(setOperation(undefined)));
        }),
      );
    });

    const stop = Effect.fn("Service.stop")(function* () {
      yield* run(
        Effect.gen(function* () {
          const observation = yield* SubscriptionRef.get(observations);
          if (!observation.registered) return yield* new ServiceDestroyed({ id: options.id });
          yield* coordinate("stop", invalidate());
          yield* setOperation("stop");
          yield* stopNow().pipe(Effect.ensuring(setOperation(undefined)));
        }),
      );
    });

    const restart = Effect.fn("Service.restart")(function* (
      candidate?: Config,
      requestedRevision?: number,
      guard: Effect.Effect<void, ServiceError> = Effect.void,
    ) {
      const expectedRevision = requestedRevision ?? (yield* Ref.get(revision));
      const nextConfig = candidate ?? (yield* Ref.get(config));
      if (definition.prepare !== undefined) yield* definition.prepare(nextConfig);
      yield* run(
        Effect.gen(function* () {
          const observation = yield* SubscriptionRef.get(observations);
          if (!observation.registered) return yield* new ServiceDestroyed({ id: options.id });
          if ((yield* Ref.get(revision)) !== expectedRevision)
            return yield* new ServiceError({
              operation: "admission",
              message: "Service intent changed before admission",
            });
          yield* coordinate("restart", invalidate());
          yield* setOperation("restart");
          yield* Effect.gen(function* () {
            yield* stopNow();
            yield* Ref.set(config, nextConfig);
            yield* update({ config: nextConfig });
            yield* launchNow(guard);
          }).pipe(Effect.ensuring(setOperation(undefined)));
        }),
      );
    });

    const ready = Effect.fn("Service.ready")(function* () {
      const initial = yield* SubscriptionRef.get(observations);
      if (!initial.registered) return yield* new ServiceDestroyed({ id: options.id });
      const expectedRevision = yield* Ref.get(revision);
      const expectedLaunchId = initial.lifecycle === "starting" ? initial.launchId : undefined;
      let record = yield* Ref.get(current);
      if (record === undefined && initial.lifecycle === "starting") {
        yield* run(Effect.void);
        record = yield* Ref.get(current);
      }
      if (record === undefined) {
        if ((yield* Ref.get(revision)) !== expectedRevision)
          return yield* new ServiceStaleLaunch({
            id: options.id,
            launchId: yield* Ref.get(launchCounter),
          });
        return yield* new ServiceNotRunning({ id: options.id });
      }
      const launchId = record.launchId;
      if ((yield* Ref.get(revision)) !== expectedRevision)
        return yield* new ServiceStaleLaunch({ id: options.id, launchId });
      if (expectedLaunchId !== undefined && record.launchId !== expectedLaunchId)
        return yield* new ServiceStaleLaunch({ id: options.id, launchId });
      if ((yield* SubscriptionRef.get(observations)).lifecycle === "stopping") {
        return yield* new ServiceStaleLaunch({ id: options.id, launchId });
      }
      const healthResult = yield* Deferred.await(record.health);
      if (
        (yield* Ref.get(current)) !== record ||
        (yield* SubscriptionRef.get(observations)).lifecycle !== "running"
      ) {
        return yield* new ServiceStaleLaunch({ id: options.id, launchId });
      }
      yield* healthResult;
    });

    const storage = Effect.fn("Service.storage")(function* <A>(
      operation: Effect.Effect<A, ServiceError>,
    ) {
      return yield* run(
        Effect.gen(function* () {
          const observation = yield* SubscriptionRef.get(observations);
          if (!observation.registered) return yield* new ServiceDestroyed({ id: options.id });
          if (observation.lifecycle !== "stopped" || observation.wakeEnabled) {
            return yield* new ServiceNotStopped({
              id: options.id,
              lifecycle: observation.lifecycle,
              message: `Service ${options.id} must be stopped with wake disabled before modifying data`,
            });
          }
          yield* coordinate("storage", setOperation("storage"));
          return yield* operation.pipe(Effect.ensuring(setOperation(undefined)));
        }),
      );
    });

    const destroy = Effect.fn("Service.destroy")(function* () {
      yield* run(
        Effect.gen(function* () {
          const observation = yield* SubscriptionRef.get(observations);
          if (!observation.registered) return;
          yield* coordinate("destroy", invalidate());
          yield* setOperation("destroy");
          yield* Effect.gen(function* () {
            yield* stopNow();
            {
              const dataScope = yield* Scope.fork(owner, "parallel");
              yield* definition
                .removeData(contextFor(options.id, yield* Ref.get(config), dataScope))
                .pipe(
                  Effect.tapError((error) => update({ error })),
                  Effect.ensuring(Scope.close(dataScope, Exit.void)),
                );
            }
            yield* update({ registered: false, lifecycle: "stopped" });
          }).pipe(Effect.ensuring(setOperation(undefined)));
        }),
      );
    });

    return {
      id: options.id,
      observation: SubscriptionRef.changes(observations),
      get: SubscriptionRef.get(observations),
      start,
      startAt,
      arm,
      armAt,
      sleep: sleep(),
      stop: stop(),
      restart,
      ready: ready(),
      storage,
      destroy: destroy(),
    };
  });
