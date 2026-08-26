import { ProjectConfigParseError } from "../errors.ts";

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
 * whose API value is `undefined` (key not reported) always, and skips `null`
 * unless the row declares a `transform` — a transform receives `null` and
 * decides (e.g. `smtp_host: null` still means "SMTP disabled").
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
   * Push-direction inverse (config value → API body value). Unused by
   * `toProjectConfig` — carried so a future push mapper can derive from this
   * registry instead of a second hand-maintained table. Absence does NOT mean
   * identity: several rows have no faithful config→API inverse yet (every
   * duration row, since `"1m0s"` must push as `60`; `BytesSize` strings;
   * `email.smtp.port`'s number→string; `sms.test_otp`'s record→env string;
   * the SMS provider selection rows). Absence means "not derived for this row
   * yet" — a push mapper must treat a missing `inverse` as unsupported for
   * that row, never fall back to identity.
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
    throw new ProjectConfigParseError({ apiPath, cause: typeMismatch("a string", value) });
  }
  return value;
}

export function expectNumber(value: unknown, apiPath: ReadonlyArray<string>): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ProjectConfigParseError({ apiPath, cause: typeMismatch("a number", value) });
  }
  return value;
}

export function expectBoolean(value: unknown, apiPath: ReadonlyArray<string>): boolean {
  if (typeof value !== "boolean") {
    throw new ProjectConfigParseError({ apiPath, cause: typeMismatch("a boolean", value) });
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

function typeMismatch(expected: string, value: unknown): Error {
  return new Error(`expected ${expected}, got ${value === null ? "null" : typeof value}`);
}
