/** A table-level rule violation, with `path` relative to the table the rule checks. */
export interface CliConfigTableRuleIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}
