import { Effect, Ref } from "effect";

/**
 * Runs `retried` over a counted `attempt` and records the total as `retry.attempt_count` on the
 * current span. Attempts emit no spans unless `traced` is set, so polling stays one span.
 */
export const withAttemptCount = <A, E, R, A2, E2, R2>(
  attempt: Effect.Effect<A, E, R>,
  retried: (counted: Effect.Effect<A, E, R>) => Effect.Effect<A2, E2, R2>,
  options?: { readonly traced?: boolean },
): Effect.Effect<A2, E2, R2> =>
  Effect.gen(function* () {
    const count = yield* Ref.make(0);
    const counted = Ref.update(count, (value) => value + 1).pipe(
      Effect.andThen(attempt),
      options?.traced === true ? (effect) => effect : Effect.withTracerEnabled(false),
    );
    return yield* retried(counted).pipe(
      Effect.ensuring(
        Ref.get(count).pipe(
          Effect.flatMap((value) => Effect.annotateCurrentSpan({ "retry.attempt_count": value })),
        ),
      ),
    );
  });
