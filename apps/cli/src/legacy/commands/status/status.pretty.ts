import { legacyAqua, legacyBold, legacyGreen, legacyYellow } from "../../shared/legacy-colors.ts";
import type { LegacyStatusOutputNames } from "./status.values.ts";

/**
 * Port of Go's `PrettyPrint` / `OutputGroup.printTable`
 * (`apps/cli-go/internal/status/status.go:236-392`), reproducing
 * `tablewriter.NewTable` with `tw.StyleRounded` byte-for-byte for the fixed
 * 5-group, 2-column layout `status` needs. This is not a general tablewriter
 * port — column sizing, wrapping, and merge behavior are only implemented to the
 * extent this command's rounded box needs them.
 *
 * Column 0 (the label column) is capped at 16 display columns
 * (`ColMaxWidths.PerColumn[0] = 16`, `status.go:344`); a label wider than that
 * word-wraps across multiple lines, leaving column 1 blank on the continuation
 * lines (verified against a real `tablewriter@v1.1.4` render — see the port
 * plan). None of the fixed labels below reach 17 characters today, so this is
 * defensive parity rather than an observed case.
 *
 * This does not reuse `legacy/output/legacy-glamour-table.ts` — that helper
 * byte-matches Go's `glamour.RenderTable(..., AsciiStyle)`, a single ASCII table
 * with a different border style used by other commands. `status`'s Go source
 * renders with `tablewriter`/`tw.StyleRounded` into 5 separate grouped, colored,
 * Unicode-rounded-box tables, which is a different rendering contract entirely.
 *
 * Every color call below styles text written to **stdout** (via `output.raw`
 * with no stream argument in `status.handler.ts`), so each one explicitly passes
 * `process.stdout` to `legacy-colors.ts`'s helpers — they default to
 * `process.stderr`, which would check the wrong stream's TTY status here.
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
 * Builds the 5 fixed groups Go's `PrettyPrint` declares (`status.go:245-285`),
 * looking up each label's value by output KEY from the resolved value map —
 * `--override-name` remaps the KEY but never the group layout, matching Go
 * (`values[names.StudioURL]`, not a hardcoded default name).
 */
function buildGroups(
  values: Readonly<Record<string, string>>,
  names: LegacyStatusOutputNames,
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
 * Display width, matching `go-runewidth`'s treatment closely enough for this
 * command's inputs: URLs/keys/labels are always plain ASCII, so every rune is
 * width 1. The only non-ASCII runes ever rendered are the 5 fixed group-title
 * emoji, whose exact rendered widths are hardcoded in {@link HEADER_DISPLAY_WIDTH}
 * below rather than computed generically (avoids taking a full Unicode
 * East-Asian-Width dependency for a 5-value constant table).
 */
function displayWidth(text: string): number {
  return [...text].length;
}

/** Go-rendered display width of each fixed group title (see `status.pretty.unit.test.ts`). */
const HEADER_DISPLAY_WIDTH: Readonly<Record<string, number>> = {
  "🔧 Development Tools": 20,
  "🌐 APIs": 7,
  "⛁ Database": 10,
  "🔑 Authentication Keys": 22,
  "📦 Storage (S3)": 15,
};

/**
 * Exported only for direct unit coverage of the fallback branch (a group title
 * outside the 5-entry {@link HEADER_DISPLAY_WIDTH} table) — every call site in
 * this file only ever passes one of those 5 fixed titles.
 */
export function legacyStatusHeaderWidth(name: string): number {
  return HEADER_DISPLAY_WIDTH[name] ?? displayWidth(name);
}

/**
 * Greedy word-wrap to `width` columns, mirroring tablewriter's column wrapping.
 * Exported only for direct unit coverage of the >16-char defensive-wrap branch
 * (see the file-level doc comment) — none of this command's real labels reach
 * that width today, so `legacyRenderStatusPretty` never exercises it end to end.
 */
export function legacyWrapStatusLabel(text: string, width: number): ReadonlyArray<string> {
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

/**
 * Value coloring, mirroring the `switch row.Type` in `printTable`
 * (`status.go:372-377`): `Link` → Aqua, `Key` → Yellow, `Text` → unstyled (the
 * switch has no `Text` case, so `value` keeps its raw pre-switch assignment).
 */
function colorValue(kind: OutputKind, value: string): string {
  switch (kind) {
    case "link":
      return legacyAqua(value, process.stdout);
    case "key":
      return legacyYellow(value, process.stdout);
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
 * Computes the padded column widths and total inner (header) width for a group,
 * mirroring tablewriter's column-sizing pass: each column is sized from its
 * widest content cell (col 0 capped at 16), then both columns widen evenly
 * (col 0 taking the larger half of an odd remainder) if the header text is
 * wider than the data-driven layout. Exported only for direct unit coverage of
 * the header-widens-the-table branch — none of this command's 5 fixed group
 * titles are wider than their data today, so `legacyRenderStatusPretty` never
 * exercises it end to end (see the file-level doc comment).
 */
export function legacyStatusColumnLayout(
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

  // Column 0 wraps at 16; column 1 is never capped (Go only sets PerColumn[0]).
  // Kept as plain text here — color is applied only after padding, below, so an
  // ANSI escape is never counted toward the padded display width.
  const wrappedRows = rows.map((row) => ({
    lines: legacyWrapStatusLabel(row.label, COLUMN_0_MAX_WIDTH),
    kind: row.kind,
    value: row.value,
  }));

  const { col0Padded, col1Padded, targetInner } = legacyStatusColumnLayout(
    legacyStatusHeaderWidth(group.name),
    rows.map((row) => row.label),
    rows.map((row) => row.value),
  );
  const col0Width = col0Padded - 2;
  const col1Width = col1Padded - 2;

  // Pad on the plain text first, then apply color/bold — an active ANSI escape
  // must never be counted toward the padded display width.
  const pad = (text: string, width: number) =>
    text + " ".repeat(Math.max(0, width - displayWidth(text)));
  // The header uses `headerWidth` (the hardcoded emoji-aware width table) rather
  // than `displayWidth`, so its padding lines up with the border math above,
  // which sized `targetInner` off the same `headerWidth` call.
  const padHeader = (text: string, width: number) =>
    text + " ".repeat(Math.max(0, width - legacyStatusHeaderWidth(text)));

  const lines: string[] = [];
  lines.push(`╭${"─".repeat(col0Padded + 1 + col1Padded)}╮`);
  lines.push(`│ ${legacyBold(padHeader(group.name, targetInner - 2), process.stdout)} │`);
  lines.push(`├${"─".repeat(col0Padded)}┬${"─".repeat(col1Padded)}┤`);
  for (const row of wrappedRows) {
    row.lines.forEach((line, index) => {
      // Only the first wrapped line carries the value; Go's continuation lines
      // (from a >16-char label wrapping) leave column 1 blank.
      const labelCell = legacyGreen(pad(line, col0Width), process.stdout);
      const paddedValue = pad(index === 0 ? row.value : "", col1Width);
      const valueCell = index === 0 ? colorValue(row.kind, paddedValue) : paddedValue;
      lines.push(`│ ${labelCell} │ ${valueCell} │`);
    });
  }
  lines.push(`╰${"─".repeat(col0Padded)}┴${"─".repeat(col1Padded)}╯`);
  return lines.join("\n");
}

/**
 * Port of Go's `PrettyPrint` (`status.go:236-294`): renders the 5 fixed groups
 * as rounded-border tables, skipping empty rows and empty groups, with a blank
 * line after every group (rendered or not — Go's loop always
 * `fmt.Fprintln(w)`s after a nil-error `printTable`, even when nothing rendered).
 */
export function legacyRenderStatusPretty(
  values: Readonly<Record<string, string>>,
  names: LegacyStatusOutputNames,
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
