import { Effect } from "effect";
import { hasBlockingDiagnostics, STRICT_COVERAGE_CODES } from "@supabase/pg-delta/frontends";

import { Output } from "../../../shared/output/output.service.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { PgDeltaEngineError } from "./pgdelta-engine.service.ts";
import type {
  PgDeltaNextDiagnostic,
  PgDeltaNextOperation,
} from "./pgdelta-next-adapter.service.ts";

const operationConsequence: Record<PgDeltaNextOperation, string> = {
  diff: "Changes to these objects are omitted from the generated database diff.",
  declarativeExport: "These objects are omitted from the exported declarative schema.",
  declarativePlan: "Changes to these objects are omitted from the declarative migration plan.",
  snapshotCapture: "These objects are omitted from the captured database snapshot.",
};

const operationAction: Record<PgDeltaNextOperation, string> = {
  diff: "emit the database diff",
  declarativeExport: "export the declarative schema",
  declarativePlan: "emit the declarative migration plan",
  snapshotCapture: "capture the database snapshot",
};

/**
 * Code for declarative statements pg-delta's loader couldn't model. Synthesized here
 * rather than emitted by pg-delta, so {@link isCoverageDiagnostic} layers it onto
 * `STRICT_COVERAGE_CODES` to warn by default and fail under `--strict-coverage`.
 */
export const PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE = "skipped_statement";

function isCoverageDiagnostic(diagnostic: PgDeltaNextDiagnostic): boolean {
  return (
    STRICT_COVERAGE_CODES.has(diagnostic.code) ||
    diagnostic.code === PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE
  );
}

export interface PgDeltaNextDiagnosticReport {
  readonly diagnostics: ReadonlyArray<PgDeltaNextDiagnostic>;
  readonly blocking: ReadonlyArray<PgDeltaNextDiagnostic>;
  readonly coverage: ReadonlyArray<PgDeltaNextDiagnostic>;
  readonly unmodeledKinds: ReadonlyArray<string>;
}

function diagnosticKind(diagnostic: PgDeltaNextDiagnostic): string | undefined {
  if (diagnostic.code !== "unmodeled_kind") return undefined;
  const kind = diagnostic.context?.kind;
  if (typeof kind !== "string") return undefined;
  const normalized = kind.trim().replaceAll(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

export function pgDeltaNextDiagnosticReport(
  diagnostics: readonly PgDeltaNextDiagnostic[],
  strictCoverage: boolean,
): PgDeltaNextDiagnosticReport {
  const coverage = diagnostics.filter(isCoverageDiagnostic);
  const libraryDiagnostics = diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.context !== undefined ? { context: { ...diagnostic.context } } : {}),
  }));
  // The library's own policy stays authoritative for library codes; the CLI-owned
  // skipped-statement code is OR-ed in so strict coverage blocks on it too.
  const blocking =
    hasBlockingDiagnostics(libraryDiagnostics, { strictCoverage }) ||
    (strictCoverage && coverage.length > 0)
      ? diagnostics.filter(
          (diagnostic) =>
            diagnostic.severity === "error" || (strictCoverage && isCoverageDiagnostic(diagnostic)),
        )
      : [];
  const unmodeledKinds = [
    ...new Set(diagnostics.map(diagnosticKind).filter((kind) => kind !== undefined)),
  ].sort((left, right) => left.localeCompare(right));

  return { diagnostics: [...diagnostics], blocking, coverage, unmodeledKinds };
}

export function pgDeltaNextDiagnosticMessage(diagnostic: PgDeltaNextDiagnostic): string {
  const subject =
    diagnostic.subject === undefined || diagnostic.subject === "unknown"
      ? ""
      : ` subject=${diagnostic.subject}`;
  return `pg-delta next diagnostic: origin=${diagnostic.origin} code=${diagnostic.code}${subject} message=${diagnostic.message}`;
}

function pgDeltaNextUnmodeledKindsMessage(
  operation: PgDeltaNextOperation,
  kinds: readonly string[],
  strictCoverage: boolean,
): string {
  const policy = strictCoverage
    ? "Strict coverage is enabled, so the operation will stop."
    : operationConsequence[operation];
  const summary =
    kinds.length === 0
      ? "pg-delta found schema objects it does not manage."
      : `pg-delta does not manage these PostgreSQL object kinds: ${kinds.join(", ")}.`;
  return `${summary} ${policy}`;
}

/**
 * Aggregate line for skipped declarative statements: names only the files, never the
 * statement SQL. The per-diagnostic detail carries that, rendered only under
 * `--debug`/`--strict-coverage`.
 */
function pgDeltaNextSkippedStatementsMessage(
  operation: PgDeltaNextOperation,
  skipped: readonly PgDeltaNextDiagnostic[],
  strictCoverage: boolean,
): string {
  const policy = strictCoverage
    ? "Strict coverage is enabled, so the operation will stop."
    : operationConsequence[operation];
  const files = [
    ...new Set(
      skipped
        .map((diagnostic) => diagnostic.subject)
        .filter((subject): subject is string => subject !== undefined && subject !== "unknown"),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const where = files.length === 0 ? "" : ` in ${files.join(", ")}`;
  const count =
    skipped.length === 1
      ? "1 declarative schema statement"
      : `${skipped.length} declarative schema statements`;
  return `pg-delta could not load ${count}${where}. ${policy}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function pgDeltaNextFeedbackInvitation(kinds: readonly string[]): string | undefined {
  if (kinds.length === 0) return undefined;
  const problem = `pg-delta does not manage these PostgreSQL object kinds: ${kinds.join(", ")}`;
  const solution = "Add pg-delta support for these PostgreSQL object kinds.";
  return [
    "Request pg-delta support:",
    `  supabase issue feature --problem ${shellQuote(problem)} --proposed-solution ${shellQuote(solution)}`,
  ].join("\n");
}

function pgDeltaNextBlockingDiagnosticMessage(
  operation: PgDeltaNextOperation,
  blockedByCoverage: boolean,
): string {
  const reason = blockedByCoverage
    ? "strict coverage rejected unmanaged schema objects"
    : "pg-delta reported an error";
  return `pg-delta next refused to ${operationAction[operation]}: ${reason}`;
}

/** Render actionable diagnostics, route internal detail to debug, and enforce coverage policy. */
export const reportPgDeltaNextDiagnostics = Effect.fnUntraced(function* (
  operation: PgDeltaNextOperation,
  diagnostics: readonly PgDeltaNextDiagnostic[],
  strictCoverage: boolean,
  showFeedback = true,
  verboseDiagnostics = false,
) {
  const output = yield* Output;
  const debug = yield* DebugLogger;
  const report = pgDeltaNextDiagnosticReport(diagnostics, strictCoverage);

  for (const diagnostic of report.diagnostics) {
    const message = pgDeltaNextDiagnosticMessage(diagnostic);
    const renderDetail =
      verboseDiagnostics ||
      diagnostic.severity === "error" ||
      (strictCoverage && isCoverageDiagnostic(diagnostic));
    if (!renderDetail) {
      yield* debug.debug(message);
      continue;
    }
    if (diagnostic.severity === "error") {
      yield* output.error(message);
    } else if (diagnostic.severity === "warning") {
      yield* output.warn(message);
    } else {
      yield* output.info(message);
    }
  }

  const unmodeledCount = report.diagnostics.filter(
    (diagnostic) => diagnostic.code === "unmodeled_kind",
  ).length;
  if (unmodeledCount > 0) {
    yield* output.warn(
      pgDeltaNextUnmodeledKindsMessage(operation, report.unmodeledKinds, strictCoverage),
    );
  }

  const skipped = report.diagnostics.filter(
    (diagnostic) => diagnostic.code === PG_DELTA_NEXT_SKIPPED_STATEMENT_CODE,
  );
  if (skipped.length > 0) {
    yield* output.warn(pgDeltaNextSkippedStatementsMessage(operation, skipped, strictCoverage));
  }

  const feedback = showFeedback ? pgDeltaNextFeedbackInvitation(report.unmodeledKinds) : undefined;
  if (feedback !== undefined) yield* output.info(feedback);

  if (report.blocking.length > 0) {
    return yield* Effect.fail(
      new PgDeltaEngineError({
        message: pgDeltaNextBlockingDiagnosticMessage(
          operation,
          strictCoverage && report.coverage.length > 0,
        ),
        cause: report.blocking,
      }),
    );
  }
});
