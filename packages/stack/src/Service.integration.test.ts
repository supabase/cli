import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Ref, Stream } from "effect";
import {
  makeService,
  ServiceDestroyed,
  ServiceError,
  ServiceLaunchError,
  type RuntimeSession,
  type ServiceDefinition,
  type ServiceInstance,
  type ServiceObservation,
} from "./Service.ts";

type Config = { readonly version: number };

interface ResourceState {
  readonly phase: "created" | "launched" | "stopping" | "stopped";
  readonly health: "not-started" | "starting" | "healthy";
  readonly removed: boolean;
}

interface RuntimePlan {
  readonly launchGate: Deferred.Deferred<void>;
  readonly launchStarted: Deferred.Deferred<void>;
  readonly healthGate: Deferred.Deferred<void>;
  readonly healthStarted: Deferred.Deferred<void>;
  readonly exit: Deferred.Deferred<Exit.Exit<void, ServiceError>>;
  readonly stopGate: Deferred.Deferred<void>;
  readonly stopStarted: Deferred.Deferred<void>;
  readonly stopRetryStarted: Deferred.Deferred<void>;
  readonly stopFailure: Ref.Ref<boolean>;
  readonly removeGate: Deferred.Deferred<void>;
  readonly removeStarted: Deferred.Deferred<void>;
  readonly removeFailure: Ref.Ref<boolean>;
  readonly state: Ref.Ref<ResourceState>;
}

interface PreparationPlan {
  readonly gate: Deferred.Deferred<void>;
  readonly started: Deferred.Deferred<void>;
  readonly completed: Deferred.Deferred<void>;
}

const makeRuntimePlan = Effect.gen(function* () {
  return {
    launchGate: yield* Deferred.make<void>(),
    launchStarted: yield* Deferred.make<void>(),
    healthGate: yield* Deferred.make<void>(),
    healthStarted: yield* Deferred.make<void>(),
    exit: yield* Deferred.make<Exit.Exit<void, ServiceError>>(),
    stopGate: yield* Deferred.make<void>(),
    stopStarted: yield* Deferred.make<void>(),
    stopRetryStarted: yield* Deferred.make<void>(),
    stopFailure: yield* Ref.make(false),
    removeGate: yield* Deferred.make<void>(),
    removeStarted: yield* Deferred.make<void>(),
    removeFailure: yield* Ref.make(false),
    state: yield* Ref.make<ResourceState>({
      phase: "created",
      health: "not-started",
      removed: false,
    }),
  } satisfies RuntimePlan;
});

const makePreparationPlan = Effect.gen(function* () {
  return {
    gate: yield* Deferred.make<void>(),
    started: yield* Deferred.make<void>(),
    completed: yield* Deferred.make<void>(),
  } satisfies PreparationPlan;
});

const open = (deferred: Deferred.Deferred<void>) => Deferred.succeed(deferred, undefined);

const waitForObservation = <Config>(
  service: ServiceInstance<Config>,
  predicate: (observation: ServiceObservation<Config>) => boolean,
) =>
  service.observation.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.asVoid,
    Effect.forkScoped,
  );

const makeDefinition = (
  plans: Queue.Queue<RuntimePlan>,
  preparations?: Queue.Queue<PreparationPlan>,
  prepared?: Ref.Ref<ReadonlyArray<Config>>,
  invalid?: Ref.Ref<boolean>,
  launchFailure?: Ref.Ref<boolean>,
): ServiceDefinition<Config> => ({
  prepare:
    preparations === undefined && prepared === undefined && invalid === undefined
      ? undefined
      : (config) => {
          const queue = preparations;
          return Effect.gen(function* () {
            if (invalid !== undefined && (yield* Ref.get(invalid))) {
              return yield* new ServiceError({
                operation: "prepare",
                message: "invalid configuration",
              });
            }
            if (prepared !== undefined)
              yield* Ref.update(prepared, (values) => [...values, config]);
            if (queue !== undefined) {
              const preparation = yield* Queue.take(queue);
              yield* Deferred.succeed(preparation.started, undefined);
              yield* Deferred.await(preparation.gate);
              yield* Deferred.succeed(preparation.completed, undefined);
            }
          });
        },
  launch: (_context) =>
    Effect.gen(function* () {
      const plan = yield* Queue.take(plans);
      yield* Deferred.succeed(plan.launchStarted, undefined);
      yield* Deferred.await(plan.launchGate);
      if (launchFailure !== undefined && (yield* Ref.get(launchFailure))) {
        yield* Ref.set(launchFailure, false);
        return yield* new ServiceError({ operation: "launch", message: "launch failed" });
      }
      yield* Ref.update(plan.state, (state): ResourceState => ({ ...state, phase: "launched" }));
      const session: RuntimeSession = {
        health: Effect.gen(function* () {
          const state = yield* Ref.get(plan.state);
          if (state.health !== "not-started") {
            return yield* new ServiceError({
              operation: "health",
              message: "health started twice",
            });
          }
          yield* Ref.update(plan.state, (value): ResourceState => ({
            ...value,
            health: "starting",
          }));
          yield* Deferred.succeed(plan.healthStarted, undefined);
          yield* Deferred.await(plan.healthGate);
          yield* Ref.update(plan.state, (value): ResourceState => ({
            ...value,
            health: "healthy",
          }));
        }),
        exit: Deferred.await(plan.exit),
        stop: Effect.gen(function* () {
          yield* Ref.update(plan.state, (value): ResourceState => ({
            ...value,
            phase: "stopping",
          }));
          yield* Deferred.succeed(plan.stopStarted, undefined);
          if (yield* Ref.get(plan.stopFailure)) {
            yield* Ref.set(plan.stopFailure, false);
            return yield* new ServiceError({ operation: "stop", message: "stop failed" });
          }
          yield* Deferred.succeed(plan.stopRetryStarted, undefined);
          yield* Deferred.await(plan.stopGate);
          yield* Ref.update(plan.state, (value): ResourceState => ({ ...value, phase: "stopped" }));
        }),
        remove: Effect.gen(function* () {
          yield* Deferred.succeed(plan.removeStarted, undefined);
          if (yield* Ref.get(plan.removeFailure)) {
            yield* Ref.set(plan.removeFailure, false);
            return yield* new ServiceError({
              operation: "remove",
              message: "exact cleanup failed",
            });
          }
          yield* Deferred.await(plan.removeGate);
          yield* Ref.update(plan.state, (value) => ({ ...value, removed: true }));
        }),
      };
      return session;
    }),
  removeData: () => Effect.void,
});

const makeFixture = Effect.gen(function* () {
  const plans = yield* Queue.unbounded<RuntimePlan>();
  const service = yield* makeService(makeDefinition(plans), {
    id: "database-1",
    config: { version: 17 },
  });
  return { plans, service };
});

const stopFixture = (service: ServiceInstance<Config>, plan: RuntimePlan) =>
  Effect.gen(function* () {
    yield* open(plan.stopGate);
    yield* open(plan.removeGate);
    yield* service.stop;
  });

describe("service kernel", () => {
  it.live("submits stop while launch is delayed and completes it after launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        const starting = yield* fixture.service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.launchStarted);

        const stopping = yield* fixture.service.stop.pipe(Effect.forkScoped);
        expect((yield* fixture.service.get).lifecycle).toBe("starting");
        yield* open(plan.launchGate);
        yield* Fiber.join(starting);
        yield* Deferred.await(plan.stopStarted);
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
        yield* Fiber.join(stopping);

        expect((yield* fixture.service.get).lifecycle).toBe("stopped");
        expect((yield* Ref.get(plan.state)).removed).toBe(true);
      }),
    ),
  );

  it.live("shares one health program and a canceled readiness waiter does not poison it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* Deferred.await(plan.healthStarted);

        const canceled = yield* fixture.service.ready.pipe(Effect.forkScoped);
        const ready = yield* fixture.service.ready.pipe(Effect.forkScoped);
        yield* Fiber.interrupt(canceled);
        yield* open(plan.healthGate);
        expect(Exit.isSuccess(yield* Fiber.await(ready))).toBe(true);
        expect((yield* Ref.get(plan.state)).health).toBe("healthy");
        expect((yield* fixture.service.get).health).toBe("healthy");
        yield* stopFixture(fixture.service, plan);
      }),
    ),
  );

  it.live("cancels after preparation while waiting for the lifecycle gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const preparation = yield* makePreparationPlan;
        const retryPreparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, preparation);
        yield* Queue.offer(preparations, retryPreparation);
        const service = yield* makeService(makeDefinition(plans, preparations), {
          id: "database-gate-wait",
          config: { version: 17 },
        });
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);

        const storageStarted = yield* Deferred.make<void>();
        const storageGate = yield* Deferred.make<void>();
        const storage = yield* service
          .storage(
            Effect.gen(function* () {
              yield* Deferred.succeed(storageStarted, undefined);
              yield* Deferred.await(storageGate);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(storageStarted);

        const start = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(preparation.started);
        yield* open(preparation.gate);
        yield* Deferred.await(preparation.completed);
        yield* Fiber.interrupt(start);
        yield* open(storageGate);
        yield* Fiber.join(storage);

        expect(yield* Deferred.isDone(plan.launchStarted)).toBe(false);
        const retry = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(retryPreparation.started);
        yield* open(retryPreparation.gate);
        yield* open(plan.launchGate);
        yield* Fiber.join(retry);
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("does not prepare concurrent starts more than once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const preparation = yield* makePreparationPlan;
        const duplicatePreparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, preparation);
        yield* Queue.offer(preparations, duplicatePreparation);
        const service = yield* makeService(makeDefinition(plans, preparations), {
          id: "database-concurrent-prepare",
          config: { version: 17 },
        });
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);

        const first = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(preparation.started);
        yield* open(preparation.gate);
        yield* Deferred.await(preparation.completed);
        yield* Deferred.await(plan.launchStarted);
        const second = yield* service.start.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* open(plan.launchGate);
        yield* Fiber.join(first);
        expect(yield* Deferred.isDone(duplicatePreparation.started)).toBe(false);
        yield* Fiber.join(second);
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("reprepares a queued candidate after the current launch fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const firstPreparation = yield* makePreparationPlan;
        const secondPreparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, firstPreparation);
        yield* Queue.offer(preparations, secondPreparation);
        const launchFailure = yield* Ref.make(true);
        const service = yield* makeService(
          makeDefinition(plans, preparations, undefined, undefined, launchFailure),
          { id: "database-retry-prepare", config: { version: 17 } },
        );
        const firstPlan = yield* makeRuntimePlan;
        const secondPlan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, firstPlan);
        yield* Queue.offer(plans, secondPlan);

        const first = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(firstPreparation.started);
        yield* open(firstPreparation.gate);
        yield* Deferred.await(firstPlan.launchStarted);
        const second = yield* service
          .startAt(0, { version: 18 }, false, Effect.void)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* open(firstPlan.launchGate);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        yield* Deferred.await(secondPreparation.started);
        yield* open(secondPreparation.gate);
        yield* open(secondPlan.launchGate);
        yield* Fiber.join(second);
        expect((yield* service.get).config.version).toBe(18);
        yield* stopFixture(service, secondPlan);
      }),
    ),
  );

  it.live("invalidates a prepared start when stop is admitted before preparation finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const preparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, preparation);
        const service = yield* makeService(makeDefinition(plans, preparations), {
          id: "database-stale-preparation",
          config: { version: 17 },
        });
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);
        const start = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(preparation.started);

        yield* service.stop;
        yield* open(preparation.gate);
        const result = yield* Fiber.await(start);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* Deferred.isDone(plan.launchStarted)).toBe(false);
        expect((yield* service.get).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("records a launch failure as stopped and can launch successfully on retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const failLaunch = yield* Ref.make(true);
        const definition = makeDefinition(plans);
        const service = yield* makeService(
          {
            launch: (context) =>
              Effect.gen(function* () {
                if (yield* Ref.get(failLaunch)) {
                  yield* Ref.set(failLaunch, false);
                  return yield* new ServiceError({
                    operation: "launch",
                    message: "binary unavailable",
                  });
                }
                return yield* definition.launch(context);
              }),
            removeData: definition.removeData,
          },
          { id: "database-launch-retry", config: { version: 17 } },
        );
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);

        const failed = yield* service.start.pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* service.get).lifecycle).toBe("stopped");
        expect((yield* service.get).error?.operation).toBe("launch");
        expect((yield* Ref.get(plan.state)).phase).toBe("created");

        yield* open(plan.launchGate);
        yield* service.start;
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("retains a runtime acquired before launch failure for exact cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        const base = makeDefinition(fixture.plans);
        const failure = new ServiceError({ operation: "launch", message: "initialization failed" });
        const partial = yield* makeService(
          {
            launch: (context) =>
              base
                .launch(context)
                .pipe(
                  Effect.flatMap((runtime) =>
                    Effect.fail(new ServiceLaunchError({ failure, runtime })),
                  ),
                ),
            removeData: base.removeData,
          },
          { id: "database-partial", config: { version: 17 } },
        );
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* Ref.set(plan.stopFailure, true);

        const failed = yield* partial.start.pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* partial.get).lifecycle).toBe("stopping");
        expect((yield* partial.get).error).toEqual(failure);
        expect((yield* partial.get).cleanupError).toBeDefined();
        expect((yield* Ref.get(plan.state)).removed).toBe(false);

        const retry = yield* partial.stop.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.stopRetryStarted);
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
        yield* Fiber.join(retry);
        expect((yield* partial.get).lifecycle).toBe("stopped");
        expect((yield* Ref.get(plan.state)).removed).toBe(true);

        const plans2 = yield* Queue.unbounded<RuntimePlan>();
        const plan2 = yield* makeRuntimePlan;
        const base2 = makeDefinition(plans2);
        const cleanFailure = new ServiceError({
          operation: "launch",
          message: "clean partial failure",
        });
        const cleaned = yield* makeService(
          {
            launch: (context) =>
              base2
                .launch(context)
                .pipe(
                  Effect.flatMap((runtime) =>
                    Effect.fail(new ServiceLaunchError({ failure: cleanFailure, runtime })),
                  ),
                ),
            removeData: base2.removeData,
          },
          { id: "database-partial-clean", config: { version: 17 } },
        );
        yield* Queue.offer(plans2, plan2);
        yield* open(plan2.launchGate);
        yield* open(plan2.stopGate);
        yield* open(plan2.removeGate);
        expect(Exit.isFailure(yield* cleaned.start.pipe(Effect.exit))).toBe(true);
        expect((yield* cleaned.get).lifecycle).toBe("stopped");
        expect((yield* Ref.get(plan2.state)).removed).toBe(true);
      }),
    ),
  );

  it.live("admits a prepared start after restart and does not relaunch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const queuedStartPreparation = yield* makePreparationPlan;
        const restartPreparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, queuedStartPreparation);
        yield* Queue.offer(preparations, restartPreparation);
        const service = yield* makeService(makeDefinition(plans, preparations), {
          id: "database-start-after-restart",
          config: { version: 17 },
        });
        const first = yield* makeRuntimePlan;
        const unused = yield* makeRuntimePlan;
        yield* Queue.offer(plans, first);
        yield* Queue.offer(plans, unused);

        const queuedStart = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(queuedStartPreparation.started);

        const restart = yield* service.restart().pipe(Effect.forkScoped);
        yield* Deferred.await(restartPreparation.started);
        yield* open(restartPreparation.gate);
        yield* open(first.launchGate);
        yield* Fiber.join(restart);
        expect((yield* service.get).lifecycle).toBe("running");

        yield* open(queuedStartPreparation.gate);
        expect(Exit.isSuccess(yield* Fiber.await(queuedStart))).toBe(true);
        expect((yield* service.get).launchId).toBe(1);
        expect(yield* Deferred.isDone(unused.launchStarted)).toBe(false);
        yield* stopFixture(service, first);
      }),
    ),
  );

  it.live("accepts a prepared start queued during restart once restart is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const initialPreparation = yield* makePreparationPlan;
        const queuedStartPreparation = yield* makePreparationPlan;
        const restartPreparation = yield* makePreparationPlan;
        yield* open(initialPreparation.gate);
        yield* Queue.offer(preparations, initialPreparation);
        yield* Queue.offer(preparations, restartPreparation);
        yield* Queue.offer(preparations, queuedStartPreparation);
        const service = yield* makeService(makeDefinition(plans, preparations), {
          id: "database-restart-queue",
          config: { version: 17 },
        });
        const first = yield* makeRuntimePlan;
        const second = yield* makeRuntimePlan;
        yield* Queue.offer(plans, first);
        yield* Queue.offer(plans, second);
        yield* open(first.launchGate);
        yield* service.start;

        const restartRunning = yield* waitForObservation(
          service,
          (value) => value.currentOperation === "restart",
        );
        const restart = yield* service.restart().pipe(Effect.forkScoped);
        yield* Deferred.await(restartPreparation.started);
        yield* open(restartPreparation.gate);
        yield* Fiber.join(restartRunning);
        const queuedStart = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(queuedStartPreparation.started);
        yield* Deferred.await(first.stopStarted);
        yield* open(first.stopGate);
        yield* Deferred.await(first.removeStarted);
        yield* open(first.removeGate);
        yield* Deferred.await(second.launchStarted);
        yield* open(queuedStartPreparation.gate);
        yield* open(second.launchGate);
        yield* Fiber.join(restart);
        expect(Exit.isSuccess(yield* Fiber.await(queuedStart))).toBe(true);
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, second);
      }),
    ),
  );

  it.live("keeps an admitted launch alive after its caller is canceled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        const running = yield* waitForObservation(
          fixture.service,
          (value) => value.lifecycle === "running",
        );
        const caller = yield* fixture.service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.launchStarted);
        yield* Fiber.interrupt(caller);
        yield* open(plan.launchGate);
        yield* Fiber.join(running);
        expect((yield* Ref.get(plan.state)).phase).toBe("launched");
        yield* stopFixture(fixture.service, plan);
      }),
    ),
  );

  it.live("lets independent instances progress concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leftFixture = yield* makeFixture;
        const rightFixture = yield* makeFixture;
        const leftPlan = yield* makeRuntimePlan;
        const rightPlan = yield* makeRuntimePlan;
        yield* Queue.offer(leftFixture.plans, leftPlan);
        yield* Queue.offer(rightFixture.plans, rightPlan);
        const leftRunning = yield* waitForObservation(
          leftFixture.service,
          (value) => value.lifecycle === "running",
        );
        const rightRunning = yield* waitForObservation(
          rightFixture.service,
          (value) => value.lifecycle === "running",
        );
        const leftStart = yield* leftFixture.service.start.pipe(Effect.forkScoped);
        const rightStart = yield* rightFixture.service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(leftPlan.launchStarted);
        yield* Deferred.await(rightPlan.launchStarted);
        yield* open(leftPlan.launchGate);
        yield* Fiber.join(leftRunning);
        expect((yield* leftFixture.service.get).lifecycle).toBe("running");
        expect((yield* rightFixture.service.get).lifecycle).toBe("starting");
        yield* open(rightPlan.launchGate);
        yield* Fiber.join(leftStart);
        yield* Fiber.join(rightRunning);
        yield* Fiber.join(rightStart);
        yield* stopFixture(leftFixture.service, leftPlan);
        yield* stopFixture(rightFixture.service, rightPlan);
      }),
    ),
  );

  it.live("keeps exact cleanup authority after failure and retries only remaining cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* open(plan.stopGate);
        yield* Ref.set(plan.removeFailure, true);
        const failed = yield* fixture.service.stop.pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.service.get).lifecycle).toBe("stopping");
        expect((yield* Ref.get(plan.state)).removed).toBe(false);
        yield* open(plan.removeGate);
        yield* fixture.service.stop;
        expect((yield* fixture.service.get).lifecycle).toBe("stopped");
        expect((yield* Ref.get(plan.state)).removed).toBe(true);
      }),
    ),
  );

  it.live("keeps registration after data removal failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        const dataFailure = yield* Ref.make(true);
        const service = yield* makeService(
          {
            launch: makeDefinition(fixture.plans).launch,
            removeData: () =>
              Effect.gen(function* () {
                if (yield* Ref.get(dataFailure)) {
                  yield* Ref.set(dataFailure, false);
                  return yield* new ServiceError({ operation: "data", message: "retry" });
                }
              }),
          },
          { id: "database-data", config: { version: 17 } },
        );
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* service.start;
        yield* stopFixture(service, plan);
        expect(Exit.isFailure(yield* service.destroy.pipe(Effect.exit))).toBe(true);
        expect((yield* service.get).registered).toBe(true);
        yield* service.destroy;
        expect((yield* service.get).registered).toBe(false);
      }),
    ),
  );

  it.live("destroys a running instance and retains registration after stop failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* open(plan.stopGate);
        yield* open(plan.removeGate);
        yield* fixture.service.destroy;
        expect((yield* fixture.service.get).registered).toBe(false);
        expect((yield* Ref.get(plan.state)).removed).toBe(true);

        const plans = yield* Queue.unbounded<RuntimePlan>();
        const dataRemoved = yield* Ref.make(false);
        const service = yield* makeService(
          {
            launch: makeDefinition(plans).launch,
            removeData: () => Ref.set(dataRemoved, true),
          },
          { id: "database-destroy-stop-failure", config: { version: 17 } },
        );
        const failedPlan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, failedPlan);
        yield* open(failedPlan.launchGate);
        yield* service.start;
        yield* Ref.set(failedPlan.stopFailure, true);

        expect(Exit.isFailure(yield* service.destroy.pipe(Effect.exit))).toBe(true);
        expect((yield* service.get).lifecycle).toBe("stopping");
        expect((yield* service.get).registered).toBe(true);
        expect(yield* Ref.get(dataRemoved)).toBe(false);

        yield* open(failedPlan.stopGate);
        yield* open(failedPlan.removeGate);
        yield* service.stop;
        yield* service.destroy;
        expect(yield* Ref.get(dataRemoved)).toBe(true);
        expect((yield* service.get).registered).toBe(false);
      }),
    ),
  );

  it.live("reports a destroyed instance as ServiceDestroyed to readiness callers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* fixture.service.destroy;
        const result = yield* fixture.service.ready.pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = result.cause.reasons.find(Cause.isFailReason);
          expect(failure !== undefined && failure.error instanceof ServiceDestroyed).toBe(true);
        }
      }),
    ),
  );

  it.live("waits for a pending launch before checking readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        const start = yield* fixture.service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.launchStarted);
        const ready = yield* fixture.service.ready.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* open(plan.launchGate);
        yield* Deferred.await(plan.healthStarted);
        yield* open(plan.healthGate);
        expect(Exit.isSuccess(yield* Fiber.await(ready))).toBe(true);
        yield* Fiber.join(start);
        yield* stopFixture(fixture.service, plan);
      }),
    ),
  );

  it.live("serializes storage and destroy through the same gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const storageStarted = yield* Deferred.make<void>();
        const storageGate = yield* Deferred.make<void>();
        const service = yield* makeService(
          {
            launch: makeDefinition(plans).launch,
            removeData: () => Effect.void,
          },
          { id: "database-storage", config: { version: 17 } },
        );
        const storage = yield* service
          .storage(
            Effect.gen(function* () {
              yield* Deferred.succeed(storageStarted, undefined);
              yield* Deferred.await(storageGate);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(storageStarted);
        const destroying = yield* service.destroy.pipe(Effect.forkScoped);
        expect((yield* service.get).currentOperation).toBe("storage");
        yield* open(storageGate);
        yield* Fiber.join(storage);
        yield* Fiber.join(destroying);
        expect((yield* service.get).registered).toBe(false);
      }),
    ),
  );

  it.live("prepares invalid restart configuration before stopping current runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const prepared = yield* Ref.make<ReadonlyArray<Config>>([]);
        const invalid = yield* Ref.make(false);
        const service = yield* makeService(makeDefinition(plans, undefined, prepared, invalid), {
          id: "database-restart",
          config: { version: 17 },
        });
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);
        yield* open(plan.launchGate);
        yield* service.start;
        yield* Ref.set(invalid, true);
        expect(Exit.isFailure(yield* service.restart({ version: 18 }).pipe(Effect.exit))).toBe(
          true,
        );
        expect((yield* service.get).lifecycle).toBe("running");
        expect((yield* service.get).config.version).toBe(17);
        expect((yield* Ref.get(plan.state)).removed).toBe(false);
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("cleans an exact runtime after an unexpected exit during health", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* Deferred.await(plan.healthStarted);
        const ready = yield* fixture.service.ready.pipe(Effect.forkScoped);
        const stopping = yield* waitForObservation(
          fixture.service,
          (value) => value.lifecycle === "stopping",
        );
        const stopped = yield* waitForObservation(
          fixture.service,
          (value) => value.lifecycle === "stopped",
        );
        yield* Deferred.succeed(
          plan.exit,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Deferred.await(plan.stopStarted);
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
        yield* Fiber.join(stopping);
        yield* Fiber.join(stopped);
        expect(Exit.isFailure(yield* Fiber.await(ready))).toBe(true);
        expect((yield* fixture.service.get).lifecycle).toBe("stopped");
        expect((yield* Ref.get(plan.state)).removed).toBe(true);
        expect((yield* fixture.service.get).wakeEnabled).toBe(false);
      }),
    ),
  );

  it.live("reports stop as the current operation during exit cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* Deferred.succeed(
          plan.exit,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Deferred.await(plan.stopStarted);
        expect((yield* fixture.service.get).currentOperation).toBe("stop");
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
      }),
    ),
  );

  it.live("preserves cleanupError while a retry is admitted and blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* Ref.set(plan.stopFailure, true);
        expect(Exit.isFailure(yield* fixture.service.stop.pipe(Effect.exit))).toBe(true);
        expect((yield* fixture.service.get).cleanupError).toBeDefined();

        const retry = yield* fixture.service.stop.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.stopRetryStarted);
        const exited = yield* waitForObservation(
          fixture.service,
          (value) => value.exit !== undefined,
        );
        yield* Deferred.succeed(
          plan.exit,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Fiber.join(exited);
        expect((yield* fixture.service.get).cleanupError).toBeDefined();
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
        yield* Fiber.join(retry);
        expect((yield* fixture.service.get).cleanupError).toBeUndefined();
      }),
    ),
  );

  it.live(
    "makes an old readiness wait stale across stop and lets the new launch become ready",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture;
          const first = yield* makeRuntimePlan;
          const second = yield* makeRuntimePlan;
          yield* Queue.offer(fixture.plans, first);
          yield* Queue.offer(fixture.plans, second);
          yield* open(first.launchGate);
          yield* fixture.service.start;
          yield* Deferred.await(first.healthStarted);

          const oldReady = yield* fixture.service.ready.pipe(Effect.forkScoped);
          const stopping = yield* fixture.service.stop.pipe(Effect.forkScoped);
          yield* Deferred.await(first.stopStarted);
          yield* open(first.stopGate);
          yield* Deferred.await(first.removeStarted);
          yield* open(first.removeGate);
          yield* Fiber.join(stopping);
          expect(Exit.isFailure(yield* Fiber.await(oldReady))).toBe(true);

          yield* open(second.launchGate);
          yield* fixture.service.start;
          yield* Deferred.await(second.healthStarted);
          const newReady = yield* fixture.service.ready.pipe(Effect.forkScoped);
          yield* open(second.healthGate);
          expect(Exit.isSuccess(yield* Fiber.await(newReady))).toBe(true);
          expect((yield* fixture.service.get).launchId).toBe(2);
          yield* stopFixture(fixture.service, second);
        }),
      ),
  );
});

it.live("retains armed wake after a partially launched process exits during cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const exited = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
      const stopping = yield* Deferred.make<void>();
      const finishStop = yield* Deferred.make<void>();
      const failure = new ServiceError({ operation: "launch", message: "initialization failed" });
      const service = yield* makeService(
        {
          launch: () =>
            Effect.fail(
              new ServiceLaunchError({
                failure,
                runtime: {
                  health: Effect.never,
                  exit: Deferred.await(exited),
                  stop: Deferred.succeed(stopping, undefined).pipe(
                    Effect.andThen(Deferred.await(finishStop)),
                  ),
                  remove: Effect.void,
                },
              }),
            ),
          removeData: () => Effect.void,
        },
        { id: "armed-partial", config: {} },
      );
      yield* service.arm;
      const observedExit = yield* waitForObservation(service, (state) => state.exit !== undefined);
      const starting = yield* service.start.pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* Deferred.succeed(exited, Exit.void);
      yield* Fiber.join(observedExit);
      yield* Deferred.succeed(finishStop, undefined);
      expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);
      expect((yield* service.get).lifecycle).toBe("stopped");
      expect((yield* service.get).wakeEnabled).toBe(true);
    }),
  ),
);

it.live("keeps a sleeping instance armed when exit observation retries failed removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const exited = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
      const failRemoval = yield* Ref.make(true);
      const service = yield* makeService(
        {
          launch: () =>
            Effect.succeed({
              health: Effect.void,
              exit: Deferred.await(exited),
              stop: Effect.void,
              remove: Ref.getAndSet(failRemoval, false).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(
                        new ServiceError({
                          operation: "remove",
                          message: "temporary removal failure",
                        }),
                      )
                    : Effect.void,
                ),
              ),
            }),
          removeData: () => Effect.void,
        },
        { id: "sleep-cleanup-retry", config: {} },
      );
      yield* service.arm;
      yield* service.start;
      yield* service.ready;
      expect(Exit.isFailure(yield* Effect.exit(service.sleep))).toBe(true);
      expect((yield* service.get).wakeEnabled).toBe(true);
      const stopped = yield* waitForObservation(service, (state) => state.lifecycle === "stopped");
      yield* Deferred.succeed(exited, Exit.void);
      yield* Fiber.join(stopped);
      expect((yield* service.get).wakeEnabled).toBe(true);
    }),
  ),
);
