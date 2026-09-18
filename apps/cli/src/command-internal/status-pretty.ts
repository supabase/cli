import { aqua, bold, green, yellow } from "./colors.ts";
import type { StatusOutputNames } from "./status-values.ts";

/**
 * Renders `status`'s fixed 5-group, 2-column layout as rounded-border tables — column 0 caps
 * at 16 display columns and word-wraps (no fixed label reaches that width today), and this is
 * distinct from `output/glamour-table.ts`'s single-ASCII-table renderer used elsewhere.
 *
 * Every color call below explicitly passes `process.stdout`, since `colors.ts` defaults to
 * `process.stderr` and would check the wrong stream's TTY status.
 */

type OutputKind = "text" | "link" | "key";

interface OutputItem {
  readonly label: string;
  readonly value: string;
  readonly kind: OutputKind;
}

interface OutputGroup {
  readonly name: string;
  readonly items: ReadonlyArray<OutputItem>;
}

const COLUMN_0_MAX_WIDTH = 16;

/**
 * Builds the 5 fixed display groups, looking up each label's value by its resolved output
 * key — `--override-name` remaps the key but never the group layout.
 */
function buildGroups(
  values: Readonly<Record<string, string>>,
  names: StatusOutputNames,
): ReadonlyArray<OutputGroup> {
  const at = (key: string) => values[key] ?? "";
  return [
    {
      name: "🔧 Development Tools",
      items: [
        { label: "Studio", value: at(names.studioUrl), kind: "link" },
        { label: "Mailpit", value: at(names.mailpitUrl), kind: "link" },
        { label: "MCP", value: at(names.mcpUrl), kind: "link" },
      ],
    },
    {
      name: "🌐 APIs",
      items: [
        { label: "Project URL", value: at(names.apiUrl), kind: "link" },
        { label: "REST", value: at(names.restUrl), kind: "link" },
        { label: "GraphQL", value: at(names.graphqlUrl), kind: "link" },
        { label: "Edge Functions", value: at(names.functionsUrl), kind: "link" },
      ],
    },
    {
      name: "⛁ Database",
      items: [{ label: "URL", value: at(names.dbUrl), kind: "link" }],
    },
    {
      name: "🔑 Authentication Keys",
      items: [
        { label: "Publishable", value: at(names.publishableKey), kind: "key" },
        { label: "Secret", value: at(names.secretKey), kind: "key" },
      ],
    },
    {
      name: "📦 Storage (S3)",
      items: [
        { label: "URL", value: at(names.storageS3Url), kind: "link" },
        { label: "Access Key", value: at(names.storageS3AccessKeyId), kind: "key" },
        { label: "Secret Key", value: at(names.storageS3SecretAccessKey), kind: "key" },
        { label: "Region", value: at(names.storageS3Region), kind: "text" },
      ],
    },
  ];
}

/**
 * Display width for this command's inputs: URLs/keys/labels are always plain ASCII, so every
 * rune is width 1. The 5 fixed group-title emoji are the only non-ASCII runes ever rendered,
 * and their widths are hardcoded in {@link HEADER_DISPLAY_WIDTH} instead of computed
 * generically.
 */
function displayWidth(text: string): number {
  return [...text].length;
}

/** Rendered display width of each fixed group title (see `status.pretty.unit.test.ts`). */
const HEADER_DISPLAY_WIDTH: Readonly<Record<string, number>> = {
  "🔧 Development Tools": 20,
  "🌐 APIs": 7,
  "⛁ Database": 10,
  "🔑 Authentication Keys": 22,
  "📦 Storage (S3)": 15,
};

/**
 * Exported only for direct unit coverage of the fallback branch — every call site in this
 * file passes one of the 5 fixed titles in {@link HEADER_DISPLAY_WIDTH}.
 */
export function statusHeaderWidth(name: string): number {
  return HEADER_DISPLAY_WIDTH[name] ?? displayWidth(name);
}

/**
 * Greedy word-wrap to `width` columns. Exported only for direct unit coverage of the
 * >16-char defensive-wrap branch — no real label reaches that width today, so
 * `renderStatusPretty` never exercises it end to end.
 */
export function wrapStatusLabel(text: string, width: number): ReadonlyArray<string> {
  if (displayWidth(text) <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

/** Value coloring: `link` → aqua, `key` → yellow, `text` → unstyled. */
function colorValue(kind: OutputKind, value: string): string {
  switch (kind) {
    case "link":
      return aqua(value, process.stdout);
    case "key":
      return yellow(value, process.stdout);
    case "text":
      return value;
  }
}

interface ColumnLayout {
  readonly col0Padded: number;
  readonly col1Padded: number;
  readonly targetInner: number;
}

/**
 * Computes the padded column widths and total inner (header) width for a group: each column
 * is sized from its widest content cell (col 0 capped at 16), then both columns widen evenly
 * if the header text is wider than the data-driven layout. Exported only for direct unit
 * coverage of that header-widens-the-table branch — no real group title is wider than its
 * data today.
 */
export function statusColumnLayout(
  headerWidthValue: number,
  col0Contents: ReadonlyArray<string>,
  col1Contents: ReadonlyArray<string>,
): ColumnLayout {
  const col0Content = Math.min(
    COLUMN_0_MAX_WIDTH,
    Math.max(...col0Contents.map((text) => displayWidth(text))),
  );
  const col1Content = Math.max(...col1Contents.map((text) => displayWidth(text)));

  let col0Padded = col0Content + 2;
  let col1Padded = col1Content + 2;
  const dataInner = col0Padded + 1 + col1Padded;
  const targetInner = Math.max(dataInner, headerWidthValue + 2);
  const extra = targetInner - dataInner;
  if (extra > 0) {
    col0Padded += Math.ceil(extra / 2);
    col1Padded += Math.floor(extra / 2);
  }
  return { col0Padded, col1Padded, targetInner };
}

function renderGroupTable(group: OutputGroup): string | undefined {
  const rows = group.items.filter((item) => item.value.length > 0);
  if (rows.length === 0) return undefined;

  // Column 0 wraps at 16; column 1 is never capped. Kept as plain text here — color is
  // applied only after padding, below, so an ANSI escape is never counted toward the padded
  // display width.
  const wrappedRows = rows.map((row) => ({
    lines: wrapStatusLabel(row.label, COLUMN_0_MAX_WIDTH),
    kind: row.kind,
    value: row.value,
  }));

  const { col0Padded, col1Padded, targetInner } = statusColumnLayout(
    statusHeaderWidth(group.name),
    rows.map((row) => row.label),
    rows.map((row) => row.value),
  );
  const col0Width = col0Padded - 2;
  const col1Width = col1Padded - 2;

  // Pad on the plain text first, then apply color/bold — an active ANSI escape
  // must never be counted toward the padded display width.
  const pad = (text: string, width: number) =>
    text + " ".repeat(Math.max(0, width - displayWidth(text)));
  // The header uses `statusHeaderWidth` (the hardcoded emoji-aware width table) rather than
  // `displayWidth`, so its padding matches the border math above, sized off the same call.
  const padHeader = (text: string, width: number) =>
    text + " ".repeat(Math.max(0, width - statusHeaderWidth(text)));

  const lines: string[] = [];
  lines.push(`╭${"─".repeat(col0Padded + 1 + col1Padded)}╮`);
  lines.push(`│ ${bold(padHeader(group.name, targetInner - 2), process.stdout)} │`);
  lines.push(`├${"─".repeat(col0Padded)}┬${"─".repeat(col1Padded)}┤`);
  for (const row of wrappedRows) {
    row.lines.forEach((line, index) => {
      // Only the first wrapped line carries the value; continuation lines (from a >16-char
      // label wrapping) leave column 1 blank.
      const labelCell = green(pad(line, col0Width), process.stdout);
      const paddedValue = pad(index === 0 ? row.value : "", col1Width);
      const valueCell = index === 0 ? colorValue(row.kind, paddedValue) : paddedValue;
      lines.push(`│ ${labelCell} │ ${valueCell} │`);
    });
  }
  lines.push(`╰${"─".repeat(col0Padded)}┴${"─".repeat(col1Padded)}╯`);
  return lines.join("\n");
}

/**
 * Renders the 5 fixed groups as rounded-border tables, skipping empty rows and empty
 * groups, with a blank line after every group whether or not it rendered.
 */
export function renderStatusPretty(
  values: Readonly<Record<string, string>>,
  names: StatusOutputNames,
): string {
  const groups = buildGroups(values, names);
  const lines: string[] = [];
  for (const group of groups) {
    const table = renderGroupTable(group);
    if (table !== undefined) {
      lines.push(table);
    }
    lines.push("");
  }
  return lines.join("\n");
}
