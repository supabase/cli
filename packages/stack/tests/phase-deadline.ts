import { Data, Duration, Effect } from "effect";

export class PhaseStallError extends Data.TaggedError("PhaseStallError")<{
  readonly message: string;
}> {}

/** Fails with the stalled phase's name before the test's own timeout hides which step hung. */
export const phaseDeadline =
  (phase: string, seconds = 5) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(self, {
      duration: Duration.seconds(seconds),
      orElse: () =>
        Effect.fail(new PhaseStallError({ message: `${phase} did not finish within ${seconds}s` })),
    });
