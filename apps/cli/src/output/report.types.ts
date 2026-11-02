/** Structured `inspect` output, rendered as text or emitted as JSON. */

export type ReportSeverity = "info" | "ok" | "warn" | "critical";

/** Aligned label/value pairs, e.g. the environment header of a diagnostic. */
interface ReportKeyValueBlock {
  readonly kind: "keyValue";
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

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
  | ReportStepsBlock;

export interface Report {
  /** The producing subcommand, e.g. "collation-drift". */
  readonly command: string;
  /** Overall status of what the report found. */
  readonly severity: ReportSeverity;
  readonly blocks: ReadonlyArray<ReportBlock>;
}
