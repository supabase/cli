import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { formatCoverageDiagnostics } from "./schema-output.ts";
import type { SchemaPlanView } from "./schema-types.ts";

function view(diagnostics: SchemaPlanView["diagnostics"]): SchemaPlanView {
  const plan = {
    formatVersion: 1,
    engineVersion: "0.3.0",
    planId: "plan-1",
    source: { fingerprint: "source-fingerprint" },
    target: { fingerprint: "desired-fingerprint" },
    preamble: [],
    deltas: [],
    filteredDeltas: [],
    renameCandidates: [],
    actions: [],
    safetyReport: {
      destructiveActions: 0,
      rewriteRiskActions: 0,
      nonTransactionalActions: 0,
      lockClasses: {},
    },
  } satisfies Plan;
  return {
    planId: plan.planId,
    sourceFingerprint: plan.source.fingerprint,
    desiredFingerprint: plan.target.fingerprint,
    engineVersion: plan.engineVersion,
    profile: "supabase",
    changes: false,
    files: [],
    hazards: {
      kinds: [],
      destructive: 0,
      rewrite: 0,
      coverageGaps: diagnostics.length,
      report: classifyPlanHazards(plan),
    },
    destructive: false,
    renameCandidates: [],
    acceptedRenames: [],
    coverageBlocked: diagnostics.length > 0,
    renameBlocked: false,
    diagnostics,
    plan,
  };
}

describe("formatCoverageDiagnostics", () => {
  it("shortens to kind and samples and caps the default list", () => {
    const diagnostics = ["cast", "operator", "collation", "language"].map((kind) => ({
      code: "unmodeled_kind",
      severity: "warning" as const,
      message: `1 unmodeled "${kind}" object — v1 detects but does not model this kind`,
      context: { kind, count: 1, samples: [kind] },
    }));
    expect(formatCoverageDiagnostics(view(diagnostics), { verbose: false })).toBe(
      [
        "1 unmodeled cast (cast)",
        "1 unmodeled operator (operator)",
        "1 unmodeled collation (collation)",
        "1 more. Re-run with --debug for full diagnostics.",
      ].join("\n"),
    );
  });
});
