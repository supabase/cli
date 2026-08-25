import { Cause, Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { Stack } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { SupervisorSession } from "./SupervisorSession.ts";

const state = new StackServiceState({
  name: "auth",
  status: "Running",
  pid: null,
  exitCode: null,
  restartCount: 0,
  startedAt: null,
  error: null,
});

const makeStack = (events: Array<string>): Stack["Service"] => ({
  getInfo: () => Effect.die("unused"),
  start: () => Effect.void,
  stop: () => Effect.sync(() => events.push("stop")),
  dispose: () => Effect.sync(() => events.push("dispose")),
  startService: () => Effect.void,
  stopService: () => Effect.void,
  restartService: () => Effect.void,
  reloadFunctions: () => Effect.void,
  reloadEdgeRuntime: () => Effect.void,
  getState: () => Effect.succeed(state),
  getAllStates: () => Effect.succeed([state]),
  stateChanges: () => Effect.succeed(Stream.empty),
  allStateChanges: () => Stream.empty,
  waitReady: () => Effect.void,
  waitAllReady: () => Effect.void,
  subscribeLogs: () => Stream.empty,
  subscribeAllLogs: () => Stream.empty,
  logHistory: () => Effect.succeed([]),
  logHistoryAll: () => Effect.succeed([]),
});

const withSession = <A>(
  use: (session: Awaited<ReturnType<typeof makeSession>>) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const controller = yield* SupervisorSession.make({
          ownershipId: "stack",
          ownerSessionId: "session",
          daemonCliVersion: "test",
        }).pipe(Effect.provideService(Scope.Scope, scope));
        return { scope, controller };
      }),
      (session) => Effect.tryPromise(() => use(session)),
      ({ scope }) => Scope.close(scope, Exit.void),
    ),
  );

const makeSession = async () => {
  const scope = Scope.makeUnsafe();
  const controller = await Effect.runPromise(
    SupervisorSession.make({
      ownershipId: "stack",
      ownerSessionId: "session",
      daemonCliVersion: "test",
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { scope, controller };
};

describe("SupervisorSession", () => {
  it("acknowledges stop after publishing stopping and closes ownership last", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const startup = Deferred.makeUnsafe<Stack["Service"]>();
      const run = Effect.runFork(
        controller.run({
          startup: () => Deferred.await(startup),
          stack: (stack) => stack,
          awaitDisposed: () => Effect.never,
          onRunning: () => Effect.void,
          onStopped: Effect.sync(() => events.push("persist-stopped")),
          onFailure: () => Effect.void,
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(controller.service.submitShutdown);
      expect(await Effect.runPromise(controller.service.currentStatus)).toMatchObject({
        state: "stopping",
        ready: false,
      });
      await Effect.runPromise(Fiber.join(run));
      expect(events).toEqual(["persist-stopped", "close-owner"]);
    }));

  it("waits for interrupted startup finalizers before closing ownership", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const startupEntered = Deferred.makeUnsafe<void>();
      const finalizerEntered = Deferred.makeUnsafe<void>();
      const releaseFinalizer = Deferred.makeUnsafe<void>();
      const startup = Effect.acquireUseRelease(
        Deferred.succeed(startupEntered, undefined),
        () => Effect.never,
        () =>
          Effect.sync(() => events.push("startup-finalizer")).pipe(
            Effect.andThen(Deferred.succeed(finalizerEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFinalizer)),
          ),
      );
      const run = Effect.runFork(
        controller.run({
          startup: () => startup,
          stack: (stack: Stack["Service"]) => stack,
          awaitDisposed: () => Effect.never,
          onRunning: () => Effect.void,
          onStopped: Effect.sync(() => events.push("persist-stopped")),
          onFailure: () => Effect.void,
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(startupEntered));
      await Effect.runPromise(controller.service.submitShutdown);
      await Effect.runPromise(Deferred.await(finalizerEntered));
      expect(events).toEqual(["startup-finalizer"]);
      expect(await Effect.runPromise(controller.service.currentStatus)).toMatchObject({
        state: "stopping",
      });
      await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
      await Effect.runPromise(Fiber.join(run));
      expect(events).toEqual(["startup-finalizer", "persist-stopped", "close-owner"]);
    }));

  it("stops a constructed runtime when readiness publication fails", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const stack = makeStack(events);
      const run = await Effect.runPromise(
        controller
          .run({
            startup: () =>
              Effect.addFinalizer(() => Effect.sync(() => events.push("close-runtime-scope"))).pipe(
                Effect.as(stack),
              ),
            stack: (runtime) => runtime,
            awaitDisposed: () => Effect.never,
            onRunning: () => Effect.fail(new Error("publish failed")),
            onStopped: Effect.void,
            onFailure: () => Effect.sync(() => events.push("persist-failed")),
            closeOwner: Effect.sync(() => events.push("close-owner")),
            errorDetail: (cause) => String(Cause.squash(cause)),
          })
          .pipe(Effect.exit),
      );
      expect(Exit.isFailure(run)).toBe(true);
      expect(events).toEqual([
        "stop",
        "dispose",
        "close-runtime-scope",
        "persist-failed",
        "close-owner",
      ]);
    }));

  it("persists the terminal state and closes ownership when a runtime finalizer defects", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const running = Deferred.makeUnsafe<void>();
      const stack = makeStack(events);
      const run = Effect.runFork(
        controller.run({
          startup: () =>
            Effect.addFinalizer(() => Effect.die("runtime finalizer failed")).pipe(
              Effect.as(stack),
            ),
          stack: (runtime) => runtime,
          awaitDisposed: () => Effect.never,
          onRunning: () => Deferred.succeed(running, undefined).pipe(Effect.asVoid),
          onStopped: Effect.sync(() => events.push("persist-stopped")),
          onFailure: () => Effect.void,
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(running));
      await Effect.runPromise(controller.service.submitShutdown);
      const exit = await Effect.runPromise(Fiber.await(run));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(events).toEqual(["stop", "dispose", "persist-stopped", "close-owner"]);
    }));

  it("acknowledges a stop submitted while terminal cleanup is already running", () =>
    withSession(async ({ controller }) => {
      const terminalEntered = Deferred.makeUnsafe<void>();
      const releaseTerminal = Deferred.makeUnsafe<void>();
      const run = Effect.runFork(
        controller.run({
          startup: () => Effect.succeed(makeStack([])),
          stack: (runtime) => runtime,
          awaitDisposed: () => Effect.never,
          onRunning: () => Effect.fail(new Error("publish failed")),
          onStopped: Effect.void,
          onFailure: () =>
            Deferred.succeed(terminalEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTerminal)),
            ),
          closeOwner: Effect.void,
          errorDetail: () => "publish failed",
        }),
      );

      await Effect.runPromise(Deferred.await(terminalEntered));
      const stopAccepted = Deferred.makeUnsafe<void>();
      Effect.runFork(
        controller.service.submitShutdown.pipe(
          Effect.andThen(Deferred.succeed(stopAccepted, undefined)),
        ),
      );
      await Effect.runPromise(Effect.yieldNow);
      expect(await Effect.runPromise(Deferred.isDone(stopAccepted))).toBe(true);
      await Effect.runPromise(Deferred.succeed(releaseTerminal, undefined));
      expect(Exit.isFailure(await Effect.runPromise(Fiber.await(run)))).toBe(true);
    }));

  it("reports unexpected runtime disposal as a tagged stack failure", () =>
    withSession(async ({ controller }) => {
      const running = Deferred.makeUnsafe<void>();
      const disposed = Deferred.makeUnsafe<void>();
      const run = Effect.runFork(
        controller.run({
          startup: () => Effect.succeed(makeStack([])),
          stack: (runtime) => runtime,
          awaitDisposed: () => Deferred.await(disposed),
          onRunning: () => Deferred.succeed(running, undefined).pipe(Effect.asVoid),
          onStopped: Effect.void,
          onFailure: () => Effect.void,
          closeOwner: Effect.void,
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(running));
      await Effect.runPromise(Deferred.succeed(disposed, undefined));
      const exit = await Effect.runPromise(Fiber.await(run));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Predicate.isTagged(Cause.squash(exit.cause), "StackUnavailableError")).toBe(true);
      }
      expect(await Effect.runPromise(controller.service.currentState)).toEqual({ phase: "closed" });
    }));
});
