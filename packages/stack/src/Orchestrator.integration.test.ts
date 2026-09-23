import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "./Orchestrator.ts";
import type { RegisteredInstance } from "./Orchestrator.ts";
import { makeService, ServiceError } from "./Service.ts";

const failure = (message: string) => new ServiceError({ operation: "fixture", message });
const makeTestOrchestrator = () =>
  Layer.build(Layer.fresh(Orchestrator.layer)).pipe(
    Effect.map((context) => Context.get(context, Orchestrator.Service)),
  );
const makeInstance = (
  orchestrator: Orchestrator.Interface,
  id: string,
  options: {
    readonly endpoint?: boolean;
    readonly health?: Effect.Effect<void, ServiceError>;
    readonly prepare?: Effect.Effect<void, ServiceError>;
    readonly launch?: Effect.Effect<void, ServiceError>;
    readonly stop?: Effect.Effect<void, ServiceError>;
    readonly exit?: Deferred.Deferred<Exit.Exit<void, ServiceError>>;
    readonly events?: Ref.Ref<ReadonlyArray<string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<ReadonlyArray<Readonly<Record<string, string>>>>([]);
    const bound = yield* Ref.make(false);
    const event = (name: string) =>
      options.events === undefined
        ? Effect.void
        : Ref.update(options.events, (values) => [...values, `${name}:${id}`]);
    const core = yield* makeService<Record<string, string>>(
      {
        prepare: () => options.prepare ?? Effect.void,
        launch: ({ config }) =>
          Effect.gen(function* () {
            yield* options.launch ?? Effect.void;
            yield* Ref.update(starts, (values) => [...values, config]);
            yield* event("start");
            const exited = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
            return {
              health: options.health ?? Effect.void,
              exit: Deferred.await(options.exit ?? exited),
              stop: (options.stop ?? Effect.void).pipe(
                Effect.andThen(event("stop")),
                Effect.andThen(Deferred.succeed(exited, Exit.void)),
                Effect.asVoid,
              ),
              remove: Effect.void,
            };
          }),
        removeData: () => Effect.void,
      },
      { id, config: {}, coordinate: orchestrator.admissionFor(id) },
    );
    const instance: RegisteredInstance = {
      id,
      core,
      startAt: (revision, inputs, wake, guard) => core.startAt(revision, inputs, wake, guard),
      restart: (revision, inputs, candidate, guard) =>
        (candidate === undefined
          ? Effect.succeed(inputs)
          : Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(candidate).pipe(
              Effect.mapError(() => failure("Invalid configuration")),
            )
        ).pipe(Effect.flatMap((config) => core.restart(config, revision, guard))),
      bind: Ref.set(bound, true),
      close: core.get.pipe(
        Effect.flatMap((state) =>
          state.lifecycle === "stopped" && !state.wakeEnabled ? Ref.set(bound, false) : Effect.void,
        ),
      ),
      hasEndpoint: options.endpoint ?? true,
      inputs: ["databaseUrl"],
      outputs: { url: Effect.succeed(`postgres://${id}`) },
    };
    yield* orchestrator.register(instance);
    return { ...instance, starts, bound };
  });

const stopped = (instance: RegisteredInstance) =>
  instance.core.observation.pipe(
    Stream.filter((state) => state.lifecycle === "stopped" && state.currentOperation === undefined),
    Stream.take(1),
    Stream.runDrain,
  );

describe("service composition", () => {
  it.live("admits an inspector connection while its service is still becoming healthy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const health = yield* Deferred.make<void>();
        const functions = yield* makeInstance(orchestrator, "functions", {
          health: Deferred.await(health),
        });
        yield* orchestrator.start("functions");
        expect((yield* functions.core.get).health).toBe("starting");
        yield* Effect.scoped(orchestrator.acquire("functions", false));
        expect((yield* functions.core.get).health).toBe("starting");
        yield* Deferred.succeed(health, undefined);
        yield* Effect.scoped(orchestrator.acquire("functions"));
        expect((yield* functions.core.get).health).toBe("healthy");
      }),
    ),
  );

  it.live(
    "launches an individual service before health and invalidates a dependent readiness wait on stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const health = yield* Deferred.make<void>();
          const database = yield* makeInstance(orchestrator, "database", {
            health: Deferred.await(health),
          });
          const rest = yield* makeInstance(orchestrator, "rest");
          yield* orchestrator.configure({
            members: [{ id: "rest", activation: "eager" }],
            dependencies: [
              { from: "database", to: "rest", bindings: [{ output: "url", input: "databaseUrl" }] },
            ],
          });
          yield* orchestrator.start("database");
          expect((yield* database.core.get).health).toBe("starting");
          const dependent = yield* orchestrator
            .start("rest")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* orchestrator.stop("database");
          expect(Exit.isFailure(yield* Fiber.await(dependent))).toBe(true);
          expect(yield* Ref.get(rest.starts)).toEqual([]);
          expect((yield* database.core.get).lifecycle).toBe("stopped");
        }),
      ),
  );

  it.live(
    "rejects a stale dependency plan after its prerequisite was stopped and replaced during preparation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const preparing = yield* Deferred.make<void>();
          const continuePreparation = yield* Deferred.make<void>();
          const database = yield* makeInstance(orchestrator, "database");
          const rest = yield* makeInstance(orchestrator, "rest", {
            prepare: Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Deferred.await(continuePreparation)),
            ),
          });
          yield* orchestrator.configure({
            members: [{ id: "rest", activation: "eager" }],
            dependencies: [{ from: "database", to: "rest" }],
          });
          const request = yield* orchestrator.start("rest").pipe(Effect.forkChild);
          yield* Deferred.await(preparing);
          yield* orchestrator.stop("database");
          yield* orchestrator.start("database");
          yield* database.core.ready;
          yield* Deferred.succeed(continuePreparation, undefined);
          expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
          expect(yield* Ref.get(rest.starts)).toEqual([]);
          expect((yield* database.core.get).lifecycle).toBe("running");
        }),
      ),
  );

  it.live(
    "restarts selected members in dependency order and keeps standalone instances independent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const events = yield* Ref.make<ReadonlyArray<string>>([]);
          const database = yield* makeInstance(orchestrator, "database", { events });
          const rest = yield* makeInstance(orchestrator, "rest", { events });
          const standalone = yield* makeInstance(orchestrator, "shadow", { events });
          yield* orchestrator.configure({
            members: [
              { id: "database", activation: "eager" },
              { id: "rest", activation: "eager" },
            ],
            dependencies: [
              { from: "database", to: "rest", bindings: [{ output: "url", input: "databaseUrl" }] },
            ],
          });
          yield* orchestrator.start("shadow");
          yield* orchestrator.startComposition;
          expect(yield* Ref.get(rest.starts)).toEqual([{ databaseUrl: "postgres://database" }]);
          yield* orchestrator.stop("database").pipe(Effect.flip);
          yield* Ref.set(events, []);
          yield* orchestrator.restartComposition;
          expect(yield* Ref.get(events)).toEqual([
            "stop:rest",
            "stop:database",
            "start:database",
            "start:rest",
          ]);
          expect(yield* Ref.get(standalone.starts)).toHaveLength(1);
          yield* orchestrator.stopNamespace;
          expect((yield* standalone.core.get).lifecycle).toBe("stopped");
          expect((yield* database.core.get).lifecycle).toBe("stopped");
        }),
      ),
  );

  it.live(
    "does not restart after a failed stop and still settles independent selected members",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const failStop = yield* Ref.make(true);
          const bad = yield* makeInstance(orchestrator, "bad", {
            stop: Ref.get(failStop).pipe(
              Effect.flatMap((fail) => (fail ? Effect.fail(failure("cannot stop")) : Effect.void)),
            ),
          });
          const independent = yield* makeInstance(orchestrator, "independent");
          yield* orchestrator.configure({
            members: [
              { id: "bad", activation: "eager" },
              { id: "independent", activation: "eager" },
            ],
            dependencies: [],
          });
          yield* orchestrator.startComposition;
          const result = yield* orchestrator.restartComposition.pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          expect((yield* bad.core.get).lifecycle).toBe("stopping");
          expect((yield* independent.core.get).lifecycle).toBe("stopped");
          expect(yield* Ref.get(bad.starts)).toHaveLength(1);
          expect(yield* Ref.get(independent.starts)).toHaveLength(1);
          yield* Ref.set(failStop, false);
          yield* orchestrator.stopNamespace;
        }),
      ),
  );

  it.live(
    "binds lazy endpoints without launching, counts traffic, and sleeps idle prerequisites after dependents",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const database = yield* makeInstance(orchestrator, "database");
          const rest = yield* makeInstance(orchestrator, "rest");
          yield* orchestrator.configure({
            members: [
              { id: "database", activation: "lazy", idleMillis: 100 },
              { id: "rest", activation: "lazy", idleMillis: 1000 },
            ],
            dependencies: [{ from: "database", to: "rest" }],
          });
          yield* orchestrator.startComposition;
          expect(yield* Ref.get(database.bound)).toBe(true);
          expect(yield* Ref.get(rest.bound)).toBe(true);
          expect(yield* Ref.get(database.starts)).toEqual([]);
          const requestScope = yield* Scope.make();
          yield* orchestrator.acquire("rest").pipe(Scope.provide(requestScope));
          expect((yield* rest.core.get).health).toBe("healthy");
          yield* TestClock.adjust("2 seconds");
          expect((yield* rest.core.get).lifecycle).toBe("running");
          expect((yield* database.core.get).lifecycle).toBe("running");
          yield* Scope.close(requestScope, Exit.void);
          const restStopped = yield* stopped(rest).pipe(Effect.forkChild);
          const databaseStopped = yield* stopped(database).pipe(Effect.forkChild);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(restStopped);
          yield* Fiber.join(databaseStopped);
          expect((yield* database.core.get).wakeEnabled).toBe(true);
          expect(yield* Ref.get(rest.bound)).toBe(true);
          yield* orchestrator.stopComposition;
          yield* orchestrator.acquire("rest").pipe(Effect.flip);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("rechecks an idle prerequisite after dependent cleanup completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const dependentExit = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupGate = yield* Deferred.make<void>();
        const database = yield* makeInstance(orchestrator, "database");
        const rest = yield* makeInstance(orchestrator, "rest", {
          exit: dependentExit,
          stop: Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupGate)),
          ),
        });
        yield* orchestrator.configure({
          members: [
            { id: "database", activation: "lazy", idleMillis: 100 },
            { id: "rest", activation: "lazy", idleMillis: 10000 },
          ],
          dependencies: [{ from: "database", to: "rest" }],
        });
        yield* orchestrator.startComposition;
        const requestScope = yield* Scope.make();
        yield* orchestrator.acquire("rest").pipe(Scope.provide(requestScope));
        yield* Scope.close(requestScope, Exit.void);
        yield* TestClock.adjust("200 millis");
        expect((yield* database.core.get).lifecycle).toBe("running");
        const restStopped = yield* stopped(rest).pipe(Effect.forkChild);
        const databaseStopped = yield* stopped(database).pipe(Effect.forkChild);
        yield* Deferred.succeed(
          dependentExit,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Deferred.await(cleanupStarted);
        expect((yield* database.core.get).lifecycle).toBe("running");
        yield* Deferred.succeed(cleanupGate, undefined);
        yield* Fiber.join(restStopped);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(databaseStopped);
        expect((yield* database.core.get).lifecycle).toBe("stopped");
        yield* orchestrator.stopNamespace;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

it.live("joins an in-progress wake and wakes again after an admitted idle stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* makeTestOrchestrator();
      const launching = yield* Deferred.make<void>();
      const launch = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      const stop = yield* Deferred.make<void>();
      const instance = yield* makeInstance(orchestrator, "api", {
        launch: Deferred.succeed(launching, undefined).pipe(Effect.andThen(Deferred.await(launch))),
        stop: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(stop))),
      });
      yield* orchestrator.configure({
        members: [{ id: "api", activation: "lazy", idleMillis: 1000 }],
        dependencies: [],
      });
      yield* orchestrator.startComposition;
      const first = yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.forkChild);
      yield* Deferred.await(launching);
      const second = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(launch, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Ref.get(instance.starts)).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(stopping);
      const third = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(third);
      expect(yield* Ref.get(instance.starts)).toHaveLength(2);
      yield* orchestrator.stopNamespace;
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.live("allows later traffic to retry an armed service after a failed wake launch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* makeTestOrchestrator();
      const failing = yield* Ref.make(true);
      const instance = yield* makeInstance(orchestrator, "api", {
        launch: Ref.get(failing).pipe(
          Effect.flatMap((value) => (value ? Effect.fail(failure("launch failed")) : Effect.void)),
        ),
      });
      yield* orchestrator.configure({
        members: [{ id: "api", activation: "lazy" }],
        dependencies: [],
      });
      yield* orchestrator.startComposition;
      yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);
      yield* Ref.set(failing, false);
      yield* Effect.scoped(orchestrator.acquire("api"));
      expect((yield* instance.core.get).health).toBe("healthy");
      yield* orchestrator.stopNamespace;
    }),
  ),
);
