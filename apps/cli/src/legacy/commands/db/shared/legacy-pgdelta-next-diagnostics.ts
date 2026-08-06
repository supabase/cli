import type {
  LegacyPgDeltaNextDiagnostic,
  LegacyPgDeltaNextOperation,
} from "./legacy-pgdelta-next-adapter.service.ts";

const coverageDiagnosticCodes = new Set(["unmodeled_kind", "unresolved_security_label"]);

export function legacyPgDeltaNextBlockingDiagnostic(
  diagnostics: readonly LegacyPgDeltaNextDiagnostic[],
): LegacyPgDeltaNextDiagnostic | undefined {
  return diagnostics.find(
    (diagnostic) => diagnostic.severity === "error" || coverageDiagnosticCodes.has(diagnostic.code),
  );
}

export function legacyPgDeltaNextBlockingDiagnosticMessage(
  operation: LegacyPgDeltaNextOperation,
  diagnostic: LegacyPgDeltaNextDiagnostic,
): string {
  const action =
    operation === "declarativeExport"
      ? "export the declarative schema"
      : operation === "declarativePlan"
        ? "emit the declarative migration plan"
        : operation === "snapshotCapture"
          ? "capture the database snapshot"
          : "emit the database diff";
  const subject = diagnostic.subject ?? "unknown";
  return `pg-delta next refused to ${action}: origin=${diagnostic.origin} code=${diagnostic.code} subject=${subject} message=${diagnostic.message}`;
}
