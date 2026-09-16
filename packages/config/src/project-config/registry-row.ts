import {
  formatProjectConfigParseErrorMessage,
  PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  ProjectConfigParseError,
} from "../errors.ts";

/**
 * Registry mapping between the Management API v2 project-config resource (`data.attributes`) and
 * the hosted subset of `CliConfig`. Rows are data, not behavior — the assembly engine lives in
 * `project-config.ts`.
 *
 * Produces a sparse config where "no value" stays absent: a row is skipped when its API value is
 * `undefined` (unless `alsoConsumes` names a present sibling, letting the transform still run) and
 * skipped when `null` unless the row declares a `transform`, which receives `null` and decides
 * what it means (e.g. `smtp_host: null` still means "SMTP disabled").
 */
export interface ProjectConfigMappingRow {
  /** Path segments into the hosted subset of `CliConfig`, e.g. `["api", "max_rows"]`. */
  readonly configPath: ReadonlyArray<string>;
  /**
   * Path segments under v2 `data.attributes`, e.g. `["api", "db_schema"]` or `["auth",
   * "site_url"]`. Several rows may share one `apiPath` when a single API field feeds multiple
   * config fields.
   */
  readonly apiPath: ReadonlyArray<string>;
  /**
   * Maps the API-reported value to the config-side value; identity when absent. Receives the full
   * decoded attributes object as a second argument for rows that combine sibling fields (declare
   * those siblings in {@link alsoConsumes}). Returning `undefined` omits the field from the mapped
   * output. Narrowing failures throw `ProjectConfigParseError` via the `expect*` helpers.
   */
  readonly transform?: (value: unknown, attributes: Record<string, unknown>) => unknown;
  /**
   * Additional `data.attributes` paths this row's `transform` reads beyond `apiPath`, counted as
   * mapped for `unmappedApiFields`.
   */
  readonly alsoConsumes?: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Canonicalizes a document-sourced value at `configPath` so a value pulled from the API and the
   * same logical value spelled locally converge on one representation (e.g. `"24h"` vs.
   * `"24h0m0s"`). Applied by `fromConfigDocument` only; `fromApiProjectConfig`'s output is already
   * canonical. Must return the canonical value, the input verbatim when it can't be parsed (never
   * throw), or `undefined` to remove the field — the engine prunes containers the removal empties.
   */
  readonly normalizeDocument?: (value: unknown) => unknown;
  /**
   * Push-direction inverse of `transform` (config value → API body value). Unused today; carried
   * so a future push mapper can derive from this registry instead of a second hand-maintained
   * table. Absence does not mean identity — several rows have no faithful inverse yet, so a push
   * mapper must treat a missing `inverse` as unsupported for that row, not a fallback to identity.
   */
  readonly inverse?: (value: unknown) => unknown;
  /**
   * Marks an `x-secret` field: the API reports only an HMAC digest, never the plaintext, so the
   * mapping omits the value and pull flows must source it from the local document. The path still
   * counts as mapped for `unmappedApiFields`.
   */
  readonly isSecret?: boolean;
  /**
   * Equality semantics for an array-valued row when a diff consumer compares two projections.
   * `"sequence"` (the default) treats element order as meaningful, e.g. `api.schemas`'s first
   * entry is PostgREST's default schema; `"set"` opts out for order-free arrays like
   * `auth.additional_redirect_urls`. Defaulting to sequence over-reports drift rather than
   * missing it.
   */
  readonly arrayEquality?: "set" | "sequence";
  /**
   * The value the platform reports at `configPath` for a project that never configured this
   * feature, in config-space (post-`transform`). A diff consumer treats a remote report equal to
   * this value as "unconfigured", not drift. A row without it over-reports rather than guessing
   * from a type-level zero value, since canonicalization can turn a platform zero into a
   * non-zero shape (e.g. `0` arriving as the string `"0s"`).
   */
  readonly unconfiguredValue?: unknown;
  /**
   * The platform renders this value itself; there is no local default. When the local projection
   * carries no value here, any remote value is the platform's own rendering, never `remote_only`
   * drift — a locally declared value still classifies normally. Unlike {@link unconfiguredValue},
   * which suppresses one pinned baseline, this suppresses unconditionally.
   */
  readonly platformRendered?: boolean;
  /** Unit/semantics note for documentation only, e.g. `"csv → string[]"`; never read at runtime. */
  readonly unit?: string;
  /**
   * True when the hosted value has no business overwriting the local dev stack's own setting
   * (e.g. `db.major_version`), so `config pull` warns before overwriting it at the config root.
   * Writes into `[remotes.*]` blocks are unaffected.
   */
  readonly dualScope?: boolean;
}

/** Narrows to a string API value, mostly guarding the loosely-typed `auth` attributes record. */
export function expectString(value: unknown, apiPath: ReadonlyArray<string>): string {
  if (typeof value !== "string") {
    throw parseErrorFor("a string", value, apiPath);
  }
  return value;
}

/**
 * Also rejects non-finite numbers; the error names them "a finite number" rather than "a number"
 * so a `NaN`/`Infinity` input doesn't render as "expected a number, got number".
 */
function expectNumber(value: unknown, apiPath: ReadonlyArray<string>): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw parseErrorFor("a finite number", value, apiPath);
  }
  return value;
}

/**
 * Narrows to a finite integer. The API's lenient decode doesn't enforce this itself, so
 * integer-typed config fields re-assert it here; session-hour durations use {@link expectNumber}
 * instead, since fractional hours are meaningful.
 */
export function expectInteger(value: unknown, apiPath: ReadonlyArray<string>): number {
  const numeric = expectNumber(value, apiPath);
  // Rejects unsafe integers: a JSON number past Number.MAX_SAFE_INTEGER has already been
  // silently rounded during parsing, so passing it through would launder that rounding.
  if (!Number.isSafeInteger(numeric)) {
    throw parseErrorFor("a safe integer", numeric, apiPath);
  }
  return numeric;
}

/**
 * Narrows to a finite number within `[min, max]`, for fields whose downstream formatter only
 * handles a bounded range — e.g. session-hour durations, where an out-of-range value would
 * overflow the nanosecond conversion or stringify in exponent notation no duration parser reads.
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

/** Clamps a signed API integer to the unsigned domain the config schema expects. */
export function clampToUint(value: number): number {
  return value < 0 ? 0 : value;
}

/** Splits a comma-separated API list field into a trimmed string array. */
export function splitCommaSeparated(value: string): ReadonlyArray<string> {
  if (value.length === 0) {
    return [];
  }
  return value.split(",").map((entry) => entry.trim());
}

/**
 * Document-side canonicalization for the CSV-backed array rows: joins with `,` then re-splits with
 * {@link splitCommaSeparated}, so an element containing a literal comma or padding whitespace
 * converges on what actually exists hosted after a push, instead of round-tripping into a
 * different array. Non-array or non-string-element values pass through verbatim.
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
