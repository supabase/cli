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
 * Both handlers here are therefore for `Effect.try` only. `Effect.tryPromise`
 * calls its `catch` handler from inside the promise chain the runtime is
 * awaiting, so a handler that rethrows there escapes into that chain instead of
 * becoming a defect. An asynchronous call sorts its failures after the fact
 * instead — see `identity.ts`, which recovers the effect with `Effect.catch` and
 * dies on anything it does not recognize.
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
