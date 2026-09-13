/**
 * Pure helpers for `db lint` output.
 *
 * The shapes' JSON key names and declaration order are an established output
 * contract, so the encoder reproduces the pretty-printed output byte-for-byte.
 * `omitempty` fields are modelled as optional and simply omitted when empty;
 * `level` / `message` have no `omitempty` and are always present.
 */

import { encodeGoJsonIndented } from "../../../command-internal/go-json.ts";
import { makeLevelEnum } from "../../../command-internal/fail-on.ts";

/** Lowest severity first. */
export const LINT_ALLOWED_LEVELS = ["warning", "error"] as const;

/** Prefix match over the allowed levels. */
export const LINT_LEVEL_ENUM = makeLevelEnum(LINT_ALLOWED_LEVELS, "prefix");

/** A single statement reference within a lint issue. */
interface LintStatement {
  readonly lineNumber: string;
  readonly text: string;
}

/** A single query reference within a lint issue. */
interface LintQuery {
  readonly position: string;
  readonly text: string;
}

/** A single lint issue — fields in the established output-contract order. */
interface LintIssue {
  readonly level: string;
  readonly message: string;
  readonly statement?: LintStatement;
  readonly query?: LintQuery;
  readonly hint?: string;
  readonly detail?: string;
  readonly context?: string;
  readonly sqlState?: string;
}

/** The lint result for a single function. */
export interface LintResult {
  readonly function: string;
  readonly issues: ReadonlyArray<LintIssue>;
}

/**
 * Decodes a JSON value into a plain string field of the issue/statement/query
 * shapes: absent or `null` is the zero value `""`; a present non-string
 * (number/bool/object/array) throws (the handler maps it to
 * `DbLintMalformedJsonError`).
 */
function requireLintString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new TypeError(`cannot unmarshal lint ${field} into string`);
  }
  return value;
}

function normalizeStatement(value: unknown): LintStatement | undefined {
  // absent/null → omitted; present non-object (string/number/array) → throw.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("cannot unmarshal lint statement into lint.Statement");
  }
  const record = value as Record<string, unknown>;
  return {
    lineNumber: requireLintString(record["lineNumber"], "statement.lineNumber"),
    text: requireLintString(record["text"], "statement.text"),
  };
}

function normalizeQuery(value: unknown): LintQuery | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("cannot unmarshal lint query into lint.Query");
  }
  const record = value as Record<string, unknown>;
  return {
    position: requireLintString(record["position"], "query.position"),
    text: requireLintString(record["text"], "query.text"),
  };
}

/** Builds an `Issue` in the established output-contract order, dropping empty `omitempty` fields. */
function normalizeIssue(value: unknown): LintIssue {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const issue: {
    level: string;
    message: string;
    statement?: LintStatement;
    query?: LintQuery;
    hint?: string;
    detail?: string;
    context?: string;
    sqlState?: string;
  } = {
    level: requireLintString(record["level"], "level"),
    message: requireLintString(record["message"], "message"),
  };

  const statement = normalizeStatement(record["statement"]);
  if (statement !== undefined) issue.statement = statement;
  const query = normalizeQuery(record["query"]);
  if (query !== undefined) issue.query = query;
  const hint = requireLintString(record["hint"], "hint");
  if (hint !== "") issue.hint = hint;
  const detail = requireLintString(record["detail"], "detail");
  if (detail !== "") issue.detail = detail;
  const context = requireLintString(record["context"], "context");
  if (context !== "") issue.context = context;
  const sqlState = requireLintString(record["sqlState"], "sqlState");
  if (sqlState !== "") issue.sqlState = sqlState;

  return issue;
}

/**
 * Parses the `plpgsql_check_function(... format:='json')` payload for one function and
 * overrides `function` with `<schema>.<proname>`. Throws on malformed JSON (mapped to
 * `DbLintMalformedJsonError` by the handler): a top-level `null` decodes to the zero
 * value, but any other non-object, a present-but-not-array `issues`, or a non-object
 * issue entry throws instead of being silently coerced to an empty ("no lint errors")
 * result.
 */
export function parseLintResult(jsonText: string, functionName: string): LintResult {
  const parsed: unknown = JSON.parse(jsonText);
  if (parsed === null) {
    return { function: functionName, issues: [] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("cannot unmarshal payload into lint.Result");
  }
  const record = parsed as Record<string, unknown>;
  const issuesField = record["issues"];
  let issuesRaw: ReadonlyArray<unknown>;
  if (issuesField === undefined || issuesField === null) {
    issuesRaw = [];
  } else if (Array.isArray(issuesField)) {
    issuesRaw = issuesField;
  } else {
    throw new TypeError("cannot unmarshal issues into []lint.Issue");
  }
  // A null entry decodes to a zero-value issue (handled by `normalizeIssue`'s
  // fallback), not skipped.
  for (const entry of issuesRaw) {
    if (entry !== null && (typeof entry !== "object" || Array.isArray(entry))) {
      throw new TypeError("cannot unmarshal issue into lint.Issue");
    }
  }
  // Validates `function`'s type (throwing if non-string) before discarding it for
  // the override below.
  requireLintString(record["function"], "function");
  return { function: functionName, issues: issuesRaw.map(normalizeIssue) };
}

/** Drops issues below `minLevel` and results left without any issue. */
export function filterLintResult(
  results: ReadonlyArray<LintResult>,
  minLevel: number,
): ReadonlyArray<LintResult> {
  const filtered: Array<LintResult> = [];
  for (const result of results) {
    const issues = result.issues.filter((issue) => LINT_LEVEL_ENUM.toEnum(issue.level) >= minLevel);
    if (issues.length > 0) filtered.push({ function: result.function, issues });
  }
  return filtered;
}

/**
 * Encodes the filtered results as the established output contract: pretty
 * 2-space JSON array, struct-order keys, trailing newline. An empty slice
 * produces no output, so the caller skips emission instead.
 *
 * `normalizeIssue` / `parseLintResult` already build their objects in
 * the established order with `omitempty` fields dropped, so the values feed
 * straight to the order-preserving encoder.
 */
export function encodeLintResults(results: ReadonlyArray<LintResult>): string {
  return encodeGoJsonIndented(results);
}
