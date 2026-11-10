import { escapeControlCharacters } from "../../../shared/output/escape-control-characters.ts";
import {
  cliConfigLineKeys,
  cliConfigValueSpans,
  type CliConfigLocation,
} from "@supabase/config/internal";

import { displayPath, isPublicValuePath, type ConfigProblem } from "./validate.model.ts";

/** ANSI styling applied to the text report; the handler passes stream-gated colours. */
export interface ReportStyle {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly red: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly code: (text: string) => string;
}

const plain = (text: string) => text;

export const PLAIN_REPORT_STYLE: ReportStyle = {
  bold: plain,
  dim: plain,
  green: plain,
  red: plain,
  yellow: plain,
  code: plain,
};

export type StopStage = "syntax" | "schema_version" | "file_conflict" | "env_file" | "removed_env";

const STOP_LABELS: Readonly<Record<StopStage, string>> = {
  syntax: "the syntax check",
  schema_version: "the schema version check",
  file_conflict: "the config file check",
  env_file: "loading the env files",
  removed_env: "resolving the environment variables",
};

const PAYLOAD_VERSION = 1;

export interface ValidateReport {
  readonly file: string;
  readonly format: "toml" | "json" | "jsonc";
  readonly source: string;
  readonly remotes: ReadonlyArray<string>;
  readonly skippedRemotes: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  readonly problems: ReadonlyArray<ConfigProblem>;
  readonly stoppedAt?: StopStage;
}

const MASK = "****";
const MAX_FRAME_WIDTH = 100;
const CARET_LEAD = 30;
const MAX_VALUE_LINES = 4;

const errorsOf = (report: ValidateReport) =>
  sortedByLocation(report.problems.filter((problem) => problem.severity === "error"));
const warningsOf = (report: ValidateReport) =>
  sortedByLocation(report.problems.filter((problem) => problem.severity === "warning"));

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function validateSummaryMessage(report: ValidateReport): string {
  const errors = errorsOf(report).length;
  return errors === 0
    ? `${report.file} is valid`
    : `${report.file} has ${plural(errors, "problem")}`;
}

const safe = escapeControlCharacters;

const display = (text: string): string =>
  [...text]
    .map((character) => {
      if (character === "\t") return "  ";
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "·" : character;
    })
    .join("");

interface Span {
  readonly column: number;
  readonly endColumn?: number;
}

const KEY_VALUE =
  /^(\s*(?:(?:#|\/\/)\s*)?(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*\s*[=:]\s*)(.*)$/;
const ENV_REFERENCE_VALUE = /^["']env\([A-Za-z_][A-Za-z0-9_]*\)["']\s*,?\s*$/;
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/([^\s/?#"']*)@/gi;
const URL_QUERY = /[a-z][a-z0-9+.-]*:\/\/[^\s"'?#]*\?([^\s"'#]*)/gi;
const TRAILING_COMMENT = /^[\s,}\]]*(#|\/\/)/;

interface MaskedLine {
  readonly text: string;
  readonly map: (index: number) => number;
}

function maskLine(text: string, spans: ReadonlyArray<Span>): MaskedLine {
  const ranges = spans
    .map((span) => ({
      start: Math.min(span.column - 1, text.length),
      end: span.endColumn === undefined ? text.length : Math.min(span.endColumn - 1, text.length),
    }))
    .sort((left, right) => left.start - right.start);
  let out = "";
  let position = 0;
  const applied: Array<{ start: number; end: number; outStart: number }> = [];
  for (const range of ranges) {
    if (range.end <= position) continue;
    const start = Math.max(range.start, position);
    out += text.slice(position, start);
    applied.push({ start, end: range.end, outStart: out.length });
    out += MASK;
    position = range.end;
  }
  out += text.slice(position);
  return {
    text: out,
    map: (index) => {
      let shift = 0;
      for (const range of applied) {
        if (index < range.start) break;
        if (index < range.end) return range.outStart;
        shift += MASK.length - (range.end - range.start);
      }
      return index + shift;
    },
  };
}

/** The credentials and query string of every URL in `text` from `from` to `to` (1-based, `to` exclusive). */
function urlSpans(text: string, from: number, to: number): ReadonlyArray<Span> {
  const slice = text.slice(from - 1, to - 1);
  const spans: Array<Span> = [];
  for (const match of slice.matchAll(URL_USERINFO)) {
    const userinfo = match[1] ?? "";
    const start = from + match.index + match[0].length - 1 - userinfo.length;
    if (userinfo.length > 0) spans.push({ column: start, endColumn: start + userinfo.length });
  }
  for (const match of slice.matchAll(URL_QUERY)) {
    const query = match[1] ?? "";
    const start = from + match.index + match[0].length - query.length;
    if (query.length > 0) spans.push({ column: start, endColumn: start + query.length });
  }
  return spans;
}

/** A scalar or a flat array of scalars; a table, or anything nested, may hold values the problem is not about. */
function isShowable(lines: ReadonlyArray<string>, location: CliConfigLocation): boolean {
  const first = lines[location.line - 1] ?? "";
  const last = location.endLine ?? location.line;
  const text =
    last === location.line
      ? first.slice(location.column - 1, (location.endColumn ?? first.length + 1) - 1)
      : [
          first.slice(location.column - 1),
          ...lines.slice(location.line, last - 1),
          (lines[last - 1] ?? "").slice(0, (location.endColumn ?? 1) - 1),
        ].join("\n");
  const head = text.trimStart()[0];
  if (head === "{") return false;
  if (head !== "[") return true;
  let quote: string | undefined;
  for (let index = text.indexOf("[") + 1; index < text.length; index++) {
    const character = text[index];
    if (quote !== undefined) {
      if (character === "\\" && quote === '"') index++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "{" || character === "[") return false;
  }
  return true;
}

const isBefore = (line: number, column: number, otherLine: number, otherColumn: number) =>
  line < otherLine || (line === otherLine && column < otherColumn);

const isWithin = (value: CliConfigLocation, shown: CliConfigLocation): boolean =>
  !isBefore(value.line, value.column, shown.line, shown.column) &&
  !isBefore(
    shown.endLine ?? shown.line,
    shown.endColumn ?? shown.column,
    value.endLine ?? value.line,
    value.endColumn ?? value.column,
  );

/**
 * A source line with every value masked, whichever lines it spans, except the values inside
 * `shown`. Lines of text that cannot be parsed are masked in full.
 */
function maskedAt(
  { lines, valuesByLine }: SourceView,
  lineNumber: number,
  shown?: CliConfigLocation,
): MaskedLine {
  const text = lines[lineNumber - 1] ?? "";
  const indent = text.length - text.trimStart().length;
  if (text.trim() === "") return maskLine(text, []);
  if (valuesByLine === undefined) return maskLine(text, [{ column: indent + 1 }]);

  const spans: Array<Span> = [];
  const redactions: Array<Span> = [];
  for (const value of valuesByLine.get(lineNumber) ?? []) {
    const startsHere = value.line === lineNumber;
    const endsHere = (value.endLine ?? value.line) === lineNumber;
    const column = startsHere ? value.column : indent + 1;
    const endColumn = endsHere ? value.endColumn : undefined;
    if (shown !== undefined && isWithin(value, shown)) {
      redactions.push(...urlSpans(text, column, endColumn ?? text.length + 1));
      continue;
    }
    if (
      startsHere &&
      endsHere &&
      ENV_REFERENCE_VALUE.test(text.slice(column - 1, (endColumn ?? text.length + 1) - 1))
    ) {
      continue;
    }
    spans.push(endColumn === undefined ? { column } : { column, endColumn });
  }
  if (spans.length === 0) {
    const pair = /^\s*(?:#|\/\/)/.test(text) ? KEY_VALUE.exec(text) : null;
    return maskLine(text, [
      ...redactions,
      ...(pair?.[1] === undefined ? [] : [{ column: pair[1].length + 1 }]),
    ]);
  }
  const lastEnd = Math.max(...spans.map((span) => span.endColumn ?? text.length + 1)) - 1;
  const comment = TRAILING_COMMENT.exec(text.slice(lastEnd));
  if (comment !== null) {
    spans.push({ column: lastEnd + comment[0].length - comment[1]!.length + 1 });
  }
  return maskLine(text, [...spans, ...redactions]);
}

function windowAround(text: string, caretOffset: number): { text: string; caretOffset: number } {
  if (text.length <= MAX_FRAME_WIDTH) return { text, caretOffset };
  const from = Math.max(0, caretOffset - CARET_LEAD);
  const slice = text.slice(from, from + MAX_FRAME_WIDTH);
  const head = from > 0 ? "…" : "";
  const tail = from + MAX_FRAME_WIDTH < text.length ? "…" : "";
  return { text: `${head}${slice}${tail}`, caretOffset: caretOffset - from + head.length };
}

interface SourceView {
  readonly lines: ReadonlyArray<string>;
  /** 1-based lines holding a single non-secret schema leaf, whose value context lines may show. */
  readonly publicLines: ReadonlySet<number>;
  /** The value spans touching each 1-based line; undefined when the source cannot be parsed. */
  readonly valuesByLine: ReadonlyMap<number, ReadonlyArray<CliConfigLocation>> | undefined;
}

function sourceView(report: ValidateReport): SourceView {
  const lines = report.source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const publicLines = new Set<number>();
  for (const [line, path] of cliConfigLineKeys(
    report.source,
    report.format === "toml" ? "toml" : "json",
  )) {
    if (isPublicValuePath(path)) publicLines.add(line);
  }
  const values = cliConfigValueSpans(report.source, report.format === "toml" ? "toml" : "json");
  if (values === undefined) return { lines, publicLines, valuesByLine: undefined };
  const valuesByLine = new Map<number, Array<CliConfigLocation>>();
  for (const value of values) {
    for (let line = value.line; line <= (value.endLine ?? value.line); line++) {
      valuesByLine.set(line, [...(valuesByLine.get(line) ?? []), value]);
    }
  }
  return { lines, publicLines, valuesByLine };
}

function frameLines(
  problem: ConfigProblem,
  view: SourceView,
  style: ReportStyle,
): ReadonlyArray<string> {
  const { lines, publicLines } = view;
  const location = problem.location;
  const first = location === undefined ? undefined : lines[location.line - 1];
  if (location === undefined || first === undefined) return [];

  const lastLine = Math.min(
    location.endLine ?? location.line,
    location.line + MAX_VALUE_LINES - 1,
    lines.length,
  );
  const width = String(lastLine).length;
  const gutter = (label: string) => `${label.padStart(width)} │`;
  const out: Array<string> = [];

  if (location.line > 1) {
    const previous = lines[location.line - 2] ?? "";
    const before = publicLines.has(location.line - 1)
      ? maskLine(previous, urlSpans(previous, 1, previous.length + 1)).text
      : maskedAt(view, location.line - 1).text;
    const shown = display(before).trimEnd();
    const clipped = shown.length > MAX_FRAME_WIDTH ? `${shown.slice(0, MAX_FRAME_WIDTH)}…` : shown;
    out.push(
      `    ${style.dim(`${gutter(String(location.line - 1))}${clipped === "" ? "" : " "}${clipped}`)}`,
    );
  }

  const shown =
    problem.showValue && location.exact && isShowable(lines, location) ? location : undefined;
  const current = maskedAt(view, location.line, shown);
  const start = current.map(location.column - 1);
  const singleLine = location.endLine === undefined || location.endLine === location.line;
  const end =
    singleLine && location.endColumn !== undefined
      ? current.map(location.endColumn - 1)
      : singleLine
        ? start + 1
        : current.text.length;
  const caretOffset = display(current.text.slice(0, start)).length;
  const windowed = windowAround(display(current.text).trimEnd(), caretOffset);
  const visible =
    windowed.text.length - windowed.caretOffset - (windowed.text.endsWith("…") ? 1 : 0);
  const caretLength = Math.max(
    1,
    Math.min(display(current.text.slice(start, end)).length, visible),
  );
  out.push(`  ${style.red(">")} ${style.dim(gutter(String(location.line)))} ${windowed.text}`);
  out.push(
    `    ${style.dim(gutter(""))} ${" ".repeat(windowed.caretOffset)}${style.red("^".repeat(caretLength))}`,
  );
  for (let line = location.line + 1; line <= lastLine; line++) {
    const text = display(maskedAt(view, line, shown).text).trimEnd();
    const clipped = text.length > MAX_FRAME_WIDTH ? `${text.slice(0, MAX_FRAME_WIDTH)}…` : text;
    out.push(`  ${style.red(">")} ${style.dim(gutter(String(line)))} ${clipped}`);
  }
  return out;
}

const locationLabel = (report: ValidateReport, problem: ConfigProblem): string | undefined =>
  problem.location === undefined
    ? undefined
    : `${safe(report.file)}:${problem.location.line}:${problem.location.column}`;

function sortedByLocation(problems: ReadonlyArray<ConfigProblem>): ReadonlyArray<ConfigProblem> {
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort((left, right) => {
      const a = left.problem.location;
      const b = right.problem.location;
      if (a === undefined || b === undefined) {
        return a === b ? left.index - right.index : a === undefined ? 1 : -1;
      }
      return a.line - b.line || a.column - b.column || left.index - right.index;
    })
    .map(({ problem }) => problem);
}

function renderProblem(
  report: ValidateReport,
  problem: ConfigProblem,
  source: SourceView,
  style: ReportStyle,
): ReadonlyArray<string> {
  const glyph = problem.severity === "error" ? style.red("✗") : style.yellow("⚠");
  const subject = safe(
    problem.path === undefined ? (problem.subject ?? report.file) : displayPath(problem.path),
  );
  const remote =
    problem.remote === undefined ? "" : `  ${style.dim(`[remote: ${safe(problem.remote)}]`)}`;
  const out = [`  ${glyph} ${style.bold(subject)}  ${safe(problem.reason)}${remote}`];
  const label = locationLabel(report, problem);
  if (label !== undefined) {
    out.push(`    ${style.dim(label)}`, ...frameLines(problem, source, style));
  }
  if (problem.help !== undefined) {
    out.push(`    ${style.green("help:")} ${safe(problem.help)}`);
  }
  return out;
}

const countsLabel = (errors: number, warnings: number): string =>
  [
    ...(errors > 0 ? [plural(errors, "error")] : []),
    ...(warnings > 0 ? [plural(warnings, "warning")] : []),
  ].join(", ");

/** Renders the text report: every problem in file order as one shape, then a total. */
export function validateReport(
  report: ValidateReport,
  style: ReportStyle = PLAIN_REPORT_STYLE,
): string {
  const errors = errorsOf(report);
  const warnings = warningsOf(report);
  const source = sourceView(report);
  const file = safe(report.file);
  const out: Array<string> = [];

  for (const problem of sortedByLocation(report.problems)) {
    out.push(...renderProblem(report, problem, source, style), "");
  }

  if (errors.length === 0) {
    const suffix = warnings.length === 0 ? "" : ` · ${plural(warnings.length, "warning")}`;
    out.push(`${style.green("✓")} ${style.bold(`${file} is valid`)}${suffix}`);
  } else {
    out.push(
      `${style.red("✗")} ${style.bold(`${countsLabel(errors.length, warnings.length)} in ${file}`)}`,
    );
  }
  if (report.remotes.length > 0) {
    out.push(`  ${style.dim(`Checked remotes: ${report.remotes.map(safe).join(", ")}`)}`);
  }
  if (report.skippedRemotes.length > 0) {
    const skipped = report.skippedRemotes.map(
      ({ name, reason }) => `${safe(name)} (${safe(reason)})`,
    );
    out.push(`  ${style.dim(`Skipped remotes: ${skipped.join(", ")}`)}`);
  }
  if (report.stoppedAt !== undefined) {
    out.push(
      "",
      `  Stopped after ${STOP_LABELS[report.stoppedAt]}. Fix ${errors.length === 1 ? "this" : "these"} and run ${style.code("supabase config validate")} again to check the rest.`,
    );
  }
  out.push("");
  return out.join("\n");
}

function payloadProblem(problem: ConfigProblem) {
  const path = problem.path === undefined ? undefined : displayPath(problem.path);
  const key =
    path === undefined
      ? undefined
      : problem.remote === undefined
        ? path
        : `remotes.${problem.remote}.${path}`;
  const { location } = problem;
  return {
    code: problem.code,
    severity: problem.severity,
    ...(key === undefined ? {} : { key, path }),
    ...(problem.remote === undefined ? {} : { remote: problem.remote }),
    ...(problem.subject === undefined ? {} : { file: problem.subject }),
    reason: problem.reason,
    ...(problem.help === undefined ? {} : { help: problem.help }),
    ...(location === undefined ? {} : { line: location.line, column: location.column }),
    ...(location?.endLine === undefined ? {} : { end_line: location.endLine }),
    ...(location?.endColumn === undefined ? {} : { end_column: location.endColumn }),
  };
}

/** The JSON-mode payload; it carries key paths and positions, never source text or values. */
export function validateJsonPayload(report: ValidateReport) {
  const errors = errorsOf(report);
  return {
    schema_version: PAYLOAD_VERSION,
    valid: errors.length === 0,
    complete: report.stoppedAt === undefined,
    ...(report.stoppedAt === undefined ? {} : { stopped_at: report.stoppedAt }),
    file: report.file,
    format: report.format,
    remotes: report.remotes,
    ...(report.skippedRemotes.length === 0 ? {} : { skipped_remotes: report.skippedRemotes }),
    errors: errors.map(payloadProblem),
    warnings: warningsOf(report).map(payloadProblem),
  };
}
