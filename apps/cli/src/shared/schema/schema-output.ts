import { STRICT_COVERAGE_CODES } from "@supabase/pg-delta/frontends";
import { explicitBooleanLongFlag } from "../cli/cobra-flag-groups.ts";
import type { SchemaFileSummary, SchemaPlanView } from "./schema-types.ts";

export type CoverageFormatOptions = {
  readonly verbose?: boolean;
};

const DEFAULT_COVERAGE_LINES = 3;

export function coverageVerbose(opts?: CoverageFormatOptions): boolean {
  return opts?.verbose ?? explicitBooleanLongFlag(process.argv, "debug") === true;
}

function coverageDiagnostics(plan: SchemaPlanView): SchemaPlanView["diagnostics"] {
  const seen = new Set<string>();
  const unique: SchemaPlanView["diagnostics"][number][] = [];
  for (const diagnostic of plan.diagnostics) {
    if (diagnostic.severity !== "error" && !STRICT_COVERAGE_CODES.has(diagnostic.code)) continue;
    const key = `${diagnostic.code}\0${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

function stringSamples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function shortCoverageLine(diagnostic: SchemaPlanView["diagnostics"][number]): string {
  const kind = diagnostic.context?.["kind"];
  const samples = stringSamples(diagnostic.context?.["samples"]);
  const items = samples.length > 0 ? samples : stringSamples(diagnostic.context?.["missing"]);
  if (typeof kind === "string" && items.length > 0) {
    const rawCount = diagnostic.context?.["count"];
    const count = typeof rawCount === "number" ? rawCount : items.length;
    const shown = items.slice(0, 3);
    const extra = count > shown.length ? ", …" : "";
    return `${count} unmodeled ${kind} (${shown.join(", ")}${extra})`;
  }
  const sentence = diagnostic.message.split(" — ")[0];
  return sentence !== undefined && sentence.length > 0 ? sentence : diagnostic.message;
}

export function formatCoverageDiagnostics(
  plan: SchemaPlanView,
  opts?: CoverageFormatOptions,
): string {
  const diagnostics = coverageDiagnostics(plan);
  if (diagnostics.length === 0) return "";
  if (coverageVerbose(opts)) {
    return diagnostics.map((diagnostic) => diagnostic.message).join("\n");
  }
  const shown = diagnostics.slice(0, DEFAULT_COVERAGE_LINES);
  const lines = shown.map(shortCoverageLine);
  const hidden = diagnostics.length - shown.length;
  if (hidden > 0) {
    lines.push(`${hidden} more. Re-run with --debug for full diagnostics.`);
  }
  return lines.join("\n");
}

export function withCoverageMessage(
  status: string,
  plan: SchemaPlanView,
  opts?: CoverageFormatOptions,
): string {
  const coverage = formatCoverageDiagnostics(plan, opts);
  return coverage.length > 0 ? `${status}\n${coverage}` : status;
}

export function formatPlanSummary(input: {
  readonly title: string;
  readonly source: string;
  readonly desired: string;
  readonly target: string;
  readonly plan: SchemaPlanView;
  readonly verbose?: boolean;
}): string {
  const coverage = formatCoverageDiagnostics(input.plan, { verbose: input.verbose });
  return [
    `${input.title}: ${input.source} -> ${input.desired}`,
    `Target: ${input.target}`,
    `Actions: ${input.plan.plan.actions.length}`,
    `Hazards: ${input.plan.hazards.rewrite} rewrite, ${input.plan.hazards.destructive} destructive, ${input.plan.hazards.coverageGaps} coverage gaps`,
    ...(coverage.length > 0 ? [coverage] : []),
    `Plan: ${input.plan.planId}`,
  ].join("\n");
}

export function formatFileSummary(summary: SchemaFileSummary): string {
  return `${summary.created.length} created, ${summary.updated.length} updated, ${summary.unchanged.length} unchanged, ${summary.removed.length} removed`;
}
