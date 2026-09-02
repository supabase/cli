import {
  formatProjectConfigParseErrorMessage,
  PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  ProjectConfigParseError,
} from "../errors.ts";

/**
 * Registry-driven mapping between the Management API v2 project-config
 * resource (`data.attributes`) and the hosted subset of `CliConfig` — one
 * table of rows so the pull-direction normalizer (`fromApiProjectConfig`) and
 * the future push-direction `*ToUpdateBody` mappers derive from a single
 * source of truth (CLI-2230). Rows are data, not behavior: the assembly
 * engine lives in `project-config.ts`, and `unmappedApiFields` derives its
 * mapped-path set from these same rows.
 *
 * Null convention: the legacy push-direction apply (`config-sync/*.sync.ts`)
 * merges remote values into a local document, so it maps API `null` to a
 * zero value (`valOrDefault`). This registry produces a *standalone sparse*
 * config instead, where "no value" must stay absent: the engine skips a row
 * whose API value is `undefined` (key not reported) — unless the row declares
 * `alsoConsumes` and a consumed sibling IS present, in which case the
 * transform runs with `undefined` so it can still validate the sibling — and
 * skips `null` unless the row declares a `transform`; a transform receives
 * `null` and decides (e.g. `smtp_host: null` still means "SMTP disabled").
 */
export interface ProjectConfigMappingRow {
  /** Path segments into the hosted subset of `CliConfig`, e.g. `["api", "max_rows"]`. */
  readonly configPath: ReadonlyArray<string>;
  /**
   * Path segments under v2 `data.attributes`, e.g. `["api", "db_schema"]` or
   * `["auth", "site_url"]`. Several rows may share one `apiPath` when a
   * single API field feeds multiple config fields (e.g. `api.db_schema`
   * drives both `api.schemas` and the derived `api.enabled`).
   */
  readonly apiPath: ReadonlyArray<string>;
  /**
   * Maps the API-reported value to the config-side value; identity when
   * absent. Receives the full decoded attributes object as a second argument
   * for the rare row that combines sibling fields (declare those siblings in
   * {@link alsoConsumes}). Returning `undefined` omits the field from the
   * mapped output (e.g. an API enum member the config schema cannot
   * represent). Narrowing failures throw `ProjectConfigParseError` via the
   * `expect*` helpers.
   */
  readonly transform?: (value: unknown, attributes: Record<string, unknown>) => unknown;
  /**
   * Additional `data.attributes` paths this row's `transform` reads beyond
   * `apiPath` (e.g. Apple/Google `external_*_additional_client_ids`, folded
   * into `client_id`). Listed so `unmappedApiFields` counts them as mapped.
   */
  readonly alsoConsumes?: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Canonicalizes a DOCUMENT-sourced value at `configPath` so a value pulled
   * from the API and the same logical value spelled locally converge on one
   * representation (CLI-2230's duration/byte-size finding) — e.g. a document
   * duration of `"24h"` and an API-derived `"24h0m0s"` denote the same
   * duration but compare unequal textually unless one side is normalized.
   * Applied by `fromConfigDocument` only, at `configPath`, after the
   * secret-omitting copy; never applied by `fromApiProjectConfig` (its output
   * is already canonical). Must return the canonical value, the input
   * verbatim when it cannot be parsed (a document value has already passed
   * schema validation, so this must never throw), or `undefined` to REMOVE
   * the field — unmanaged absence, for a value the push wrapper would omit
   * entirely (e.g. an empty `test_otp` map); the engine prunes containers
   * the removal empties.
   */
  readonly normalizeDocument?: (value: unknown) => unknown;
  /**
   * Push-direction inverse (config value → API body value). Unused by
   * `toProjectConfig` — carried so a future push mapper can derive from this
   * registry instead of a second hand-maintained table. Absence does NOT mean
   * identity: several rows have no faithful config→API inverse yet (every
   * duration row, since `"1m0s"` must push as `60`; `BytesSize` strings;
   * `email.smtp.port`'s number→string; `sms.test_otp`'s record→env string;
   * the SMS provider selection rows). Absence means "not derived for this row
   * yet" — zero rows currently define one; a push mapper must treat a missing
   * `inverse` as unsupported for that row, never fall back to identity. Push
   * derivation lands with the push-mapper work (CLI-2230 follow-up).
   */
  readonly inverse?: (value: unknown) => unknown;
  /**
   * `x-secret` field: the API reports an HMAC digest of the value, never the
   * plaintext, so the mapping omits the value entirely and pull flows must
   * source it from the local document (ADR 0019, rule 5). The path still
   * counts as mapped for `unmappedApiFields`.
   */
  readonly isSecret?: boolean;
  /**
   * Equality semantics for an array-valued row when a diff consumer compares
   * the two projections (`../config-diff.ts`). Whether an array is a set or a
   * sequence is per-field wire knowledge, so it lives here with the rest of
   * the field's semantics. `"sequence"` — the default when absent — treats
   * element order as meaningful: `api.schemas`' first entry is PostgREST's
   * default schema and `api.extra_search_path` is a literal `search_path`
   * whose order is resolution order, so a reordering changes runtime behavior
   * and must register as drift. `"set"` opts a row out for arrays whose wire
   * semantics are order-free (`auth.additional_redirect_urls`). Defaulting to
   * sequence over-reports rather than under-reports when a new array row
   * forgets to choose.
   */
  readonly arrayEquality?: "set" | "sequence";
  /**
   * The value the platform reports at `configPath` for a project that never
   * configured this feature, expressed in CONFIG-space (post-`transform`) —
   * e.g. the `"0s"` an unset `sessions.timebox` canonicalizes to, or the
   * provisioning-default mailer subjects (pinned by the recorded
   * `GET /v1/projects/{ref}/config/auth` fixtures under
   * `apps/cli-e2e/fixtures/recorded/`). `../config-diff.ts` uses this as the
   * last `remote_only`-suppression baseline tier for paths the default config
   * (and its convergence projection) is silent on: a remote report equal to
   * this value is the platform's spelling of "unconfigured", not drift. A row
   * without it (and without any other baseline) over-reports rather than
   * guesses — "unconfigured" is never inferred from type-level zero values,
   * because canonicalization can turn a platform zero into a non-zero shape
   * (`sessions_timebox: 0` arrives as the string `"0s"`).
   */
  readonly unconfiguredValue?: unknown;
  /**
   * The platform authors/renders this value itself; there is no local
   * default. When the local projection carries no value at this path, any
   * remote value is the platform's own rendering — never `remote_only`
   * drift. A locally DECLARED value still classifies normally. Unlike
   * {@link unconfiguredValue}, which suppresses one pinned baseline value,
   * this suppresses unconditionally — the right choice for a rendered string
   * with no fixed spelling (e.g. a mailer subject line), where pinning a
   * baseline breaks the moment the platform rewords its own default.
   */
  readonly platformRendered?: boolean;
  /**
   * Unit/semantics note, e.g. `"csv → string[]"` or `"seconds → duration
   * string"`. Documentation-only — never read at runtime.
   */
  readonly unit?: string;
}

/**
 * Narrowing helpers for `transform` implementations. The non-auth attribute
 * sections are schema-typed before rows run, so these mostly guard the `auth`
 * record (typed `Record<string, Json>` by the API) and document each row's
 * expectation at its use site.
 */
export function expectString(value: unknown, apiPath: ReadonlyArray<string>): string {
  if (typeof value !== "string") {
    throw parseErrorFor("a string", value, apiPath);
  }
  return value;
}

/**
 * Also rejects non-finite numbers (`NaN`, `Infinity`, `-Infinity`) — no
 * registry row expects one. The expectation text is "a finite number", not
 * "a number": for a non-finite input, `typeof value` is already `"number"`,
 * so the generic "a number" wording used to render the nonsensical "expected
 * a number, got number".
 */
function expectNumber(value: unknown, apiPath: ReadonlyArray<string>): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw parseErrorFor("a finite number", value, apiPath);
  }
  return value;
}

/**
 * Narrows to a finite integer. The generated API contract types these fields
 * `isInt`; the lenient mirror deliberately drops that check so API-ahead skew
 * never fails the decode (ADR 0019 rule 2), so the rows for integer-typed
 * config fields re-assert it here — a fractional value on an integer field is
 * a malformed platform response, not tolerable skew. Only the session-hour
 * durations stay on {@link expectNumber}: the contract types them as plain
 * numbers and fractional hours are meaningful (the renderer rounds); every
 * other numeric field — including the `*_max_frequency` seconds — is
 * `isInt()` in the contract and narrows here.
 */
export function expectInteger(value: unknown, apiPath: ReadonlyArray<string>): number {
  const numeric = expectNumber(value, apiPath);
  // Safe integers only: the generated contract bounds every int field to
  // Number.MAX_SAFE_INTEGER, and a JSON number past it has already been
  // silently rounded during parsing — emitting it would launder the rounding.
  if (!Number.isSafeInteger(numeric)) {
    throw parseErrorFor("a safe integer", numeric, apiPath);
  }
  return numeric;
}

/**
 * Narrows to a finite number within `[min, max]` — for fields whose
 * downstream formatter is only defined on a bounded range. The session-hour
 * durations are the motivating case: the generated contract only requires
 * them finite, but a huge-but-finite hours value overflows the nanosecond
 * conversion into `"InfinityhNaNmNaNs"`, and a merely-large one stringifies
 * in exponent notation (`"1e+22h0m0s"`) that no duration parser reads.
 */
export function expectNumberBetween(
  value: unknown,
  apiPath: ReadonlyArray<string>,
  min: number,
  max: number,
): number {
  const numeric = expectNumber(value, apiPath);
  if (numeric < min || numeric > max) {
    throw parseErrorFor(`a number between ${min} and ${max}`, numeric, apiPath);
  }
  return numeric;
}

export function expectBoolean(value: unknown, apiPath: ReadonlyArray<string>): boolean {
  if (typeof value !== "boolean") {
    throw parseErrorFor("a boolean", value, apiPath);
  }
  return value;
}

/**
 * Clamps a signed API integer to the unsigned domain the config schema
 * expects. Replicates the legacy shell's `intToUint`
 * (`apps/cli/src/legacy/shared/legacy-size-units.ts`), applied by the sync
 * mappers to every uint-typed field pulled from the API.
 */
export function clampToUint(value: number): number {
  return value < 0 ? 0 : value;
}

/**
 * Splits an API comma-separated list field into the string array the config
 * schema holds. Replicates the legacy shell's `legacyStrToArr` + per-element
 * trim as applied in `config-sync/api.sync.ts:92-93` (`db_schema`,
 * `db_extra_search_path`). The `auth.sync.ts:1265` `uri_allow_list` site uses
 * `legacyStrToArr` without the trim; trimming there too is a deliberate,
 * benign normalization — push-direction bodies are built with `join(",")`, so
 * round-tripped data never carries the spaces the trim would remove.
 */
export function splitCommaSeparated(value: string): ReadonlyArray<string> {
  if (value.length === 0) {
    return [];
  }
  return value.split(",").map((entry) => entry.trim());
}

/**
 * DOCUMENT-side canonicalization for the three CSV-backed array rows
 * (`api.schemas`, `api.extra_search_path`, `auth.additional_redirect_urls`):
 * the push mapper joins the array with `","` (auth.sync.ts:2294,
 * api.sync.ts:138,140) and the pull direction re-splits with
 * {@link splitCommaSeparated}, so an element containing a literal comma (or
 * padded with whitespace) round-trips into a DIFFERENT array — replaying
 * join-then-split makes the document projection converge on the value that
 * actually exists hosted after a push, same as the whole-second duration
 * flooring. Non-array/non-string-element values stay verbatim (a document
 * value has already passed schema validation; never throw here).
 */
export function canonicalizeCommaJoinedArray(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return splitCommaSeparated(value.join(","));
}

function typeMismatchDetail(expected: string, value: unknown): string {
  return `expected ${expected}, got ${value === null ? "null" : typeof value}`;
}

function parseErrorFor(
  expected: string,
  value: unknown,
  apiPath: ReadonlyArray<string>,
): ProjectConfigParseError {
  const detail = typeMismatchDetail(expected, value);
  return new ProjectConfigParseError({
    apiPath,
    cause: new Error(detail),
    message: formatProjectConfigParseErrorMessage(detail, apiPath),
    suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  });
}
