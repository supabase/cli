import { Effect } from "effect";

import { changedLinkedLocalFlags } from "../../../command-internal/db-target-flags.ts";
import { SeedMutuallyExclusiveFlagsError } from "./buckets.errors.ts";

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
  const setFlags = changedLinkedLocalFlags(args);
  if (setFlags.length > 1) {
    return yield* new SeedMutuallyExclusiveFlagsError({
      message: `if any flags in the group [local linked] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});
