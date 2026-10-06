import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Queue, Ref, Scope, Stream } from "effect";
import { makeStandaloneService } from "../tests/standalone-service.ts";
import { LifecycleEvent } from "./Lifecycle.ts";
import type { Status } from "./Orchestrator.ts";
import {
  makeService,
  ServiceError,
  ServiceLaunchError,
  type RuntimeSession,
  type ServiceDefinition,
} from "./Service.ts";

type Config = { readonly version: number };
type Standalone = Effect.Success<ReturnType<typeof makeStandaloneService<Config>>>;

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
  } satisfies PreparationPlan;
});

const open = (deferred: Deferred.Deferred<void>) => Deferred.succeed(deferred, undefined);

const waitForStatus = (service: Standalone, predicate: (status: Status) => boolean) =>
  service.observation.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.asVoid,
    Effect.forkScoped({ startImmediately: true }),
  );

const makeDefinition = (
  plans: Queue.Queue<RuntimePlan>,
  options: {
    readonly preparations?: Queue.Queue<PreparationPlan>;
    readonly invalid?: Ref.Ref<boolean>;
  } = {},
): ServiceDefinition<Config> => ({
  prepare: () =>
    Effect.gen(function* () {
      if (options.invalid !== undefined && (yield* Ref.get(options.invalid)))
        return yield* new ServiceError({ operation: "prepare", message: "invalid configuration" });
      if (options.preparations === undefined) return;
      const preparation = yield* Queue.take(options.preparations);
      yield* open(preparation.started);
      yield* Deferred.await(preparation.gate);
    }),
  launch: (_context) =>
    Effect.gen(function* () {
      const plan = yield* Queue.take(plans);
      yield* open(plan.launchStarted);
      yield* Deferred.await(plan.launchGate);
      yield* Ref.update(plan.state, (state): ResourceState => ({ ...state, phase: "launched" }));
      const session: RuntimeSession = {
        health: Effect.gen(function* () {
          yield* Ref.update(plan.state, (value): ResourceState => ({
            ...value,
            health: "starting",
          }));
          yield* open(plan.healthStarted);
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
          yield* open(plan.stopStarted);
          if (yield* Ref.getAndSet(plan.stopFailure, false))
            return yield* new ServiceError({ operation: "stop", message: "stop failed" });
          yield* open(plan.stopRetryStarted);
          yield* Deferred.await(plan.stopGate);
          yield* Ref.update(plan.state, (value): ResourceState => ({ ...value, phase: "stopped" }));
        }),
        remove: Effect.gen(function* () {
          yield* open(plan.removeStarted);
          if (yield* Ref.getAndSet(plan.removeFailure, false))
            return yield* new ServiceError({
              operation: "remove",
              message: "exact cleanup failed",
            });
          yield* Deferred.await(plan.removeGate);
          yield* Ref.update(plan.state, (value) => ({ ...value, removed: true }));
        }),
      };
      return session;
    }),
  removeData: () => Effect.void,
});

const makeFixture = (id: string, definition = makeDefinition) =>
  Effect.gen(function* () {
    const plans = yield* Queue.unbounded<RuntimePlan>();
    const service = yield* makeStandaloneService(definition(plans), {
      id,
      config: { version: 17 },
    });
    return { plans, service };
  });

const partialFailure = new ServiceError({ operation: "launch", message: "initialization failed" });

/** Acquires a runtime, then fails the launch with it retained for cleanup. */
const partialDefinition = (plans: Queue.Queue<RuntimePlan>): ServiceDefinition<Config> => {
  const base = makeDefinition(plans);
  return {
    launch: (context) =>
      base
        .launch(context)
        .pipe(
          Effect.flatMap((runtime) =>
            Effect.fail(new ServiceLaunchError({ failure: partialFailure, runtime })),
          ),
        ),
    removeData: base.removeData,
  };
};

/** Waits until the service's lifecycle records a pending destroy. */
const awaitDestroyPending = (service: Standalone) =>
  service.observation.pipe(
    Stream.filter((status) => status.destroyPending),
    Stream.runHead,
  );

const stopFixture = (service: Standalone, plan: RuntimePlan) =>
  Effect.gen(function* () {
    yield* open(plan.stopGate);
    yield* open(plan.removeGate);
    yield* service.stop;
  });

describe("service execution", () => {
  it.live(
    "stops a launch requested to stop mid-launch once its runtime exists, then cleans it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture("database-mid-launch");
          const plan = yield* makeRuntimePlan;
          yield* Queue.offer(fixture.plans, plan);
          const starting = yield* fixture.service.start.pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(plan.launchStarted);

          const stopRequested = yield* waitForStatus(
            fixture.service,
            (status) => status.lifecycle === "stopping",
          );
          const stopping = yield* fixture.service.stop.pipe(Effect.forkScoped);
          yield* Fiber.join(stopRequested);
          yield* open(plan.launchGate);
          yield* Deferred.await(plan.stopStarted);
          yield* open(plan.stopGate);
          yield* Deferred.await(plan.removeStarted);
          yield* open(plan.removeGate);
          yield* Fiber.join(stopping);

          expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
          expect((yield* fixture.service.get).lifecycle).toBe("stopped");
          expect((yield* Ref.get(plan.state)).removed).toBe(true);
        }),
      ),
  );

  it.live("shares one health check and a cancelled readiness caller does not poison it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture("database-shared-health");
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* Deferred.await(plan.healthStarted);

        const cancelled = yield* fixture.service.ready.pipe(Effect.forkScoped);
        const ready = yield* fixture.service.ready.pipe(Effect.forkScoped);
        yield* Fiber.interrupt(cancelled);
        yield* open(plan.healthGate);
        expect(Exit.isSuccess(yield* Fiber.await(ready))).toBe(true);
        expect((yield* Ref.get(plan.state)).health).toBe("healthy");
        expect((yield* fixture.service.get).health).toBe("healthy");
        yield* stopFixture(fixture.service, plan);
      }),
    ),
  );

  it.live("records a failed preparation on the observation and stays wakeable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const invalid = yield* Ref.make(true);
        const service = yield* makeStandaloneService(makeDefinition(plans, { invalid }), {
          id: "database-prepare-failure",
          config: { version: 17 },
        });
        const failure = yield* service.start.pipe(Effect.flip);
        expect(failure.message).toContain("invalid configuration");
        expect(yield* service.get).toMatchObject({
          lifecycle: "stopped",
          wakeEnabled: true,
          error: { message: "invalid configuration" },
        });
      }),
    ),
  );

  it.live("keeps a stopped launch's late preparation failure off its successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const staleStarted = yield* Deferred.make<void>();
        const staleGate = yield* Deferred.make<void>();
        const attempts = yield* Ref.make(0);
        const service = yield* makeStandaloneService(
          {
            ...makeDefinition(plans),
            // Uninterruptible, so the stop has to wait it out and its failure arrives late.
            prepare: () =>
              Effect.gen(function* () {
                if ((yield* Ref.updateAndGet(attempts, (value) => value + 1)) > 1) return;
                yield* open(staleStarted);
                yield* Deferred.await(staleGate);
                return yield* new ServiceError({
                  operation: "prepare",
                  message: "stale preparation",
                });
              }).pipe(Effect.uninterruptible),
          },
          { id: "database-stale-failure", config: { version: 17 } },
        );
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);
        yield* open(plan.launchGate);
        const stale = yield* service.start.pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(staleStarted);
        // The stop of generation 1 is admitted, and waiting on its preparation, before it fails.
        const stopAdmitted = yield* waitForStatus(
          service,
          (status) => status.lifecycle === "stopping",
        );
        const restarted = yield* service.restart().pipe(Effect.forkScoped);
        yield* Fiber.join(stopAdmitted);
        yield* open(staleGate);
        yield* Fiber.join(restarted);
        expect((yield* service.get).launchId).toBe(2);

        // The earlier start is satisfied by the restarted generation.
        expect(Exit.isSuccess(yield* Fiber.join(stale))).toBe(true);
        expect(yield* service.get).toMatchObject({ lifecycle: "running", error: undefined });
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("prepares and launches once for concurrent starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const preparation = yield* makePreparationPlan;
        const duplicatePreparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, preparation);
        yield* Queue.offer(preparations, duplicatePreparation);
        const service = yield* makeStandaloneService(makeDefinition(plans, { preparations }), {
          id: "database-concurrent-start",
          config: { version: 17 },
        });
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);

        const first = yield* service.start.pipe(Effect.forkScoped);
        yield* Deferred.await(preparation.started);
        const second = yield* service.start.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* open(preparation.gate);
        yield* open(plan.launchGate);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Deferred.isDone(duplicatePreparation.started)).toBe(false);
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("skips the launch when a stop arrives during preparation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const preparation = yield* makePreparationPlan;
        yield* Queue.offer(preparations, preparation);
        const service = yield* makeStandaloneService(makeDefinition(plans, { preparations }), {
          id: "database-stop-in-preparation",
          config: { version: 17 },
        });
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);
        const start = yield* service.start.pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(preparation.started);

        yield* service.stop;
        yield* open(preparation.gate);
        expect(Exit.isFailure(yield* Fiber.join(start))).toBe(true);
        expect(yield* Deferred.isDone(plan.launchStarted)).toBe(false);
        expect((yield* service.get).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("never launches a restart whose service is destroyed while it prepares", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const preparations = yield* Queue.unbounded<PreparationPlan>();
        const initialPreparation = yield* makePreparationPlan;
        const restartPreparation = yield* makePreparationPlan;
        yield* open(initialPreparation.gate);
        yield* Queue.offer(preparations, initialPreparation);
        yield* Queue.offer(preparations, restartPreparation);
        const service = yield* makeStandaloneService(makeDefinition(plans, { preparations }), {
          id: "database-late-restart",
          config: { version: 17 },
        });
        const original = yield* makeRuntimePlan;
        const superseded = yield* makeRuntimePlan;
        yield* Queue.offer(plans, original);
        yield* Queue.offer(plans, superseded);
        yield* open(original.launchGate);
        yield* service.start;

        const restarting = yield* service.restart({ version: 18 }).pipe(Effect.forkScoped);
        yield* Deferred.await(restartPreparation.started);
        yield* open(original.stopGate);
        yield* open(original.removeGate);
        yield* service.destroy;
        expect(yield* service.listed).toBe(false);
        expect((yield* Ref.get(original.state)).removed).toBe(true);

        yield* open(restartPreparation.gate);
        expect(Exit.isFailure(yield* Fiber.await(restarting))).toBe(true);
        expect(yield* Deferred.isDone(superseded.launchStarted)).toBe(false);
      }),
    ),
  );

  it.live("records a launch failure as stopped and launches successfully on retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const failLaunch = yield* Ref.make(true);
        const definition = makeDefinition(plans);
        const service = yield* makeStandaloneService(
          {
            launch: (context) =>
              Ref.getAndSet(failLaunch, false).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(
                        new ServiceError({ operation: "launch", message: "binary unavailable" }),
                      )
                    : definition.launch(context),
                ),
              ),
            removeData: definition.removeData,
          },
          { id: "database-launch-retry", config: { version: 17 } },
        );
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);

        expect(Exit.isFailure(yield* service.start.pipe(Effect.exit))).toBe(true);
        expect(yield* service.get).toMatchObject({
          lifecycle: "stopped",
          error: { operation: "launch" },
        });
        expect((yield* Ref.get(plan.state)).phase).toBe("created");

        yield* open(plan.launchGate);
        yield* service.start;
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("retains a runtime acquired before a launch failure for exact cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = partialFailure;
        const partial = yield* makeFixture("database-partial", partialDefinition);
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(partial.plans, plan);
        yield* open(plan.launchGate);
        yield* Ref.set(plan.stopFailure, true);

        expect(Exit.isFailure(yield* partial.service.start.pipe(Effect.exit))).toBe(true);
        expect(yield* partial.service.get).toMatchObject({ lifecycle: "stopping", error: failure });
        expect((yield* partial.service.get).cleanupError).toBeDefined();
        expect((yield* Ref.get(plan.state)).removed).toBe(false);

        const retry = yield* partial.service.stop.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.stopRetryStarted);
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
        yield* Fiber.join(retry);
        expect(yield* partial.service.get).toMatchObject({
          lifecycle: "stopped",
          cleanupError: undefined,
        });
        expect((yield* Ref.get(plan.state)).removed).toBe(true);

        const cleaned = yield* makeFixture("database-partial-clean", partialDefinition);
        const cleanPlan = yield* makeRuntimePlan;
        yield* Queue.offer(cleaned.plans, cleanPlan);
        yield* open(cleanPlan.launchGate);
        yield* open(cleanPlan.stopGate);
        yield* open(cleanPlan.removeGate);
        expect(Exit.isFailure(yield* cleaned.service.start.pipe(Effect.exit))).toBe(true);
        expect((yield* cleaned.service.get).lifecycle).toBe("stopped");
        expect((yield* Ref.get(cleanPlan.state)).removed).toBe(true);
      }),
    ),
  );

  it.live(
    "keeps a retained runtime pending cleanup, refusing storage, until a stop retry confirms its removal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture("database-retained", partialDefinition);
          const plan = yield* makeRuntimePlan;
          yield* Queue.offer(fixture.plans, plan);
          yield* open(plan.launchGate);
          yield* Ref.set(plan.stopFailure, true);
          expect(Exit.isFailure(yield* fixture.service.start.pipe(Effect.exit))).toBe(true);

          yield* Ref.set(plan.stopFailure, true);
          expect(Exit.isFailure(yield* fixture.service.stop.pipe(Effect.exit))).toBe(true);
          expect((yield* fixture.service.get).lifecycle).toBe("stopping");
          expect(
            Exit.isFailure(yield* fixture.service.storage(Effect.void).pipe(Effect.exit)),
          ).toBe(true);

          yield* open(plan.stopGate);
          yield* open(plan.removeGate);
          yield* fixture.service.stop;
          expect((yield* fixture.service.get).lifecycle).toBe("stopped");
          expect((yield* Ref.get(plan.state)).removed).toBe(true);
        }),
      ),
  );

  it.live(
    "fails a restart whose stop fails instead of waiting, and retries the cleanup on stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture("database-restart-stop-failure");
          const plan = yield* makeRuntimePlan;
          yield* Queue.offer(fixture.plans, plan);
          yield* open(plan.launchGate);
          yield* fixture.service.start;
          yield* Ref.set(plan.stopFailure, true);

          const failed = yield* fixture.service
            .restart()
            .pipe(Effect.flip, Effect.timeoutOption("5 seconds"));
          expect(Option.getOrUndefined(failed)?.message).toContain("stop failed");
          expect((yield* fixture.service.get).lifecycle).toBe("stopping");

          yield* stopFixture(fixture.service, plan);
          expect((yield* fixture.service.get).lifecycle).toBe("stopped");
          expect((yield* Ref.get(plan.state)).removed).toBe(true);
        }),
      ),
  );

  it.live("never lets a late stop of an older generation touch a newer session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const service = yield* makeService(makeDefinition(plans), {
          id: "database-late-stop",
          config: { version: 17 },
          report: () => Effect.void,
        });
        const first = yield* makeRuntimePlan;
        const second = yield* makeRuntimePlan;
        yield* Queue.offer(plans, first);
        yield* Queue.offer(plans, second);
        for (const plan of [first, second])
          for (const gate of [plan.launchGate, plan.healthGate, plan.stopGate, plan.removeGate])
            yield* open(gate);
        const stopOptions = { operation: "stop", discard: false } as const;

        yield* service.launch(1, { version: 17 });
        yield* service.stop(1, stopOptions);
        yield* service.launch(2, { version: 17 });
        yield* service.stop(1, stopOptions);

        expect((yield* Ref.get(second.state)).phase).toBe("launched");
        yield* service.stop(2, stopOptions);
        expect((yield* Ref.get(second.state)).removed).toBe(true);
      }),
    ),
  );

  it.live(
    "keeps a launch, and the resources its scope owns, alive after its caller is cancelled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const resourceClosed = yield* Deferred.make<void>();
          const launchStarted = yield* Deferred.make<void>();
          const launchGate = yield* Deferred.make<void>();
          const service = yield* makeStandaloneService<Config>(
            {
              launch: (context) =>
                Effect.gen(function* () {
                  yield* Scope.addFinalizer(
                    context.scope,
                    open(resourceClosed).pipe(Effect.asVoid),
                  );
                  yield* open(launchStarted);
                  yield* Deferred.await(launchGate);
                  return {
                    health: Effect.void,
                    exit: Effect.never,
                    stop: Effect.void,
                    remove: Effect.void,
                  } satisfies RuntimeSession;
                }),
              removeData: () => Effect.void,
            },
            { id: "cold-launch-resource", config: { version: 1 } },
          );
          const caller = yield* service.start.pipe(Effect.forkScoped);
          yield* Deferred.await(launchStarted);
          yield* Fiber.interrupt(caller);
          expect(yield* Deferred.isDone(resourceClosed)).toBe(false);
          yield* open(launchGate);
          yield* service.ready;
          expect((yield* service.get).lifecycle).toBe("running");
          expect(yield* Deferred.isDone(resourceClosed)).toBe(false);
          yield* service.stop;
          expect(yield* Deferred.isDone(resourceClosed)).toBe(true);
        }),
      ),
  );

  it.live("keeps exact cleanup authority after a failed stop and retries only what remains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture("database-cleanup-retry");
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* open(plan.stopGate);
        yield* Ref.set(plan.removeFailure, true);
        expect(Exit.isFailure(yield* fixture.service.stop.pipe(Effect.exit))).toBe(true);
        expect(yield* fixture.service.get).toMatchObject({ lifecycle: "stopping" });
        expect((yield* fixture.service.get).cleanupError).toBeDefined();
        expect((yield* Ref.get(plan.state)).removed).toBe(false);

        const retry = yield* fixture.service.stop.pipe(Effect.forkScoped);
        yield* Deferred.await(plan.removeStarted);
        expect((yield* fixture.service.get).cleanupError).toBeDefined();
        yield* open(plan.removeGate);
        yield* Fiber.join(retry);
        expect(yield* fixture.service.get).toMatchObject({
          lifecycle: "stopped",
          cleanupError: undefined,
        });
        expect((yield* Ref.get(plan.state)).removed).toBe(true);
      }),
    ),
  );

  it.live(
    "reports confirmed termination when removeData cleans up a session a failed stop retained",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Direct `makeService`, not `makeStandaloneService`: the orchestrator's own dispatch
          // already retries and reports a failed stop correctly (`Lifecycle.ts`'s `retryCleanup`)
          // and so never exercises this path. Only a direct `removeData` call does.
          const plans = yield* Queue.unbounded<RuntimePlan>();
          const events = yield* Ref.make<ReadonlyArray<LifecycleEvent>>([]);
          const service = yield* makeService(makeDefinition(plans), {
            id: "database-removedata-retry",
            config: { version: 17 },
            report: (event) => Ref.update(events, (current) => [...current, event]),
          });
          const plan = yield* makeRuntimePlan;
          yield* Queue.offer(plans, plan);
          yield* open(plan.launchGate);
          yield* open(plan.healthGate);
          yield* service.launch(1, { version: 17 });

          yield* Ref.set(plan.stopFailure, true);
          yield* service.stop(1, { operation: "stop", discard: true });
          expect((yield* Ref.get(events)).some((event) => event._tag === "StopFailed")).toBe(true);

          // The retained session's retry, through `removeData` alone this time.
          yield* open(plan.stopGate);
          yield* open(plan.removeGate);
          yield* service.removeData();

          expect(
            (yield* Ref.get(events)).some((event) => event._tag === "Exited"),
            "the retry's confirmed termination must reach the reducer, or it stays Stopping forever",
          ).toBe(true);
          expect((yield* Ref.get(plan.state)).removed).toBe(true);
        }),
      ),
  );

  it.live(
    "keeps the registration and data of a running instance whose destroy fails to stop it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const plans = yield* Queue.unbounded<RuntimePlan>();
          const dataRemoved = yield* Ref.make(false);
          const service = yield* makeStandaloneService(
            { launch: makeDefinition(plans).launch, removeData: () => Ref.set(dataRemoved, true) },
            { id: "database-destroy-stop-failure", config: { version: 17 } },
          );
          const plan = yield* makeRuntimePlan;
          yield* Queue.offer(plans, plan);
          yield* open(plan.launchGate);
          yield* service.start;
          yield* Ref.set(plan.stopFailure, true);

          expect(Exit.isFailure(yield* service.destroy.pipe(Effect.exit))).toBe(true);
          expect(yield* service.get).toMatchObject({ lifecycle: "stopping" });
          expect(yield* service.listed).toBe(true);
          expect(yield* Ref.get(dataRemoved)).toBe(false);

          yield* open(plan.stopGate);
          yield* open(plan.removeGate);
          yield* service.destroy;
          expect(yield* Ref.get(dataRemoved)).toBe(true);
          expect(yield* service.listed).toBe(false);
        }),
      ),
  );

  it.live("destroys an instance once the storage operation that owns it finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const storageStarted = yield* Deferred.make<void>();
        const storageGate = yield* Deferred.make<void>();
        const removalStarted = yield* Deferred.make<void>();
        const removalGate = yield* Deferred.make<void>();
        const service = yield* makeStandaloneService(
          {
            launch: makeDefinition(plans).launch,
            removeData: () =>
              open(removalStarted).pipe(Effect.andThen(Deferred.await(removalGate))),
          },
          { id: "database-storage", config: { version: 17 } },
        );
        const storage = yield* service
          .storage(open(storageStarted).pipe(Effect.andThen(Deferred.await(storageGate))))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(storageStarted);
        expect((yield* service.get).currentOperation).toBe("storage");

        const destroyed = yield* service.destroy.pipe(Effect.forkScoped);
        yield* awaitDestroyPending(service);
        expect(yield* service.listed).toBe(true);
        yield* open(storageGate);
        yield* Fiber.join(storage);
        yield* Deferred.await(removalStarted);
        const refused = yield* service.storage(Effect.void).pipe(Effect.flip);
        expect(refused.message).toBe("database-storage is being destroyed");

        yield* open(removalGate);
        yield* Fiber.join(destroyed);
        expect(yield* service.listed).toBe(false);
      }),
    ),
  );

  it.live("keeps an instance usable when a destroy waiting behind storage is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const storageStarted = yield* Deferred.make<void>();
        const storageGate = yield* Deferred.make<void>();
        const dataRemoved = yield* Ref.make(false);
        const service = yield* makeStandaloneService(
          { launch: makeDefinition(plans).launch, removeData: () => Ref.set(dataRemoved, true) },
          { id: "database-storage-interrupted", config: { version: 17 } },
        );
        const storage = yield* service
          .storage(open(storageStarted).pipe(Effect.andThen(Deferred.await(storageGate))))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(storageStarted);

        const destroyed = yield* service.destroy.pipe(Effect.forkScoped);
        yield* awaitDestroyPending(service);
        yield* Fiber.interrupt(destroyed);
        expect(Exit.hasInterrupts(yield* Fiber.await(destroyed))).toBe(true);
        expect((yield* service.get).destroyPending).toBe(false);
        yield* open(storageGate);
        yield* Fiber.join(storage);

        expect(yield* service.storage(Effect.succeed("stored"))).toBe("stored");
        expect(yield* Ref.get(dataRemoved)).toBe(false);
        expect(yield* service.listed).toBe(true);
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(plans, plan);
        yield* open(plan.launchGate);
        yield* service.start;
        expect((yield* service.get).lifecycle).toBe("running");
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("prepares an invalid restart configuration before stopping the current runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plans = yield* Queue.unbounded<RuntimePlan>();
        const invalid = yield* Ref.make(false);
        const service = yield* makeStandaloneService(makeDefinition(plans, { invalid }), {
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
        expect(yield* service.get).toMatchObject({ lifecycle: "running", config: { version: 17 } });
        expect((yield* Ref.get(plan.state)).removed).toBe(false);
        yield* stopFixture(service, plan);
      }),
    ),
  );

  it.live("fails readiness with the crash error, cleans the exact runtime and stays wakeable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture("database-crash");
        const plan = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, plan);
        yield* open(plan.launchGate);
        yield* fixture.service.start;
        yield* Deferred.await(plan.healthStarted);
        const ready = yield* fixture.service.ready.pipe(
          Effect.flip,
          Effect.forkScoped({ startImmediately: true }),
        );
        const stopped = yield* waitForStatus(
          fixture.service,
          (value) => value.lifecycle === "stopped" && value.currentOperation === undefined,
        );
        yield* Deferred.succeed(
          plan.exit,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Deferred.await(plan.stopStarted);
        expect((yield* fixture.service.get).currentOperation).toBe("stop");
        yield* open(plan.stopGate);
        yield* Deferred.await(plan.removeStarted);
        yield* open(plan.removeGate);
        yield* Fiber.join(stopped);

        expect((yield* Fiber.join(ready)).message).toContain("crashed");
        expect(yield* fixture.service.get).toMatchObject({
          lifecycle: "stopped",
          wakeEnabled: true,
          error: { operation: "process", message: "crashed" },
        });
        expect((yield* Ref.get(plan.state)).removed).toBe(true);
      }),
    ),
  );

  it.live("fails an old readiness wait on stop and lets the next launch become ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture("database-relaunch");
        const first = yield* makeRuntimePlan;
        const second = yield* makeRuntimePlan;
        yield* Queue.offer(fixture.plans, first);
        yield* Queue.offer(fixture.plans, second);
        yield* open(first.launchGate);
        yield* fixture.service.start;
        yield* Deferred.await(first.healthStarted);

        const oldReady = yield* fixture.service.ready.pipe(Effect.exit, Effect.forkScoped);
        const stopping = yield* fixture.service.stop.pipe(Effect.forkScoped);
        yield* Deferred.await(first.stopStarted);
        yield* open(first.stopGate);
        yield* Deferred.await(first.removeStarted);
        yield* open(first.removeGate);
        yield* Fiber.join(stopping);
        expect(Exit.isFailure(yield* Fiber.join(oldReady))).toBe(true);

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

const unhealthy = (message: string) => new ServiceError({ operation: "health", message });

const makeProbedService = (
  check: (launch: number) => Effect.Effect<void, ServiceError>,
  options: { readonly probe: boolean } = { probe: true },
) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const service = yield* makeStandaloneService<Config>(
      {
        launch: () =>
          Ref.updateAndGet(launches, (count) => count + 1).pipe(
            Effect.map((launch): RuntimeSession => ({
              health: check(launch),
              ...(options.probe ? { probe: check(launch) } : {}),
              exit: Effect.never,
              stop: Effect.void,
              remove: Effect.void,
            })),
          ),
        removeData: () => Effect.void,
      },
      { id: "probed", config: { version: 1 } },
    );
    return { service, launches };
  });

const startUnhealthy = (service: Standalone) =>
  Effect.gen(function* () {
    const failed = yield* waitForStatus(service, (value) => value.health === "unhealthy");
    yield* service.start;
    yield* Fiber.join(failed);
  });

describe("service readiness recovery", () => {
  it.live("reports the initial check's failure to callers waiting on it without re-probing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checks = yield* Ref.make(0);
        const checkStarted = yield* Deferred.make<void>();
        const checkGate = yield* Deferred.make<void>();
        const { service } = yield* makeProbedService(() =>
          Ref.updateAndGet(checks, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? open(checkStarted).pipe(
                    Effect.andThen(Deferred.await(checkGate)),
                    Effect.andThen(Effect.fail(unhealthy("rest HTTP readiness timed out"))),
                  )
                : Effect.fail(unhealthy("probe replaced the initial failure")),
            ),
          ),
        );
        yield* service.start;
        yield* Deferred.await(checkStarted);
        const waiting = yield* Effect.forkChild(Effect.flip(service.ready), {
          startImmediately: true,
        });

        yield* open(checkGate);

        expect((yield* Fiber.join(waiting)).message).toContain("rest HTTP readiness timed out");
        expect(yield* Ref.get(checks)).toBe(1);
        expect(yield* service.get).toMatchObject({
          health: "unhealthy",
          error: { message: "rest HTTP readiness timed out" },
        });
        yield* service.stop;
      }),
    ),
  );

  it.live("keeps a failed check final for a session without a probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checks = yield* Ref.make(0);
        const { service } = yield* makeProbedService(
          () =>
            Ref.updateAndGet(checks, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Effect.fail(unhealthy("setup failed")) : Effect.void,
              ),
            ),
          { probe: false },
        );
        yield* startUnhealthy(service);

        expect((yield* Effect.flip(service.ready)).message).toContain("setup failed");
        expect((yield* Effect.flip(service.ready)).message).toContain("setup failed");
        expect(yield* Ref.get(checks)).toBe(1);
        yield* service.stop;
      }),
    ),
  );

  it.live("shares one re-probe among concurrent readiness callers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checks = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const probeGate = yield* Deferred.make<void>();
        const { service } = yield* makeProbedService(() =>
          Ref.updateAndGet(checks, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(unhealthy("first check failed"))
                : count === 2
                  ? open(probeStarted).pipe(
                      Effect.andThen(Deferred.await(probeGate)),
                      Effect.andThen(Effect.fail(unhealthy("still booting"))),
                    )
                  : Effect.void,
            ),
          ),
        );
        yield* startUnhealthy(service);

        const first = yield* Effect.forkChild(Effect.flip(service.ready), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(Effect.flip(service.ready), {
          startImmediately: true,
        });
        yield* Deferred.await(probeStarted);
        yield* open(probeGate);

        expect((yield* Fiber.join(first)).message).toContain("still booting");
        expect((yield* Fiber.join(second)).message).toContain("still booting");
        expect(yield* Ref.get(checks)).toBe(2);
        yield* service.ready;
        expect(yield* Ref.get(checks)).toBe(3);
        yield* service.stop;
      }),
    ),
  );

  it.live("interrupts a superseded launch's probe and reports only the new launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstLaunchChecks = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const probeInterrupted = yield* Deferred.make<void>();
        const { service } = yield* makeProbedService((launch) =>
          launch === 1
            ? Ref.updateAndGet(firstLaunchChecks, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Effect.fail(unhealthy("first launch unhealthy"))
                    : open(probeStarted).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() => open(probeInterrupted)),
                      ),
                ),
              )
            : Effect.fail(unhealthy("second launch unhealthy")),
        );
        yield* startUnhealthy(service);
        const stale = yield* Effect.forkChild(Effect.exit(service.ready), {
          startImmediately: true,
        });
        yield* Deferred.await(probeStarted);

        const relaunched = yield* waitForStatus(
          service,
          (value) => value.launchId === 2 && value.health === "unhealthy",
        );
        yield* service.restart();
        yield* Fiber.join(relaunched);

        yield* Deferred.await(probeInterrupted);
        expect(Exit.isFailure(yield* Fiber.join(stale))).toBe(true);
        expect(yield* service.get).toMatchObject({
          launchId: 2,
          health: "unhealthy",
          error: { message: "second launch unhealthy" },
        });
        expect((yield* Effect.flip(service.ready)).message).toContain("second launch unhealthy");
        expect(yield* Ref.get(firstLaunchChecks)).toBe(2);
        yield* service.stop;
      }),
    ),
  );

  it.live("releases readiness waiters when the owner scope closes during a probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checks = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const owner = yield* Scope.make();
        const { service } = yield* makeProbedService(() =>
          Ref.updateAndGet(checks, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(unhealthy("first check failed"))
                : open(probeStarted).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        ).pipe(Scope.provide(owner));
        yield* startUnhealthy(service).pipe(Scope.provide(owner));
        const waiting = yield* Effect.forkChild(Effect.flip(service.ready), {
          startImmediately: true,
        });
        yield* Deferred.await(probeStarted);

        yield* Scope.close(owner, Exit.void);

        expect((yield* Fiber.join(waiting)).message).toBe("Lifecycle owner stopped");
      }),
    ),
  );
});
