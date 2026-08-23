import { Context, Deferred, Effect, Exit, Ref, Scope } from "effect";
import type { ControlOwnerStatus } from "./DaemonProtocol.ts";
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
    /** Releases an accepted HTTP /stop response for graceful listener close. */
    readonly releaseStopResponse: Effect.Effect<void, never>;
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
    readonly daemonBuildId: string;
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
      const stopResponseGate = Deferred.makeUnsafe<void>();
      const shutdownExit = Deferred.makeUnsafe<Exit.Exit<void, unknown>>();
      const status = (state: SupervisorState): ControlOwnerStatus => {
        switch (state.phase) {
          case "starting":
            return {
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: input.ownershipId,
              ownerSessionId: input.ownerSessionId,
              state: "starting",
              ready: false,
              daemonCliVersion: input.daemonCliVersion,
              daemonBuildId: input.daemonBuildId,
            };
          case "running":
            return {
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: input.ownershipId,
              ownerSessionId: input.ownerSessionId,
              state: "running",
              ready: true,
              daemonCliVersion: input.daemonCliVersion,
              daemonBuildId: input.daemonBuildId,
            };
          case "stopping":
            return {
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: input.ownershipId,
              ownerSessionId: input.ownerSessionId,
              state: "stopping",
              ready: false,
              daemonCliVersion: input.daemonCliVersion,
              daemonBuildId: input.daemonBuildId,
            };
          case "failed":
            return {
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: input.ownershipId,
              ownerSessionId: input.ownerSessionId,
              state: "failed",
              ready: false,
              daemonCliVersion: input.daemonCliVersion,
              daemonBuildId: input.daemonBuildId,
            };
          case "deleting":
            return {
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: input.ownershipId,
              ownerSessionId: input.ownerSessionId,
              state: "deleting",
              ready: false,
              daemonCliVersion: input.daemonCliVersion,
              daemonBuildId: input.daemonBuildId,
            };
          case "closed":
            return {
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: input.ownershipId,
              ownerSessionId: input.ownerSessionId,
              state: "stopping",
              ready: false,
              daemonCliVersion: input.daemonCliVersion,
              daemonBuildId: input.daemonBuildId,
            };
        }
      };
      const shutdown = (reason: string) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (reason === "stop") yield* Deferred.await(stopResponseGate);
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
            if (stack !== undefined) {
              yield* stack.stop();
              yield* stack.dispose();
            }
            if (input.close === undefined) {
              yield* Deferred.await(closeReady);
            }
            const close = yield* Ref.get(closeRef);
            if (close !== undefined) yield* close;
            yield* Ref.set(stateRef, { phase: "closed" });
            // state publication follows all owned cleanup and is observable by
            // every waiter joining the same shutdown transaction.
            void reason;
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
          Exit.match(exit, { onFailure: Effect.fail, onSuccess: Effect.succeed }),
        ),
      );
      const submitShutdown = (reason: "stop" | "signal" | "startup-failure" | "dispose") =>
        Effect.gen(function* () {
          const won = yield* Deferred.succeed(shutdownReason, reason);
          if (won && reason !== "stop") yield* Deferred.succeed(stopResponseGate, undefined);
        });
      const requestShutdown = (reason: "stop" | "signal" | "startup-failure" | "dispose") =>
        Effect.gen(function* () {
          const won = yield* Deferred.succeed(shutdownReason, reason);
          if (won) yield* Deferred.succeed(stopResponseGate, undefined);
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
        releaseStopResponse: Deferred.succeed(stopResponseGate, undefined).pipe(Effect.asVoid),
        requestShutdown,
        awaitShutdown: awaitShutdownExit,
      };
    });
  }
}
