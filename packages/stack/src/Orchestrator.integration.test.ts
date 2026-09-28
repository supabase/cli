import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schema, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "./Orchestrator.ts";
import type { RegisteredInstance } from "./Orchestrator.ts";
import { makeService, ServiceError } from "./Service.ts";

const failure = (message: string) => new ServiceError({ operation: "fixture", message });
const makeTestOrchestrator = () => Orchestrator.make<RegisteredInstance>();
const makeInstance = (
  orchestrator: Orchestrator.Interface,
  id: string,
  options: {
    readonly endpoint?: boolean;
    readonly health?: Effect.Effect<void, ServiceError>;
    readonly probe?: Effect.Effect<void, ServiceError>;
    readonly bind?: Effect.Effect<void, ServiceError>;
    readonly prepare?: Effect.Effect<void, ServiceError>;
    readonly launch?: Effect.Effect<void, ServiceError>;
    readonly stop?: Effect.Effect<void, ServiceError>;
    readonly removeData?: Effect.Effect<void, ServiceError>;
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
              ...(options.probe === undefined ? {} : { probe: options.probe }),
              exit: Deferred.await(options.exit ?? exited),
              stop: (options.stop ?? Effect.void).pipe(
                Effect.andThen(event("stop")),
                Effect.andThen(Deferred.succeed(exited, Exit.void)),
                Effect.asVoid,
              ),
              remove: Effect.void,
            };
          }),
        removeData: () => event("destroy").pipe(Effect.andThen(options.removeData ?? Effect.void)),
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
      bind: options.bind ?? Ref.set(bound, true),
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
  it.live("starts independent eager services concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const firstEntered = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const first = yield* makeInstance(orchestrator, "first", {
          launch: Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(firstGate)),
          ),
        });
        yield* makeInstance(orchestrator, "second", {
          launch: Deferred.succeed(secondEntered, undefined),
        });
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(firstGate, undefined).pipe(Effect.asVoid),
        );
        yield* orchestrator.configure({
          members: [
            { id: "first", activation: "eager" },
            { id: "second", activation: "eager" },
          ],
          dependencies: [],
        });

        const composition = yield* orchestrator.startComposition.pipe(Effect.forkChild);
        yield* Deferred.await(firstEntered);
        const secondStarted = yield* Deferred.await(secondEntered).pipe(
          Effect.timeoutOption("5 seconds"),
        );
        yield* Deferred.succeed(firstGate, undefined);
        yield* Fiber.join(composition);

        expect(Option.isSome(secondStarted)).toBe(true);
        expect(yield* Ref.get(first.starts)).toHaveLength(1);
        yield* orchestrator.stopNamespace;
      }),
    ),
  );

  it.live(
    "starts a dependent after all prerequisites while an unrelated eager service is pending",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const unrelatedEntered = yield* Deferred.make<void>();
          const unrelatedGate = yield* Deferred.make<void>();
          const databaseLaunched = yield* Deferred.make<void>();
          const databaseHealthGate = yield* Deferred.make<void>();
          const authLaunched = yield* Deferred.make<void>();
          const authHealthy = yield* Deferred.make<void>();
          const restLaunched = yield* Deferred.make<void>();
          const events = yield* Ref.make<ReadonlyArray<string>>([]);
          const database = yield* makeInstance(orchestrator, "database", {
            health: Deferred.await(databaseHealthGate).pipe(
              Effect.andThen(Ref.update(events, (values) => [...values, "database:healthy"])),
            ),
            launch: Deferred.succeed(databaseLaunched, undefined),
          });
          const auth = yield* makeInstance(orchestrator, "auth", {
            health: Deferred.await(authHealthy).pipe(
              Effect.andThen(Ref.update(events, (values) => [...values, "auth:healthy"])),
            ),
            launch: Deferred.succeed(authLaunched, undefined),
          });
          const rest = yield* makeInstance(orchestrator, "rest", {
            launch: Deferred.succeed(restLaunched, undefined).pipe(
              Effect.andThen(Ref.update(events, (values) => [...values, "rest:launch"])),
            ),
          });
          yield* makeInstance(orchestrator, "unrelated", {
            launch: Deferred.succeed(unrelatedEntered, undefined).pipe(
              Effect.andThen(Deferred.await(unrelatedGate)),
            ),
          });
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(unrelatedGate, undefined).pipe(
              Effect.andThen(Deferred.succeed(databaseHealthGate, undefined)),
              Effect.andThen(Deferred.succeed(authHealthy, undefined)),
              Effect.asVoid,
            ),
          );
          yield* orchestrator.configure({
            members: [
              { id: "unrelated", activation: "eager" },
              { id: "database", activation: "eager" },
              { id: "auth", activation: "eager" },
              { id: "rest", activation: "eager" },
            ],
            dependencies: [
              { from: "database", to: "rest", bindings: [{ output: "url", input: "databaseUrl" }] },
              { from: "auth", to: "rest" },
            ],
          });

          const composition = yield* orchestrator.startComposition.pipe(Effect.forkChild);
          yield* Deferred.await(unrelatedEntered);
          const dependencyProgress = yield* Effect.gen(function* () {
            yield* Deferred.await(databaseLaunched);
            yield* Deferred.await(authLaunched);
            yield* Deferred.succeed(authHealthy, undefined);
            yield* auth.core.ready;
            yield* Deferred.succeed(databaseHealthGate, undefined);
            yield* database.core.ready;
            yield* Deferred.await(restLaunched);
            yield* rest.core.ready;
            return {
              boundInputs: yield* Ref.get(rest.starts),
              eventOrder: yield* Ref.get(events),
            };
          }).pipe(Effect.timeoutOption("5 seconds"));
          yield* Deferred.succeed(authHealthy, undefined);
          yield* Deferred.succeed(databaseHealthGate, undefined);
          yield* Deferred.succeed(unrelatedGate, undefined);
          yield* Fiber.join(composition);

          expect(Option.isSome(dependencyProgress)).toBe(true);
          if (Option.isNone(dependencyProgress))
            return yield* Effect.die(
              "composition did not progress after all prerequisites became healthy",
            );
          expect(dependencyProgress.value.eventOrder).toEqual([
            "auth:healthy",
            "database:healthy",
            "rest:launch",
          ]);
          expect(dependencyProgress.value.boundInputs).toEqual([
            { databaseUrl: "postgres://database" },
          ]);
          yield* orchestrator.stopNamespace;
        }),
      ),
  );

  it.live("blocks descendants of a failed prerequisite and returns ordered outcomes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const descendantPreparations = yield* Ref.make(0);
        yield* makeInstance(orchestrator, "prerequisite", {
          health: Effect.fail(failure("unhealthy")),
        });
        const descendant = yield* makeInstance(orchestrator, "descendant", {
          prepare: Ref.update(descendantPreparations, (count) => count + 1),
        });
        const independent = yield* makeInstance(orchestrator, "independent");
        yield* orchestrator.configure({
          members: [
            { id: "prerequisite", activation: "eager" },
            { id: "descendant", activation: "eager" },
            { id: "independent", activation: "eager" },
          ],
          dependencies: [{ from: "prerequisite", to: "descendant" }],
        });

        const result = yield* orchestrator.startComposition.pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result))
          return yield* Effect.die(
            "composition with an unhealthy prerequisite unexpectedly passed",
          );
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        expect(error).toBeInstanceOf(Orchestrator.OrchestratorError);
        if (!(error instanceof Orchestrator.OrchestratorError))
          return yield* Effect.die("composition failure did not include ordered outcomes");
        expect(
          error.outcomes?.map(({ id, result: outcome }) => [id, Exit.isSuccess(outcome)]),
        ).toEqual([
          ["prerequisite", false],
          ["descendant", false],
          ["independent", true],
        ]);
        const descendantOutcome = error.outcomes?.find(({ id }) => id === "descendant")?.result;
        if (descendantOutcome === undefined || Exit.isSuccess(descendantOutcome))
          return yield* Effect.die("unhealthy prerequisite did not block descendant startup");
        const descendantError = Option.getOrUndefined(
          Cause.findErrorOption(descendantOutcome.cause),
        );
        expect(descendantError).toMatchObject({
          message: "Blocked by prerequisites: prerequisite",
        });
        expect(yield* Ref.get(descendant.starts)).toEqual([]);
        expect(yield* Ref.get(descendantPreparations)).toBe(0);
        expect(yield* Ref.get(independent.starts)).toHaveLength(1);
        yield* orchestrator.stopNamespace;
      }),
    ),
  );

  it.live(
    "settles prebinding failures and arms a lazy descendant after its prerequisite fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          yield* makeInstance(orchestrator, "prerequisite", {
            bind: Effect.fail(failure("listener unavailable")),
          });
          const descendant = yield* makeInstance(orchestrator, "descendant");
          const lazyDescendant = yield* makeInstance(orchestrator, "lazy-descendant");
          const independent = yield* makeInstance(orchestrator, "independent");
          yield* orchestrator.configure({
            members: [
              { id: "prerequisite", activation: "eager" },
              { id: "descendant", activation: "eager" },
              { id: "lazy-descendant", activation: "lazy" },
              { id: "independent", activation: "eager" },
            ],
            dependencies: [
              { from: "prerequisite", to: "descendant" },
              { from: "prerequisite", to: "lazy-descendant" },
            ],
          });

          const result = yield* orchestrator.startComposition.pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isSuccess(result))
            return yield* Effect.die("composition with a prebinding failure unexpectedly passed");
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          if (!(error instanceof Orchestrator.OrchestratorError))
            return yield* Effect.die("prebinding failure did not return composition outcomes");
          expect(
            error.outcomes?.map(({ id, result: outcome }) => [id, Exit.isSuccess(outcome)]),
          ).toEqual([
            ["prerequisite", false],
            ["descendant", false],
            ["lazy-descendant", true],
            ["independent", true],
          ]);
          const blocked = error.outcomes?.find(({ id }) => id === "descendant")?.result;
          if (blocked === undefined || Exit.isSuccess(blocked))
            return yield* Effect.die("eager descendant unexpectedly started");
          expect(Option.getOrUndefined(Cause.findErrorOption(blocked.cause))).toMatchObject({
            message: "Blocked by prerequisites: prerequisite",
          });
          expect(yield* Ref.get(descendant.starts)).toEqual([]);
          expect(yield* Ref.get(lazyDescendant.starts)).toEqual([]);
          expect((yield* lazyDescendant.core.get).wakeEnabled).toBe(true);
          expect(yield* Ref.get(independent.starts)).toHaveLength(1);
          yield* orchestrator.stopNamespace;
          expect((yield* lazyDescendant.core.get).wakeEnabled).toBe(false);
        }),
      ),
  );

  it.live("waits to arm a lazy dependent while its prerequisite is starting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const launchEntered = yield* Deferred.make<void>();
        const healthGate = yield* Deferred.make<void>();
        const prerequisite = yield* makeInstance(orchestrator, "prerequisite", {
          health: Deferred.await(healthGate),
          launch: Deferred.succeed(launchEntered, undefined),
        });
        const dependent = yield* makeInstance(orchestrator, "dependent");
        const independentLazy = yield* makeInstance(orchestrator, "independent-lazy");
        const independentArmed = independentLazy.core.observation.pipe(
          Stream.filter((state) => state.wakeEnabled),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(healthGate, undefined).pipe(Effect.asVoid),
        );
        yield* orchestrator.configure({
          members: [
            { id: "prerequisite", activation: "eager" },
            { id: "dependent", activation: "lazy" },
            { id: "independent-lazy", activation: "lazy" },
          ],
          dependencies: [{ from: "prerequisite", to: "dependent" }],
        });

        const armedObserver = yield* independentArmed.pipe(Effect.forkChild);
        const composition = yield* orchestrator.startComposition.pipe(Effect.forkChild);
        yield* Deferred.await(launchEntered);
        const observedIndependentArm = yield* Fiber.join(armedObserver).pipe(
          Effect.timeoutOption("5 seconds"),
        );
        expect((yield* prerequisite.core.get).health).toBe("starting");
        expect((yield* dependent.core.get).wakeEnabled).toBe(false);
        expect((yield* independentLazy.core.get).wakeEnabled).toBe(true);

        yield* Deferred.succeed(healthGate, undefined);
        expect(Option.isSome(observedIndependentArm)).toBe(true);
        yield* Fiber.join(composition);
        expect((yield* dependent.core.get).wakeEnabled).toBe(true);
        expect(yield* Ref.get(dependent.starts)).toEqual([]);
        yield* orchestrator.stopNamespace;
      }),
    ),
  );

  it.live("interrupts composition waits without canceling admitted service work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const launching = yield* Deferred.make<void>();
        const launchGate = yield* Deferred.make<void>();
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const prerequisite = yield* makeInstance(orchestrator, "prerequisite", {
          events,
          launch: Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Deferred.await(launchGate)),
          ),
        });
        const descendant = yield* makeInstance(orchestrator, "descendant", {
          events,
        });
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(launchGate, undefined).pipe(Effect.asVoid),
        );
        yield* orchestrator.configure({
          members: [
            { id: "prerequisite", activation: "eager" },
            { id: "descendant", activation: "eager" },
          ],
          dependencies: [{ from: "prerequisite", to: "descendant" }],
        });

        const composition = yield* orchestrator.startComposition.pipe(Effect.forkChild);
        yield* Deferred.await(launching);
        const interruptFinished = yield* Fiber.interrupt(composition).pipe(
          Effect.timeoutOption("5 seconds"),
        );
        yield* Deferred.succeed(launchGate, undefined);
        expect(Option.isSome(interruptFinished)).toBe(true);
        const interrupted = yield* Fiber.await(composition);
        expect(Exit.isFailure(interrupted)).toBe(true);
        expect(yield* Ref.get(descendant.starts)).toEqual([]);

        yield* prerequisite.core.ready;
        expect((yield* prerequisite.core.get).lifecycle).toBe("running");
        expect(yield* Ref.get(descendant.starts)).toEqual([]);
        yield* orchestrator.stopNamespace;
        expect(
          (yield* Ref.get(events)).filter((event) => event === "stop:prerequisite"),
        ).toHaveLength(1);
        expect(
          (yield* Ref.get(events)).filter((event) => event === "stop:descendant"),
        ).toHaveLength(0);
      }),
    ),
  );

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

  it.live("continues namespace destruction after a service data removal fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const failRemoval = yield* Ref.make(true);
        const next = yield* makeInstance(orchestrator, "next", { events });
        const failing = yield* makeInstance(orchestrator, "failing", {
          events,
          removeData: Ref.get(failRemoval).pipe(
            Effect.flatMap((fail) =>
              fail ? Effect.fail(failure("cannot remove data")) : Effect.void,
            ),
          ),
        });
        yield* orchestrator.start("failing");
        yield* orchestrator.start("next");

        const result = yield* Effect.exit(orchestrator.destroyNamespace);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result))
          return yield* Effect.die("namespace destroy unexpectedly passed");
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        expect(error).toBeInstanceOf(Orchestrator.OrchestratorError);
        if (!(error instanceof Orchestrator.OrchestratorError))
          return yield* Effect.die("namespace destroy did not return a combined error");
        expect(error.operation).toBe("destroy");
        expect(
          error.outcomes?.map(({ id, result: outcome }) => [id, Exit.isSuccess(outcome)]),
        ).toEqual([
          ["failing", false],
          ["next", true],
        ]);
        expect((yield* Ref.get(events)).filter((event) => event.startsWith("destroy:"))).toEqual([
          "destroy:failing",
          "destroy:next",
        ]);
        expect((yield* failing.core.get).registered).toBe(true);
        expect((yield* next.core.get).registered).toBe(false);

        yield* Ref.set(failRemoval, false);
        yield* orchestrator.destroyNamespace;
        expect((yield* failing.core.get).registered).toBe(false);
      }),
    ),
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

describe("readiness recovery", () => {
  const recoverableHealth = (healthy: Ref.Ref<boolean>) =>
    Ref.get(healthy).pipe(
      Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(failure("still booting")))),
    );

  it.live("serves traffic once a running instance recovers without restarting it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const healthy = yield* Ref.make(false);
        const api = yield* makeInstance(orchestrator, "api", {
          health: recoverableHealth(healthy),
          probe: recoverableHealth(healthy),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "eager" }],
          dependencies: [],
        });
        yield* orchestrator.startComposition.pipe(Effect.flip);
        yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);

        yield* Ref.set(healthy, true);
        yield* Effect.scoped(orchestrator.acquire("api"));

        expect(yield* Ref.get(api.starts)).toHaveLength(1);
        expect(yield* api.core.get).toMatchObject({ lifecycle: "running", health: "healthy" });
        yield* orchestrator.stopNamespace;
      }),
    ),
  );

  it.live("starts a blocked dependent once its running prerequisite recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const healthy = yield* Ref.make(false);
        const database = yield* makeInstance(orchestrator, "database", {
          health: recoverableHealth(healthy),
          probe: recoverableHealth(healthy),
        });
        const rest = yield* makeInstance(orchestrator, "rest");
        yield* orchestrator.configure({
          members: [
            { id: "database", activation: "eager" },
            { id: "rest", activation: "eager" },
          ],
          dependencies: [{ from: "database", to: "rest" }],
        });
        yield* orchestrator.startComposition.pipe(Effect.flip);
        expect(yield* Ref.get(rest.starts)).toEqual([]);

        yield* Ref.set(healthy, true);
        yield* orchestrator.startComposition;

        expect(yield* Ref.get(database.starts)).toHaveLength(1);
        expect(yield* Ref.get(rest.starts)).toHaveLength(1);
        expect((yield* rest.core.get).health).toBe("healthy");
        yield* orchestrator.stopNamespace;
      }),
    ),
  );
});
