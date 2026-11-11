import { renderGlamourTable } from "../output/glamour-table.ts";
import { stringWidth } from "./string-width.ts";

// Width counts East Asian Wide as 2 and zero-width/combining as 0, so CJK/emoji cells still
// align columns and borders; counting JS code points would under-measure them.
const displayWidth = (text: string): number => stringWidth(text);

/**
 * Render rows as the established box-layout table (header not upper-cased).
 * Left aligned, one space of padding each side, Unicode box-drawing borders.
 * An empty column set renders nothing (established empty-header output).
 */
export function renderTablewriter(
  cols: ReadonlyArray<string>,
  data: ReadonlyArray<ReadonlyArray<unknown>>,
  formatCell: (value: unknown, columnIndex: number) => string,
): string {
  if (cols.length === 0) return "";
  const rows = data.map((row) => row.map((cell, columnIndex) => formatCell(cell, columnIndex)));
  // A person at a terminal gets the shared borderless table; column names stay as written.
  if (process.stdout.isTTY) {
    return renderGlamourTable(
      cols.map((col) => ({ terminal: col, kind: "data" as const })),
      rows.map((row) => row.map((cell) => cell.replaceAll("\n", "↵"))),
    );
  }
  // Column width is the widest visual line, since a multi-line cell splits across stacked lines.
  const widths = cols.map((col, i) => {
    let width = displayWidth(col);
    for (const row of rows) {
      for (const line of (row[i] ?? "").split("\n")) width = Math.max(width, displayWidth(line));
    }
    return width;
  });

  const segment = (width: number) => "─".repeat(width + 2);
  const top = `┌${widths.map(segment).join("┬")}┐`;
  const sep = `├${widths.map(segment).join("┼")}┤`;
  const bottom = `└${widths.map(segment).join("┴")}┘`;
  const renderLine = (cells: ReadonlyArray<string>) =>
    `│${cells
      .map((cell, i) => {
        const width = widths[i];
        return ` ${cell}${width === undefined ? "" : " ".repeat(width - displayWidth(cell))} `;
      })
      .join("│")}│`;
  // A multiline cell splits across stacked bordered lines within the same
  // logical row (other columns blank on continuation lines), no per-row separator.
  const renderRow = (cells: ReadonlyArray<string>): string => {
    const split = cells.map((cell) => cell.split("\n"));
    const lineCount = Math.max(1, ...split.map((s) => s.length));
    const visual: string[] = [];
    for (let j = 0; j < lineCount; j++) {
      visual.push(renderLine(split.map((s) => s[j] ?? "")));
    }
    return visual.join("\n");
  };

  const lines = [top, renderLine(cols), sep, ...rows.map(renderRow), bottom];
  return `${lines.join("\n")}\n`;
}

/** The established CSV field-quoting rule. */
function csvFieldNeedsQuotes(field: string): boolean {
  if (field === "") return false;
  if (field === "\\.") return true;
  if (/[\n\r",]/.test(field)) return true;
  return /\s/u.test(field[0] ?? "");
}

function csvField(field: string): string {
  if (!csvFieldNeedsQuotes(field)) return field;
  return `"${field.replaceAll('"', '""')}"`;
}

/** The established CSV output (RFC4180, `\n` line terminator). */
export function toCsv(
  cols: ReadonlyArray<string>,
  data: ReadonlyArray<ReadonlyArray<unknown>>,
  formatCell: (value: unknown, columnIndex: number) => string,
): string {
  const lines = [cols.map(csvField).join(",")];
  for (const row of data) {
    lines.push(row.map((value, columnIndex) => csvField(formatCell(value, columnIndex))).join(","));
  }
  return `${lines.join("\n")}\n`;
}
