import { Effect } from "effect";

/**
 * The managed guards in `ids.ts`, `paths.ts`, and `repository.ts` are pure
 * synchronous functions that throw their own tagged failures, and both registry
 * adapters drive synchronous SQLite or in-memory code that raises those same
 * failures. Wrapping such a call with `Effect.try` therefore only has to
 * recognize the failures the call site actually expects.
 *
 * Rethrowing anything else is deliberate: `Effect.try` treats a `catch` handler
 * that throws as a defect, so a corrupt registry row or a decoder bug stays a
 * defect instead of widening a method's error channel to `unknown`.
 *
 * Both rethrowing handlers here are therefore for `Effect.try` only.
 * `Effect.tryPromise` calls its `catch` handler from inside the promise chain
 * the runtime is awaiting, so a handler that rethrows there escapes into that
 * chain instead of becoming a defect. An asynchronous call sorts its failures
 * after the fact instead, with {@link asRaised} and {@link failsOnlyWith}.
 *
 * The expected union must be named explicitly, because TypeScript infers a
 * single class from a variadic list of unrelated constructors instead of
 * unioning them:
 *
 * ```ts
 * Effect.try({
 *   try: () => repository.publish(stackId),
 *   catch: failsWith<ManagedOperationOwnershipError | ManagedStackNotFoundError>(
 *     ManagedOperationOwnershipError,
 *     ManagedStackNotFoundError,
 *   ),
 * })
 * ```
 */
export const failsWith =
  <E>(...failures: ReadonlyArray<abstract new (...args: never[]) => E>) =>
  (error: unknown): E => {
    for (const failure of failures) {
      if (error instanceof failure) {
        return error;
      }
    }
    throw error;
  };

/**
 * The `catch` handler for a synchronous call that has no domain failure at all:
 * every throw is a defect.
 */
export const neverFails = (error: unknown): never => {
  throw error;
};

/**
 * Narrows an effect's error channel to the one failure class a protocol reports,
 * turning everything else into a defect.
 *
 * This is the asynchronous counterpart of {@link failsWith}. A protocol's own
 * refusals are the only ones its callers can act on; the filesystem errors
 * around them — an unreadable workspace, a full disk — are defects, and
 * inventing a protocol failure for them would hide what actually went wrong.
 *
 * The sorting happens after the effect fails rather than inside a `tryPromise`
 * `catch` handler: `Effect.try` turns a throwing handler into a defect, but a
 * `tryPromise` handler that throws does so inside the promise chain the runtime
 * is awaiting, where nothing is watching for it. Such a call therefore pairs a
 * handler that classifies nothing — see {@link asRaised} — with this recovery.
 */
export const failsOnlyWith =
  <E>(failure: abstract new (...args: never[]) => E) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, E, R> =>
    Effect.catch(effect, (error) =>
      error instanceof failure ? Effect.fail(error) : Effect.die(error),
    );

/** A `catch` handler that classifies nothing, so it can never throw. */
export const asRaised = (error: unknown): unknown => error;
