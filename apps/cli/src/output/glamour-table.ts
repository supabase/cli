import { stripVTControlCharacters } from "node:util";

import { type ColorStream, emphasis, heading, muted } from "../command-internal/colors.ts";
import { formatStatus } from "./status.ts";
import { formatAge } from "../command-internal/age.format.ts";
import { GUTTER, detailRows } from "../shared/output/gutter.ts";

/**
 * What a column holds, which decides its terminal styling (see docs/adr/0034-cli-colour-system.md):
 * `primary` is what the row is (bold), `id` is something people copy (plain, never shortened),
 * `status` is an API state (`● Label` in its tone), `meta` is supporting detail (dim), `time` is
 * a timestamp shown as an age (`3d ago`), and `data` is query output shown exactly as returned.
 */
export type ColumnKind = "primary" | "id" | "status" | "meta" | "time" | "plain" | "data";

/**
 * A column header: one name for both layouts, or a terminal label and column kind beside the
 * established piped name. Primary and meta columns shrink with `…` to fit the terminal.
 */
export type TableHeader =
  | string
  | { readonly piped?: string; readonly terminal: string; readonly kind?: ColumnKind };

const pipedHeader = (header: TableHeader): string =>
  typeof header === "string" ? header : (header.piped ?? header.terminal.toUpperCase());
const terminalHeader = (header: TableHeader): string =>
  shortTimeLabel(typeof header === "string" ? titleCase(header) : header.terminal);

/** "Created At (UTC)" reads as "Created" once the value is an age. */
const shortTimeLabel = (label: string): string =>
  TIME_HEADER.test(label) ? label.replace(/\s+At\b/i, "").replace(/\s*\(UTC\)/i, "") : label;

const TIME_HEADER = /\b(created|updated|inserted|deleted|last|expires?)\b.*|\(UTC\)/i;
// Columns that describe a setting someone turns on or off; every other true/false is a fact.
const TOGGLE_HEADER = /enabled|active|allowed|required|verified/i;

/** The stream a table is written to; its TTY flag picks the terminal or piped layout. */
export interface TableStream extends ColorStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
}

const TERMINAL_INDENT = GUTTER;
const TERMINAL_COLUMN_GAP = "   ";
const ACRONYMS = new Set([
  "ID",
  "API",
  "URL",
  "UTC",
  "JWT",
  "SSO",
  "SAML",
  "DB",
  "IP",
  "PITR",
  "WALG",
]);

/** Renders an established upper-case header in Title Case, keeping acronyms upper-case. */
const titleCase = (header: string): string =>
  header.replace(/[A-Z]+/g, (word) =>
    ACRONYMS.has(word) ? word : `${word[0]}${word.slice(1).toLowerCase()}`,
  );

/**
 * Renders a table: borderless with a green Title Case header on a terminal, and the established
 * `|`-separated format when piped so scripts keep working. See docs/adr/0034-cli-colour-system.md.
 */
export function renderGlamourTable(
  headers: ReadonlyArray<TableHeader>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  stream: TableStream = process.stdout,
  /** What a terminal shows when there are no rows, e.g. "No preview branches". */
  empty = "Nothing to show",
): string {
  if (stream.isTTY !== true) return renderPipedTable(headers.map(pipedHeader), rows);
  if (rows.length === 0) return `\n${GUTTER}${muted(empty, stream)}\n`;
  // A PROPERTY/VALUE table is already a detail view; show it as label/value rows.
  if (headers.length === 2 && /^(property|key|field)$/i.test(pipedHeader(headers[0] ?? ""))) {
    return `\n${detailRows(
      rows.map(([label = "", value = ""]) => {
        const name = shortTimeLabel(titleCase(label));
        const kind = columnKind(label);
        return [name, detailValue(value, kind, name, stream)] as const;
      }),
      stream,
    )}`;
  }
  const labels = headers.map(terminalHeader);
  const kinds = headers.map(columnKind);
  // One record reads better as a detail view than as a one-row table.
  if (rows.length === 1 && headers.length >= 3) {
    const row = rows[0] ?? [];
    return `${detailRows(
      labels.map(
        (label, index) =>
          [label, detailValue(row[index] ?? "", kinds[index], label, stream)] as const,
      ),
      stream,
    )}`;
  }
  return renderTerminalTable(labels, kinds, rows, stream);
}

/** A column's kind: declared, or inferred for Status and timestamp columns. */
const columnKind = (header: TableHeader): ColumnKind => {
  const name = typeof header === "string" ? header : header.terminal;
  // A timestamp column declared as plain metadata still reads as an age.
  if (typeof header !== "string" && header.kind === "meta" && TIME_HEADER.test(name)) return "time";
  if (typeof header !== "string" && header.kind !== undefined) return header.kind;
  if (/\bstatus$/i.test(name)) return "status";
  if (TIME_HEADER.test(name)) return "time";
  return "plain";
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/**
 * The value people read for a cell: statuses as `● Label`, timestamps as an age, and true/false as
 * Yes/No for facts or Enabled/Disabled for settings, with the "off" word dim.
 */
const relabel = (
  cell: string,
  kind: ColumnKind | undefined,
  label: string,
  stream: TableStream,
) => {
  if (kind === "data") return cell;
  if (kind === "status") return formatStatus(cell, stream);
  if (kind === "time" && TIMESTAMP.test(cell)) {
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(cell) ? cell : `${cell.replace(" ", "T")}Z`;
    // oxlint-disable-next-line effecttsgo/global-date -- a pure renderer; the age is display-only
    const age = formatAge(iso, Date.now());
    return age === "" ? cell : /^\d+s$/.test(age) ? "just now" : `${age} ago`;
  }
  if (cell === "true") return TOGGLE_HEADER.test(label) ? "Enabled" : "Yes";
  if (cell === "false") return muted(TOGGLE_HEADER.test(label) ? "Disabled" : "No", stream);
  return cell;
};

const detailValue = (
  cell: string,
  kind: ColumnKind | undefined,
  label: string,
  stream: TableStream,
) => {
  if (cell.trim() === "") return muted("–", stream);
  const value = relabel(cell, kind, label, stream);
  return kind === "meta" || kind === "time" ? muted(value, stream) : value;
};

const MIN_SHRUNK_WIDTH = 8;
const MIN_PRIMARY_WIDTH = 16;

/** Shortens a cell to `width` visible columns with `…`; a shortened cell loses its styling. */
const fitCell = (cell: string, width: number): string => {
  const plain = stripVTControlCharacters(cell);
  return plain.length <= width ? cell : `${plain.slice(0, Math.max(0, width - 1))}…`;
};

function renderTerminalTable(
  headers: ReadonlyArray<string>,
  kinds: ReadonlyArray<ColumnKind>,
  sourceRows: ReadonlyArray<ReadonlyArray<string>>,
  stream: TableStream,
): string {
  const shrinkable = kinds.map((kind) => kind === "primary" || kind === "meta");
  const styleCell = (cell: string, kind: ColumnKind | undefined): string => {
    if (cell.trim() === "") return kind === "data" ? cell : muted("–", stream);
    switch (kind) {
      case "primary":
        return emphasis(cell, stream);
      case "status":
        return formatStatus(cell, stream);
      case "meta":
      case "time":
        return muted(cell, stream);
      default:
        return cell;
    }
  };
  // Relabelled cells change width, so they are prepared before measuring.
  const preparedRows = sourceRows.map((row) =>
    row.map((cell, index) =>
      cell.trim() === "" ? cell : relabel(cell, kinds[index], headers[index] ?? "", stream),
    ),
  );
  const displayWidth = (cell: string) => stripVTControlCharacters(cell).length;
  const widths = headers.map((header, columnIndex) =>
    Math.max(
      displayWidth(header),
      ...preparedRows.map((row) => displayWidth(row[columnIndex] || "–")),
    ),
  );
  // Fit the terminal by shortening the widest descriptive column until the table fits or none can
  // shrink further.
  const available = (stream.columns ?? 100) - TERMINAL_INDENT.length;
  const total = () =>
    widths.reduce((sum, width) => sum + width, 0) +
    TERMINAL_COLUMN_GAP.length * (widths.length - 1);
  // Supporting detail gives way before the column that names the row, one character at a time,
  // and no column gets narrower than its floor or its own header.
  for (const kind of ["meta", "primary"] as const) {
    const kindFloor = kind === "primary" ? MIN_PRIMARY_WIDTH : MIN_SHRUNK_WIDTH;
    const floorOf = (index: number) => Math.max(kindFloor, displayWidth(headers[index] ?? ""));
    while (total() > available) {
      let widest = -1;
      widths.forEach((width, index) => {
        if (kinds[index] !== kind || width <= floorOf(index)) return;
        if (widest === -1 || width > (widths[widest] ?? 0)) widest = index;
      });
      if (widest === -1) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
    }
  }
  const rows = preparedRows.map((row) =>
    row.map((cell, index) => {
      if (kinds[index] === "status") return cell;
      const fitted = shrinkable[index] === true ? fitCell(cell, widths[index] ?? 0) : cell;
      return styleCell(fitted, kinds[index]);
    }),
  );
  const renderRow = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, columnIndex) =>
        columnIndex === cells.length - 1
          ? cell
          : cell + " ".repeat(Math.max(0, (widths[columnIndex] ?? 0) - displayWidth(cell))),
      )
      .join(TERMINAL_COLUMN_GAP)
      .trimEnd();

  const lines = [
    TERMINAL_INDENT + heading(renderRow(headers), stream),
    ...rows.map((row) => TERMINAL_INDENT + renderRow(row)),
  ];
  return `\n${lines.join("\n")}\n`;
}

/**
 * The established piped format: a blank line, a decorative empty line, the header row, a dash
 * separator, each data row, and a trailing blank line. Each cell is padded to the column width and
 * wrapped with one space on each side.
 */
function renderPipedTable(
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
