import { Effect } from "effect";
import { Stack } from "@supabase/stack/internals";
import { interruptOnSignal } from "../signal.ts";
import { makeStartForegroundSession } from "../ui/foreground-session.ts";

export const startForegroundWithStopSignal = <R>(stopRequested: Effect.Effect<void, never, R>) =>
  Effect.fnUntraced(function* () {
    const stack = yield* Stack;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* makeStartForegroundSession();
        yield* Effect.addFinalizer(() =>
          Effect.uninterruptible(stack.dispose()).pipe(Effect.ignore),
        );

        return yield* Effect.gen(function* () {
          yield* stack.start();
          yield* session.markRunning;
          yield* session.waitUntilExit;
          yield* session.markStopping;
        }).pipe(
          Effect.raceFirst(stopRequested),
          Effect.catchCause((cause) =>
            session.markFailed(cause).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      }),
    );
  })();

export const startForeground = Effect.fnUntraced(function* () {
  return yield* startForegroundWithStopSignal(interruptOnSignal);
});
