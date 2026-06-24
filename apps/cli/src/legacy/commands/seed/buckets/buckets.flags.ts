import { Effect } from "effect";

import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../../../shared/legacy-db-target-flags.ts";
import { LegacySeedMutuallyExclusiveFlagsError } from "./buckets.errors.ts";

/**
 * Detects which of `--local` / `--linked` were explicitly set on the command
 * line, reproducing cobra's `pflag.Changed` for `seed`'s
 * `MarkFlagsMutuallyExclusive("local", "linked")` (`apps/cli-go/cmd/seed.go:32`).
 *
 * Effect CLI's parsed flags carry no `Changed` bit, so we re-derive it from raw
 * argv. Value-consuming flags (`--workdir <path>`, `-o <fmt>`, …) skip their
 * value token to avoid false positives like `--workdir --linked`.
 *
 * Returned in cobra's alphabetically-sorted order `["linked", "local"]` so the
 * rendered conflict string matches Go exactly.
 */
export function legacySeedChangedTargetFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let linked = false;
  let local = false;
  let skipNext = false;

  for (const token of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "--") break;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const isBare = eqIdx === -1;
      // Treat Effect CLI's boolean negation form (`--no-linked`/`--no-local`) as
      // "changed" too — it sets the flag false but is unambiguously present on
      // argv, the TS equivalent of cobra's `pflag.Changed` (and the seed target
      // is selected from Changed, not the value, so `--no-linked` is still the
      // linked path). Mirrors the sibling DB scanner (legacy-db-target-flags.ts).
      if (name === "linked" || name === "no-linked") {
        linked = true;
        continue;
      }
      if (name === "local" || name === "no-local") {
        local = true;
        continue;
      }
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(name)) skipNext = true;
      continue;
    }

    if (token.startsWith("-") && token.length >= 2 && token.charAt(1) !== "-") {
      if (token.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(token.charAt(1))) {
        skipNext = true;
      }
    }
  }

  const setFlags: Array<string> = [];
  if (linked) setFlags.push("linked");
  if (local) setFlags.push("local");
  return setFlags;
}

/**
 * Reproduce cobra's `MarkFlagsMutuallyExclusive("local", "linked")`
 * (`apps/cli-go/cmd/seed.go:32`). Go rejects this at flag validation — before
 * `RunE`/`PersistentPostRun` — so it must NOT emit `cli_command_executed`; the
 * command calls this BEFORE `withLegacyCommandInstrumentation`.
 */
export const legacyAssertSeedTargetsExclusive = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
) {
  const setFlags = legacySeedChangedTargetFlags(args);
  if (setFlags.length > 1) {
    return yield* new LegacySeedMutuallyExclusiveFlagsError({
      message: `if any flags in the group [linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});
