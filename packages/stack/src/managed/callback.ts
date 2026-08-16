import { Effect } from "effect";

/**
 * The bridge every caller-supplied callback crosses on its way into the managed
 * service.
 *
 * A callback may answer synchronously, asynchronously, or by throwing either
 * way, and whatever it does becomes this effect's outcome unchanged: the
 * service's handling of a refused callback is the same as it was when the
 * service awaited these callbacks directly.
 *
 * `isAnswer` recognizes the callback's synchronous answer, and everything else
 * is awaited. Testing for the synchronous shape rather than for a `Promise` is
 * what makes an answer from another promise implementation — a thenable that is
 * not `instanceof Promise` — awaited instead of being mistaken for work that has
 * already finished.
 */
export const fromCallback = <A>(
  run: () => A | PromiseLike<A>,
  isAnswer: (answer: A | PromiseLike<A>) => answer is A,
): Effect.Effect<A, unknown> =>
  Effect.flatMap(Effect.try({ try: run, catch: (error: unknown) => error }), (answer) =>
    isAnswer(answer)
      ? Effect.succeed(answer)
      : Effect.flatMap(
          Effect.tryPromise({ try: () => answer, catch: (error: unknown) => error }),
          (resolved) =>
            isAnswer(resolved)
              ? Effect.succeed(resolved)
              : Effect.fail(new Error("Callback resolved with an invalid answer")),
        ),
  );

/** A callback that answers by finishing, so anything else is still pending. */
export const isFinished = (answer: void | PromiseLike<void>): answer is void =>
  answer === undefined;

export const isBooleanAnswer = (answer: boolean | PromiseLike<boolean>): answer is boolean =>
  typeof answer === "boolean";
