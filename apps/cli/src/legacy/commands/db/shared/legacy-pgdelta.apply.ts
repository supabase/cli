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

/**
 * Go's `ApplyStatementLocation` (pg-topo's `StatementId` shape). `ApplyStatementLocation`
 * has no custom `UnmarshalJSON` of its own, so `filePath`/`statementIndex`/`sourceOffset`
 * are plain, non-pointer Go types decoded via the default `encoding/json` — same "null
 * means absent" rule as every other scalar in this file (verified empirically, see {@link
 * LegacyPgDeltaApplyIssue.code}'s doc comment), hence `| null` on all three. `sourceOffset`
 * is never read by {@link legacyFormatStatementLocation} (Go's own `formatStatementLocation`
 * doesn't display it either), but it still must be validated in
 * {@link legacyNormalizeApplyStatementId}: Go's struct-level `json.Unmarshal` fails the
 * WHOLE object the moment any declared field — including this unused one — has the wrong
 * type, not just the fields the formatter happens to read.
 */
export interface LegacyPgDeltaApplyStatementLocation {
  readonly filePath?: string | null;
  readonly statementIndex?: number | null;
  readonly sourceOffset?: number | null;
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

/**
 * The JSON payload `pgdelta_declarative_apply.ts` prints on stdout. Go's `ApplyResult`.
 *
 * `| null` on each `total*` counter (not just `?`): `ApplyResult` has no custom
 * `UnmarshalJSON` of its own, so these plain, non-pointer `int` fields decode via the
 * default `encoding/json`, which — verified empirically, same rule as {@link
 * LegacyPgDeltaApplyIssue.code} — accepts a JSON `null` for a non-pointer `int` field with
 * NO error and leaves the zero value. So `{"status":"success","totalApplied":null}` is a
 * valid, Go-accepted `ApplyResult`, not a parse failure.
 *
 * `| null` on each array field too (`errors`/`stuckStatements`/`validationErrors`/
 * `diagnostics`): these are plain, non-pointer Go `[]T` slice fields with no custom
 * unmarshaler on `ApplyResult` itself, and `encoding/json` accepts a JSON `null` for a
 * slice field with NO error, leaving a nil (zero-length) slice — verified empirically:
 * `json.Unmarshal([]byte(\`{"status":"error","errors":null}\`), &r)` returns `err == nil`
 * with `r.Errors == nil` (`len(r.Errors) == 0`). `formatApplyFailure`'s `len(result.Errors)
 * > 0` guards treat a nil slice identically to an empty one, so `{"status":"error",
 * "errors":null}` must be accepted here too, not rejected as a parse failure.
 *
 * `status?: string | null` (not required non-null `string`): like every other field here,
 * `Status` has no custom unmarshaler on `ApplyResult` itself, so an absent key or a JSON
 * `null` decodes with NO error and leaves Go's zero value `""` — verified empirically:
 * `json.Unmarshal([]byte(\`{}\`), &r)` and the `{"status":null}` variant both return
 * `err == nil` with `r.Status == ""`. So `{}`/`{"status":null}` must reach the normal
 * failed-apply summary (status rendered as `""`), not a rejected parse failure.
 */
export interface LegacyPgDeltaApplyResult {
  readonly status?: string | null;
  readonly totalStatements?: number | null;
  readonly totalRounds?: number | null;
  readonly totalApplied?: number | null;
  readonly totalSkipped?: number | null;
  readonly errors?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null> | null;
  readonly stuckStatements?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null> | null;
  readonly validationErrors?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null> | null;
  readonly diagnostics?: ReadonlyArray<LegacyPgDeltaApplyDiagnosis | null> | null;
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
 *
 * Each array field also tolerates a JSON `null` (not just an absent key): `ApplyResult`'s
 * `[]ApplyIssue`/`[]ApplyDiagnosis` fields have no custom unmarshaler of their own, and
 * Go's `encoding/json` accepts `null` for a slice field with no error, leaving a nil
 * (zero-length) slice — verified empirically, see {@link LegacyPgDeltaApplyResult}'s own
 * doc comment. So `{"status":"error","errors":null}` is a valid, Go-accepted payload, not
 * a rejected one.
 *
 * `status` is checked the same "null/absent tolerated" way as every other field, NOT
 * required to be present and non-null: an absent key or `"status":null` is Go's zero
 * value `""`, not a parse failure — see {@link LegacyPgDeltaApplyResult}'s own doc comment
 * for the empirical verification.
 */
function legacyIsPgDeltaApplyResult(value: unknown): value is LegacyPgDeltaApplyResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ("status" in value && value.status !== null && typeof value.status !== "string")
  ) {
    return false;
  }
  if (
    "totalStatements" in value &&
    value.totalStatements !== null &&
    !legacyIsGoIntNumber(value.totalStatements)
  ) {
    return false;
  }
  if (
    "totalRounds" in value &&
    value.totalRounds !== null &&
    !legacyIsGoIntNumber(value.totalRounds)
  ) {
    return false;
  }
  if (
    "totalApplied" in value &&
    value.totalApplied !== null &&
    !legacyIsGoIntNumber(value.totalApplied)
  ) {
    return false;
  }
  if (
    "totalSkipped" in value &&
    value.totalSkipped !== null &&
    !legacyIsGoIntNumber(value.totalSkipped)
  ) {
    return false;
  }
  if ("errors" in value && value.errors !== null) {
    if (!Array.isArray(value.errors) || !value.errors.every(legacyIsValidApplyIssueElement)) {
      return false;
    }
  }
  if ("stuckStatements" in value && value.stuckStatements !== null) {
    if (
      !Array.isArray(value.stuckStatements) ||
      !value.stuckStatements.every(legacyIsValidApplyIssueElement)
    ) {
      return false;
    }
  }
  if ("validationErrors" in value && value.validationErrors !== null) {
    if (
      !Array.isArray(value.validationErrors) ||
      !value.validationErrors.every(legacyIsValidApplyIssueElement)
    ) {
      return false;
    }
  }
  if ("diagnostics" in value && value.diagnostics !== null) {
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

/**
 * Go's `(d *ApplyDiagnosis) UnmarshalJSON` three-way `statementId` fallback
 * (`apply.go:100-115`): decode into `ApplyStatementLocation` first — an object whose
 * PRESENT `filePath`/`statementIndex` fields each match the declared type (`null`
 * tolerated per field, same rule as {@link legacyIsValidApplyIssueElement}) — and if
 * that fails (a non-object, or an object with a mistyped field), fall back to a bare
 * string; if BOTH fail, Go silently leaves `StatementID` nil rather than erroring the
 * whole `ApplyResult` parse. Verified empirically: `{"statementId":{"filePath":123,
 * "statementIndex":1}}` decodes with `StatementID == nil` in Go — the object-shape
 * unmarshal fails on the mistyped `filePath`, and the string fallback also fails since
 * the value is an object, not a string. `legacyIsValidApplyDiagnosisElement` deliberately
 * does NOT check `statementId`'s shape (see its own doc comment — Go defers this into a
 * `json.RawMessage` that never fails the outer parse), so this is the only place that can
 * drop a malformed location instead of `legacyFormatStatementLocation`'s `String(...)`
 * coercion rendering a bogus location (e.g. `123#1`) Go would never have shown.
 *
 * `sourceOffset` is validated here too, even though {@link legacyFormatStatementLocation}
 * never reads it: Go's struct-level unmarshal (`apply.go:105`) fails on ANY declared field
 * with the wrong type, not just the ones a later formatter happens to display. Verified
 * empirically: `json.Unmarshal([]byte(\`{"filePath":"x.sql","sourceOffset":"bad"}\`), &loc)`
 * returns a non-nil `UnmarshalTypeError` even though `filePath` itself is well-typed, so
 * the object-shape decode fails, the string fallback also fails (the value is an object),
 * and Go leaves `StatementID` nil — dropping the location entirely rather than keeping a
 * `{filePath:"x.sql"}` that misattributes the diagnostic to the wrong file.
 */
function legacyNormalizeApplyStatementId(
  raw: LegacyPgDeltaApplyStatementLocation | string | null | undefined,
): LegacyPgDeltaApplyStatementLocation | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") return { filePath: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const filePathOk =
    !("filePath" in raw) || raw.filePath === null || typeof raw.filePath === "string";
  const indexOk =
    !("statementIndex" in raw) ||
    raw.statementIndex === null ||
    legacyIsGoIntNumber(raw.statementIndex);
  const sourceOffsetOk =
    !("sourceOffset" in raw) || raw.sourceOffset === null || legacyIsGoIntNumber(raw.sourceOffset);
  if (filePathOk && indexOk && sourceOffsetOk) return raw;
  return undefined;
}

/** Go's `(d *ApplyDiagnosis) UnmarshalJSON` defensive `statementId` handling. */
function legacyNormalizeApplyDiagnosis(
  raw: LegacyPgDeltaApplyDiagnosis | null | undefined,
): LegacyPgDeltaApplyDiagnosis {
  if (raw === null || raw === undefined) return {};
  return { ...raw, statementId: legacyNormalizeApplyStatementId(raw.statementId) };
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

/**
 * Go's `formatStatementSQL` (`apply.go:277-283`): collapse whitespace, then truncate at 120
 * UTF-8 bytes — not JS UTF-16 code units. Go's `len(normalized)` and `normalized[:maxLen-3]`
 * both count/slice raw bytes, so a statement with multibyte (e.g. non-ASCII identifier)
 * characters can be far longer in bytes than in UTF-16 units — a `.length`/`.slice()` guard
 * would under-truncate (or not truncate at all) relative to Go's 120-byte limit, changing the
 * legacy stderr contract for an already-failed apply.
 *
 * `\p{White_Space}+`, not `\s+`: `sql` is a user-authored SQL statement pulled verbatim from
 * `supabase/declarative`, so — unlike this file's JSON envelope, whose key/shape is controlled
 * by the embedded producer script — it can genuinely contain any Unicode code point a user's
 * editor wrote, including NEL (code point 0x85) or a BOM (code point 0xFEFF) pasted into a
 * comment or string literal. Go's `strings.Fields`/`unicode.IsSpace` and ECMAScript's `\s`
 * disagree on both: verified empirically — Go's `unicode.IsSpace(rune(0x85))` (NEL) is `true`
 * (`strings.Fields` collapses it, splitting `"a"+NEL+"b"` into two fields) while
 * `unicode.IsSpace(rune(0xFEFF))` (BOM) is `false` (`strings.Fields` preserves it inside one
 * field); ECMAScript's `\s` is the exact opposite (`/\s/u.test(String.fromCodePoint(0x85))` is
 * `false`, `/\s/u.test(String.fromCodePoint(0xfeff))` is `true`). `\p{White_Space}` matches the
 * Unicode `White_Space` property Go's `unicode.IsSpace` is itself built from (confirmed
 * empirically against the same two code points, plus NBSP `0xA0` and ideographic space
 * `0x3000`), so it reproduces Go's classification instead of ECMAScript's — both the rendered
 * SQL text and, for a statement long enough to need it, the 120-byte truncation boundary now
 * line up with Go's.
 *
 * Returns a `Buffer`, not a `string`: Go's `[:maxLen-3]` is a raw byte slice with no regard
 * for codepoint boundaries, so a multibyte (e.g. non-ASCII identifier) character straddling
 * byte 117 is cut mid-sequence, leaving an intentionally INVALID trailing UTF-8 fragment —
 * exactly what Go writes to stderr, unvalidated. `Buffer#toString("utf-8")` on that same
 * fragment does NOT reproduce it: Node's UTF-8 decoder substitutes U+FFFD for the incomplete
 * sequence, and re-encoding that string back to bytes for output yields a DIFFERENT (and
 * differently-sized) byte sequence than Go's raw slice — verified empirically: slicing Go's
 * own `formatStatementSQL` at a non-boundary-aligned cut produces a 120-byte, deliberately
 * invalid-UTF-8 result (`utf8.ValidString` reports `false`), while
 * `Buffer.from(sql,"utf-8").subarray(...).toString("utf-8")` on that exact byte range
 * decodes+re-encodes to a 121-byte result containing U+FFFD instead. Keeping this a `Buffer`
 * all the way to `output.rawBytes` (see {@link legacyFormatApplyFailure}) avoids that
 * lossy string round-trip and reproduces Go's bytes exactly, valid or not.
 */
function legacyFormatStatementSql(sql: string): Buffer {
  const normalized = sql
    .split(/\p{White_Space}+/u)
    .filter((part) => part.length > 0)
    .join(" ");
  const maxLen = 120;
  const normalizedBytes = Buffer.from(normalized, "utf-8");
  if (normalizedBytes.byteLength <= maxLen) return normalizedBytes;
  return Buffer.concat([normalizedBytes.subarray(0, maxLen - 3), Buffer.from("...", "utf-8")]);
}

/**
 * Joins Buffer "lines" with `\n` — a Buffer-safe equivalent of `Array#join("\n")`, used so
 * {@link legacyFormatApplyIssue}/{@link legacyFormatApplyFailure} can embed
 * {@link legacyFormatStatementSql}'s raw (possibly invalid-UTF-8) bytes without ever
 * decoding them back into a JS string.
 */
function legacyJoinLines(lines: ReadonlyArray<Buffer>): Buffer {
  const newline = Buffer.from("\n", "utf-8");
  const parts: Array<Buffer> = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(newline);
    parts.push(line);
  });
  return Buffer.concat(parts);
}

/**
 * Go's `json.Indent` (`encoding/json/indent.go`): re-flows compact/pretty JSON by inserting
 * whitespace between tokens ONLY — every token (string, number, `true`/`false`/`null`) is
 * copied byte-for-byte from `src`, never decoded into a value and re-encoded. This is NOT the
 * same as `JSON.parse` + `JSON.stringify`: parsing a number decodes it into a JS `float64`,
 * which silently loses precision for an integer literal beyond
 * `Number.MAX_SAFE_INTEGER` (e.g. a snowflake-style id), and re-stringifying a string
 * re-escapes it using `JSON.stringify`'s own rules, which can change an existing escape's
 * representation (e.g. `\/` becomes a literal `/`) — both would corrupt the exact debug
 * payload users are asked to attach to bug reports. `legacyGoJsonIndentTokens` instead scans
 * `src` as a token stream (only tracking string boundaries, via backslash-escape skipping, to
 * avoid misreading punctuation inside a string as structural) and reproduces Go's exact
 * spacing rules: verified empirically against `encoding/json.Indent` for nested objects/
 * arrays, empty `{}`/`[]` (no inserted newline), a `\/`-escaped string, an emoji (multi-UTF-16
 * code point) string, and an integer literal beyond `Number.MAX_SAFE_INTEGER` — all byte-
 * identical to Go's own output. Caller ({@link legacyFormatDebugJson}) is responsible for
 * validating `src` is well-formed JSON first; this function assumes it and does not itself
 * detect malformed input.
 */
function legacyGoJsonIndentTokens(src: string): string {
  let out = "";
  let depth = 0;
  let needIndent = false;
  let i = 0;
  const n = src.length;
  const newline = (): void => {
    out += `\n${"  ".repeat(depth)}`;
  };
  const openIndentIfNeeded = (): void => {
    if (!needIndent) return;
    needIndent = false;
    depth++;
    newline();
  };
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      openIndentIfNeeded();
      out += src.slice(start, i);
      continue;
    }
    if (c === "{" || c === "[") {
      openIndentIfNeeded();
      out += c;
      needIndent = true;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (needIndent) {
        needIndent = false;
      } else {
        depth--;
        newline();
      }
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      openIndentIfNeeded();
      out += c;
      newline();
      i++;
      continue;
    }
    if (c === ":") {
      openIndentIfNeeded();
      out += ": ";
      i++;
      continue;
    }
    openIndentIfNeeded();
    out += c;
    i++;
  }
  return out;
}

/**
 * Go's `formatDebugJSON` (`apply.go:285-294`): pretty-print if parseable, else the trimmed raw
 * bytes. `JSON.parse` here is used ONLY as a well-formedness check (its result is discarded);
 * the actual reformatting goes through {@link legacyGoJsonIndentTokens} so token values are
 * never decoded and re-encoded — see that function's own doc comment for why
 * `JSON.stringify(JSON.parse(...))` would corrupt the payload Go's `json.Indent` preserves.
 */
export function legacyFormatDebugJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  return legacyGoJsonIndentTokens(trimmed);
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
 *
 * Returns a `Buffer`, not a `string`: the `SQL: ` line embeds {@link legacyFormatStatementSql}'s
 * raw bytes directly (via {@link legacyJoinLines}) rather than interpolating them into a
 * template string, so a truncation that lands mid-codepoint reaches `output.rawBytes`
 * unmodified instead of being silently corrupted by a UTF-8 decode/re-encode round-trip.
 */
function legacyFormatApplyIssue(rawIssue: LegacyPgDeltaApplyIssue | string | null): Buffer {
  const issue = legacyNormalizeApplyIssue(rawIssue);
  if (issue.statement === undefined || issue.statement === null) {
    return Buffer.from(`- ${legacyFormatApplyIssueMessage(issue)}`, "utf-8");
  }
  const statementClass = String(issue.statement.statementClass ?? "");
  const classSuffix = statementClass.length > 0 ? ` [${statementClass}]` : "";
  const lines: Array<Buffer> = [
    Buffer.from(`- ${String(issue.statement.id ?? "")}${classSuffix}`, "utf-8"),
    Buffer.from(`  ${legacyFormatApplyIssueMessage(issue)}`, "utf-8"),
  ];
  const detail = String(issue.detail ?? "").trim();
  if (detail.length > 0) lines.push(Buffer.from(`  Detail: ${detail}`, "utf-8"));
  const hint = String(issue.hint ?? "").trim();
  if (hint.length > 0) lines.push(Buffer.from(`  Hint: ${hint}`, "utf-8"));
  const sql = legacyFormatStatementSql(String(issue.statement.sql ?? ""));
  if (sql.byteLength > 0) {
    lines.push(Buffer.concat([Buffer.from("  SQL: ", "utf-8"), sql]));
  }
  return legacyJoinLines(lines);
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
 *
 * Returns a `Buffer`, not a `string` — see {@link legacyFormatStatementSql}'s doc comment:
 * an embedded truncated SQL statement can be intentionally invalid UTF-8 (matching Go's raw
 * byte slice), and only a `Buffer` carried through to `output.rawBytes` reproduces those
 * exact bytes instead of a lossy decode/re-encode round-trip. Callers that only need the
 * text for display/assertions (this module's own unit tests) can `.toString("utf-8")` it —
 * safe for every case except the one pathological truncation this return type exists to
 * preserve exactly.
 */
export function legacyFormatApplyFailure(
  result: LegacyPgDeltaApplyResult,
  verbose: boolean,
): Buffer {
  const errors = result.errors ?? [];
  const stuckStatements = result.stuckStatements ?? [];
  const validationErrors = result.validationErrors ?? [];
  const diagnostics = result.diagnostics ?? [];

  let totalStatements = result.totalStatements ?? 0;
  if (totalStatements === 0) {
    totalStatements =
      (result.totalApplied ?? 0) + (result.totalSkipped ?? 0) + stuckStatements.length;
  }

  const lines: Array<Buffer> = [
    Buffer.from(`pg-delta apply returned status "${result.status ?? ""}".`, "utf-8"),
    Buffer.from(
      `${result.totalApplied ?? 0}/${totalStatements} statements applied in ${
        result.totalRounds ?? 0
      } round(s); ${result.totalSkipped ?? 0} skipped.`,
      "utf-8",
    ),
  ];
  if (errors.length > 0) {
    lines.push(Buffer.from("Errors:", "utf-8"));
    for (const issue of errors) lines.push(legacyFormatApplyIssue(issue));
  }
  if (stuckStatements.length > 0) {
    lines.push(Buffer.from("Stuck statements:", "utf-8"));
    for (const issue of stuckStatements) lines.push(legacyFormatApplyIssue(issue));
  }
  if (validationErrors.length > 0) {
    lines.push(Buffer.from("Validation errors (from check_function_bodies=on pass):", "utf-8"));
    for (const issue of validationErrors) lines.push(legacyFormatApplyIssue(issue));
  }
  if (diagnostics.length > 0) {
    if (verbose) {
      lines.push(Buffer.from("Diagnostics:", "utf-8"));
      for (const diagnosis of diagnostics) {
        lines.push(Buffer.from(legacyFormatApplyDiagnosis(diagnosis), "utf-8"));
      }
    } else {
      lines.push(
        Buffer.from(
          `${diagnostics.length} pg-topo diagnostic(s) omitted (re-run with --debug to view).`,
          "utf-8",
        ),
      );
    }
  }
  // pg-delta may report status "error" without populating any issue arrays (e.g. an internal
  // assertion in a future pg-delta release) — point the user at how to get more information
  // rather than leaving them with just the bare status line.
  if (errors.length === 0 && stuckStatements.length === 0 && validationErrors.length === 0) {
    lines.push(
      Buffer.from(
        [
          "No per-statement diagnostics were reported by pg-delta.",
          "Re-run with --debug to print the raw pg-delta payload, or open an issue at",
          "https://github.com/supabase/pg-toolbelt/issues with the debug bundle attached.",
        ].join("\n"),
        "utf-8",
      ),
    );
  }
  return legacyJoinLines(lines);
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
    // `output.rawBytes`, not `output.raw`: `legacyFormatApplyFailure` returns a `Buffer` that
    // may contain intentionally-invalid trailing UTF-8 bytes (a truncated SQL statement cut
    // mid-codepoint, matching Go's raw byte slice) — decoding it into a string here would
    // corrupt exactly the bytes that Buffer exists to preserve. See its own doc comment.
    yield* output.rawBytes(
      Buffer.concat([legacyFormatApplyFailure(parsed, debug), Buffer.from("\n", "utf-8")]),
      "stderr",
    );
    if (debug) {
      const debugJson = legacyFormatDebugJson(result.stdout);
      if (debugJson.length > 0) {
        yield* output.raw("pg-delta apply result:\n", "stderr");
        yield* output.raw(`${debugJson}\n`, "stderr");
      }
    }
    return yield* Effect.fail(
      new LegacyDeclarativeApplyError({
        message: `pg-delta declarative apply failed with status: ${parsed.status ?? ""}`,
      }),
    );
  }
  yield* output.raw(
    `Applied ${parsed.totalApplied ?? 0} statements in ${parsed.totalRounds ?? 0} round(s).\n`,
    "stderr",
  );
});
