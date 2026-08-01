/**
 * Port of Go's `pgdelta.ApplyDeclarative` (`apps/cli-go/internal/pgdelta/apply.go:299-360`) —
 * CLI-1956's declarative-apply runner: applies `supabase/database` (or the configured
 * declarative dir) to the shadow's `contrib_regression` override database via pg-delta's
 * declarative apply engine, run inside the edge-runtime container.
 *
 * This is genuinely NEW work, not a seam removal: the Deno script template itself
 * (`legacyPgDeltaDeclarativeApplyScript`) already existed (ported for a different, now-dead
 * seam), but nothing in TS ever invoked it — every declarative apply ran through the bundled
 * Go binary until now.
 */

import { Data, Effect, type FileSystem } from "effect";

import { LegacyDebugFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import {
  legacyInterpolatePgDeltaScript,
  legacyPgDeltaDeclarativeApplyScript,
} from "./legacy-pgdelta.deno-templates.ts";
import {
  legacyEdgeRuntimeId,
  legacyPgDeltaNpmRegistryOption,
  type LegacyPgDeltaContext,
} from "./legacy-pgdelta.ts";

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/** `pgdelta.ApplyDeclarative` failed — Go's own error messages at each step (see call sites below). */
export class LegacyDeclarativeApplyError extends Data.TaggedError("LegacyDeclarativeApplyError")<{
  readonly message: string;
}> {}

/** Go's `containerSchemaPath` (`apply.go:311`). */
const LEGACY_PG_DELTA_APPLY_CONTAINER_SCHEMA_PATH = "/declarative";

/** One statement/error entry — Go's `ApplyIssue`, which may arrive as a bare string or an object. */
export interface LegacyPgDeltaApplyIssue {
  readonly statement?: {
    // Optional (not required): `legacyIsValidApplyIssueElement` only checks the TYPE of each
    // present field (matching Go's per-field `json.Unmarshal` type check), not that every
    // field is present — so a partially-populated `statement` object (e.g. a future pg-delta
    // release that only reports `id`) must still render, not throw — see
    // `legacyFormatApplyIssue`'s defensive `?? ""` handling below. Go's own `(i
    // *ApplyIssue) UnmarshalJSON` is deliberately just as permissive about ABSENT fields,
    // while still rejecting a MISTYPED one for the whole payload — see
    // `legacyIsValidApplyIssueElement`'s own doc comment.
    //
    // `| null` on each of `id`/`sql`/`statementClass` (not just `?`): these are plain,
    // non-pointer `string` fields on Go's `ApplyStatement`, which has no custom
    // `UnmarshalJSON` of its own — so they decode via the default `encoding/json`, which
    // (verified empirically) accepts a JSON `null` for a non-pointer field with NO error and
    // leaves the zero value (`""`), the same "null means absent" rule as every other scalar
    // on this interface — see {@link LegacyPgDeltaApplyIssue.code}'s doc comment.
    readonly id?: string | null;
    readonly sql?: string | null;
    readonly statementClass?: string | null;
    // `| null` (not just `?`): Go's `Statement *ApplyStatement` is a pointer, so a JSON
    // `"statement":null` entry (e.g. `{"statement":null,"message":"failed"}`) unmarshals to a
    // nil pointer — `formatApplyIssue`'s `issue.Statement == nil` (`apply.go:202`) treats that
    // identically to a missing field. `legacyFormatApplyIssue`'s guard below must check for
    // `null` as well as `undefined`, or a `JSON.parse`'d `null` reaches `issue.statement.*` and
    // throws a `TypeError` instead of rendering the message.
  } | null;
  // `| null` on every scalar below (not just `?`): `ApplyIssue`'s non-`Statement` fields
  // (`Code`/`Message`/`IsDependencyError`/`Position`/`Detail`/`Hint`) are all plain,
  // non-pointer Go types (`string`/`bool`/`int`) decoded via the default `encoding/json`
  // inside `(i *ApplyIssue) UnmarshalJSON`'s `json.Unmarshal(trimmed, &parsed)` call
  // (`apply.go:133-138`) — verified empirically that unmarshaling a JSON `null` into a
  // non-pointer struct field produces NO error and leaves the zero value untouched (Go's
  // documented "null means absent" rule applies to any Go type, not just pointers/maps/
  // slices/interfaces). So `{"message":null}` is a valid, Go-accepted `ApplyIssue` element —
  // rejecting it here would turn an otherwise-parseable pg-delta payload into a spurious
  // "failed to parse pg-delta apply output" instead of rendering `unknown pg-delta issue`
  // the way `legacyFormatApplyIssueMessage`'s existing `String(issue.message ?? "")` already
  // does once this type (and `legacyIsValidApplyIssueElement`) let a null through.
  readonly code?: string | null;
  readonly message?: string | null;
  readonly isDependencyError?: boolean | null;
  readonly position?: number | null;
  readonly detail?: string | null;
  readonly hint?: string | null;
}

/** Go's `ApplyStatementLocation` (pg-topo's `StatementId` shape). */
export interface LegacyPgDeltaApplyStatementLocation {
  readonly filePath?: string;
  readonly statementIndex?: number;
}

/** Go's `ApplyDiagnosis` — a pg-topo static-analysis diagnostic. */
export interface LegacyPgDeltaApplyDiagnosis {
  // `| null` on `code`/`message`/`suggestedFix` (not just `?`): `(d *ApplyDiagnosis)
  // UnmarshalJSON`'s shadow `raw` struct (`apply.go:87-92`) declares these as plain,
  // non-pointer `string` fields with no custom unmarshaler of their own, so — same
  // empirically-verified "null means absent" `encoding/json` rule as
  // {@link LegacyPgDeltaApplyIssue.code} — a JSON `null` for any of them decodes with no
  // error and leaves `""`, not a rejected payload.
  readonly code?: string | null;
  readonly message?: string | null;
  // `| null` (not just `?`): Go's `(d *ApplyDiagnosis) UnmarshalJSON` (`apply.go:79-108`)
  // explicitly maps a JSON `"statementId":null` to a nil `*ApplyStatementLocation`, and
  // `formatStatementLocation` (`apply.go:263-274`) returns `""` for a nil pointer — so the TS
  // path must accept `null` here as absent too, or a `JSON.parse`'d `null` reaches
  // `legacyFormatStatementLocation`'s `resolved.filePath` and throws a `TypeError` instead of
  // rendering the rest of the diagnostic.
  readonly statementId?: LegacyPgDeltaApplyStatementLocation | string | null;
  readonly suggestedFix?: string | null;
}

/** The JSON payload `pgdelta_declarative_apply.ts` prints on stdout. Go's `ApplyResult`. */
export interface LegacyPgDeltaApplyResult {
  readonly status: string;
  readonly totalStatements?: number;
  readonly totalRounds?: number;
  readonly totalApplied?: number;
  readonly totalSkipped?: number;
  readonly errors?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null>;
  readonly stuckStatements?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null>;
  readonly validationErrors?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null>;
  readonly diagnostics?: ReadonlyArray<LegacyPgDeltaApplyDiagnosis | null>;
}

/**
 * Go's `int`-typed fields (`TotalStatements`/`TotalRounds`/`TotalApplied`/`TotalSkipped` on
 * `ApplyResult`, `Position` on `ApplyIssue`) reject any JSON number literal containing a decimal
 * point or exponent — Go's `json.Unmarshal` parses the literal text via `strconv.ParseInt`
 * rather than decoding a `float64` and truncating it, so even a "whole" float like `1.0` fails
 * identically to `1.5` (verified empirically: `json.Unmarshal([]byte(\`{"totalApplied":1.0}\`),
 * &r)` and the `1.5` variant both return `cannot unmarshal number ... into ... type int`). A
 * `JSON.parse`'d `1.0` is already indistinguishable from the integer `1` by the time it reaches
 * this guard — `JSON.parse` itself collapses that distinction, so that exact literal-text
 * sub-case can't be reproduced post-parse — but `Number.isInteger` still correctly rejects any
 * genuinely fractional value like `1.5`, which is the reachable and observable part of this
 * parity gap.
 */
function legacyIsGoIntNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Go's `(i *ApplyIssue) UnmarshalJSON` (`apply.go:124-142`) accepts `null`, a bare string, or
 * an object whose PRESENT fields each match `ApplyIssue`'s declared JSON types — anything else
 * (a number, boolean, array, or an object with a mistyped field) fails Go's `json.Unmarshal`
 * for the WHOLE `ApplyResult`, not just that element. Verified empirically against Go's real
 * struct definitions: `{"errors":[123]}` returns `cannot unmarshal number into Go struct field
 * ApplyResult.errors of type main.alias`, and `{"errors":[{"message":123}]}` returns `cannot
 * unmarshal number into Go struct field ApplyResult.errors.message of type string` — both abort
 * the ENTIRE parse rather than degrading that one element, so a payload like
 * `{"status":"success","errors":[123]}` must be rejected here too, not accepted as a (false)
 * success. Nested `statement` is checked the same way, one level deep — Go's `ApplyStatement`
 * has no custom `UnmarshalJSON`, so a mistyped `id`/`sql`/`statementClass` fails identically.
 *
 * A JSON `null` for any INDIVIDUAL scalar field, though — top-level (`code`/`message`/
 * `isDependencyError`/`position`/`detail`/`hint`) or nested under `statement`
 * (`id`/`sql`/`statementClass`) — is NOT a mistyped field: every one of these is a plain,
 * non-pointer Go type with no custom unmarshaler, and `encoding/json` accepts `null` for those
 * with no error, leaving the zero value (verified empirically — see
 * {@link LegacyPgDeltaApplyIssue.code}'s doc comment). So `null` is tolerated alongside each
 * field's declared type below, matching Go exactly instead of rejecting an otherwise
 * Go-compatible payload like `{"message":null}`.
 */
function legacyIsValidApplyIssueElement(value: unknown): boolean {
  if (value === null || typeof value === "string") return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  if ("statement" in value) {
    const statement = value.statement;
    if (statement !== null && statement !== undefined) {
      if (typeof statement !== "object" || Array.isArray(statement)) return false;
      if ("id" in statement && statement.id !== null && typeof statement.id !== "string") {
        return false;
      }
      if ("sql" in statement && statement.sql !== null && typeof statement.sql !== "string") {
        return false;
      }
      if (
        "statementClass" in statement &&
        statement.statementClass !== null &&
        typeof statement.statementClass !== "string"
      ) {
        return false;
      }
    }
  }
  if ("code" in value && value.code !== null && typeof value.code !== "string") return false;
  if ("message" in value && value.message !== null && typeof value.message !== "string") {
    return false;
  }
  if (
    "isDependencyError" in value &&
    value.isDependencyError !== null &&
    typeof value.isDependencyError !== "boolean"
  ) {
    return false;
  }
  if ("position" in value && value.position !== null && !legacyIsGoIntNumber(value.position)) {
    return false;
  }
  if ("detail" in value && value.detail !== null && typeof value.detail !== "string") return false;
  if ("hint" in value && value.hint !== null && typeof value.hint !== "string") return false;
  return true;
}

/**
 * Go's `(d *ApplyDiagnosis) UnmarshalJSON` (`apply.go:79-116`) — unlike `ApplyIssue`, there is
 * NO bare-string acceptance branch, so only `null` or an object is valid; a bare
 * string/number/boolean/array element fails the whole `ApplyResult` unmarshal. Verified
 * empirically: `{"diagnostics":["boom"]}` returns `cannot unmarshal string into Go struct field
 * ApplyResult.diagnostics of type struct {...}`. `statementId` is deliberately NOT type-checked
 * here: Go decodes it into a `json.RawMessage` first (accepts any valid JSON value), then tries
 * `ApplyStatementLocation`, then a bare string, and silently leaves `StatementID` nil if BOTH
 * fail — it never propagates an error for a mistyped `statementId` (verified empirically:
 * `{"statementId":42}` and `{"statementId":{"filePath":123}}` both unmarshal with `err: <nil>`),
 * so `legacyNormalizeApplyDiagnosis`/`legacyFormatStatementLocation`'s existing defensive
 * handling is the correct (and only) place that degrades gracefully.
 *
 * Same "null tolerated on a scalar field" rule as {@link legacyIsValidApplyIssueElement}
 * applies to `code`/`message`/`suggestedFix` here too: `UnmarshalJSON`'s shadow `raw` struct
 * (`apply.go:87-92`) decodes them via the default `encoding/json`, which accepts a JSON
 * `null` for a plain `string` field with no error (verified empirically).
 */
function legacyIsValidApplyDiagnosisElement(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  if ("code" in value && value.code !== null && typeof value.code !== "string") return false;
  if ("message" in value && value.message !== null && typeof value.message !== "string") {
    return false;
  }
  if (
    "suggestedFix" in value &&
    value.suggestedFix !== null &&
    typeof value.suggestedFix !== "string"
  ) {
    return false;
  }
  return true;
}

/**
 * Structural guard for Go's `ApplyResult` JSON shape, applied to an untrusted
 * `JSON.parse` of the pg-delta subprocess's stdout. A syntactically valid but non-object
 * payload (`null`, an array, a bare string/number — e.g. a future pg-delta release that
 * changes its output shape) must fail typed as {@link LegacyDeclarativeApplyError}, not
 * crash `parsed.status` with an unhandled `TypeError`.
 *
 * Every field `ApplyResult` itself declares a type for is checked when present — Go's
 * `json.Unmarshal` rejects the whole payload with an `UnmarshalTypeError` the moment any of
 * these doesn't match its struct field's declared type (`Errors []ApplyIssue`, `TotalApplied
 * int`, etc., `apps/cli-go/internal/pgdelta/apply.go:27-44`), so e.g. an `errors` field that
 * arrives as an object (`{"length":1}`) instead of an array must fail here too, not reach
 * `legacyFormatApplyFailure`'s `for (const issue of errors)` and throw an unhandled
 * `TypeError` defect. Each ARRAY field's elements are also validated ({@link
 * legacyIsValidApplyIssueElement}/{@link legacyIsValidApplyDiagnosisElement}) since Go's own
 * per-element `UnmarshalJSON` implementations reject a malformed element by failing the WHOLE
 * `ApplyResult` decode, not by skipping just that element — see those functions' own doc
 * comments for the empirical verification. This is also the AGENTS.md-mandated way to narrow
 * `unknown` without an `as` cast.
 */
function legacyIsPgDeltaApplyResult(value: unknown): value is LegacyPgDeltaApplyResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    return false;
  }
  if ("totalStatements" in value && !legacyIsGoIntNumber(value.totalStatements)) return false;
  if ("totalRounds" in value && !legacyIsGoIntNumber(value.totalRounds)) return false;
  if ("totalApplied" in value && !legacyIsGoIntNumber(value.totalApplied)) return false;
  if ("totalSkipped" in value && !legacyIsGoIntNumber(value.totalSkipped)) return false;
  if ("errors" in value) {
    if (!Array.isArray(value.errors) || !value.errors.every(legacyIsValidApplyIssueElement)) {
      return false;
    }
  }
  if ("stuckStatements" in value) {
    if (
      !Array.isArray(value.stuckStatements) ||
      !value.stuckStatements.every(legacyIsValidApplyIssueElement)
    ) {
      return false;
    }
  }
  if ("validationErrors" in value) {
    if (
      !Array.isArray(value.validationErrors) ||
      !value.validationErrors.every(legacyIsValidApplyIssueElement)
    ) {
      return false;
    }
  }
  if ("diagnostics" in value) {
    if (
      !Array.isArray(value.diagnostics) ||
      !value.diagnostics.every(legacyIsValidApplyDiagnosisElement)
    ) {
      return false;
    }
  }
  return true;
}

/** Go's `(i *ApplyIssue) UnmarshalJSON` string/object dual shape, applied post-`JSON.parse`. */
function legacyNormalizeApplyIssue(
  raw: LegacyPgDeltaApplyIssue | string | null | undefined,
): LegacyPgDeltaApplyIssue {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") return { message: raw };
  return raw;
}

/** Go's `(d *ApplyDiagnosis) UnmarshalJSON` defensive `statementId` handling. */
function legacyNormalizeApplyDiagnosis(
  raw: LegacyPgDeltaApplyDiagnosis | null | undefined,
): LegacyPgDeltaApplyDiagnosis {
  if (raw === null || raw === undefined) return {};
  if (typeof raw.statementId === "string") {
    return { ...raw, statementId: { filePath: raw.statementId } };
  }
  return raw;
}

/**
 * Go's `formatStatementLocation` (`apply.go:262-275`). `String(... ?? "")` rather than a bare
 * `?? ""` before `.trim()`: `filePath` is typed as `string | undefined`, but this whole module
 * types an untrusted `JSON.parse` of subprocess output, so a malformed payload can hand this a
 * non-string value (e.g. a number) at runtime — `?? ""` alone only substitutes `null`/
 * `undefined`, so a non-string, non-nullish value would still reach `.trim()` and throw. The
 * `resolved === null` check (not just `undefined`) is the same shape: Go's `StatementID
 * *ApplyStatementLocation` is a pointer, so `"statementId":null` unmarshals to `nil` and
 * `formatStatementLocation`'s own `loc == nil` (`apply.go:264`) treats it as absent — checking
 * only `undefined` here would fall through to `resolved.filePath` on a `null` and throw a
 * `TypeError` instead of rendering the rest of the diagnostic.
 */
function legacyFormatStatementLocation(
  loc: LegacyPgDeltaApplyStatementLocation | string | null | undefined,
): string {
  const resolved = typeof loc === "string" ? { filePath: loc } : loc;
  if (resolved === null || resolved === undefined) return "";
  const path = String(resolved.filePath ?? "").trim();
  if (path.length === 0) return "";
  if ((resolved.statementIndex ?? 0) > 0) return `${path}#${resolved.statementIndex}`;
  return path;
}

/** Go's `formatStatementSQL` (`apply.go:277-283`): collapse whitespace, then truncate at 120 chars. */
function legacyFormatStatementSql(sql: string): string {
  const normalized = sql
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");
  const maxLen = 120;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

/** Go's `formatDebugJSON` (`apply.go:285-294`): pretty-print if parseable, else the trimmed raw bytes. */
export function legacyFormatDebugJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Go's `formatApplyIssueMessage` (`apply.go:222-238`). `String(x ?? "")` throughout — see {@link legacyFormatApplyIssue}'s own doc comment for why. */
function legacyFormatApplyIssueMessage(issue: LegacyPgDeltaApplyIssue): string {
  const trimmed = String(issue.message ?? "").trim();
  const message = trimmed.length > 0 ? trimmed : "unknown pg-delta issue";
  const metadata: Array<string> = [];
  const code = String(issue.code ?? "");
  if (code.length > 0) metadata.push(`SQLSTATE ${code}`);
  if ((issue.position ?? 0) > 0) metadata.push(`position ${issue.position}`);
  if (issue.isDependencyError === true) metadata.push("dependency error");
  if (metadata.length === 0) return message;
  return `${message} (${metadata.join(", ")})`;
}

/**
 * Go's `formatApplyIssue` (`apply.go:202-221`). Every `issue.statement.*`/`issue.*` field is
 * defaulted with `String(x ?? "")` before use — not a bare `?? ""`: a malformed subprocess
 * payload (e.g. a pg-delta release that reports `detail`/`hint`/`sql` as a number) can hand any
 * of these a non-string value, which `?? ""` alone does not catch (it only substitutes
 * `null`/`undefined`), and the very next call on several of these fields is a string-only
 * method (`.trim()`, `legacyFormatStatementSql`'s `.split()`) that throws a `TypeError` on
 * anything else — turning an actionable SQL error into an unhandled defect, the worst place for
 * a rendering bug to exist, since this only ever runs on an ALREADY-FAILED apply.
 *
 * The no-statement guard checks both `undefined` and `null`: Go's `Statement *ApplyStatement`
 * is a pointer, so `{"statement":null,...}` unmarshals to `nil` and `issue.Statement == nil`
 * (`apply.go:202`) treats it exactly like a missing field. A `JSON.parse`'d `null` is not
 * `=== undefined`, so checking only `undefined` would fall through to `issue.statement.*` and
 * throw a `TypeError` instead of rendering the message.
 */
function legacyFormatApplyIssue(rawIssue: LegacyPgDeltaApplyIssue | string | null): string {
  const issue = legacyNormalizeApplyIssue(rawIssue);
  if (issue.statement === undefined || issue.statement === null) {
    return `- ${legacyFormatApplyIssueMessage(issue)}`;
  }
  const statementClass = String(issue.statement.statementClass ?? "");
  const classSuffix = statementClass.length > 0 ? ` [${statementClass}]` : "";
  const lines: Array<string> = [
    `- ${String(issue.statement.id ?? "")}${classSuffix}`,
    `  ${legacyFormatApplyIssueMessage(issue)}`,
  ];
  const detail = String(issue.detail ?? "").trim();
  if (detail.length > 0) lines.push(`  Detail: ${detail}`);
  const hint = String(issue.hint ?? "").trim();
  if (hint.length > 0) lines.push(`  Hint: ${hint}`);
  const sql = legacyFormatStatementSql(String(issue.statement.sql ?? ""));
  if (sql.length > 0) lines.push(`  SQL: ${sql}`);
  return lines.join("\n");
}

/** Go's `formatApplyDiagnosis` (`apply.go:240-258`). `String(x ?? "")` throughout — see {@link legacyFormatApplyIssue}'s own doc comment for why. */
function legacyFormatApplyDiagnosis(rawDiagnosis: LegacyPgDeltaApplyDiagnosis | null): string {
  const diagnosis = legacyNormalizeApplyDiagnosis(rawDiagnosis);
  const trimmed = String(diagnosis.message ?? "").trim();
  const message = trimmed.length > 0 ? trimmed : "unknown pg-delta diagnostic";
  let out = "- ";
  const code = String(diagnosis.code ?? "").trim();
  if (code.length > 0) out += `[${code}] `;
  out += message;
  const loc = legacyFormatStatementLocation(diagnosis.statementId);
  if (loc.length > 0) out += ` (${loc})`;
  const fix = String(diagnosis.suggestedFix ?? "").trim();
  if (fix.length > 0) out += `\n  Suggested fix: ${fix}`;
  return out;
}

/**
 * Port of Go's `formatApplyFailure` (`apply.go:145-183`): a human-readable summary of an
 * unsuccessful pg-delta apply, rendered on failure regardless of `--debug`. `verbose`
 * (Go's `viper.GetBool("DEBUG")`) only expands pg-topo diagnostics inline — collapsed to a
 * one-line count by default since a large schema can produce hundreds of them.
 */
export function legacyFormatApplyFailure(
  result: LegacyPgDeltaApplyResult,
  verbose: boolean,
): string {
  const errors = result.errors ?? [];
  const stuckStatements = result.stuckStatements ?? [];
  const validationErrors = result.validationErrors ?? [];
  const diagnostics = result.diagnostics ?? [];

  let totalStatements = result.totalStatements ?? 0;
  if (totalStatements === 0) {
    totalStatements =
      (result.totalApplied ?? 0) + (result.totalSkipped ?? 0) + stuckStatements.length;
  }

  const lines: Array<string> = [
    `pg-delta apply returned status "${result.status}".`,
    `${result.totalApplied ?? 0}/${totalStatements} statements applied in ${
      result.totalRounds ?? 0
    } round(s); ${result.totalSkipped ?? 0} skipped.`,
  ];
  if (errors.length > 0) {
    lines.push("Errors:");
    for (const issue of errors) lines.push(legacyFormatApplyIssue(issue));
  }
  if (stuckStatements.length > 0) {
    lines.push("Stuck statements:");
    for (const issue of stuckStatements) lines.push(legacyFormatApplyIssue(issue));
  }
  if (validationErrors.length > 0) {
    lines.push("Validation errors (from check_function_bodies=on pass):");
    for (const issue of validationErrors) lines.push(legacyFormatApplyIssue(issue));
  }
  if (diagnostics.length > 0) {
    if (verbose) {
      lines.push("Diagnostics:");
      for (const diagnosis of diagnostics) lines.push(legacyFormatApplyDiagnosis(diagnosis));
    } else {
      lines.push(
        `${diagnostics.length} pg-topo diagnostic(s) omitted (re-run with --debug to view).`,
      );
    }
  }
  // pg-delta may report status "error" without populating any issue arrays (e.g. an internal
  // assertion in a future pg-delta release) — point the user at how to get more information
  // rather than leaving them with just the bare status line.
  if (errors.length === 0 && stuckStatements.length === 0 && validationErrors.length === 0) {
    lines.push(
      "No per-statement diagnostics were reported by pg-delta.",
      "Re-run with --debug to print the raw pg-delta payload, or open an issue at",
      "https://github.com/supabase/pg-toolbelt/issues with the debug bundle attached.",
    );
  }
  return lines.join("\n");
}

/**
 * Port of Go's `pgdelta.ApplyDeclarative` (`apps/cli-go/internal/pgdelta/apply.go:299-360`):
 * applies `declarativeDirAbs` to `target` (the shadow's `contrib_regression` override
 * database) via pg-delta's declarative apply engine. Unlike the diff/export/catalog scripts
 * (`legacy-pgdelta.ts`), this binds the declarative directory itself read-only at
 * `/declarative` rather than mounting the whole project at `/workspace` — Go's own
 * `ApplyDeclarative` never needs the wider project tree, only the schema files. `target` is
 * always a LOCAL shadow connection (never a remote/Supabase-hosted endpoint), so — unlike
 * `legacyDiffPgDelta`'s SOURCE/TARGET — no SSL/CA-bundle preparation applies here, matching
 * Go's own plain `"TARGET="+utils.ToPostgresURL(config)` (no TLS handling at all).
 */
export const legacyApplyDeclarativePgDelta = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  params: {
    readonly fs: FileSystem.FileSystem;
    /** Absolute host path to the declarative schema directory. */
    readonly declarativeDirAbs: string;
    /** The shadow override database's Postgres URL. */
    readonly target: string;
  },
) {
  const exists = yield* params.fs
    .exists(params.declarativeDirAbs)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* Effect.fail(
      new LegacyDeclarativeApplyError({
        message: `declarative schema directory not found: ${params.declarativeDirAbs}`,
      }),
    );
  }

  const output = yield* Output;
  const edgeRuntime = yield* LegacyEdgeRuntimeScript;
  const debug = yield* LegacyDebugFlag;

  yield* output.raw("Applying declarative schemas via pg-delta...\n", "stderr");

  const env: Record<string, string> = {
    SCHEMA_PATH: LEGACY_PG_DELTA_APPLY_CONTAINER_SCHEMA_PATH,
    TARGET: params.target,
  };
  const binds = [
    `${legacyEdgeRuntimeId(ctx.projectId)}:/root/.cache/deno:rw`,
    `${params.declarativeDirAbs}:${LEGACY_PG_DELTA_APPLY_CONTAINER_SCHEMA_PATH}:ro`,
  ];
  const npm = legacyPgDeltaNpmRegistryOption();
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaDeclarativeApplyScript, ctx.npmVersion),
      env,
      binds,
      errPrefix: "error running pg-delta script",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
    })
    .pipe(Effect.mapError((cause) => new LegacyDeclarativeApplyError({ message: cause.message })));

  const parsed = yield* Effect.try({
    try: () => {
      const raw: unknown = JSON.parse(result.stdout);
      if (!legacyIsPgDeltaApplyResult(raw)) {
        throw new Error("pg-delta apply output was not a JSON object");
      }
      return raw;
    },
    catch: (cause) =>
      new LegacyDeclarativeApplyError({
        message: debug
          ? `failed to parse pg-delta apply output: ${errMessage(cause)}\nstdout: ${result.stdout}`
          : `failed to parse pg-delta apply output: ${errMessage(cause)}`,
      }),
  });

  if (parsed.status !== "success") {
    yield* output.raw(`${legacyFormatApplyFailure(parsed, debug)}\n`, "stderr");
    if (debug) {
      const debugJson = legacyFormatDebugJson(result.stdout);
      if (debugJson.length > 0) {
        yield* output.raw("pg-delta apply result:\n", "stderr");
        yield* output.raw(`${debugJson}\n`, "stderr");
      }
    }
    return yield* Effect.fail(
      new LegacyDeclarativeApplyError({
        message: `pg-delta declarative apply failed with status: ${parsed.status}`,
      }),
    );
  }
  yield* output.raw(
    `Applied ${parsed.totalApplied ?? 0} statements in ${parsed.totalRounds ?? 0} round(s).\n`,
    "stderr",
  );
});
