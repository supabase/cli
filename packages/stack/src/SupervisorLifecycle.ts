import { Context, Deferred, Effect, Exit, Ref, Scope } from "effect";
import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  type ControlOwnerStatus,
} from "./DaemonProtocol.ts";
import type { Stack } from "./Stack.ts";
import { StackUnavailableError } from "./errors.ts";

export { StackUnavailableError } from "./errors.ts";

export type SupervisorRuntime = Pick<Stack["Service"], "stop" | "dispose">;

export type SupervisorState =
  | { readonly phase: "starting" }
  | {
      readonly phase: "running";
      readonly stack: Stack["Service"];
    }
  | {
      readonly phase: "stopping";
      readonly stack?: Stack["Service"];
    }
  | { readonly phase: "failed"; readonly detail: string }
  | { readonly phase: "deleting" }
  | { readonly phase: "closed" };

export class SupervisorLifecycle extends Context.Service<
  SupervisorLifecycle,
  {
    readonly currentState: Effect.Effect<SupervisorState>;
    readonly currentStatus: Effect.Effect<ControlOwnerStatus>;
    readonly runtime: Effect.Effect<SupervisorRuntime, StackUnavailableError>;
    readonly runtimeStack: Effect.Effect<Stack["Service"], StackUnavailableError>;
    readonly publishStack: (stack: Stack["Service"]) => Effect.Effect<void, never>;
    readonly setClose: (close: Effect.Effect<void, unknown>) => Effect.Effect<void, never>;
    /** Enters the owner-visible deleting projection before destructive cleanup. */
    readonly beginDeleting: Effect.Effect<void, never>;
    readonly fail: (detail: string) => Effect.Effect<void, never>;
    /** Publishes the single shutdown reason without waiting for teardown. */
    readonly submitShutdown: (
      reason: "stop" | "signal" | "startup-failure" | "dispose",
    ) => Effect.Effect<void, never>;
    readonly requestShutdown: (
      reason: "stop" | "signal" | "startup-failure" | "dispose",
    ) => Effect.Effect<void, unknown>;
    readonly awaitShutdown: Effect.Effect<void, unknown>;
  }
>()("stack/SupervisorLifecycle") {
  static make(input: {
    readonly ownershipId: string;
    readonly ownerSessionId: string;
    readonly daemonCliVersion: string;
    readonly close?: Effect.Effect<void, unknown>;
  }): Effect.Effect<SupervisorLifecycle["Service"], never, Scope.Scope> {
    return Effect.gen(function* () {
      const lifecycleScope = yield* Effect.scope;
      const stateRef = Ref.makeUnsafe<SupervisorState>({ phase: "starting" });
      const closeReady = Deferred.makeUnsafe<void>();
      const closeRef = Ref.makeUnsafe<Effect.Effect<void, unknown> | undefined>(input.close);
      const shutdownReason = Deferred.makeUnsafe<
        "stop" | "signal" | "startup-failure" | "dispose"
      >();
      const shutdownExit = Deferred.makeUnsafe<Exit.Exit<void, unknown>>();
      const status = (state: SupervisorState): ControlOwnerStatus => ({
        controlProtocol: CONTROL_PROTOCOL,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        ownershipId: input.ownershipId,
        ownerSessionId: input.ownerSessionId,
        state: state.phase === "closed" ? "stopping" : state.phase,
        ready: state.phase === "running",
        daemonCliVersion: input.daemonCliVersion,
      });
      const shutdown = (_reason: string) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const stack =
              current.phase === "running"
                ? current.stack
                : current.phase === "stopping"
                  ? current.stack
                  : undefined;
            yield* Ref.set(stateRef, {
              phase: "stopping",
              ...(stack === undefined ? {} : { stack }),
            });

            // Each owned cleanup is evaluated independently so a failed stop
            // cannot strand disposal, listener close, or the terminal state
            // publication. The first failure is the shared shutdown result;
            // in particular, a stop failure preserves its exact Cause.
            const stopExit =
              stack === undefined ? Exit.succeed(undefined) : yield* Effect.exit(stack.stop());
            const disposeExit =
              stack === undefined ? Exit.succeed(undefined) : yield* Effect.exit(stack.dispose());
            if (input.close === undefined) yield* Deferred.await(closeReady);
            const close = yield* Ref.get(closeRef);
            const closeExit =
              close === undefined ? Exit.succeed(undefined) : yield* Effect.exit(close);

            yield* Ref.set(stateRef, { phase: "closed" });

            const failure = Exit.isFailure(stopExit)
              ? stopExit.cause
              : Exit.isFailure(disposeExit)
                ? disposeExit.cause
                : Exit.isFailure(closeExit)
                  ? closeExit.cause
                  : undefined;
            if (failure !== undefined) yield* Effect.failCause(failure);
          }),
        );
      const completeShutdown = (exit: Exit.Exit<void, unknown>) =>
        Deferred.succeed(shutdownExit, exit).pipe(Effect.asVoid);
      yield* Effect.forkIn(
        Deferred.await(shutdownReason).pipe(
          Effect.flatMap(shutdown),
          Effect.exit,
          Effect.tap(completeShutdown),
        ),
        lifecycleScope,
      );
      const awaitShutdownExit = Deferred.await(shutdownExit).pipe(
        Effect.flatMap((exit) =>
          Exit.match(exit, { onFailure: Effect.failCause, onSuccess: Effect.succeed }),
        ),
      );
      const commitStopping = Ref.modify(stateRef, (state): [undefined, SupervisorState] =>
        state.phase === "running"
          ? [undefined, { phase: "stopping", stack: state.stack }]
          : state.phase === "starting"
            ? [undefined, { phase: "stopping" }]
            : [undefined, state],
      ).pipe(Effect.asVoid);
      const submitShutdown = (reason: "stop" | "signal" | "startup-failure" | "dispose") =>
        commitStopping.pipe(
          Effect.andThen(Deferred.succeed(shutdownReason, reason)),
          Effect.asVoid,
        );
      const requestShutdown = (reason: "stop" | "signal" | "startup-failure" | "dispose") =>
        Effect.gen(function* () {
          yield* submitShutdown(reason);
          yield* awaitShutdownExit;
        });
      return {
        currentState: Ref.get(stateRef),
        currentStatus: Ref.get(stateRef).pipe(Effect.map(status)),
        runtime: Ref.get(stateRef).pipe(
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
        runtimeStack: Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          if (state.phase === "running") return state.stack;
          return yield* Effect.fail(
            new StackUnavailableError({
              phase: state.phase === "closed" ? "stopping" : state.phase,
              ...(state.phase === "failed" ? { detail: state.detail } : {}),
            }),
          );
        }),
        publishStack: (stack) =>
          Ref.modify(stateRef, (state): [undefined, SupervisorState] =>
            state.phase === "starting"
              ? [undefined, { phase: "running", stack }]
              : [undefined, state],
          ).pipe(Effect.asVoid),
        setClose: (close) =>
          Ref.set(closeRef, close).pipe(
            Effect.andThen(Deferred.succeed(closeReady, undefined)),
            Effect.asVoid,
          ),
        beginDeleting: Ref.modify(stateRef, (state): [undefined, SupervisorState] =>
          state.phase === "starting" || state.phase === "running"
            ? [undefined, { phase: "deleting" }]
            : [undefined, state],
        ).pipe(Effect.asVoid),
        fail: (detail) =>
          Ref.modify(stateRef, (state): [undefined, SupervisorState] =>
            state.phase === "starting" || state.phase === "running"
              ? [undefined, { phase: "failed", detail }]
              : [undefined, state],
          ).pipe(Effect.asVoid),
        submitShutdown,
        requestShutdown,
        awaitShutdown: awaitShutdownExit,
      };
    });
  }
}
