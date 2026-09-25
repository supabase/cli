/**
 * The report document model for `inspect` command output.
 *
 * A command produces a `Report` — a structured document — and per-format
 * renderers turn it into terminal text or a JSON payload. The document is the
 * single source of truth, so text and JSON mode finally describe the same
 * thing, severities included.
 *
 * Design doc: apps/cli/docs/inspect-report-output.md (Part 2, Option 2).
 */

export type ReportSeverity = "info" | "ok" | "warn" | "critical";

/** Aligned label/value pairs, e.g. the environment header of a diagnostic. */
interface ReportKeyValueBlock {
  readonly kind: "keyValue";
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

/** A table; the one block type the pre-report commands could express. */
export interface ReportTableBlock {
  readonly kind: "table";
  readonly columns: ReadonlyArray<{ readonly title: string }>;
  readonly rows: ReadonlyArray<{
    readonly cells: ReadonlyArray<string>;
    readonly severity?: ReportSeverity;
  }>;
}

/** A short highlighted message: the empty state, a warning, a success line. */
interface ReportCalloutBlock {
  readonly kind: "callout";
  readonly severity: ReportSeverity;
  readonly text: string;
}

/** Copy-pasteable SQL, rendered indented under a title. */
interface ReportSqlBlock {
  readonly kind: "sql";
  readonly title: string;
  readonly statements: ReadonlyArray<string>;
}

/** An ordered remediation workflow; each step may carry its own SQL. */
export interface ReportStepsBlock {
  readonly kind: "steps";
  readonly steps: ReadonlyArray<{
    readonly title: string;
    readonly body?: string;
    readonly sql?: ReadonlyArray<string>;
  }>;
}

export type ReportBlock =
  | ReportKeyValueBlock
  | ReportTableBlock
  | ReportCalloutBlock
  | ReportSqlBlock
  | ReportStepsBlock;

export interface Report {
  /** The producing subcommand, e.g. "collation-drift". */
  readonly command: string;
  /** Overall status of what the report found. */
  readonly severity: ReportSeverity;
  readonly blocks: ReadonlyArray<ReportBlock>;
}
