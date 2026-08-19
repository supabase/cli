import type { SchemaFileSummary, SchemaPlanView } from "./schema-types.ts";

export function formatPlanSummary(input: {
  readonly title: string;
  readonly source: string;
  readonly desired: string;
  readonly target: string;
  readonly plan: SchemaPlanView;
}): string {
  return [
    `${input.title}: ${input.source} -> ${input.desired}`,
    `Target: ${input.target}`,
    `Actions: ${input.plan.plan.actions.length}`,
    `Hazards: ${input.plan.hazards.rewrite} rewrite, ${input.plan.hazards.destructive} destructive, ${input.plan.hazards.coverageGaps} coverage gaps`,
    `Plan: ${input.plan.planId}`,
  ].join("\n");
}

export function formatFileSummary(summary: SchemaFileSummary): string {
  return `${summary.created.length} created, ${summary.updated.length} updated, ${summary.unchanged.length} unchanged, ${summary.removed.length} removed`;
}
