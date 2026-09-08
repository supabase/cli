import { Effect } from "effect";

import { changedLinkedLocalFlags } from "../../../command-internal/db-target-flags.ts";
import { SeedMutuallyExclusiveFlagsError } from "./buckets.errors.ts";

/**
 * Detects which of `--local` / `--linked` were explicitly set, reproducing
 * cobra's `pflag.Changed` for `seed`'s `MarkFlagsMutuallyExclusive`.
 * Delegates to the shared linked/local scanner (also used by `storage`). The
 * seed target is selected from this changed set (`flag.Changed`, via
 * `internal/utils/flags/db_url.go:46-63`), not the parsed flag value.
 */
export function seedChangedTargetFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return changedLinkedLocalFlags(args);
}

/**
 * Reproduce cobra's `MarkFlagsMutuallyExclusive("local", "linked")`. This is
 * rejected at flag validation — before `RunE`/`PersistentPostRun` — so it
 * must NOT emit `cli_command_executed`; the command calls this BEFORE
 * `withCommandTelemetry`.
 *
 * The first bracket keeps seed's REGISTRATION order `[local linked]` — cobra
 * joins the group names unsorted (`flag_groups.go:73`) and only sorts the
 * "were all set" list (`flag_groups.go:203-204`). `storage` registers the same
 * pair in the opposite order, so the two commands' first brackets legitimately
 * differ.
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
