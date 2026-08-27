import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Match,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  type ControlSupervisorStatus,
  type ControlStopIntent,
} from "./DaemonProtocol.ts";
import type { Stack } from "./Stack.ts";
import { StackUnavailableError } from "./errors.ts";

type SupervisorSessionState =
  | { readonly phase: "starting" }
  | { readonly phase: "running"; readonly stack: Stack["Service"] }
  | { readonly phase: "stopping" }
  | { readonly phase: "failed"; readonly detail: string }
  | { readonly phase: "closed" };

type SessionCommand =
  | { readonly _tag: "StartupFinished" }
  | { readonly _tag: "StopRequested"; readonly intent: ControlStopIntent }
  | { readonly _tag: "RuntimeDisposed" };

interface SupervisorSessionRunInput<A, E, R, F> {
  readonly startup: (runtimeScope: Scope.Scope) => Effect.Effect<A, E, R | Scope.Scope>;
  readonly stack: (runtime: A) => Stack["Service"];
  readonly awaitDisposed: (runtime: A) => Effect.Effect<void, never>;
  readonly onRunning: (runtime: A) => Effect.Effect<void, F>;
  readonly onStopped: (intent: ControlStopIntent) => Effect.Effect<void, F>;
  readonly onFailure: (detail: string) => Effect.Effect<void, F>;
  readonly closeOwner: Effect.Effect<void, F>;
  readonly errorDetail: (cause: Cause.Cause<unknown>) => string;
}

export interface SupervisorSessionController {
  readonly service: SupervisorSession["Service"];
  readonly run: <A, E, R, F = never>(
    input: SupervisorSessionRunInput<A, E, R, F>,
  ) => Effect.Effect<
    { readonly started: boolean },
    E | F | StackUnavailableError,
    Exclude<R, Scope.Scope>
  >;
}

const cleanupFailures = (
  exits: ReadonlyArray<Exit.Exit<void, unknown>>,
): ReadonlyArray<Cause.Cause<unknown>> => {
  const failures: Array<Cause.Cause<unknown>> = [];
  for (const exit of exits) {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) failures.push(exit.cause);
  }
  return failures;
};

export class SupervisorSession extends Context.Service<
  SupervisorSession,
  {
    readonly currentStatus: Effect.Effect<ControlSupervisorStatus>;
    readonly runtimeStack: Effect.Effect<Stack["Service"], StackUnavailableError>;
    readonly interruptWhenStopping: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StackUnavailableError, R>;
    readonly interruptStreamWhenStopping: <A, E, R>(
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E | StackUnavailableError, R>;
    readonly submitShutdownWithIntent: (intent: ControlStopIntent) => Effect.Effect<void, never>;
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
      // The terminal signal is completed before teardown begins. Its value is
      // retained for every later caller, including streams subscribed after
      // the session has already closed, so they observe the actual terminal
      // reason instead of a generic "stopping" state.
      const terminalSignal = Deferred.makeUnsafe<StackUnavailableError>();
      const status = (state: SupervisorSessionState): ControlSupervisorStatus => ({
        controlProtocol: CONTROL_PROTOCOL,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        ownershipId: input.ownershipId,
        ownerSessionId: input.ownerSessionId,
        kind: "supervisor",
        state: state.phase === "closed" ? "stopping" : state.phase,
        ready: state.phase === "running",
        daemonCliVersion: input.daemonCliVersion,
      });
      const service: SupervisorSession["Service"] = {
        currentStatus: Ref.get(stateRef).pipe(Effect.map(status)),
        runtimeStack: Ref.get(stateRef).pipe(
          Effect.flatMap((state) =>
            state.phase === "running"
              ? Effect.succeed(state.stack)
              : state.phase === "closed"
                ? Deferred.await(terminalSignal).pipe(Effect.flatMap((error) => Effect.fail(error)))
                : Effect.fail(
                    new StackUnavailableError({
                      phase: state.phase,
                      ...(state.phase === "failed" ? { detail: state.detail } : {}),
                    }),
                  ),
          ),
        ),
        interruptWhenStopping: (effect) =>
          Effect.raceFirst(
            effect,
            Deferred.await(terminalSignal).pipe(Effect.flatMap((error) => Effect.fail(error))),
          ),
        interruptStreamWhenStopping: (stream) =>
          stream.pipe(
            Stream.interruptWhen(
              Deferred.await(terminalSignal).pipe(Effect.flatMap((error) => Effect.fail(error))),
            ),
          ),
        submitShutdownWithIntent: (intent) =>
          Queue.offer(commands, { _tag: "StopRequested", intent }).pipe(
            Effect.andThen(Deferred.await(terminalSignal).pipe(Effect.asVoid)),
          ),
      };
      const run = <A, E, R, F = never>(
        runInput: SupervisorSessionRunInput<A, E, R, F>,
      ): Effect.Effect<
        { readonly started: boolean },
        E | F | StackUnavailableError,
        Exclude<R, Scope.Scope>
      > =>
        Effect.uninterruptibleMask((restore) =>
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

            type CleanupRequest = {
              readonly terminal: Effect.Effect<void, F>;
              readonly reason: StackUnavailableError;
            };
            const cleanupResult = Deferred.makeUnsafe<Exit.Exit<void, never>>();
            let cleanupStarted = false;
            let cleanupRequest: CleanupRequest | undefined;
            const awaitCleanup = Deferred.await(cleanupResult).pipe(
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause),
              ),
            );

            const cleanup = (request: CleanupRequest) =>
              Effect.uninterruptible(
                Effect.suspend(() => {
                  if (cleanupStarted) {
                    return awaitCleanup;
                  }
                  cleanupStarted = true;
                  cleanupRequest = request;
                  return Effect.gen(function* () {
                    // Publish the terminal reason before interrupting startup
                    // or disposing the runtime so all in-flight and future
                    // RPC calls are fenced to the same outcome.
                    yield* Deferred.succeed(terminalSignal, request.reason);
                    // The startup fiber may have built a runtime without yet
                    // publishing StartupFinished. Interrupt and join it before
                    // deriving the stack so every cleanup path owns the value.
                    yield* Fiber.interrupt(startupFiber);
                    const startupExit = yield* Deferred.await(startupResult);
                    if (runtime === undefined && Exit.isSuccess(startupExit)) {
                      runtime = startupExit.value;
                    }
                    const stack = runtime === undefined ? undefined : runInput.stack(runtime);
                    const stopExit =
                      stack === undefined ? Exit.void : yield* Effect.exit(stack.stop());
                    const disposeExit =
                      stack === undefined ? Exit.void : yield* Effect.exit(stack.dispose());
                    const scopeExit = yield* Effect.exit(Scope.close(runtimeScope, Exit.void));
                    const terminalExit = yield* Effect.exit(request.terminal);
                    const closeExit = yield* Effect.exit(runInput.closeOwner);
                    yield* Ref.set(stateRef, { phase: "closed" });
                    yield* Queue.shutdown(commands);
                    const failures = cleanupFailures([
                      stopExit,
                      disposeExit,
                      scopeExit,
                      terminalExit,
                      closeExit,
                    ]);
                    yield* Effect.forEach(failures, (failure) =>
                      Effect.logError("Supervisor cleanup failed", Cause.pretty(failure)),
                    );
                  }).pipe(
                    Effect.exit,
                    Effect.flatMap((exit) =>
                      Deferred.succeed(cleanupResult, exit).pipe(
                        Effect.andThen(
                          Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.void,
                        ),
                      ),
                    ),
                  );
                }),
              );

            yield* Scope.addFinalizer(
              sessionScope,
              Effect.suspend(() =>
                cleanup(
                  cleanupRequest ?? {
                    terminal: runInput.onStopped("explicit"),
                    reason: new StackUnavailableError({ phase: "stopping" }),
                  },
                ),
              ),
            );

            const runLoop = Effect.gen(function* () {
              while (true) {
                const command = yield* Queue.take(commands);
                const outcome = yield* Match.valueTags(command, {
                  StartupFinished: () =>
                    Effect.gen(function* () {
                      const exit = yield* Deferred.await(startupResult);
                      if (Exit.isFailure(exit)) {
                        const detail = runInput.errorDetail(exit.cause);
                        yield* Ref.set(stateRef, { phase: "failed", detail });
                        yield* cleanup({
                          terminal: runInput.onFailure(detail),
                          reason: new StackUnavailableError({ phase: "failed", detail }),
                        });
                        return yield* Effect.failCause(exit.cause);
                      }
                      runtime = exit.value;
                      yield* Ref.set(stateRef, {
                        phase: "running",
                        stack: runInput.stack(runtime),
                      });
                      const runningExit = yield* Effect.exit(runInput.onRunning(runtime));
                      if (Exit.isFailure(runningExit)) {
                        const detail = runInput.errorDetail(runningExit.cause);
                        yield* Ref.set(stateRef, { phase: "failed", detail });
                        yield* cleanup({
                          terminal: runInput.onFailure(detail),
                          reason: new StackUnavailableError({ phase: "failed", detail }),
                        });
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
                    }),
                  StopRequested: (command) =>
                    Effect.gen(function* () {
                      yield* Ref.set(stateRef, { phase: "stopping" });
                      yield* cleanup({
                        terminal: runInput.onStopped(command.intent),
                        reason: new StackUnavailableError({ phase: "stopping" }),
                      });
                      return { started };
                    }),
                  RuntimeDisposed: () =>
                    Effect.gen(function* () {
                      const detail = "Local stack disposed unexpectedly";
                      yield* Ref.set(stateRef, { phase: "failed", detail });
                      yield* cleanup({
                        terminal: runInput.onFailure(detail),
                        reason: new StackUnavailableError({ phase: "failed", detail }),
                      });
                      return yield* new StackUnavailableError({ phase: "failed", detail });
                    }),
                });
                if (outcome !== undefined) return outcome;
              }
            });

            return yield* restore(runLoop).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) return Effect.void;
                const activeCleanup = cleanupRequest;
                if (activeCleanup !== undefined) return cleanup(activeCleanup);
                const request: CleanupRequest = Cause.hasInterruptsOnly(exit.cause)
                  ? {
                      terminal: runInput.onStopped("explicit"),
                      reason: new StackUnavailableError({ phase: "stopping" }),
                    }
                  : (() => {
                      const detail = runInput.errorDetail(exit.cause);
                      return {
                        terminal: runInput.onFailure(detail),
                        reason: new StackUnavailableError({ phase: "failed", detail }),
                      };
                    })();
                return cleanup(request);
              }),
            );
          }),
        );
      return { service, run };
    });
  }
}
