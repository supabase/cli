/**
 * Pure helpers for `db lint` output.
 *
 * The shapes' JSON key names and declaration order are an established output
 * contract, so the encoder reproduces the pretty-printed output byte-for-byte.
 * `omitempty` fields are modelled as optional and simply omitted when empty;
 * `level` / `message` have no `omitempty` and are always present.
 */

import { encodeGoJsonIndented } from "../../../shared/legacy-go-json.ts";
import { makeLegacyLevelEnum } from "../../../shared/legacy-fail-on.ts";

/** Lowest severity first. */
export const LEGACY_LINT_ALLOWED_LEVELS = ["warning", "error"] as const;

/** Prefix match over the allowed levels. */
export const LEGACY_LINT_LEVEL_ENUM = makeLegacyLevelEnum(LEGACY_LINT_ALLOWED_LEVELS, "prefix");

/** A single statement reference within a lint issue. */
interface LegacyLintStatement {
  readonly lineNumber: string;
  readonly text: string;
}

/** A single query reference within a lint issue. */
interface LegacyLintQuery {
  readonly position: string;
  readonly text: string;
}

/** A single lint issue — fields in the established output-contract order. */
interface LegacyLintIssue {
  readonly level: string;
  readonly message: string;
  readonly statement?: LegacyLintStatement;
  readonly query?: LegacyLintQuery;
  readonly hint?: string;
  readonly detail?: string;
  readonly context?: string;
  readonly sqlState?: string;
}

/** The lint result for a single function. */
export interface LegacyLintResult {
  readonly function: string;
  readonly issues: ReadonlyArray<LegacyLintIssue>;
}

/**
 * Decodes a JSON value into a plain string field of the issue/statement/query
 * shapes: absent or `null` is the zero value `""`; a present non-string
 * (number/bool/object/array) throws (the handler maps it to
 * `LegacyDbLintMalformedJsonError`).
 */
function requireLintString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new TypeError(`cannot unmarshal lint ${field} into string`);
  }
  return value;
}

function normalizeStatement(value: unknown): LegacyLintStatement | undefined {
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

function normalizeQuery(value: unknown): LegacyLintQuery | undefined {
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
function normalizeIssue(value: unknown): LegacyLintIssue {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const issue: {
    level: string;
    message: string;
    statement?: LegacyLintStatement;
    query?: LegacyLintQuery;
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
 * Parses the `plpgsql_check_function(... format:='json')` payload for one
 * function and overrides `function` with `<schema>.<proname>`.
 *
 * Throws on malformed JSON; the handler maps that to `LegacyDbLintMalformedJsonError`.
 *
 * Structurally strict: a top-level `null` decodes to the zero value, but any
 * other non-object (array / string / number), a present-but-not-array
 * `issues`, or a non-object issue entry throws — rather than being silently
 * coerced to an empty result, which would report a malformed payload as "no
 * lint errors". Missing/unknown fields stay tolerated.
 */
export function parseLegacyLintResult(jsonText: string, functionName: string): LegacyLintResult {
  const parsed: unknown = JSON.parse(jsonText);
  // A top-level `null` leaves the result at its zero value (no error).
  if (parsed === null) {
    return { function: functionName, issues: [] };
  }
  // A top-level array / string / number throws.
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("cannot unmarshal payload into lint.Result");
  }
  const record = parsed as Record<string, unknown>;
  // `issues` missing/null → zero value; present-but-not-array → throw.
  const issuesField = record["issues"];
  let issuesRaw: ReadonlyArray<unknown>;
  if (issuesField === undefined || issuesField === null) {
    issuesRaw = [];
  } else if (Array.isArray(issuesField)) {
    issuesRaw = issuesField;
  } else {
    throw new TypeError("cannot unmarshal issues into []lint.Issue");
  }
  // Each entry decodes into an issue; a scalar/array entry fails. A null entry
  // decodes to the zero-value issue (all fields empty strings) and is included
  // in the slice — normalizeIssue handles null via its record fallback.
  for (const entry of issuesRaw) {
    if (entry !== null && (typeof entry !== "object" || Array.isArray(entry))) {
      throw new TypeError("cannot unmarshal issue into lint.Issue");
    }
  }
  // `function` is a string field, so a present non-string value throws BEFORE
  // the code overrides it with `<schema>.<name>`. Validate the type, then
  // discard it for the override.
  requireLintString(record["function"], "function");
  return { function: functionName, issues: issuesRaw.map(normalizeIssue) };
}

/** Drops issues below `minLevel` and results left without any issue. */
export function filterLegacyLintResult(
  results: ReadonlyArray<LegacyLintResult>,
  minLevel: number,
): ReadonlyArray<LegacyLintResult> {
  const filtered: Array<LegacyLintResult> = [];
  for (const result of results) {
    const issues = result.issues.filter(
      (issue) => LEGACY_LINT_LEVEL_ENUM.toEnum(issue.level) >= minLevel,
    );
    if (issues.length > 0) filtered.push({ function: result.function, issues });
  }
  return filtered;
}

/**
 * Encodes the filtered results as the established output contract: pretty
 * 2-space JSON array, struct-order keys, trailing newline. An empty slice
 * produces no output, so the caller skips emission instead.
 *
 * `normalizeIssue` / `parseLegacyLintResult` already build their objects in
 * the established order with `omitempty` fields dropped, so the values feed
 * straight to the order-preserving encoder.
 */
export function encodeLegacyLintResults(results: ReadonlyArray<LegacyLintResult>): string {
  return encodeGoJsonIndented(results);
}
