import { Cause, Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { Stack } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { SupervisorSession } from "./SupervisorSession.ts";
import { makeTestStack } from "./testing.ts";

const state = new StackServiceState({
  name: "auth",
  status: "Running",
  pid: null,
  exitCode: null,
  restartCount: 0,
  startedAt: null,
  error: null,
});

const makeStack = (events: Array<string>): Stack["Service"] =>
  makeTestStack({
    getInfo: () => Effect.die("unused"),
    stop: () => Effect.sync(() => events.push("stop")),
    dispose: () => Effect.sync(() => events.push("dispose")),
    getState: () => Effect.succeed(state),
    getAllStates: () => Effect.succeed([state]),
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
  it("runs explicit cleanup when the session is externally interrupted during startup", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const startupEntered = Deferred.makeUnsafe<void>();
      const run = Effect.runFork(
        controller.run({
          startup: () =>
            Deferred.succeed(startupEntered, undefined).pipe(Effect.andThen(Effect.never)),
          stack: (runtime: Stack["Service"]) => runtime,
          awaitDisposed: () => Effect.never,
          onRunning: () => Effect.void,
          onStopped: (intent) => Effect.sync(() => events.push(`stopped:${intent}`)),
          onFailure: () => Effect.sync(() => events.push("failed")),
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(startupEntered));
      await Effect.runPromise(Fiber.interrupt(run));
      expect(events).toEqual(["stopped:explicit", "close-owner"]);
    }));

  it("runs explicit cleanup when the session is externally interrupted while running", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const running = Deferred.makeUnsafe<void>();
      const stack = makeStack(events);
      const run = Effect.runFork(
        controller.run({
          startup: () => Effect.succeed(stack),
          stack: (runtime) => runtime,
          awaitDisposed: () => Effect.never,
          onRunning: () => Deferred.succeed(running, undefined),
          onStopped: (intent) => Effect.sync(() => events.push(`stopped:${intent}`)),
          onFailure: () => Effect.sync(() => events.push("failed")),
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(running));
      await Effect.runPromise(Fiber.interrupt(run));
      expect(events).toEqual(["stop", "dispose", "stopped:explicit", "close-owner"]);
    }));

  it("acknowledges stopping before waiting for startup finalizers and closes ownership last", () =>
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
          onStopped: () => Effect.sync(() => events.push("persist-stopped")),
          onFailure: () => Effect.void,
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(startupEntered));
      await Effect.runPromise(controller.service.submitShutdownWithIntent("explicit"));
      await Effect.runPromise(Deferred.await(finalizerEntered));
      expect(events).toEqual(["startup-finalizer"]);
      expect(await Effect.runPromise(controller.service.currentStatus)).toMatchObject({
        state: "stopping",
        ready: false,
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
            onStopped: () => Effect.void,
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

  it("logs runtime finalizer defects while completing an explicit stop", () =>
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
          onStopped: () => Effect.sync(() => events.push("persist-stopped")),
          onFailure: () => Effect.void,
          closeOwner: Effect.sync(() => events.push("close-owner")),
          errorDetail: () => "failed",
        }),
      );

      await Effect.runPromise(Deferred.await(running));
      await Effect.runPromise(controller.service.submitShutdownWithIntent("explicit"));
      const exit = await Effect.runPromise(Fiber.await(run));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(events).toEqual(["stop", "dispose", "persist-stopped", "close-owner"]);
    }));

  it("preserves the startup failure when cleanup also defects", () =>
    withSession(async ({ controller }) => {
      const events: Array<string> = [];
      const startupFailure = new Error("startup failed");
      const exit = await Effect.runPromise(
        controller
          .run({
            startup: () =>
              Effect.addFinalizer(() => Effect.die("runtime finalizer failed")).pipe(
                Effect.andThen(Effect.fail(startupFailure)),
              ),
            stack: (runtime: Stack["Service"]) => runtime,
            awaitDisposed: () => Effect.never,
            onRunning: () => Effect.void,
            onStopped: () => Effect.void,
            onFailure: () => Effect.sync(() => events.push("persist-failed")),
            closeOwner: Effect.sync(() => events.push("close-owner")),
            errorDetail: () => startupFailure.message,
          })
          .pipe(Effect.exit),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(startupFailure);
      expect(events).toEqual(["persist-failed", "close-owner"]);
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
          onStopped: () => Effect.void,
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
        controller.service
          .submitShutdownWithIntent("explicit")
          .pipe(Effect.andThen(Deferred.succeed(stopAccepted, undefined))),
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
          onStopped: () => Effect.void,
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
      const unavailable = await Effect.runPromise(Effect.flip(controller.service.runtimeStack));
      expect(Predicate.isTagged(unavailable, "StackUnavailableError")).toBe(true);
      if (Predicate.isTagged(unavailable, "StackUnavailableError")) {
        expect(unavailable).toMatchObject({
          phase: "failed",
          detail: "Local stack disposed unexpectedly",
        });
      }
      const streamExit = await Effect.runPromise(
        controller.service
          .interruptStreamWhenStopping(Stream.never)
          .pipe(Stream.runDrain, Effect.exit),
      );
      expect(Exit.isFailure(streamExit)).toBe(true);
      if (Exit.isFailure(streamExit)) {
        const error = Cause.squash(streamExit.cause);
        expect(Predicate.isTagged(error, "StackUnavailableError")).toBe(true);
        if (Predicate.isTagged(error, "StackUnavailableError")) {
          expect(error).toMatchObject({ phase: "failed" });
        }
      }
    }));
});
