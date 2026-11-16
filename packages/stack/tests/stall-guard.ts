import { type Duration, Effect, Fiber } from "effect";

/**
 * Fails with `onStall` once `duration` passes, without waiting for the stalled effect's finalizers,
 * which may hang too; the stalled fiber is interrupted in the background so its cleanup still runs.
 */
export const failOnStall =
  <E2, R2>(duration: Duration.Input, onStall: Effect.Effect<never, E2, R2>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R | R2> =>
    Effect.flatMap(Effect.forkDetach(effect), (fiber) =>
      Fiber.join(fiber).pipe(
        Effect.onInterrupt(() => Effect.forkDetach(Fiber.interrupt(fiber))),
        Effect.timeoutOrElse({ duration, orElse: () => onStall }),
      ),
    );
