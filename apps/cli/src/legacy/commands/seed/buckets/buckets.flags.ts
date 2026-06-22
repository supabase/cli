import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../../../shared/legacy-db-target-flags.ts";

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
      if (name === "linked") {
        linked = true;
        continue;
      }
      if (name === "local") {
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
