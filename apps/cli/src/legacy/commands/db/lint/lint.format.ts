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
 */
export function parseLintResult(jsonText: string, functionName: string): LegacyLintResult {
  const parsed: unknown = JSON.parse(jsonText);
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const issuesRaw = Array.isArray(record["issues"]) ? record["issues"] : [];
  return { function: functionName, issues: issuesRaw.map(normalizeIssue) };
}

/**
 * Drops issues below `minLevel` and results left without any issue, porting
 * `filterResult` (`lint.go:80-93`).
 */
export function filterLintResult(
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
 * `normalizeIssue` / `parseLintResult` already build their objects in Go struct
 * order with `omitempty` fields dropped, so the values feed straight to the
 * order-preserving encoder.
 */
export function encodeLintResults(results: ReadonlyArray<LegacyLintResult>): string {
  return encodeGoJsonIndented(results);
}
