import { DateTime } from "effect";
import { sanitizeInlineName } from "../../command-internal/http-errors.ts";
import { red, yellow, type ColorStream } from "../../command-internal/colors.ts";
import { stringWidth } from "../../command-internal/string-width.ts";
import {
  buildSpanTree,
  flattenSpanTree,
  summarizeTrace,
  type TraceSpanRecord,
} from "./traces.tree.ts";

const DEFAULT_TERMINAL_WIDTH = 80;
const SHORT_ID_LENGTH = 8;

export function shortenTraceId(id: string): string {
  return id.length <= SHORT_ID_LENGTH ? id : id.slice(0, SHORT_ID_LENGTH);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function formatOffset(ms: number): string {
  return `+${formatDuration(ms)}`;
}

function padEnd(text: string, width: number): string {
  const pad = width - stringWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 1 || stringWidth(text) <= maxWidth) return text;
  let out = "";
  for (const ch of text) {
    if (stringWidth(out + ch) > maxWidth - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function treePrefix(
  isLastChild: boolean,
  ancestorHasMoreSiblings: ReadonlyArray<boolean>,
  glyphs: boolean,
): string {
  if (ancestorHasMoreSiblings.length === 0) return "";
  if (!glyphs) return "  ".repeat(ancestorHasMoreSiblings.length);
  const continuation = ancestorHasMoreSiblings.map((hasMore) => (hasMore ? "│  " : "   ")).join("");
  return `${continuation}${isLastChild ? "└─ " : "├─ "}`;
}

export interface TraceRenderInput {
  readonly traceId: string;
  readonly spans: ReadonlyArray<{
    readonly spanId: string;
    readonly parentSpanId: string | undefined;
    readonly name: string;
    readonly serviceName: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly isError: boolean;
  }>;
}

export interface RenderTraceOptions {
  /** Color and Unicode tree glyphs; plain ASCII with no truncation otherwise. */
  readonly fancy: boolean;
  readonly terminalWidth?: number;
  readonly colorStream?: ColorStream;
}

/** Renders the trace summary line, span tree, and (when present) the first-error closing line. */
export function renderTrace(input: TraceRenderInput, options: RenderTraceOptions): string {
  const records: ReadonlyArray<TraceSpanRecord> = input.spans.map((s) => ({
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    label: `${sanitizeInlineName(s.name)} (${sanitizeInlineName(s.serviceName)})`,
    startMs: s.startMs,
    endMs: s.endMs,
    isError: s.isError,
  }));
  const flattened = flattenSpanTree(buildSpanTree(records));
  const summary = summarizeTrace(flattened);

  const summaryLine =
    `Trace ${shortenTraceId(input.traceId)} — ${formatDuration(summary.durationMs)}, ` +
    `${summary.spanCount} span${summary.spanCount === 1 ? "" : "s"}, ` +
    `${summary.errorSpanIds.length} error${summary.errorSpanIds.length === 1 ? "" : "s"}, ` +
    `started ${DateTime.formatIso(DateTime.makeUnsafe(summary.startMs))}`;

  if (flattened.length === 0) {
    return `${summaryLine}\n`;
  }

  const spanCells = flattened.map(({ span, depth, isLastChild, ancestorHasMoreSiblings }) => {
    const prefix = treePrefix(isLastChild, ancestorHasMoreSiblings, options.fancy);
    const marker =
      span.spanId === summary.slowestNonRootSpanId ? (options.fancy ? " ⏱" : " [slowest]") : "";
    const errorMarker = span.isError ? (options.fancy ? " ✗" : " [error]") : "";
    return { prefix, label: span.label, marker: `${marker}${errorMarker}`, depth };
  });

  const terminalWidth = options.terminalWidth ?? DEFAULT_TERMINAL_WIDTH;
  const startWidth = Math.max(
    5,
    ...flattened.map((f) => stringWidth(formatOffset(f.span.startMs - summary.startMs))),
  );
  const durationWidth = Math.max(
    8,
    ...flattened.map((f) => stringWidth(formatDuration(f.span.endMs - f.span.startMs))),
  );
  const idWidth = SHORT_ID_LENGTH;
  const fixedWidth = startWidth + 2 + durationWidth + 2 + idWidth;
  const spanWidth = options.fancy
    ? Math.max(12, terminalWidth - fixedWidth - 2)
    : Math.max(...spanCells.map((c) => stringWidth(c.prefix + c.label + c.marker)), "SPAN".length);

  const header = `${padEnd("SPAN", spanWidth)}  ${padEnd("START", startWidth)}  ${padEnd("DURATION", durationWidth)}  ID`;

  const rows = flattened.map((entry, index) => {
    const cell = spanCells[index]!;
    const rawSpanText = `${cell.prefix}${cell.label}${cell.marker}`;
    const spanText = options.fancy ? truncate(rawSpanText, spanWidth) : rawSpanText;
    const start = formatOffset(entry.span.startMs - summary.startMs);
    const duration = formatDuration(entry.span.endMs - entry.span.startMs);
    const id = shortenTraceId(entry.span.spanId);
    const line = `${padEnd(spanText, spanWidth)}  ${padEnd(start, startWidth)}  ${padEnd(duration, durationWidth)}  ${id}`;
    if (!options.fancy) return line;
    const colorStream = options.colorStream ?? process.stdout;
    if (entry.span.isError) return red(line, colorStream);
    if (entry.span.spanId === summary.slowestNonRootSpanId) return yellow(line, colorStream);
    return line;
  });

  const closingLine =
    summary.errorSpanIds.length > 0
      ? `\nTrace has errors. First error span: ${shortenTraceId(summary.errorSpanIds[0]!)}\n`
      : "";

  return `${summaryLine}\n\n${header}\n${rows.join("\n")}\n${closingLine}`;
}
