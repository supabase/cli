import { Cause, Deferred, Effect, Fiber, Ref } from "effect";
import type { Stack } from "../../src/Stack.ts";
import { SupervisorSession } from "../../src/SupervisorSession.ts";

/** A running session actor for integration tests that host the control app in-process. */
export const makeSupervisorSessionFixture = (input: {
  readonly ownershipId: string;
  readonly ownerSessionId: string;
  readonly daemonCliVersion: string;
  readonly close?: Effect.Effect<void, unknown>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const controller = yield* SupervisorSession.make(input);
    const startup = Deferred.makeUnsafe<Stack["Service"]>();
    const running = Deferred.makeUnsafe<void>();
    const disposed = Deferred.makeUnsafe<void>();
    const closeRef = Ref.makeUnsafe<Effect.Effect<void, unknown>>(input.close ?? Effect.void);
    const runFiber = yield* controller
      .run({
        startup: () => Deferred.await(startup),
        stack: (stack) => stack,
        awaitDisposed: () => Deferred.await(disposed),
        onRunning: () => Deferred.succeed(running, undefined).pipe(Effect.asVoid),
        onStopped: () => Effect.void,
        onFailure: () => Effect.void,
        closeOwner: Ref.get(closeRef).pipe(Effect.flatMap((close) => close)),
        errorDetail: (cause) => String(Cause.squash(cause)),
      })
      .pipe(Effect.forkIn(scope));
    const awaitShutdown = Fiber.join(runFiber).pipe(Effect.asVoid);
    return {
      ...controller.service,
      publishStack: (stack: Stack["Service"]) =>
        Deferred.succeed(startup, stack).pipe(
          Effect.andThen(Deferred.await(running)),
          Effect.asVoid,
        ),
      setClose: (close: Effect.Effect<void, unknown>) => Ref.set(closeRef, close),
      disposeRuntime: Deferred.succeed(disposed, undefined).pipe(Effect.asVoid),
      requestShutdown: (_reason?: "stop" | "signal" | "startup-failure" | "dispose") =>
        controller.service.submitShutdown.pipe(Effect.andThen(awaitShutdown)),
      awaitShutdown,
    };
  });
