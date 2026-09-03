import { ProjectConfigParseError } from "@supabase/config";
import { Effect } from "effect";

/**
 * Wraps one of `@supabase/config`'s convergence calls (`fromApiProjectConfig`,
 * `fromConfigDocument`, `diffProjectConfig`, `legacyExpandConfigPullChangeSet`),
 * each of which throws a typed `ProjectConfigParseError` on an out-of-domain
 * response/document the mapping registry cannot canonicalize. Anything else
 * escaping one of these calls would be a bug in this package pairing, so it
 * stays a defect. Shared by `config diff`, `config pull`, and `config push` —
 * every command in this family that calls into the convergence normalizer.
 */
export function legacyConfigProjectConfigTry<A>(
  thunk: () => A,
): Effect.Effect<A, ProjectConfigParseError> {
  return Effect.try({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
}
