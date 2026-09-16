import { ProjectConfigParseError } from "@supabase/config";
import { Effect } from "effect";

/**
 * Wraps a `@supabase/config` convergence call (`fromApiProjectConfig`, `fromConfigDocument`,
 * `diffProjectConfig`, `expandConfigPullChangeSet`). A `ProjectConfigParseError` becomes a typed
 * failure; anything else is a bug in this pairing and stays a defect.
 */
export function configProjectConfigTry<A>(
  thunk: () => A,
): Effect.Effect<A, ProjectConfigParseError> {
  return Effect.try({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
}
