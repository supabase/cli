import { Effect } from "effect";

import { changedLinkedLocalFlags } from "../../../command-internal/db-target-flags.ts";
import { SeedMutuallyExclusiveFlagsError } from "./buckets.errors.ts";

/**
 * Detects which of `--local` / `--linked` were explicitly set on argv,
 * delegating to the shared linked/local scanner also used by `storage`. The
 * seed target is selected from this changed set, not the parsed flag value.
 */
export function seedChangedTargetFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return changedLinkedLocalFlags(args);
}

/**
 * Rejects `--local` and `--linked` set together. Must run before
 * `withCommandTelemetry` so the rejection doesn't emit `cli_command_executed`.
 *
 * The error message's bracket lists `[local linked]` in registration order,
 * not sorted — `storage`'s equivalent registers the same pair in the opposite
 * order, so the two commands' messages legitimately differ.
 */
export const assertSeedTargetsExclusive = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
) {
  const setFlags = seedChangedTargetFlags(args);
  if (setFlags.length > 1) {
    return yield* new SeedMutuallyExclusiveFlagsError({
      message: `if any flags in the group [local linked] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});
