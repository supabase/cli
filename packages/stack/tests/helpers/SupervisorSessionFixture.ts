import { Cause, Data, Deferred, Effect, Fiber, Ref } from "effect";
import type { Stack } from "../../src/Stack.ts";
import { SupervisorSession } from "../../src/SupervisorSession.ts";

class SupervisorSessionFixtureCloseError extends Data.TaggedError(
  "SupervisorSessionFixtureCloseError",
)<{
  readonly cause: unknown;
}> {}

const normalizeClose = <E>(
  close: Effect.Effect<void, E>,
): Effect.Effect<void, SupervisorSessionFixtureCloseError> =>
  close.pipe(Effect.mapError((cause) => new SupervisorSessionFixtureCloseError({ cause })));

/** A running session actor for integration tests that host the control app in-process. */
export const makeSupervisorSessionFixture = <E = never>(input: {
  readonly ownershipId: string;
  readonly ownerSessionId: string;
  readonly daemonCliVersion: string;
  readonly close?: Effect.Effect<void, E>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const controller = yield* SupervisorSession.make(input);
    const startup = Deferred.makeUnsafe<Stack["Service"]>();
    const running = Deferred.makeUnsafe<void>();
    const disposed = Deferred.makeUnsafe<void>();
    const closeRef = Ref.makeUnsafe<Effect.Effect<void, SupervisorSessionFixtureCloseError>>(
      normalizeClose(input.close ?? Effect.void),
    );
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
      setClose: <CloseError>(close: Effect.Effect<void, CloseError>) =>
        Ref.set(closeRef, normalizeClose(close)),
      disposeRuntime: Deferred.succeed(disposed, undefined).pipe(Effect.asVoid),
      requestShutdown: (_reason?: "stop" | "signal" | "startup-failure" | "dispose") =>
        controller.service.submitShutdownWithIntent("explicit").pipe(Effect.andThen(awaitShutdown)),
      awaitShutdown,
    };
  });
