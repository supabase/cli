import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";

const SECRETS_HEADERS = ["NAME", "DIGEST"] as const;

/**
 * Reproduces the byte output of Go's `secrets list` pretty mode:
 *
 *   1. Go builds a markdown table source where each cell content is wrapped in
 *      backticks and any `|` in the name is markdown-escaped with `\|`.
 *   2. Go pipes that through `glamour.RenderTable` (`AsciiStyle`).
 *
 * Glamour's renderer strips the backticks and converts the markdown-escaped
 * `\|` back to a literal `|` in cell content before laying out columns. The
 * net result is the cell content rendered as-is. `renderGlamourTable` skips
 * the markdown intermediate step entirely and lays out columns directly, so
 * we pass the raw name and digest with no escaping or wrapping. Verified
 * byte-identical against `apps/cli-go` on `secrets list` with empty, single,
 * and pipe-containing names.
 */
export function renderSecretsListTable(
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string {
  const rows = secrets.map((s) => [s.name, s.value]);
  return renderGlamourTable(SECRETS_HEADERS, rows);
}
