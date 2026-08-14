/**
 * The separator comment constant and the line-by-line diff. No Effect, no
 * services — just string in, string out — so this stays tightly unit-testable in
 * isolation from the Docker/shadow-database machinery `squash.handler.ts` composes.
 */

/**
 * The separator comment — a raw string literal that opens
 * immediately with a newline, so the exact bytes carry a LEADING `\n`, not just the
 * trailing blank line one might expect from the source layout.
 */
export const LEGACY_SQUASH_SEPARATOR_COMMENT =
  "\n--\n-- Dumped schema changes for auth and storage\n--\n\n";

/**
 * Scan-lines tokenization for `text`: splits on `\n`, drops the trailing empty token a final `\n`
 * would otherwise produce (a `\n`-terminated final line yields no extra token; a
 * final line WITHOUT a trailing `\n` still yields a token), then strips exactly one
 * trailing `\r` from every token — including the final, EOF-flushed one. An empty `text`
 * yields zero tokens.
 *
 * Deliberate divergence (documented in `SIDE_EFFECTS.md`): the original
 * scanner this reproduces also enforces a 64 KiB max token size and silently
 * truncates the scan when a single line exceeds it — not
 * reproduced here, since replicating a silent-data-loss quirk would only make this
 * port worse for users for no observable benefit on any realistic `auth`/`storage`
 * dump line.
 */
export function legacySquashScanLines(text: string): ReadonlyArray<string> {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * A single forward pass over `after`'s lines, advancing an
 * "anchor" cursor into `before`'s lines whenever the current `after` line matches it
 * — emitting every `after` line that DOESN'T match, each with a trailing `\n`.
 * Assumes `before` is a subset of `after` (true for a
 * schema-only auth/storage dump before vs. after a migration apply — entities in
 * those managed schemas are never altered by user migrations).
 *
 * `anchorText` reproduces the exhausted-scanner sentinel exactly: once every
 * `before` token has been consumed, the anchor text returns `""` forever —
 * so every subsequent blank line in `after` is silently swallowed rather than
 * emitted.
 */
export function legacySquashLineByLineDiff(before: string, after: string): string {
  const beforeTokens = legacySquashScanLines(before);
  const afterTokens = legacySquashScanLines(after);
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
