/**
 * Go string-primitive helpers shared across the `db` command family. Currently
 * just `strings.TrimSpace`/`bytes.TrimSpace` — hoisted here (per the repo's
 * "hoist before you duplicate" rule, AGENTS.md) once a second `db`-family caller
 * needed the exact same primitive: `legacy-pgdelta.apply.ts` (CLI-1956, apply
 * error-detail trimming) and `legacy-pgadmin-diff.ts` (CLI-1968, `diff_ddl`
 * trimming) each carried their own private, verbatim copy before this move.
 */

/**
 * Go's `strings.TrimSpace`/`bytes.TrimSpace` trim exactly the Unicode
 * `White_Space` set — which, unlike JS's `String.prototype.trim`, does NOT
 * include U+FEFF (BOM/ZWNBSP). A BOM-prefixed payload must therefore fail to
 * parse (or render un-trimmed) here exactly like it does in Go, and
 * BOM-adjacent fields must render it, not eat it.
 */
export const legacyTrimGoSpace = (value: string): string =>
  value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
