/**
 * Pure helpers for `db lint` output, ported from `internal/db/lint/lint.go`.
 *
 * The shapes mirror Go's structs verbatim, including JSON key names and
 * declaration order, so the encoder reproduces Go's pretty-printed output
 * byte-for-byte. `omitempty` fields are modelled as optional and simply omitted
 * when empty; `level` / `message` have no `omitempty` and are always present.
 */

import { encodeGoJsonIndented } from "../../../shared/legacy-go-json.ts";
import { makeLegacyLevelEnum } from "../../../shared/legacy-fail-on.ts";

/** `lint.AllowedLevels` (`lint.go:23-26`) — lowest severity first. */
export const LEGACY_LINT_ALLOWED_LEVELS = ["warning", "error"] as const;

/** Go's `toEnum` (`lint.go:33-40`): prefix match over the allowed levels. */
export const LEGACY_LINT_LEVEL_ENUM = makeLegacyLevelEnum(LEGACY_LINT_ALLOWED_LEVELS, "prefix");

/** `lint.Statement` (`lint.go:170-173`). */
interface LegacyLintStatement {
  readonly lineNumber: string;
  readonly text: string;
}

/** `lint.Query` (`lint.go:165-168`). */
interface LegacyLintQuery {
  readonly position: string;
  readonly text: string;
}

/** `lint.Issue` (`lint.go:175-184`) — fields in struct-declaration order. */
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

/** `lint.Result` (`lint.go:186-189`). */
export interface LegacyLintResult {
  readonly function: string;
  readonly issues: ReadonlyArray<LegacyLintIssue>;
}

const asString = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

function normalizeStatement(value: unknown): LegacyLintStatement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return { lineNumber: asString(record["lineNumber"]), text: asString(record["text"]) };
}

function normalizeQuery(value: unknown): LegacyLintQuery | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return { position: asString(record["position"]), text: asString(record["text"]) };
}

/** Builds an `Issue` in Go struct order, dropping empty `omitempty` fields. */
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
  } = { level: asString(record["level"]), message: asString(record["message"]) };

  const statement = normalizeStatement(record["statement"]);
  if (statement !== undefined) issue.statement = statement;
  const query = normalizeQuery(record["query"]);
  if (query !== undefined) issue.query = query;
  const hint = asString(record["hint"]);
  if (hint !== "") issue.hint = hint;
  const detail = asString(record["detail"]);
  if (detail !== "") issue.detail = detail;
  const context = asString(record["context"]);
  if (context !== "") issue.context = context;
  const sqlState = asString(record["sqlState"]);
  if (sqlState !== "") issue.sqlState = sqlState;

  return issue;
}

/**
 * Parses the `plpgsql_check_function(... format:='json')` payload for one
 * function and overrides `function` with `<schema>.<proname>`, mirroring Go's
 * `json.Unmarshal` + `r.Function = s + "." + name` (`lint.go:149-154`).
 *
 * Throws on malformed JSON; the handler maps that to `LegacyDbLintMalformedJsonError`.
 *
 * Validates the decoded shape against what Go's `json.Unmarshal` into a
 * `lint.Result` struct would accept: a top-level `null` decodes to the zero
 * value, but any other non-object (array / string / number), a present-but-not-
 * array `issues`, or a non-object issue entry is an `UnmarshalTypeError` in Go
 * and must fail here too — rather than be silently coerced to an empty result,
 * which would report a malformed payload as "no lint errors". Go has no
 * `DisallowUnknownFields` here, so missing/unknown fields stay tolerated.
 */
export function parseLegacyLintResult(jsonText: string, functionName: string): LegacyLintResult {
  const parsed: unknown = JSON.parse(jsonText);
  // Go: a top-level `null` leaves the struct at its zero value (no error).
  if (parsed === null) {
    return { function: functionName, issues: [] };
  }
  // Go: a top-level array / string / number is an UnmarshalTypeError.
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("cannot unmarshal payload into lint.Result");
  }
  const record = parsed as Record<string, unknown>;
  // Go: `issues` ([]lint.Issue) missing/null → zero value; present-but-not-array → error.
  const issuesField = record["issues"];
  let issuesRaw: ReadonlyArray<unknown>;
  if (issuesField === undefined || issuesField === null) {
    issuesRaw = [];
  } else if (Array.isArray(issuesField)) {
    issuesRaw = issuesField;
  } else {
    throw new TypeError("cannot unmarshal issues into []lint.Issue");
  }
  // Go: each entry decodes into a `lint.Issue` struct; a scalar/array entry fails.
  for (const entry of issuesRaw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError("cannot unmarshal issue into lint.Issue");
    }
  }
  return { function: functionName, issues: issuesRaw.map(normalizeIssue) };
}

/**
 * Drops issues below `minLevel` and results left without any issue, porting
 * `filterResult` (`lint.go:80-93`).
 */
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
 * Encodes the filtered results as Go's `printResultJSON` does (`lint.go:95-106`):
 * pretty 2-space JSON array, struct-order keys, trailing newline. An empty slice
 * produces no output (Go's early return), so the caller skips emission instead.
 *
 * `normalizeIssue` / `parseLegacyLintResult` already build their objects in Go struct
 * order with `omitempty` fields dropped, so the values feed straight to the
 * order-preserving encoder.
 */
export function encodeLegacyLintResults(results: ReadonlyArray<LegacyLintResult>): string {
  return encodeGoJsonIndented(results);
}
