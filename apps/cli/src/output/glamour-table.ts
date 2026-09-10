/**
 * Renders the CLI's established ASCII table format: a blank line, a decorative empty line, the
 * header row, a dash separator, each data row, and a trailing blank line — every line ending in
 * "\n". Each cell is padded to `max(len(header), max(len(row[i])))` and wrapped with one space
 * on each side; the separator uses dashes of the same width, joined by "|".
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
