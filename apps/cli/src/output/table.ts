import { Effect } from "effect";
import { Output } from "./output.service.ts";

/**
 * Computes the minimum column widths needed to fit both headers and all row values.
 * Headers and rows must have the same number of columns.
 */
export function columnWidths(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<number> {
  return headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
}

/**
 * Formats a single table row by padding each cell to its column width,
 * joining with a 2-space separator.
 */
export function formatTableRow(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
): string {
  return cells.map((c, i) => c + " ".repeat(widths[i]! - c.length)).join("  ");
}

/**
 * Renders a table via the Output service: prints the header row then each data row.
 *
 * TODO: Consider replacing with a declarative ink component using `renderToString`
 * for more complex table layouts.
 *
 * `toRow` converts a data item to a string cell array (used to compute column
 * widths and as the default cell source for each row).
 *
 * `formatRow` optionally overrides how each row string is produced — receives
 * the cell array, computed column widths, and the original data item. Use it
 * to append continuation lines (e.g. `"\n" + extraLine`) or add decoration.
 * When omitted, each row is formatted with `formatTableRow`.
 */
export function outputTable<T>(
  headers: ReadonlyArray<string>,
  data: ReadonlyArray<T>,
  toRow: (item: T) => ReadonlyArray<string>,
  formatRow?: (cells: ReadonlyArray<string>, widths: ReadonlyArray<number>, item: T) => string,
): Effect.Effect<void, never, Output> {
  const rows = data.map(toRow);
  const widths = columnWidths(headers, rows);
  return Effect.gen(function* () {
    const output = yield* Output;
    yield* output.info(formatTableRow(headers, widths));
    yield* Effect.forEach(
      rows,
      (cells, i) => {
        const line = formatRow ? formatRow(cells, widths, data[i]!) : formatTableRow(cells, widths);
        return output.info(line);
      },
      { discard: true },
    );
  });
}
