import { Cause, Context, Deferred, Effect, Exit, Fiber, Queue, Ref, Scope } from "effect";
import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  type ControlOwnerStatus,
} from "./DaemonProtocol.ts";
import type { Stack } from "./Stack.ts";
import { StackUnavailableError } from "./errors.ts";

export type SupervisorSessionState =
  | { readonly phase: "starting" }
  | { readonly phase: "running"; readonly stack: Stack["Service"] }
  | { readonly phase: "stopping"; readonly stack?: Stack["Service"] }
  | { readonly phase: "failed"; readonly detail: string; readonly stack?: Stack["Service"] }
  | { readonly phase: "closed" };

type SessionCommand =
  | { readonly _tag: "StartupFinished" }
  | { readonly _tag: "StopRequested" }
  | { readonly _tag: "RuntimeDisposed" };

interface SupervisorSessionRunInput<A, E, R> {
  readonly startup: (runtimeScope: Scope.Scope) => Effect.Effect<A, E, R | Scope.Scope>;
  readonly stack: (runtime: A) => Stack["Service"];
  readonly awaitDisposed: (runtime: A) => Effect.Effect<void, never>;
  readonly onRunning: (runtime: A) => Effect.Effect<void, unknown>;
  readonly onStopped: Effect.Effect<void, unknown>;
  readonly onFailure: (detail: string) => Effect.Effect<void, unknown>;
  readonly closeOwner: Effect.Effect<void, unknown>;
  readonly errorDetail: (cause: Cause.Cause<unknown>) => string;
}

export interface SupervisorSessionController {
  readonly service: SupervisorSession["Service"];
  readonly run: <A, E, R>(
    input: SupervisorSessionRunInput<A, E, R>,
  ) => Effect.Effect<{ readonly started: boolean }, unknown, Exclude<R, Scope.Scope>>;
}

const firstFailure = (
  exits: ReadonlyArray<Exit.Exit<void, unknown>>,
): Cause.Cause<unknown> | undefined => {
  for (const exit of exits) {
    if (Exit.isFailure(exit)) return exit.cause;
  }
  return undefined;
};

export class SupervisorSession extends Context.Service<
  SupervisorSession,
  {
    readonly currentState: Effect.Effect<SupervisorSessionState>;
    readonly currentStatus: Effect.Effect<ControlOwnerStatus>;
    readonly runtimeStack: Effect.Effect<Stack["Service"], StackUnavailableError>;
    readonly submitShutdown: Effect.Effect<void, never>;
  }
>()("stack/SupervisorSession") {
  static make(input: {
    readonly ownershipId: string;
    readonly ownerSessionId: string;
    readonly daemonCliVersion: string;
  }): Effect.Effect<SupervisorSessionController, never, Scope.Scope> {
    return Effect.gen(function* () {
      const sessionScope = yield* Effect.scope;
      const stateRef = Ref.makeUnsafe<SupervisorSessionState>({ phase: "starting" });
      const commands = yield* Queue.unbounded<SessionCommand>();
      const stopAccepted = Deferred.makeUnsafe<void>();
      const status = (state: SupervisorSessionState): ControlOwnerStatus => ({
        controlProtocol: CONTROL_PROTOCOL,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        ownershipId: input.ownershipId,
        ownerSessionId: input.ownerSessionId,
        state: state.phase === "closed" ? "stopping" : state.phase,
        ready: state.phase === "running",
        daemonCliVersion: input.daemonCliVersion,
      });
      const service: SupervisorSession["Service"] = {
        currentState: Ref.get(stateRef),
        currentStatus: Ref.get(stateRef).pipe(Effect.map(status)),
        runtimeStack: Ref.get(stateRef).pipe(
          Effect.flatMap((state) =>
            state.phase === "running"
              ? Effect.succeed(state.stack)
              : Effect.fail(
                  new StackUnavailableError({
                    phase: state.phase === "closed" ? "stopping" : state.phase,
                    ...(state.phase === "failed" ? { detail: state.detail } : {}),
                  }),
                ),
          ),
        ),
        submitShutdown: Queue.offer(commands, { _tag: "StopRequested" }).pipe(
          Effect.andThen(Deferred.await(stopAccepted)),
        ),
      };
      const run = <A, E, R>(
        runInput: SupervisorSessionRunInput<A, E, R>,
      ): Effect.Effect<{ readonly started: boolean }, unknown, Exclude<R, Scope.Scope>> =>
        Effect.gen(function* () {
          const runtimeScope = yield* Scope.fork(sessionScope);
          const startupResult = Deferred.makeUnsafe<Exit.Exit<A, E>>();
          const startupFiber = yield* Effect.uninterruptibleMask((restore) =>
            restore(runInput.startup(runtimeScope)).pipe(
              Scope.provide(runtimeScope),
              Effect.exit,
              Effect.flatMap((exit) =>
                Deferred.succeed(startupResult, exit).pipe(
                  Effect.andThen(Queue.offer(commands, { _tag: "StartupFinished" })),
                ),
              ),
            ),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          let runtime: A | undefined;
          let started = false;

          const cleanup = (terminal: Effect.Effect<void, unknown>) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Deferred.succeed(stopAccepted, undefined);
                const stack = runtime === undefined ? undefined : runInput.stack(runtime);
                const stopExit = stack === undefined ? Exit.void : yield* Effect.exit(stack.stop());
                const disposeExit =
                  stack === undefined ? Exit.void : yield* Effect.exit(stack.dispose());
                const scopeExit = yield* Effect.exit(Scope.close(runtimeScope, Exit.void));
                const terminalExit = yield* Effect.exit(terminal);
                const closeExit = yield* Effect.exit(runInput.closeOwner);
                yield* Ref.set(stateRef, { phase: "closed" });
                yield* Queue.shutdown(commands);
                const failure = firstFailure([
                  stopExit,
                  disposeExit,
                  scopeExit,
                  terminalExit,
                  closeExit,
                ]);
                if (failure !== undefined) yield* Effect.failCause(failure);
              }),
            );

          while (true) {
            const command = yield* Queue.take(commands);
            switch (command._tag) {
              case "StartupFinished": {
                const exit = yield* Deferred.await(startupResult);
                if (Exit.isFailure(exit)) {
                  const detail = runInput.errorDetail(exit.cause);
                  yield* Ref.set(stateRef, { phase: "failed", detail });
                  yield* cleanup(runInput.onFailure(detail));
                  return yield* Effect.failCause(exit.cause);
                }
                runtime = exit.value;
                yield* Ref.set(stateRef, { phase: "running", stack: runInput.stack(runtime) });
                const runningExit = yield* Effect.exit(runInput.onRunning(runtime));
                if (Exit.isFailure(runningExit)) {
                  const detail = runInput.errorDetail(runningExit.cause);
                  yield* Ref.set(stateRef, {
                    phase: "failed",
                    detail,
                    stack: runInput.stack(runtime),
                  });
                  yield* cleanup(runInput.onFailure(detail));
                  return yield* Effect.failCause(runningExit.cause);
                }
                started = true;
                yield* runInput
                  .awaitDisposed(runtime)
                  .pipe(
                    Effect.exit,
                    Effect.andThen(Queue.offer(commands, { _tag: "RuntimeDisposed" })),
                    Effect.forkIn(sessionScope),
                  );
                break;
              }
              case "StopRequested": {
                const current = yield* Ref.get(stateRef);
                const stack = current.phase === "running" ? current.stack : undefined;
                yield* Ref.set(stateRef, {
                  phase: "stopping",
                  ...(stack === undefined ? {} : { stack }),
                });
                yield* Deferred.succeed(stopAccepted, undefined);
                yield* Fiber.interrupt(startupFiber);
                const startupExit = yield* Deferred.await(startupResult);
                if (runtime === undefined && Exit.isSuccess(startupExit))
                  runtime = startupExit.value;
                yield* cleanup(runInput.onStopped);
                return { started };
              }
              case "RuntimeDisposed": {
                const detail = "Local stack disposed unexpectedly";
                const stack = runtime === undefined ? undefined : runInput.stack(runtime);
                yield* Ref.set(stateRef, {
                  phase: "failed",
                  detail,
                  ...(stack === undefined ? {} : { stack }),
                });
                yield* cleanup(runInput.onFailure(detail));
                return yield* Effect.fail(new Error(detail));
              }
            }
          }
        });
      return { service, run };
    });
  }
}
