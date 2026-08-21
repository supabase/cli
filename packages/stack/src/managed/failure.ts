import { Effect } from "effect";

/** A stable human-readable rendering for failures crossing process boundaries. */
export const causeMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  try {
    const serialized = JSON.stringify(cause);
    return serialized === undefined ? String(cause) : serialized;
  } catch {
    return String(cause);
  }
};

/**
 * Narrows an effect's error channel to the one failure class a protocol reports,
 * turning everything else into a defect.
 *
 * A protocol's own refusals are the only ones its callers can act on; the filesystem errors
 * around them — an unreadable workspace, a full disk — are defects, and
 * inventing a protocol failure for them would hide what actually went wrong.
 *
 * The sorting happens after the effect fails, keeping foreign-boundary errors
 * separate from protocol failures.
 */
export const failsOnlyWith =
  <E>(failure: abstract new (...args: never[]) => E) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, E, R> =>
    Effect.catch(effect, (error) =>
      error instanceof failure ? Effect.fail(error) : Effect.die(error),
    );
