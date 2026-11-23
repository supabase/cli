import { Schema } from "effect";

/** A table-level rule violation, with `path` relative to the table the rule checks. */
export interface CliConfigTableRuleIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

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
