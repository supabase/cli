import { Effect } from "effect";
import { SchemaPlanningBlockedError } from "./schema-errors.ts";
import type { SchemaPlanView } from "./schema-types.ts";

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
    return Effect.fail(
      new SchemaPlanningBlockedError({
        detail: "Planning found a coverage gap or unmodeled object.",
        suggestion: "Move unsupported objects to _custom/ or a manual migration, then retry.",
      }),
    );
  }
  return Effect.void;
};
