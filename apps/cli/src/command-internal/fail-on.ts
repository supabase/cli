/**
 * Shared `--fail-on`/`--level` machinery for `db lint` and `db advisors`.
 *
 * Both commands map a textual issue level to an ordinal so a minimum-level filter (`--level`)
 * and a fail-on threshold (`--fail-on`) become integer comparisons. The two commands differ only
 * in how a level string maps to an ordinal:
 *
 *   - **lint** uses a prefix match over `["warning", "error"]`, so `"warning extra"` still
 *     resolves to `warning`.
 *   - **advisors** uses an exact, case-insensitive match over `["info", "warn", "error"]`
 *     matching only the lower- or upper-case form (`"info"`/`"INFO"`), so a mixed-case `"Info"`
 *     resolves to `-1`.
 *
 * An unmatched level returns `-1` in both, which is below every real level — so a `--fail-on` of
 * `-1` (i.e. `none`) never triggers, and a `--level` of `-1` keeps everything.
 */

/** How a level string maps to its ordinal — see module docs. */
export type LevelMatcher = "prefix" | "exact-ci";

export interface LevelEnum {
  /** The canonical level names, lowest severity first (index = ordinal). */
  readonly allowed: ReadonlyArray<string>;
  /** Maps a level string to its ordinal, or `-1` when unmatched. */
  readonly toEnum: (level: string) => number;
}

/**
 * Builds a {@link LevelEnum} from the canonical level vocabulary and the
 * command's matcher strategy.
 */
export function makeLevelEnum(allowed: ReadonlyArray<string>, matcher: LevelMatcher): LevelEnum {
  const toEnum =
    matcher === "prefix"
      ? (level: string): number => {
          for (let i = 0; i < allowed.length; i++) {
            const curr = allowed[i];
            if (curr !== undefined && level.startsWith(curr)) return i;
          }
          return -1;
        }
      : (level: string): number => {
          for (let i = 0; i < allowed.length; i++) {
            const curr = allowed[i];
            if (curr !== undefined && (level === curr || level === curr.toUpperCase())) return i;
          }
          return -1;
        };
  return { allowed, toEnum };
}

/**
 * Whether any item's level meets or exceeds the `--fail-on` threshold. A `failOnLevel` below 0
 * (`none`) never triggers.
 *
 * The caller flattens to the right granularity — lint checks every issue across
 * every result, advisors checks each lint — and supplies the fail message,
 * because the two commands format it differently (lint uses the canonical level
 * name by index, advisors echoes the raw flag value).
 */
export function failsOn<T>(
  items: Iterable<T>,
  getLevel: (item: T) => string,
  failOnLevel: number,
  levelEnum: LevelEnum,
): boolean {
  if (failOnLevel < 0) return false;
  for (const item of items) {
    if (levelEnum.toEnum(getLevel(item)) >= failOnLevel) return true;
  }
  return false;
}
