import { Effect } from "effect";
import { SchemaPlanningBlockedError } from "./schema-errors.ts";
import type { SchemaPlanView } from "./schema-types.ts";
import { coverageVerbose, formatCoverageDiagnostics } from "./schema-output.ts";

export const assertPlanActionable = (plan: SchemaPlanView) => {
  if (plan.renameBlocked) {
    return Effect.fail(
      new SchemaPlanningBlockedError({
        detail: "Planning found an ambiguous rename and cannot guess.",
        suggestion:
          "Rename explicitly in declarations, accept a rename decision, or reset the local database.",
      }),
    );
  }
  if (plan.coverageBlocked) {
    const verbose = coverageVerbose();
    const named = formatCoverageDiagnostics(plan, { verbose });
    return Effect.fail(
      new SchemaPlanningBlockedError({
        detail:
          named.length > 0
            ? `Planning found a coverage gap or unmodeled object.\n${named}`
            : "Planning found a coverage gap or unmodeled object.",
        suggestion:
          named.length > 0
            ? verbose
              ? "See the engine diagnostics above."
              : "Re-run with --debug for full engine diagnostics."
            : "Move unsupported objects to _custom/ or a manual migration, then retry.",
      }),
    );
  }
  return Effect.void;
};
