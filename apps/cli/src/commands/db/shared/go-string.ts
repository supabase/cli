/**
 * Trims exactly the Unicode `White_Space` set, matching Go's
 * `strings.TrimSpace`/`bytes.TrimSpace`. Unlike JS's `String.prototype.trim`,
 * it does not strip U+FEFF (BOM/ZWNBSP), so a BOM-prefixed value is left untouched.
 */
export const trimGoSpace = (value: string): string =>
  value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
