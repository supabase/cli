import { Effect, Option, Schema } from "effect";
import type { AdvisorLint } from "../../command-internal/advisors/advisors.format.ts";

export const IssueSeverity = Schema.Literals(["info", "warning", "critical"]);
export type IssueSeverity = typeof IssueSeverity.Type;
export const IssueCategory = Schema.Literals(["security", "performance", "health"]);
export type IssueCategory = typeof IssueCategory.Type;
const Resource = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  schema: Schema.NullOr(Schema.String),
});
const Affected = Schema.Struct({
  id: Schema.String,
  resource: Resource,
  detail: Schema.String,
  severity: IssueSeverity,
  docs_url: Schema.String,
});
export const Issue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  severity: IssueSeverity,
  category: IssueCategory,
  source: Schema.Literal("lint"),
  docs_url: Schema.String,
  affected: Schema.Array(Affected),
});
export interface Issue extends Schema.Schema.Type<typeof Issue> {}
export interface CheckCoverage {
  readonly type: IssueCategory;
  readonly status: "complete" | "unavailable";
  readonly reason?: string;
}
const Metadata = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  entity: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  schema: Schema.optionalKey(Schema.NullOr(Schema.String)),
  arguments: Schema.optionalKey(Schema.String),
});
const resourceTypes = new Map([
  ["table", "table"],
  ["view", "view"],
  ["materialized view", "materialized_view"],
  ["foreign table", "foreign_table"],
  ["function", "function"],
  ["auth", "auth"],
  ["extension", "extension"],
  ["bucket", "bucket"],
  ["compliance", "project"],
  ["health", "project"],
]);
export const unescapeIssueText = (text: string): string => text.replaceAll("\\`", "`");
export const isUnavailableCheck = (lint: AdvisorLint): boolean =>
  lint.name === "advisor_check_unavailable" || lint.name === "project_not_active";
const encodeAffectedIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const severityRank = { info: 0, warning: 1, critical: 2 };
export const severityAtLeast = (severity: IssueSeverity, minimum: IssueSeverity): boolean =>
  severityRank[severity] >= severityRank[minimum];
const Level = Schema.Literals(["INFO", "WARN", "ERROR"]);
const severityByLevel = { INFO: "info", WARN: "warning", ERROR: "critical" } as const;
export const groupIssues = Effect.fnUntraced(function* (
  lints: ReadonlyArray<AdvisorLint>,
  minimum: IssueSeverity,
) {
  const grouped = new Map<string, Issue>();
  for (const lint of lints) {
    if (isUnavailableCheck(lint)) continue;
    const severity = severityByLevel[yield* Schema.decodeUnknownEffect(Level)(lint.level)];
    const metadata = Option.getOrElse(Schema.decodeUnknownOption(Metadata)(lint.metadata), () =>
      Metadata.make({}),
    );
    const resource =
      metadata.entity !== undefined
        ? {
            type:
              resourceTypes.get(metadata.type ?? "") ??
              (metadata.arguments === undefined ? "project" : "function"),
            name: metadata.entity,
            schema: null,
          }
        : metadata.name === undefined
          ? { type: "project", name: "Project", schema: null }
          : {
              type:
                resourceTypes.get(metadata.type ?? "") ??
                (metadata.arguments === undefined ? "project" : "function"),
              name:
                metadata.arguments === undefined
                  ? metadata.name
                  : `${metadata.name}(${metadata.arguments})`,
              schema: metadata.schema ?? null,
            };
    const affected = {
      id:
        lint.cacheKey ||
        encodeAffectedIdentity([
          lint.name,
          resource.type,
          resource.schema,
          resource.name,
          lint.detail,
        ]),
      resource,
      detail: unescapeIssueText(lint.detail),
      severity,
      docs_url: lint.remediation,
    };
    const category: IssueCategory =
      lint.categories?.includes("HEALTH") === true
        ? "health"
        : lint.categories?.includes("SECURITY") === true
          ? "security"
          : "performance";
    const existing = grouped.get(lint.name);
    grouped.set(
      lint.name,
      existing === undefined
        ? {
            id: lint.name,
            title: lint.title,
            description: unescapeIssueText(lint.description),
            severity,
            category,
            source: "lint",
            docs_url: lint.remediation,
            affected: [affected],
          }
        : {
            ...existing,
            severity: severityAtLeast(severity, existing.severity) ? severity : existing.severity,
            affected: [...existing.affected, affected],
          },
    );
  }
  return [...grouped.values()]
    .filter((issue) => severityAtLeast(issue.severity, minimum))
    .sort(
      (a, b) => severityRank[b.severity] - severityRank[a.severity] || a.id.localeCompare(b.id),
    );
});
