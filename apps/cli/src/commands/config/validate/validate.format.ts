import { escapeControlCharacters } from "../../../shared/output/escape-control-characters.ts";

import { displayPath, type ConfigProblem } from "./validate.model.ts";

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

export type StopStage =
  | "syntax"
  | "schema_version"
  | "file_conflict"
  | "env_file"
  | "removed_env"
  | "schema_limit";

const STOP_LABELS: Readonly<Record<StopStage, string>> = {
  syntax: "the syntax check",
  schema_version: "the schema version check",
  file_conflict: "the config file check",
  env_file: "loading the env files",
  removed_env: "resolving the environment variables",
  schema_limit: "the schema check, which hit its limit on dependent failures",
};

const PAYLOAD_VERSION = 1;

export interface ValidateReport {
  readonly file: string;
  readonly format: "toml" | "json" | "jsonc";
  readonly remotes: ReadonlyArray<string>;
  readonly skippedRemotes: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  readonly problems: ReadonlyArray<ConfigProblem>;
  readonly stoppedAt?: StopStage;
}

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
    out.push(`    ${style.dim(label)}`);
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
  const file = safe(report.file);
  const out: Array<string> = [];

  for (const problem of sortedByLocation(report.problems)) {
    out.push(...renderProblem(report, problem, style), "");
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
