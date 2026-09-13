/**
 * Byte-exact separator: opens with a newline, so the constant's leading `\n` is
 * significant, not just its trailing blank line.
 */
export const SQUASH_SEPARATOR_COMMENT =
  "\n--\n-- Dumped schema changes for auth and storage\n--\n\n";

/**
 * Splits `text` on `\n`, drops the trailing empty token a final `\n` would produce,
 * and strips one trailing `\r` from each token. Does not enforce a max token size;
 * see SIDE_EFFECTS.md.
 */
export function squashScanLines(text: string): ReadonlyArray<string> {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * A single forward pass over `after`'s lines, advancing an anchor cursor into
 * `before`'s lines whenever they match and emitting every line that doesn't. Assumes
 * `before` is a subset of `after`; once exhausted, remaining `after` lines match an
 * empty sentinel and are silently swallowed rather than emitted.
 */
export function squashLineByLineDiff(before: string, after: string): string {
  const beforeTokens = squashScanLines(before);
  const afterTokens = squashScanLines(after);
  let anchorIndex = 0;
  let out = "";
  for (const line of afterTokens) {
    const anchorText = anchorIndex < beforeTokens.length ? beforeTokens[anchorIndex]! : "";
    if (line === anchorText) {
      anchorIndex++;
      continue;
    }
    out += `${line}\n`;
  }
  return out;
}
