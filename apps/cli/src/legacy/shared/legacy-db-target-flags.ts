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
 * Checks whether `name` appears as an explicitly-set flag in `args`.
 *
 * Matches:
 *   - `--<name>`           (boolean flag set true)
 *   - `--<name>=<value>`   (value-style, e.g. `--db-url=postgres://x`)
 *   - `--no-<name>`        (boolean negation, e.g. `--no-linked`)
 *
 * Stops scanning at a bare `--` end-of-options token.
 */
function isFlagChanged(args: ReadonlyArray<string>, name: string): boolean {
  for (const token of args) {
    if (token === "--") break;
    if (token === `--${name}`) return true;
    if (token.startsWith(`--${name}=`)) return true;
    if (token === `--no-${name}`) return true;
  }
  return false;
}

/**
 * Resolves the DB target selection from raw CLI args.
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
  const dbUrlChanged = isFlagChanged(args, "db-url");
  const linkedChanged = isFlagChanged(args, "linked");
  const localChanged = isFlagChanged(args, "local");

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
