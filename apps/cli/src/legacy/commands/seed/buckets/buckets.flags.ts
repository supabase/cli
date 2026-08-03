import { Effect } from "effect";

import { legacyChangedLinkedLocalFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacySeedMutuallyExclusiveFlagsError } from "./buckets.errors.ts";

/**
 * Detects which of `--local` / `--linked` were explicitly set, reproducing
 * cobra's `pflag.Changed` for `seed`'s `MarkFlagsMutuallyExclusive`
 * (`apps/cli-go/cmd/seed.go:32`). Delegates to the shared linked/local scanner
 * (also used by `storage`). The seed target is selected from this changed set
 * (Go's `flag.Changed`, via `internal/utils/flags/db_url.go:46-63`), not the
 * parsed flag value.
 */
export function legacySeedChangedTargetFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return legacyChangedLinkedLocalFlags(args);
}

/**
 * Reproduce cobra's `MarkFlagsMutuallyExclusive("local", "linked")`
 * (`apps/cli-go/cmd/seed.go:32`). Go rejects this at flag validation — before
 * `RunE`/`PersistentPostRun` — so it must NOT emit `cli_command_executed`; the
 * command calls this BEFORE `withLegacyCommandInstrumentation`.
 *
 * The first bracket keeps seed's REGISTRATION order `[local linked]` — cobra
 * joins the group names unsorted (`flag_groups.go:73`) and only sorts the
 * "were all set" list (`flag_groups.go:203-204`). `storage` registers the same
 * pair in the opposite order (`cmd/storage.go:99`), so the two commands'
 * first brackets legitimately differ.
 */
export const legacyAssertSeedTargetsExclusive = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
) {
  const setFlags = legacySeedChangedTargetFlags(args);
  if (setFlags.length > 1) {
    return yield* new LegacySeedMutuallyExclusiveFlagsError({
      message: `if any flags in the group [local linked] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});
