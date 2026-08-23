// oxlint-disable effecttsgo/async-function -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
// oxlint-disable effecttsgo/any-unknown-in-error-context -- Integration tests and subprocess fixtures intentionally inspect generic Effect failures at the boundary.
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { StackInfo } from "./Stack.ts";
import type { Stack } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";
import { StopTimeout } from "./errors.ts";

const stackInfo: StackInfo = {
  url: "http://127.0.0.1",
  dbUrl: "postgresql://127.0.0.1/postgres",
  publishableKey: "publishable",
  secretKey: "secret",
  anonJwt: "anon",
  serviceRoleJwt: "role",
  serviceEndpoints: {},
};
const stackState = new StackServiceState({
  name: "auth",
  status: "Running",
  pid: null,
  exitCode: null,
  restartCount: 0,
  startedAt: null,
  error: null,
});
type StackCleanup = ReturnType<Stack["Service"]["stop"]>;

const makeStack = (
  stop: () => StackCleanup,
  dispose: () => StackCleanup = () => Effect.void,
): Stack["Service"] => ({
  getInfo: () => Effect.succeed(stackInfo),
  start: () => Effect.void,
  stop,
  dispose,
  startService: () => Effect.void,
  stopService: () => Effect.void,
  restartService: () => Effect.void,
  reloadFunctions: () => Effect.void,
  reloadEdgeRuntime: () => Effect.void,
  getState: () => Effect.succeed(stackState),
  getAllStates: () => Effect.succeed([stackState]),
  stateChanges: () => Effect.succeed(Stream.empty),
  allStateChanges: () => Stream.empty,
  waitReady: () => Effect.void,
  waitAllReady: () => Effect.void,
  subscribeLogs: () => Stream.empty,
  subscribeAllLogs: () => Stream.empty,
  logHistory: () => Effect.succeed([]),
  logHistoryAll: () => Effect.succeed([]),
});

const makeLifecycle = async (close: Effect.Effect<void, unknown> = Effect.void) => {
  const scope = Scope.makeUnsafe();
  const lifecycle = await Effect.runPromise(
    SupervisorLifecycle.make({
      ownershipId: "stack",
      ownerSessionId: "session",
      daemonCliVersion: "test",
      close,
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return {
    lifecycle,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

describe("SupervisorLifecycle", () => {
  it("keeps runtime unavailable until publication and shares shutdown", async () => {
    const { lifecycle, close } = await makeLifecycle();
    try {
      const before = await Effect.runPromise(lifecycle.currentStatus);
      expect(before.state).toBe("starting");
      const unavailable = await Effect.runPromise(lifecycle.runtime.pipe(Effect.exit));
      expect(Exit.isFailure(unavailable)).toBe(true);
      if (Exit.isFailure(unavailable)) {
        expect(unavailable.cause).toBeDefined();
      }
      const stopped = { count: 0 };
      await Effect.runPromise(
        lifecycle.publishStack(makeStack(() => Effect.sync(() => void (stopped.count += 1)))),
      );
      expect((await Effect.runPromise(lifecycle.currentStatus)).state).toBe("running");
      await Promise.all([
        Effect.runPromise(lifecycle.requestShutdown("stop")),
        Effect.runPromise(lifecycle.requestShutdown("signal")),
      ]);
      expect(stopped.count).toBe(1);
      expect((await Effect.runPromise(lifecycle.currentState)).phase).toBe("closed");
    } finally {
      await close();
    }
  });

  it("rejects runtime calls while stopping", async () => {
    const { lifecycle, close } = await makeLifecycle();
    try {
      const stopping = Deferred.makeUnsafe<void>();
      await Effect.runPromise(
        lifecycle.publishStack(makeStack(() => Deferred.succeed(stopping, undefined))),
      );
      const stop = Effect.runFork(lifecycle.requestShutdown("stop"));
      await Effect.runPromise(Deferred.await(stopping));
      const runtime = await Effect.runPromise(lifecycle.runtime.pipe(Effect.exit));
      expect(Exit.isFailure(runtime)).toBe(true);
      await Effect.runPromise(Fiber.join(stop));
    } finally {
      await close();
    }
  });

  it("keeps shared shutdown running when one waiter is interrupted", async () => {
    const { lifecycle, close } = await makeLifecycle();
    try {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let stopCount = 0;
      await Effect.runPromise(
        lifecycle.publishStack(
          makeStack(() =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.tap(() => Effect.sync(() => void (stopCount += 1))),
            ),
          ),
        ),
      );
      const owner = Effect.runFork(lifecycle.requestShutdown("stop"));
      await Effect.runPromise(Deferred.await(started));
      const waiter = Effect.runFork(lifecycle.requestShutdown("signal"));
      await Effect.runPromise(Fiber.interrupt(owner));
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.join(waiter));
      await Effect.runPromise(lifecycle.awaitShutdown);
      expect(stopCount).toBe(1);
      expect((await Effect.runPromise(lifecycle.currentState)).phase).toBe("closed");
    } finally {
      await close();
    }
  });

  it("ignores late runtime publication after shutdown owns the state", async () => {
    const { lifecycle, close } = await makeLifecycle();
    try {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      await Effect.runPromise(
        lifecycle.publishStack(
          makeStack(() =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
      );
      const shutdown = Effect.runFork(lifecycle.requestShutdown("stop"));
      await Effect.runPromise(Deferred.await(started));
      await Effect.runPromise(lifecycle.publishStack(makeStack(() => Effect.void)));
      expect((await Effect.runPromise(lifecycle.currentState)).phase).toBe("stopping");
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.join(shutdown));
    } finally {
      await close();
    }
  });

  it("runs every cleanup and preserves a typed stop failure", async () => {
    const stopError = new StopTimeout({ endpoint: "test", ownerSessionId: "session" });
    const events: string[] = [];
    const { lifecycle, close } = await makeLifecycle(
      Effect.sync(() => {
        events.push("close");
      }),
    );
    try {
      await Effect.runPromise(
        lifecycle.publishStack(
          makeStack(
            () => Effect.fail(stopError),
            () =>
              Effect.sync(() => {
                events.push("dispose");
              }),
          ),
        ),
      );
      const exit = await Effect.runPromise(lifecycle.requestShutdown("signal").pipe(Effect.exit));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(stopError);
      expect(events).toEqual(["dispose", "close"]);
      expect((await Effect.runPromise(lifecycle.currentState)).phase).toBe("closed");
    } finally {
      await close();
    }
  });

  it("runs every cleanup and preserves a stop defect", async () => {
    const stopDefect = new Error("stop defect");
    const events: string[] = [];
    const { lifecycle, close } = await makeLifecycle(
      Effect.sync(() => {
        events.push("close");
      }),
    );
    try {
      await Effect.runPromise(
        lifecycle.publishStack(
          makeStack(
            () => Effect.die(stopDefect),
            () =>
              Effect.sync(() => {
                events.push("dispose");
              }),
          ),
        ),
      );
      const exit = await Effect.runPromise(lifecycle.requestShutdown("signal").pipe(Effect.exit));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(stopDefect);
      expect(events).toEqual(["dispose", "close"]);
      expect((await Effect.runPromise(lifecycle.currentState)).phase).toBe("closed");
    } finally {
      await close();
    }
  });

  it("uses the first cleanup failure when stop succeeds", async () => {
    const disposeError = new StopTimeout({ endpoint: "dispose", ownerSessionId: "session" });
    const closeError = new Error("close failed");
    const { lifecycle, close } = await makeLifecycle(Effect.fail(closeError));
    try {
      await Effect.runPromise(
        lifecycle.publishStack(
          makeStack(
            () => Effect.void,
            () => Effect.fail(disposeError),
          ),
        ),
      );
      const exit = await Effect.runPromise(lifecycle.requestShutdown("signal").pipe(Effect.exit));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(disposeError);
      expect((await Effect.runPromise(lifecycle.currentState)).phase).toBe("closed");
    } finally {
      await close();
    }
  });
});
