/**
 * renderGlamourTable - Reproduces the byte output of Go's `glamour.RenderTable`
 * using `styles.AsciiStyle` for the markdown tables the Go CLI emits (see
 * `apps/cli-go/internal/utils/output.go:109-122`).
 *
 * Output shape (each line terminated by "\n"):
 *
 *   <blank line>
 *   <2-space prefix><nothing>            <- decorative empty line Glamour emits
 *      <space><header-cell><space>|<space><header-cell><space>|...<space>
 *   <2-space prefix><dashes>|<dashes>|...<dashes>
 *      <space><data-cell><space>|<space>...<space>
 *   ...
 *   <blank line>
 *
 * Each cell is padded to the column width: max(len(header), max(len(row[i]))).
 * The padded cell is wrapped with " ... " (one space either side), so the cell
 * width in the output is colWidth + 2. The separator row uses dashes of the
 * same width, joined by "|".
 */
export function renderGlamourTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = headers.map((header, columnIndex) =>
    Math.max(header.length, ...rows.map((row) => (row[columnIndex] ?? "").length)),
  );

  const renderRow = (cells: ReadonlyArray<string>): string =>
    "  " +
    cells.map((cell, columnIndex) => " " + cell.padEnd(widths[columnIndex] ?? 0) + " ").join("|");

  const separator = "  " + widths.map((width) => "-".repeat(width + 2)).join("|");

  const lines: string[] = [];
  lines.push("");
  lines.push("  ");
  lines.push(renderRow(headers));
  lines.push(separator);
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  lines.push("");
  return lines.join("\n") + "\n";
}
