import { describe, expect, it } from "@effect/vitest";
import { classifyPlanHazards, type Plan } from "@supabase/pg-delta/plan";
import { formatCoverageDiagnostics, formatPlanSummary } from "./schema-output.ts";
import type { SchemaPlanView } from "./schema-types.ts";

const dummyAction: Plan["actions"][number] = {
  sql: "create table t (id int)",
  verb: "create",
  produces: [],
  consumes: [],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "none",
  newSegmentBefore: false,
  dataLoss: "none",
  rewriteRisk: false,
};

function view(
  diagnostics: SchemaPlanView["diagnostics"],
  opts: {
    readonly actions?: Plan["actions"];
    readonly rewrite?: number;
    readonly destructive?: number;
  } = {},
): SchemaPlanView {
  const actions = opts.actions ?? [];
  const plan = {
    formatVersion: 1,
    engineVersion: "0.3.0",
    planId: "2727ec28b32ec7af6ab",
    source: { fingerprint: "38e478bcsource" },
    target: { fingerprint: "f9f5e272desired" },
    preamble: [],
    deltas: [],
    filteredDeltas: [],
    renameCandidates: [],
    actions,
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
      destructive: opts.destructive ?? 0,
      rewrite: opts.rewrite ?? 0,
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

describe("formatPlanSummary", () => {
  it("omits hashes, hazards, and a statements line on a clean empty plan", () => {
    expect(formatPlanSummary({ plan: view([]), verbose: false })).toBe("");
  });

  it("prints a statements count without a hazards line when all hazard counts are zero", () => {
    const text = formatPlanSummary({
      plan: view([], { actions: [dummyAction, dummyAction, dummyAction, dummyAction] }),
      verbose: false,
    });
    expect(text).toBe("4 statements");
    expect(text).not.toContain("Hazards:");
    expect(text).not.toContain("2727ec28");
  });

  it("appends coverage diagnostics when coverageGaps is non-zero", () => {
    const text = formatPlanSummary({
      plan: view([
        {
          code: "unmodeled_kind",
          severity: "warning",
          message: '1 unmodeled "cast" object — v1 detects but does not model this kind',
          context: { kind: "cast", count: 1, samples: ["public.widget AS integer"] },
        },
      ]),
      verbose: false,
    });
    expect(text).toContain("Hazards: 0 rewrite, 0 destructive, 1 coverage gaps");
    expect(text).toContain("1 unmodeled cast (public.widget AS integer)");
    expect(text).not.toContain("2727ec28");
  });

  it("prints plan id and fingerprints only when verbose", () => {
    const text = formatPlanSummary({
      plan: view([], { actions: [dummyAction] }),
      verbose: true,
    });
    expect(text).toContain("1 statement");
    expect(text).toContain("Plan: 2727ec28b32ec7af6ab");
    expect(text).toContain("38e478bc -> f9f5e272");
  });
});
