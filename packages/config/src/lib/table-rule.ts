import { Schema } from "effect";
import type { CliConfigTableRuleIssue } from "./table-rule-issue.ts";

export type { CliConfigTableRuleIssue } from "./table-rule-issue.ts";

/** Wraps a table rule as a schema check so the schema and direct callers share one function. */
export function tableRuleFilter<T>(
  rule: (value: T) => ReadonlyArray<CliConfigTableRuleIssue>,
  annotations?: Schema.Annotations.Filter,
) {
  return Schema.makeFilter((value: T) => {
    const issues = rule(value);
    return issues.length === 0
      ? undefined
      : issues.map((issue) => ({ path: issue.path, issue: issue.message }));
  }, annotations);
}
