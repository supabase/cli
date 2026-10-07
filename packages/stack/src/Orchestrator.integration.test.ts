import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { createServer } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real backend behind the listener.
import { captureLogs } from "../tests/logs.ts";
import type { LifecycleEvent } from "./Lifecycle.ts";
import * as Network from "./Network.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { RegisteredInstance } from "./Orchestrator.ts";
import { ProxyError } from "./Proxy.ts";
import { makeService, ServiceError } from "./Service.ts";
import * as StackNamespace from "./StackNamespace.ts";

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
    /** Replaces the default close, which only tracks the bound state. */
    readonly close?: Effect.Effect<void, ServiceError>;
    /** Resolves the first launch's runtime exit; later launches exit only when stopped. */
    readonly exit?: Deferred.Deferred<Exit.Exit<void, ServiceError>>;
    /** Every launch's runtime exit, for workloads that crash on demand. */
    readonly crash?: Effect.Effect<Exit.Exit<void, ServiceError>>;
    readonly events?: Ref.Ref<ReadonlyArray<string>>;
    /** Runs after the lifecycle has applied each event the service reports. */
    readonly onReport?: (event: LifecycleEvent) => Effect.Effect<void>;
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
            const launched = yield* Ref.updateAndGet(starts, (values) => [...values, config]);
            yield* event("start");
            const exited = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
            const exit =
              options.crash ??
              (options.exit !== undefined && launched.length === 1
                ? Deferred.await(options.exit)
                : Deferred.await(exited));
            return {
              health: options.health ?? Effect.void,
              ...(options.probe === undefined ? {} : { probe: options.probe }),
              exit,
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
      {
        id,
        config: {},
        report: (reported) =>
          orchestrator
            .report(reported)
            .pipe(Effect.andThen(options.onReport?.(reported) ?? Effect.void)),
      },
    );
    const configFor = (inputs: Record<string, string>, candidate: unknown) =>
      candidate === undefined
        ? Effect.succeed(inputs)
        : Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(candidate).pipe(
            Effect.mapError(() => failure("Invalid configuration")),
          );
    const instance: RegisteredInstance = {
      id,
      service: id,
      core,
      launch: (generation, inputs, candidate) =>
        configFor(inputs, candidate).pipe(
          Effect.flatMap((config) => core.launch(generation, config)),
        ),
      prepare: (inputs, candidate) =>
        configFor(inputs, candidate).pipe(Effect.flatMap((config) => core.prepare(config))),
      bind: options.bind ?? Ref.set(bound, true),
      confirmRemoved: Effect.void,
      release: Effect.void,
      releasePorts: Effect.void,
      close:
        options.close ??
        orchestrator.status(id).pipe(
          Effect.flatMap((state) =>
            state.lifecycle === "stopped" && !state.wakeEnabled
              ? Ref.set(bound, false)
              : Effect.void,
          ),
          Effect.mapError((error) => failure(error.message)),
        ),
      hasEndpoint: options.endpoint ?? true,
      inputs: ["databaseUrl"],
      outputs: { url: Effect.succeed(`postgres://${id}`) },
    };
    yield* orchestrator.register(instance);
    return {
      ...instance,
      starts,
      bound,
      status: orchestrator.status(id),
      ready: orchestrator.ready(id),
      observation: orchestrator.changes(id),
    };
  });

type Instance = Effect.Success<ReturnType<typeof makeInstance>>;

const stopped = (instance: Instance) =>
  instance.observation.pipe(
    Stream.filter((state) => state.lifecycle === "stopped" && state.currentOperation === undefined),
    Stream.take(1),
    Stream.runDrain,
  );

/**
 * Forks a wait for the next lifecycle transition after now. It returns once the subscription has
 * seen the current state, so a transition triggered afterwards can't be missed.
 */
const nextTransition = <E>(observation: Stream.Stream<Orchestrator.Status, E>) =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const transition = yield* observation.pipe(
      Stream.zipWithIndex,
      Stream.tap(([, index]) =>
        index === 0 ? Deferred.succeed(subscribed, undefined) : Effect.void,
      ),
      Stream.drop(1),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    return transition;
  });

const errorOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

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
            yield* auth.ready;
            yield* Deferred.succeed(databaseHealthGate, undefined);
            yield* database.ready;
            yield* Deferred.await(restLaunched);
            yield* rest.ready;
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

        const error = errorOf(yield* orchestrator.startComposition.pipe(Effect.exit));
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
        expect(descendantOutcome && errorOf(descendantOutcome)).toMatchObject({
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

          const error = errorOf(yield* orchestrator.startComposition.pipe(Effect.exit));
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
          expect(blocked && errorOf(blocked)).toMatchObject({
            message: "Blocked by prerequisites: prerequisite",
          });
          expect(yield* Ref.get(descendant.starts)).toEqual([]);
          expect(yield* Ref.get(lazyDescendant.starts)).toEqual([]);
          expect((yield* lazyDescendant.status).wakeEnabled).toBe(true);
          expect(yield* Ref.get(independent.starts)).toHaveLength(1);
          yield* orchestrator.stopNamespace;
          expect((yield* lazyDescendant.status).wakeEnabled).toBe(false);
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
        const independentArmed = independentLazy.observation.pipe(
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
        expect((yield* prerequisite.status).health).toBe("starting");
        expect((yield* dependent.status).wakeEnabled).toBe(false);
        expect((yield* independentLazy.status).wakeEnabled).toBe(true);

        yield* Deferred.succeed(healthGate, undefined);
        expect(Option.isSome(observedIndependentArm)).toBe(true);
        yield* Fiber.join(composition);
        expect((yield* dependent.status).wakeEnabled).toBe(true);
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
        const descendant = yield* makeInstance(orchestrator, "descendant", { events });
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
        expect(Exit.isFailure(yield* Fiber.await(composition))).toBe(true);
        expect(yield* Ref.get(descendant.starts)).toEqual([]);

        yield* prerequisite.ready;
        expect((yield* prerequisite.status).lifecycle).toBe("running");
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
        expect((yield* functions.status).health).toBe("starting");
        yield* Effect.scoped(orchestrator.acquire("functions", false));
        expect((yield* functions.status).health).toBe("starting");
        yield* Deferred.succeed(health, undefined);
        yield* Effect.scoped(orchestrator.acquire("functions"));
        expect((yield* functions.status).health).toBe("healthy");
      }),
    ),
  );

  it.live(
    "rejects stopping a prerequisite while a dependent's start waits on it, then starts the dependent",
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
          expect((yield* database.status).health).toBe("starting");
          const dependent = yield* orchestrator
            .start("rest")
            .pipe(Effect.forkChild({ startImmediately: true }));

          const rejected = yield* orchestrator.stop("database").pipe(Effect.flip);
          expect(rejected.message).toBe("database has active dependents: rest");
          expect(yield* Ref.get(rest.starts)).toEqual([]);

          yield* Deferred.succeed(health, undefined);
          yield* Fiber.join(dependent);
          expect(yield* Ref.get(rest.starts)).toEqual([{ databaseUrl: "postgres://database" }]);
          yield* orchestrator.stopNamespace;
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
          expect((yield* standalone.status).lifecycle).toBe("stopped");
          expect((yield* database.status).lifecycle).toBe("stopped");
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
          expect((yield* bad.status).lifecycle).toBe("stopping");
          expect((yield* independent.status).lifecycle).toBe("stopped");
          expect(yield* Ref.get(bad.starts)).toHaveLength(1);
          expect(yield* Ref.get(independent.starts)).toHaveLength(1);
          yield* Ref.set(failStop, false);
          yield* orchestrator.stopNamespace;
          expect((yield* bad.status).lifecycle).toBe("stopped");
        }),
      ),
  );

  it.live(
    "binds lazy endpoints without launching, counts traffic, and sleeps an idle prerequisite after its dependent",
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
          expect((yield* rest.status).health).toBe("healthy");
          yield* TestClock.adjust("2 seconds");
          expect((yield* rest.status).lifecycle).toBe("running");
          expect((yield* database.status).lifecycle).toBe("running");
          yield* Scope.close(requestScope, Exit.void);
          const restStopped = yield* stopped(rest).pipe(Effect.forkChild);
          const databaseStopped = yield* stopped(database).pipe(Effect.forkChild);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(restStopped);
          expect((yield* database.status).lifecycle).toBe("running");
          yield* TestClock.adjust("100 millis");
          yield* Fiber.join(databaseStopped);
          expect((yield* database.status).wakeEnabled).toBe(true);
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
        expect((yield* database.status).lifecycle).toBe("running");
        const restStopped = yield* stopped(rest).pipe(Effect.forkChild);
        const databaseStopped = yield* stopped(database).pipe(Effect.forkChild);
        yield* Deferred.succeed(
          dependentExit,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Deferred.await(cleanupStarted);
        expect((yield* database.status).lifecycle).toBe("running");
        yield* Deferred.succeed(cleanupGate, undefined);
        yield* Fiber.join(restStopped);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(databaseStopped);
        expect((yield* database.status).lifecycle).toBe("stopped");
        yield* orchestrator.stopNamespace;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("holds traffic through a crashed workload's cleanup, then re-wakes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const crashed = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupGate = yield* Deferred.make<void>();
        const rest = yield* makeInstance(orchestrator, "rest", {
          exit: crashed,
          stop: Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupGate)),
          ),
        });
        yield* orchestrator.configure({
          members: [{ id: "rest", activation: "lazy", idleMillis: 10_000 }],
          dependencies: [],
        });
        yield* orchestrator.startComposition;
        yield* Effect.scoped(orchestrator.acquire("rest"));

        yield* Deferred.succeed(
          crashed,
          Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
        );
        yield* Deferred.await(cleanupStarted);
        expect((yield* rest.status).lifecycle).toBe("stopping");

        const admitted = yield* Deferred.make<void>();
        const waking = yield* Effect.scoped(orchestrator.acquire("rest")).pipe(
          Effect.andThen(Deferred.succeed(admitted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 second");
        expect(yield* Deferred.isDone(admitted)).toBe(false);
        expect(yield* Ref.get(rest.starts)).toHaveLength(1);

        yield* Deferred.succeed(cleanupGate, undefined);
        yield* Fiber.join(waking);
        expect(yield* Ref.get(rest.starts)).toHaveLength(2);
        expect((yield* rest.status).lifecycle).toBe("running");
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
        yield* makeInstance(orchestrator, "next", { events });
        yield* makeInstance(orchestrator, "failing", {
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
        const error = errorOf(result);
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
        expect((yield* orchestrator.instances).map(({ id }) => id)).toEqual(["failing"]);

        yield* Ref.set(failRemoval, false);
        yield* orchestrator.destroyNamespace;
        expect(yield* orchestrator.instances).toEqual([]);
      }),
    ),
  );
});

describe("destroying an instance with admitted traffic", () => {
  it.live("removes the instance even while its traffic lease is held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        yield* makeInstance(orchestrator, "database");
        yield* makeInstance(orchestrator, "rest");
        yield* orchestrator.configure({
          members: [
            { id: "database", activation: "lazy" },
            { id: "rest", activation: "lazy" },
          ],
          dependencies: [{ from: "database", to: "rest" }],
        });
        yield* orchestrator.startComposition;
        const request = yield* Scope.make();
        yield* orchestrator.acquire("rest").pipe(Scope.provide(request));

        yield* orchestrator.destroy("rest");
        expect((yield* orchestrator.instances).map(({ id }) => id)).not.toContain("rest");
        yield* orchestrator.stop("database");

        yield* Scope.close(request, Exit.void);
        expect((yield* orchestrator.status("database")).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live(
    "unregisters an instance whose data removal was confirmed even if its final close fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const removed = yield* Ref.make(false);
          yield* makeInstance(orchestrator, "database", {
            removeData: Ref.set(removed, true),
            close: Ref.get(removed).pipe(
              Effect.flatMap((gone) => (gone ? Effect.fail(failure("close failed")) : Effect.void)),
            ),
          });

          const error = yield* orchestrator.destroy("database").pipe(Effect.flip);

          expect(error.message).toBe("close failed");
          expect(yield* orchestrator.instances).toEqual([]);
        }),
      ),
  );
});

describe("wake and idle sleep", () => {
  it.live(
    "does not let a prerequisite idle-sleep while its dependent is still preparing to wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const preparing = yield* Deferred.make<void>();
          const continuePreparation = yield* Deferred.make<void>();
          const database = yield* makeInstance(orchestrator, "database");
          const studio = yield* makeInstance(orchestrator, "studio", {
            prepare: Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Deferred.await(continuePreparation)),
            ),
          });
          yield* orchestrator.configure({
            members: [
              { id: "database", activation: "lazy", idleMillis: 100 },
              { id: "studio", activation: "lazy" },
            ],
            dependencies: [{ from: "database", to: "studio" }],
          });
          yield* orchestrator.startComposition;
          const wake = yield* Effect.scoped(orchestrator.acquire("studio")).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(preparing);
          expect((yield* database.status).lifecycle).toBe("running");
          yield* TestClock.adjust("1 second");
          expect((yield* database.status).lifecycle).toBe("running");

          yield* Deferred.succeed(continuePreparation, undefined);
          yield* Fiber.join(wake);
          expect(yield* studio.status).toMatchObject({ lifecycle: "running", health: "healthy" });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live(
    "does not idle-sleep a launch before its first healthy observation, then idles normally once healthy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const health = yield* Deferred.make<void>();
          const api = yield* makeInstance(orchestrator, "api", {
            health: Deferred.await(health),
          });
          yield* orchestrator.configure({
            members: [{ id: "api", activation: "lazy", idleMillis: 100 }],
            dependencies: [],
          });
          yield* orchestrator.startComposition;
          expect((yield* api.status).wakeEnabled).toBe(true);

          yield* orchestrator.start("api");
          expect(yield* api.status).toMatchObject({ lifecycle: "running", health: "starting" });
          yield* TestClock.adjust("1 second");
          expect((yield* api.status).lifecycle).toBe("running");

          yield* Deferred.succeed(health, undefined);
          yield* api.ready;
          expect((yield* api.status).health).toBe("healthy");
          yield* TestClock.adjust("1 second");
          yield* stopped(api);
          expect((yield* api.status).wakeEnabled).toBe(true);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live(
    "holds an eager member's prerequisite active through a slow preparation instead of bypassing the reservation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const preparing = yield* Deferred.make<void>();
          const continuePreparation = yield* Deferred.make<void>();
          yield* makeInstance(orchestrator, "database");
          const functions = yield* makeInstance(orchestrator, "functions");
          const studio = yield* makeInstance(orchestrator, "studio", {
            prepare: Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Deferred.await(continuePreparation)),
            ),
          });
          yield* orchestrator.configure({
            members: [
              { id: "database", activation: "eager" },
              { id: "functions", activation: "lazy", idleMillis: 100 },
              { id: "studio", activation: "eager" },
            ],
            dependencies: [
              { from: "database", to: "studio" },
              { from: "functions", to: "studio" },
            ],
          });
          const composition = yield* orchestrator.startComposition.pipe(Effect.forkChild);
          yield* Deferred.await(preparing);

          // Independent traffic wakes and releases `functions` while studio is still preparing.
          yield* Effect.scoped(orchestrator.acquire("functions"));
          expect((yield* functions.status).lifecycle).toBe("running");
          yield* TestClock.adjust("1 second");
          expect((yield* functions.status).lifecycle).toBe("running");

          yield* Deferred.succeed(continuePreparation, undefined);
          yield* Fiber.join(composition);
          expect(yield* studio.status).toMatchObject({ lifecycle: "running", health: "healthy" });
          yield* orchestrator.stopNamespace;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("holds a restarted member's prerequisite active through its own slow preparation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const preparing = yield* Deferred.make<void>();
        const continuePreparation = yield* Deferred.make<void>();
        yield* makeInstance(orchestrator, "database");
        const functions = yield* makeInstance(orchestrator, "functions");
        const studio = yield* makeInstance(orchestrator, "studio", {
          prepare: Deferred.succeed(preparing, undefined).pipe(
            Effect.andThen(Deferred.await(continuePreparation)),
          ),
        });
        yield* orchestrator.configure({
          members: [
            { id: "database", activation: "lazy" },
            { id: "functions", activation: "lazy", idleMillis: 100 },
            { id: "studio", activation: "lazy" },
          ],
          dependencies: [
            { from: "database", to: "studio" },
            { from: "functions", to: "studio" },
          ],
        });
        yield* orchestrator.startComposition;
        // Functions is independently already running; studio itself is still asleep, so nothing
        // but studio's own restart keeps functions awake while studio prepares.
        yield* Effect.scoped(orchestrator.acquire("functions"));
        expect((yield* functions.status).lifecycle).toBe("running");
        expect((yield* studio.status).lifecycle).toBe("stopped");

        const restart = yield* orchestrator
          .restart("studio")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(preparing);
        yield* TestClock.adjust("1 second");
        expect((yield* functions.status).lifecycle).toBe("running");

        yield* Deferred.succeed(continuePreparation, undefined);
        yield* Fiber.join(restart);
        expect(yield* studio.status).toMatchObject({ lifecycle: "running", health: "healthy" });
        yield* orchestrator.stopNamespace;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("keeps every prerequisite of a running dependent awake past its own idle timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const pgmeta = yield* makeInstance(orchestrator, "pgmeta");
        const functions = yield* makeInstance(orchestrator, "functions");
        const studio = yield* makeInstance(orchestrator, "studio");
        yield* orchestrator.configure({
          members: [
            { id: "pgmeta", activation: "lazy", idleMillis: 60_000 },
            { id: "functions", activation: "lazy", idleMillis: 60_000 },
            { id: "studio", activation: "lazy", idleMillis: 300_000 },
          ],
          dependencies: [
            { from: "pgmeta", to: "studio" },
            { from: "functions", to: "studio" },
          ],
        });
        yield* orchestrator.startComposition;
        yield* Effect.scoped(orchestrator.acquire("studio"));

        yield* TestClock.adjust("299 seconds");
        expect((yield* studio.status).lifecycle).toBe("running");
        expect((yield* pgmeta.status).lifecycle).toBe("running");
        expect((yield* functions.status).lifecycle).toBe("running");

        const studioStopped = yield* stopped(studio).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(studioStopped);
        expect((yield* pgmeta.status).lifecycle).toBe("running");
        expect((yield* functions.status).lifecycle).toBe("running");

        const prerequisitesStopped = yield* Effect.all([stopped(pgmeta), stopped(functions)], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("60 seconds");
        yield* Fiber.join(prerequisitesStopped);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live(
    "fails only a waiter whose wake budget expires, naming the stage, while the shared launch continues",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const preparing = yield* Deferred.make<void>();
          const continuePreparation = yield* Deferred.make<void>();
          const api = yield* makeInstance(orchestrator, "api", {
            prepare: Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(Deferred.await(continuePreparation)),
            ),
          });
          yield* orchestrator.configure({
            members: [{ id: "api", activation: "lazy" }],
            dependencies: [],
          });
          yield* orchestrator.startComposition;

          const early = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
            Effect.flip,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(preparing);
          yield* TestClock.adjust("60 seconds");
          const late = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* TestClock.adjust("60 seconds");

          const expired = yield* Fiber.join(early);
          expect(expired.message).toBe(
            "api wake budget exceeded while waiting for api to finish preparing",
          );
          expect((yield* api.status).lifecycle).toBe("starting");

          yield* Deferred.succeed(continuePreparation, undefined);
          yield* Fiber.join(late);
          expect(yield* Ref.get(api.starts)).toHaveLength(1);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  describe("a traffic waiter that leaves before its launch finishes", () => {
    // A leaked lease or waiter would keep demand on the service and stop it from ever idling.
    const idlesAfterWaiterLeaves = (
      leave: (
        waiter: Fiber.Fiber<Exit.Exit<void, Orchestrator.OrchestratorError | ServiceError>>,
      ) => Effect.Effect<void>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const launching = yield* Deferred.make<void>();
          const proceed = yield* Deferred.make<void>();
          const api = yield* makeInstance(orchestrator, "api", {
            launch: Deferred.succeed(launching, undefined).pipe(
              Effect.andThen(Deferred.await(proceed)),
            ),
          });
          yield* orchestrator.configure({
            members: [{ id: "api", activation: "lazy", idleMillis: 1000 }],
            dependencies: [],
          });
          yield* orchestrator.startComposition;
          const waiter = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(launching);
          yield* leave(waiter);

          yield* Deferred.succeed(proceed, undefined);
          yield* api.ready;
          yield* TestClock.adjust("1 second");
          yield* stopped(api);
          expect(yield* Ref.get(api.starts)).toHaveLength(1);
        }),
      ).pipe(Effect.provide(TestClock.layer()));

    it.live(
      "releases its claim when its wake budget expires, so the service idles afterwards",
      () =>
        idlesAfterWaiterLeaves((waiter) =>
          TestClock.adjust("120 seconds").pipe(
            Effect.andThen(Fiber.join(waiter)),
            Effect.tap((exit) =>
              Effect.sync(() => expect(errorOf(exit)?.message).toContain("wake budget exceeded")),
            ),
            Effect.asVoid,
          ),
        ),
    );

    it.live("releases its claim when the client cancels, so the service idles afterwards", () =>
      idlesAfterWaiterLeaves((waiter) => Fiber.interrupt(waiter)),
    );
  });

  it.live("releases only a cancelled waiter and keeps the shared launch for the others", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const launching = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const api = yield* makeInstance(orchestrator, "api", {
          launch: Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Deferred.await(proceed)),
          ),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "lazy" }],
          dependencies: [],
        });
        yield* orchestrator.startComposition;
        const cancelled = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const kept = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(launching);
        yield* Fiber.interrupt(cancelled);

        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(kept);
        expect(yield* api.status).toMatchObject({ lifecycle: "running", health: "healthy" });
        expect(yield* Ref.get(api.starts)).toHaveLength(1);
        yield* orchestrator.stopNamespace;
      }),
    ),
  );

  it.live("joins an in-progress wake and wakes again after an admitted idle stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const launching = yield* Deferred.make<void>();
        const launch = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const stop = yield* Deferred.make<void>();
        const instance = yield* makeInstance(orchestrator, "api", {
          launch: Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Deferred.await(launch)),
          ),
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

  describe("while the owner refuses new work", () => {
    const makeRefusingOrchestrator = Effect.gen(function* () {
      const draining = yield* Ref.make(false);
      const orchestrator = yield* Orchestrator.make<RegisteredInstance>({
        admit: () =>
          Ref.get(draining).pipe(
            Effect.flatMap((refusing) =>
              refusing ? Effect.fail(failure("Owner is draining")) : Effect.void,
            ),
          ),
      });
      return { orchestrator, draining };
    });

    it.live(
      "refuses traffic that would wake a stopped lazy service, then wakes once admitted",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { orchestrator, draining } = yield* makeRefusingOrchestrator;
            const api = yield* makeInstance(orchestrator, "api");
            yield* orchestrator.configure({
              members: [{ id: "api", activation: "lazy" }],
              dependencies: [],
            });
            yield* orchestrator.startComposition;

            yield* Ref.set(draining, true);
            const refused = yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);
            expect(refused.message).toBe("Owner is draining");
            expect(yield* Ref.get(api.starts)).toHaveLength(0);
            expect((yield* api.status).lifecycle).toBe("stopped");

            yield* Ref.set(draining, false);
            yield* Effect.scoped(orchestrator.acquire("api"));
            expect(yield* Ref.get(api.starts)).toHaveLength(1);
            yield* orchestrator.stopNamespace;
          }),
        ).pipe(Effect.provide(TestClock.layer())),
    );

    it.live(
      "refuses traffic that arrives while an idle stop is in progress, without relaunching",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { orchestrator, draining } = yield* makeRefusingOrchestrator;
            const stopping = yield* Deferred.make<void>();
            const finishStop = yield* Deferred.make<void>();
            const api = yield* makeInstance(orchestrator, "api", {
              stop: Deferred.succeed(stopping, undefined).pipe(
                Effect.andThen(Deferred.await(finishStop)),
              ),
            });
            yield* orchestrator.configure({
              members: [{ id: "api", activation: "lazy", idleMillis: 1000 }],
              dependencies: [],
            });
            yield* orchestrator.startComposition;
            yield* Effect.scoped(orchestrator.acquire("api"));
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(stopping);

            yield* Ref.set(draining, true);
            const refused = yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);
            expect(refused.message).toBe("Owner is draining");

            yield* Deferred.succeed(finishStop, undefined);
            yield* orchestrator.stopNamespace;
            expect(yield* Ref.get(api.starts)).toHaveLength(1);
            expect((yield* api.status).lifecycle).toBe("stopped");
          }),
        ).pipe(Effect.provide(TestClock.layer())),
    );

    it.live("still admits traffic to a starting or running service", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { orchestrator, draining } = yield* makeRefusingOrchestrator;
          const launching = yield* Deferred.make<void>();
          const launch = yield* Deferred.make<void>();
          const api = yield* makeInstance(orchestrator, "api", {
            launch: Deferred.succeed(launching, undefined).pipe(
              Effect.andThen(Deferred.await(launch)),
            ),
          });
          yield* orchestrator.configure({
            members: [{ id: "api", activation: "lazy" }],
            dependencies: [],
          });
          yield* orchestrator.startComposition;
          const waking = yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.forkChild);
          yield* Deferred.await(launching);

          yield* Ref.set(draining, true);
          const joining = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(launch, undefined);
          yield* Fiber.join(waking);
          yield* Fiber.join(joining);
          yield* Effect.scoped(orchestrator.acquire("api"));
          expect(yield* Ref.get(api.starts)).toHaveLength(1);
          expect((yield* api.status).lifecycle).toBe("running");
          yield* orchestrator.stopNamespace;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

describe("idle races through a real listener", () => {
  interface HeldResponse {
    readonly release: () => void;
  }

  /**
   * A lazy service whose every generation is a real HTTP server answering `generation:N`, reached
   * only through its namespace listener. `/hold` keeps the response open until released, and a
   * stop can be held open the same way.
   */
  const makeListenerStack = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "orchestrator-listener-" });
    const stackId = `listener-${root.split("/").at(-1) ?? "stack"}`;
    const state = yield* Layer.build(StackNamespace.layer({ root })).pipe(
      Effect.map((context) => Context.get(context, StackNamespace.Service)),
    );
    yield* state.save({
      id: stackId,
      identity: { projectRoot: root, branchContext: "test", stackName: stackId },
      runtime: "native",
      lifetime: "detached",
      instances: [],
      composition: { members: [], dependencies: [] },
    });
    const network = yield* Layer.build(
      Network.layer({ stackId, runtime: "native" }).pipe(
        Layer.provide(Layer.succeed(StackNamespace.Service, state)),
      ),
    ).pipe(Effect.map((context) => Context.get(context, Network.Service)));
    const orchestrator = yield* makeTestOrchestrator();
    const address = yield* Ref.make<{ readonly host: string; readonly port: number } | undefined>(
      undefined,
    );
    const generations = yield* Ref.make(0);
    const held: Array<HeldResponse> = [];
    const holdEntered = yield* Deferred.make<void>();
    const holdStops = yield* Ref.make<
      | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
      | undefined
    >(undefined);

    const core = yield* makeService<Record<string, string>>(
      {
        launch: () =>
          Effect.gen(function* () {
            const generation = yield* Ref.updateAndGet(generations, (value) => value + 1);
            const server = createServer((request, response) => {
              const answer = () => response.end(`generation:${generation}`);
              if (request.url !== "/hold") return answer();
              held.push({ release: answer });
              Deferred.doneUnsafe(holdEntered, Effect.void);
            });
            const port = yield* Effect.callback<number, ServiceError>((resume) => {
              server.listen(0, "127.0.0.1", () => {
                const bound = server.address();
                resume(
                  bound === null || typeof bound === "string"
                    ? Effect.fail(failure("no address"))
                    : Effect.succeed(bound.port),
                );
              });
            });
            yield* Ref.set(address, { host: "127.0.0.1", port });
            const exited = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
            const close = Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
              server.closeAllConnections();
            });
            return {
              health: Effect.void,
              exit: Deferred.await(exited),
              stop: Ref.get(holdStops).pipe(
                Effect.flatMap((gate) =>
                  gate === undefined
                    ? Effect.void
                    : Deferred.succeed(gate.entered, undefined).pipe(
                        Effect.andThen(Deferred.await(gate.release)),
                      ),
                ),
                Effect.andThen(close),
                Effect.andThen(Deferred.succeed(exited, Exit.void)),
                Effect.asVoid,
              ),
              remove: Effect.void,
            };
          }),
        removeData: () => Effect.void,
      },
      { id: "api", config: {}, report: orchestrator.report },
    );
    const namespace = yield* network.register({
      id: "api",
      endpoints: {
        http: {
          protocol: "http",
          port: "auto",
          backend: orchestrator.acquire("api").pipe(
            Effect.andThen(Ref.get(address)),
            Effect.flatMap((current) =>
              current === undefined ? Effect.fail(failure("no session")) : Effect.succeed(current),
            ),
            Effect.mapError((cause) => new ProxyError({ message: cause.message, cause })),
          ),
          enabled: Effect.succeed(true),
        },
      },
    });
    yield* orchestrator.register({
      id: "api",
      service: "api",
      core,
      launch: (generation, inputs) => core.launch(generation, inputs),
      prepare: () => Effect.void,
      bind: namespace.bind.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => failure(cause.message)),
      ),
      close: Effect.void,
      confirmRemoved: Effect.void,
      release: Effect.void,
      releasePorts: Effect.void,
      hasEndpoint: true,
      inputs: [],
      outputs: {},
    });
    yield* orchestrator.configure({
      members: [{ id: "api", activation: "lazy", idleMillis: 1000 }],
      dependencies: [],
    });
    yield* orchestrator.startComposition;
    const [binding] = yield* namespace.bindings;
    if (binding === undefined) return yield* Effect.die("listener was not bound");
    const get = (path: string) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(`http://127.0.0.1:${binding.port}${path}`);
        return { status: response.status, body: yield* response.text };
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
    const releaseHeld = Effect.sync(() => {
      for (const response of held.splice(0)) response.release();
    });
    return {
      orchestrator,
      get,
      holdEntered,
      releaseHeld,
      holdStops,
      status: orchestrator.status("api"),
      observation: orchestrator.changes("api"),
    };
  });

  it.live(
    "keeps serving a request admitted before the idle timer fires, from the same generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stack = yield* makeListenerStack;
          // A scoped acquisition releases its lease before returning, so the idle timer is armed.
          yield* Effect.scoped(stack.orchestrator.acquire("api"));

          const request = yield* stack
            .get("/hold")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(stack.holdEntered);
          yield* TestClock.adjust("10 seconds");
          expect((yield* stack.status).lifecycle).toBe("running");

          yield* stack.releaseHeld;
          expect(yield* Fiber.join(request)).toEqual({ status: 200, body: "generation:1" });
          yield* stack.orchestrator.stopNamespace;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
  );

  it.live(
    "holds a request arriving after a committed sleep until the stop is confirmed, then serves it from the next generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stack = yield* makeListenerStack;
          // A scoped acquisition releases its lease before returning, so the idle timer is armed.
          yield* Effect.scoped(stack.orchestrator.acquire("api"));
          const gate = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          yield* Ref.set(stack.holdStops, gate);
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(gate.entered);
          expect((yield* stack.status).lifecycle).toBe("stopping");

          // The request's own admission is the next lifecycle transition while the stop is held.
          const queued = yield* nextTransition(stack.observation);
          const request = yield* stack.get("/").pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.join(queued);
          yield* Ref.set(stack.holdStops, undefined);
          yield* Deferred.succeed(gate.release, undefined);

          expect(yield* Fiber.join(request)).toEqual({ status: 200, body: "generation:2" });
          expect((yield* stack.status).lifecycle).toBe("running");
          yield* stack.orchestrator.stopNamespace;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
  );
});

describe("admission while the lifecycle gate is held", () => {
  // A configure whose persistence never finishes holds the gate the way a stalled state write does.
  const holdGate = (orchestrator: Orchestrator.Interface) =>
    Effect.gen(function* () {
      const persisting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const configuring = yield* orchestrator
        .configure(
          { members: [{ id: "api", activation: "lazy" }], dependencies: [] },
          Deferred.succeed(persisting, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(persisting);
      return { release: Deferred.succeed(release, undefined), configuring };
    });

  it.live("lets a client cancel an acquisition still waiting for the gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        yield* makeInstance(orchestrator, "api");
        const held = yield* holdGate(orchestrator);
        const waiting = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const cancelled = yield* Fiber.interrupt(waiting).pipe(Effect.timeoutOption("2 seconds"));
        expect(Option.isSome(cancelled)).toBe(true);
        yield* held.release;
        yield* Fiber.join(held.configuring);
      }),
    ),
  );

  it.live("fails an acquisition whose wake budget runs out while it waits for the gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        yield* makeInstance(orchestrator, "api");
        const held = yield* holdGate(orchestrator);
        const waiting = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("120 seconds");
        yield* held.release;
        yield* Fiber.join(held.configuring);
        expect((yield* Fiber.join(waiting)).message).toBe(
          "api wake budget exceeded while waiting for admission",
        );
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("failed and crashed services", () => {
  it.live("allows later traffic to retry an armed service after a failed wake launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const failing = yield* Ref.make(true);
        const instance = yield* makeInstance(orchestrator, "api", {
          launch: Ref.get(failing).pipe(
            Effect.flatMap((value) =>
              value ? Effect.fail(failure("launch failed")) : Effect.void,
            ),
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
        expect((yield* instance.status).health).toBe("healthy");
        yield* orchestrator.stopNamespace;
      }),
    ),
  );

  it.live(
    "keeps a crashed armed service wakeable and wakes it exactly once on the next request",
    () => {
      const logs: Array<string> = [];
      return Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const crash = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
          const api = yield* makeInstance(orchestrator, "api", { exit: crash });
          yield* orchestrator.configure({
            members: [{ id: "api", activation: "lazy" }],
            dependencies: [],
          });
          yield* orchestrator.startComposition;
          yield* Effect.scoped(orchestrator.acquire("api"));
          expect(yield* api.status).toMatchObject({ lifecycle: "running", health: "healthy" });

          // The runtime exits on its own, with no stop/restart/destroy ever invalidating the intent.
          yield* Deferred.succeed(
            crash,
            Exit.fail(new ServiceError({ operation: "process", message: "crashed" })),
          );
          yield* stopped(api);
          expect((yield* api.status).wakeEnabled).toBe(true);

          const recoveryLogStart = logs.length;
          const callers = yield* Effect.forEach(Array.from({ length: 5 }), () =>
            Effect.scoped(orchestrator.acquire("api")).pipe(
              Effect.forkChild({ startImmediately: true }),
            ),
          );
          yield* Effect.forEach(callers, Fiber.join);
          expect(yield* api.status).toMatchObject({ lifecycle: "running", health: "healthy" });
          yield* orchestrator.stopNamespace;
          expect(
            logs.slice(recoveryLogStart).filter((line) => line.includes("Waking api api")),
          ).toHaveLength(1);
        }),
      ).pipe(Effect.provide(captureLogs(["Error", "Info"])(logs)));
    },
  );

  it.live(
    "opens the breaker after three crashes, fails fast naming the cause, reopens for the same fixed cooldown after a further crash, and resets on an explicit start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const crashes = yield* Queue.unbounded<Exit.Exit<void, ServiceError>>();
          const api = yield* makeInstance(orchestrator, "api", { crash: Queue.take(crashes) });
          yield* orchestrator.configure({
            members: [{ id: "api", activation: "lazy" }],
            dependencies: [],
          });
          yield* orchestrator.startComposition;
          const segfault = Exit.fail(
            new ServiceError({ operation: "process", message: "segfault" }),
          );
          const serveThenCrash = Effect.gen(function* () {
            yield* Effect.scoped(orchestrator.acquire("api"));
            const down = yield* stopped(api).pipe(Effect.forkChild({ startImmediately: true }));
            yield* Queue.offer(crashes, segfault);
            yield* Fiber.join(down);
          });

          yield* serveThenCrash;
          yield* serveThenCrash;
          yield* serveThenCrash;
          const fastFail = yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);
          expect(fastFail.message).toBe("api circuit breaker is open: segfault");
          expect(yield* Ref.get(api.starts)).toHaveLength(3);

          // The cooldown's own state change is the only signal that it elapsed.
          const coolDown = (duration: Duration.Input) =>
            Effect.gen(function* () {
              const cooled = yield* nextTransition(api.observation);
              yield* TestClock.adjust(duration);
              yield* Fiber.join(cooled);
            });
          yield* coolDown("30 seconds");
          yield* serveThenCrash;
          expect(yield* Ref.get(api.starts)).toHaveLength(4);

          // A further failure reopens the breaker for the same fixed cooldown.
          expect(
            (yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip)).message,
          ).toBe("api circuit breaker is open: segfault");
          yield* coolDown("30 seconds");
          yield* serveThenCrash;
          expect(yield* Ref.get(api.starts)).toHaveLength(5);
          yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);

          yield* orchestrator.start("api");
          expect((yield* api.status).lifecycle).toBe("running");
          expect(yield* Ref.get(api.starts)).toHaveLength(6);
          yield* orchestrator.stopNamespace;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("counts a crash toward the breaker even when its cleanup has to be retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const crashes = yield* Queue.unbounded<Exit.Exit<void, ServiceError>>();
        const stops = yield* Ref.make(0);
        const cleanupFailures = yield* Queue.unbounded<void>();
        const api = yield* makeInstance(orchestrator, "api", {
          onReport: (event) =>
            event._tag === "StopFailed" ? Queue.offer(cleanupFailures, undefined) : Effect.void,
          crash: Queue.take(crashes),
          // Every generation's first cleanup attempt fails; the retry succeeds.
          stop: Ref.updateAndGet(stops, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count % 2 === 1 ? Effect.fail(failure("container busy")) : Effect.void,
            ),
          ),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "lazy" }],
          dependencies: [],
        });
        yield* orchestrator.startComposition;
        const serveThenCrash = Effect.gen(function* () {
          yield* Effect.scoped(orchestrator.acquire("api"));
          yield* Queue.offer(crashes, Exit.fail(failure("segfault")));
          yield* Queue.take(cleanupFailures);
          expect((yield* api.status).lifecycle).toBe("stopping");
        });

        yield* serveThenCrash;
        yield* serveThenCrash;
        yield* serveThenCrash;
        const fourth = yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.exit);
        expect(errorOf(fourth)?.message).toBe("api circuit breaker is open: segfault");
        expect(yield* Ref.get(api.starts)).toHaveLength(3);
      }),
    ),
  );

  it.live("relaunches a crashed prerequisite without replacing its healthy dependent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const crash = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
        const launched = yield* Queue.unbounded<void>();
        const database = yield* makeInstance(orchestrator, "database", {
          exit: crash,
          onReport: (event) =>
            event._tag === "LaunchSucceeded" ? Queue.offer(launched, undefined) : Effect.void,
        });
        const rest = yield* makeInstance(orchestrator, "rest");
        yield* orchestrator.configure({
          members: [
            { id: "database", activation: "lazy" },
            { id: "rest", activation: "lazy" },
          ],
          dependencies: [{ from: "database", to: "rest" }],
        });
        yield* orchestrator.startComposition;
        yield* Effect.scoped(orchestrator.acquire("rest"));
        yield* Queue.take(launched);

        yield* Deferred.succeed(crash, Exit.fail(failure("segfault")));
        yield* Queue.take(launched);

        expect((yield* rest.status).lifecycle).toBe("running");
        expect(yield* Ref.get(database.starts)).toHaveLength(2);
        expect(yield* Ref.get(rest.starts)).toHaveLength(1);
        yield* Effect.scoped(orchestrator.acquire("rest"));
        yield* orchestrator.stopNamespace;
      }),
    ),
  );
});

describe("wake logging", () => {
  it.live("logs a named failure for a failed wake and readiness for a successful one", () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const failing = yield* Ref.make(true);
        yield* makeInstance(orchestrator, "api", {
          launch: Ref.get(failing).pipe(
            Effect.flatMap((value) =>
              value ? Effect.fail(failure("launch failed")) : Effect.void,
            ),
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
        yield* orchestrator.stopNamespace;
        expect(logs.some((line) => line.includes("api api failed to wake"))).toBe(true);
        expect(logs.some((line) => line.includes("api api is ready"))).toBe(true);
      }),
    ).pipe(Effect.provide(captureLogs(["Error", "Info"])(logs)));
  });

  it.live("logs exactly one wake for many concurrent acquires of a sleeping member", () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const launching = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        yield* makeInstance(orchestrator, "api", {
          launch: Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Deferred.await(proceed)),
          ),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "lazy" }],
          dependencies: [],
        });
        yield* orchestrator.startComposition;
        const callers = yield* Effect.forEach(Array.from({ length: 20 }), () =>
          Effect.scoped(orchestrator.acquire("api")).pipe(
            Effect.forkChild({ startImmediately: true }),
          ),
        );
        yield* Deferred.await(launching);
        yield* Deferred.succeed(proceed, undefined);
        yield* Effect.forEach(callers, Fiber.join);
        yield* orchestrator.stopNamespace;
        expect(logs.filter((line) => line.includes("Waking api api"))).toHaveLength(1);
        expect(logs.filter((line) => line.includes("api api is ready"))).toHaveLength(1);
      }),
    ).pipe(Effect.provide(captureLogs(["Error", "Info"])(logs)));
  });

  it.live("logs a distinct failure when a launched member never becomes ready", () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        yield* makeInstance(orchestrator, "api", {
          health: Effect.fail(failure("still booting")),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "lazy" }],
          dependencies: [],
        });
        yield* orchestrator.startComposition;
        yield* Effect.scoped(orchestrator.acquire("api")).pipe(Effect.flip);
        yield* orchestrator.stopNamespace;
        expect(logs.some((line) => line.includes("api api failed to become ready"))).toBe(true);
        expect(logs.some((line) => line.includes("api api failed to wake"))).toBe(false);
      }),
    ).pipe(Effect.provide(captureLogs(["Error", "Info"])(logs)));
  });

  it.live("logs no extra wake while the initiator is still waiting for readiness", () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const healthEntered = yield* Deferred.make<void>();
        const readyGate = yield* Deferred.make<void>();
        yield* makeInstance(orchestrator, "api", {
          health: Deferred.succeed(healthEntered, undefined).pipe(
            Effect.andThen(Deferred.await(readyGate)),
          ),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "lazy" }],
          dependencies: [],
        });
        yield* orchestrator.startComposition;
        const first = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(healthEntered);
        expect(logs.filter((line) => line.includes("Waking api api"))).toHaveLength(1);
        const second = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(readyGate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* orchestrator.stopNamespace;
        expect(logs.filter((line) => line.includes("Waking api api"))).toHaveLength(1);
        expect(logs.filter((line) => line.includes("api api is ready"))).toHaveLength(1);
      }),
    ).pipe(Effect.provide(captureLogs(["Error", "Info"])(logs)));
  });

  it.live("does not log a spurious wake for a member already starting outside acquire", () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestOrchestrator();
        const launching = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        yield* makeInstance(orchestrator, "api", {
          launch: Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Deferred.await(proceed)),
          ),
        });
        yield* orchestrator.configure({
          members: [{ id: "api", activation: "eager" }],
          dependencies: [],
        });
        const composition = yield* orchestrator.startComposition.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(launching);
        const acquired = yield* Effect.scoped(orchestrator.acquire("api")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(composition);
        yield* Fiber.join(acquired);
        yield* orchestrator.stopNamespace;
        expect(logs.filter((line) => line.includes("Waking api api"))).toHaveLength(0);
      }),
    ).pipe(Effect.provide(captureLogs(["Error", "Info"])(logs)));
  });
});

describe("readiness recovery", () => {
  const recoverableHealth = (healthy: Ref.Ref<boolean>) =>
    Ref.get(healthy).pipe(
      Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(failure("still booting")))),
    );

  it.live(
    "keeps re-checking a slow prerequisite after a failed reprobe until a waiting dependent is served",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* makeTestOrchestrator();
          const probes = yield* Ref.make(0);
          const firstProbe = yield* Deferred.make<void>();
          const failFirstProbe = yield* Deferred.make<void>();
          const analytics = yield* makeInstance(orchestrator, "analytics", {
            health: Effect.fail(failure("still booting")),
            probe: Ref.updateAndGet(probes, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(firstProbe, undefined).pipe(
                      Effect.andThen(Deferred.await(failFirstProbe)),
                      Effect.andThen(Effect.fail(failure("still booting"))),
                    )
                  : Effect.void,
              ),
            ),
          });
          const studio = yield* makeInstance(orchestrator, "studio");
          yield* orchestrator.configure({
            members: [
              { id: "analytics", activation: "lazy" },
              { id: "studio", activation: "lazy" },
            ],
            dependencies: [{ from: "analytics", to: "studio" }],
          });
          yield* orchestrator.startComposition;

          const request = yield* Effect.scoped(orchestrator.acquire("studio")).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(firstProbe);
          const failed = yield* nextTransition(analytics.observation);
          yield* Deferred.succeed(failFirstProbe, undefined);
          yield* Fiber.join(failed);
          yield* TestClock.adjust("1 second");

          yield* Fiber.join(request);
          expect(yield* Ref.get(probes)).toBe(2);
          expect(yield* Ref.get(analytics.starts)).toHaveLength(1);
          expect(yield* studio.status).toMatchObject({ lifecycle: "running", health: "healthy" });
          yield* orchestrator.stopNamespace;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
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
        expect(yield* api.status).toMatchObject({ lifecycle: "running", health: "healthy" });
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
        expect((yield* rest.status).health).toBe("healthy");
        yield* orchestrator.stopNamespace;
      }),
    ),
  );
});
