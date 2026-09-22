import type { Stack } from "../src/effect.ts";
import { Cause, Effect, Exit } from "effect";

/** Releases a test stack and stops its detached owner when destroy cannot finish. */
export const destroyTestStack = (stack: Stack): Effect.Effect<void, never> =>
  stack.destroy.pipe(
    Effect.catchCause((destroyCause) =>
      stack.stop.pipe(
        Effect.exit,
        Effect.flatMap((stopExit) =>
          Exit.isSuccess(stopExit)
            ? Effect.failCause(destroyCause)
            : Effect.failCause(Cause.combine(destroyCause, stopExit.cause)),
        ),
      ),
    ),
    Effect.orDie,
  );
