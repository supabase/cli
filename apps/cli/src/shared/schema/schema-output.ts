import { STRICT_COVERAGE_CODES } from "@supabase/pg-delta/frontends";
import { explicitBooleanLongFlag } from "../cli/cobra-flag-groups.ts";
import { planStatementCount } from "./schema-body.ts";
import { MIGRATIONS_DIRECTORY_NAME } from "./schema-paths.ts";
import type { SchemaFileSummary, SchemaPlanView } from "./schema-types.ts";

export type CoverageFormatOptions = {
  readonly verbose?: boolean;
};

const DEFAULT_COVERAGE_LINES = 3;

const SHADOW_LOAD_ASSIST_CODES = new Set(["session_pollution", "reorder_on_failure"]);

function localizeShadowLoadAssist(code: string, message: string): string {
  const text = message.replaceAll(".pgdelta-export.json", "supabase/schemas/.pgdelta-export.json");
  if (code !== "session_pollution") return text;
  return text
    .replace("session poisoning", "supautils session poisoning")
    .replace(
      /\nRemove session-setting statements from declarative SQL, or do not share that session with later DDL\.$/,
      "",
    );
}

export function formatShadowLoadAssist(plan: SchemaPlanView, opts?: CoverageFormatOptions): string {
  if (!coverageVerbose(opts)) return "";
  return plan.diagnostics
    .filter((diagnostic) => SHADOW_LOAD_ASSIST_CODES.has(diagnostic.code))
    .map((diagnostic) => localizeShadowLoadAssist(diagnostic.code, diagnostic.message))
    .join("\n");
}

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

function withStatusExtras(status: string, extras: ReadonlyArray<string | undefined>): string {
  const lines = extras.filter((line): line is string => line !== undefined && line.length > 0);
  return lines.length > 0 ? `${status}\n${lines.join("\n")}` : status;
}

export function withCoverageMessage(
  status: string,
  plan: SchemaPlanView,
  opts?: CoverageFormatOptions,
): string {
  return withStatusExtras(status, [
    formatCoverageDiagnostics(plan, opts),
    formatShadowLoadAssist(plan, opts),
  ]);
}

export function formatMigrationFilePath(fileName: string): string {
  return `supabase/${MIGRATIONS_DIRECTORY_NAME}/${fileName}`;
}

export function formatNextAction(why: string, command: string): string {
  return `${why}: ${command}`;
}

export function formatPlanSummary(input: {
  readonly plan: SchemaPlanView;
  readonly verbose?: boolean;
}): string {
  const verbose = coverageVerbose({ verbose: input.verbose });
  const statements = planStatementCount(input.plan);
  const { rewrite, destructive, coverageGaps } = input.plan.hazards;
  const coverage = formatCoverageDiagnostics(input.plan, { verbose: input.verbose });
  const lines: string[] = [];
  if (statements > 0) {
    lines.push(`${statements} ${statements === 1 ? "statement" : "statements"}`);
  }
  if (rewrite > 0 || destructive > 0 || coverageGaps > 0) {
    lines.push(
      `Hazards: ${rewrite} rewrite, ${destructive} destructive, ${coverageGaps} coverage gaps`,
    );
  }
  if (coverage.length > 0) {
    lines.push(coverage);
  }
  const loadAssist = formatShadowLoadAssist(input.plan, { verbose: input.verbose });
  if (loadAssist.length > 0) {
    lines.push(loadAssist);
  }
  if (verbose) {
    lines.push(`Plan: ${input.plan.planId}`);
    lines.push(
      `${input.plan.sourceFingerprint.slice(0, 8)} -> ${input.plan.desiredFingerprint.slice(0, 8)}`,
    );
  }
  return lines.join("\n");
}

export function withPlanSummary(
  status: string,
  plan: SchemaPlanView,
  opts?: CoverageFormatOptions,
): string {
  const summary = formatPlanSummary({ plan, verbose: opts?.verbose });
  return summary.length > 0 ? `${status}\n${summary}` : status;
}

export function formatFileSummary(summary: SchemaFileSummary): string {
  return `${summary.created.length} created, ${summary.updated.length} updated, ${summary.unchanged.length} unchanged, ${summary.removed.length} removed`;
}
