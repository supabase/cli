/**
 * Pure flag-presence helpers for the `--db-url / --linked / --local` target
 * selection shared by `db lint`, `db advisors`, and `test db`.
 *
 * Go's cobra uses `pflag.Changed` to decide which selector was explicitly set by
 * the user (`apps/cli-go/internal/utils/flags/db_url.go:46-63`).  Effect CLI's
 * parsed flag values don't carry a `Changed` bit, so we re-derive it from the
 * raw `process.argv` slice.
 *
 * cobra's `MarkFlagsMutuallyExclusive` sorts the conflicting names before
 * building the error string (`apps/cli-go/.../flag_groups.go:204`), hence the
 * FIXED insertion order ["db-url","linked","local"] — alphabetical — for the
 * `setFlags` array.
 *
 * pflag accepts `--flag value` (space form) for non-boolean flags: the token
 * after a value-consuming flag is its value, not a separate flag. The scan
 * skips those value tokens to avoid false positives (e.g. `--schema --linked`
 * must not detect `--linked` as a changed selector).
 */

export type LegacyDbConnType = "db-url" | "linked" | "local";

export interface LegacyDbTargetSelection {
  /** Alphabetically-sorted list of explicitly-set selector flags ("db-url", "linked", "local"). */
  readonly setFlags: ReadonlyArray<string>;
  /**
   * Changed-first selection, matching Go's `ParseDatabaseConfig` precedence
   * (db_url.go:46-63): db-url > local > linked (if changed) > undefined (→ local default).
   *
   * `undefined` means no selector was explicitly set; callers default to "local".
   */
  readonly connType: LegacyDbConnType | undefined;
}

/**
 * Long-form flags (without `--` prefix) that consume the next token as their
 * value when given in space-separated form (`--flag value`). Flags in this set
 * cause the immediately following token to be skipped during the target-selector
 * scan.
 *
 * Sources: all legacy command files that call `resolveLegacyDbTargetFlags`
 * (`db lint`, `db advisors`, `test db`) plus the shared global flags
 * (`src/shared/legacy/global-flags.ts`, `src/shared/cli/global-flags.ts`).
 * `Flag.string` / `Flag.choice` → value-consuming; `Flag.boolean` → not.
 */
export const VALUE_CONSUMING_LONG_FLAGS = new Set([
  // db-family command flags
  "db-url",
  "schema",
  "level",
  "fail-on",
  "type",
  // inspect report flag (StringVar, no short alias)
  "output-dir",
  // legacy global flags (Flag.string / Flag.choice)
  "output",
  "output-format",
  "profile",
  "workdir",
  "network-id",
  "dns-resolver",
  "agent",
]);

/**
 * Short flags (without `-` prefix) that consume the next token as their value.
 * Only single-character short flags need to be listed here.
 */
export const VALUE_CONSUMING_SHORT_FLAGS = new Set([
  "s", // --schema / -s
  "o", // --output / -o
]);

/**
 * Resolves the DB target selection from raw CLI args.
 *
 * Performs a single left-to-right pass, skipping value tokens that follow
 * space-separated value-consuming flags to avoid false-positive detection.
 *
 * `setFlags` is built in the fixed order ["db-url","linked","local"] so the
 * rendered conflict string (`[db-url linked]`, `[linked local]`, …) matches
 * cobra's alphabetically-sorted output exactly.
 *
 * `connType` follows Go's Changed-first precedence (db_url.go:46-63):
 *   1. `--db-url` if changed → "db-url"
 *   2. `--local` if changed → "local"
 *   3. `--linked` if changed → "linked"
 *   4. none changed → `undefined` (callers default to "local")
 */
export function resolveLegacyDbTargetFlags(args: ReadonlyArray<string>): LegacyDbTargetSelection {
  let dbUrlChanged = false;
  let linkedChanged = false;
  let localChanged = false;

  let skipNext = false;
  for (const token of args) {
    // pflag: a value-consuming flag consumes the next token as its value even
    // when that token is "--". Only a "--" that is NOT a pending value acts as
    // the end-of-options sentinel.
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (token === "--") break;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const isBare = eqIdx === -1;

      // Check target selectors.
      if (name === "db-url") {
        dbUrlChanged = true;
        // --db-url is a string flag: in space form the next token is the value.
        if (isBare) skipNext = true;
        continue;
      }
      if (name === "linked" || name === "no-linked") {
        linkedChanged = true;
        continue;
      }
      if (name === "local" || name === "no-local") {
        localChanged = true;
        continue;
      }

      // Non-target long flag: skip its value token if value-consuming and bare.
      if (isBare && VALUE_CONSUMING_LONG_FLAGS.has(name)) {
        skipNext = true;
      }
      continue;
    }

    // Short flags: `-s`, `-o`, etc.
    if (token.startsWith("-") && token.length >= 2 && token.charAt(1) !== "-") {
      const shortName = token.charAt(1);
      // `-s` bare (length === 2): next token is the value.
      // `-svalue` (length > 2): value is attached, no skip needed.
      if (token.length === 2 && VALUE_CONSUMING_SHORT_FLAGS.has(shortName)) {
        skipNext = true;
      }
    }
  }

  const setFlags: Array<string> = [];
  if (dbUrlChanged) setFlags.push("db-url");
  if (linkedChanged) setFlags.push("linked");
  if (localChanged) setFlags.push("local");

  let connType: LegacyDbConnType | undefined;
  if (dbUrlChanged) {
    connType = "db-url";
  } else if (localChanged) {
    connType = "local";
  } else if (linkedChanged) {
    connType = "linked";
  }

  return { setFlags, connType };
}
