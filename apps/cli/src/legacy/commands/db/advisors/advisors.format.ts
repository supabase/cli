/**
 * Pure helpers for `db advisors`, ported from `internal/db/advisors/advisors.go`.
 *
 * The `Lint` shape mirrors Go's struct verbatim (JSON key names + declaration
 * order) so the encoder reproduces Go's pretty-printed output byte-for-byte. The
 * only `omitempty` field is `metadata`.
 */

import { encodeGoJsonIndented } from "../../../shared/legacy-go-json.ts";
import { makeLegacyLevelEnum } from "../../../shared/legacy-fail-on.ts";

/** `advisors.AllowedLevels` (`advisors.go:20-24`) — lowest severity first. */
const LEGACY_ADVISORS_ALLOWED_LEVELS = ["info", "warn", "error"] as const;

/** Go's `toEnum` (`advisors.go:38-48`): exact, case-insensitive level switch. */
export const LEGACY_ADVISORS_LEVEL_ENUM = makeLegacyLevelEnum(
  LEGACY_ADVISORS_ALLOWED_LEVELS,
  "exact-ci",
);

/** `advisors.Lint` (`advisors.go:50-61`) — fields in struct-declaration order. */
export interface LegacyAdvisorLint {
  readonly name: string;
  readonly title: string;
  readonly level: string;
  readonly facing: string;
  /**
   * `null` on the API path when Go's `apiResponseToLints` appends onto a nil
   * slice with zero iterations (`advisors.go:197-199`): `append(nil, …zero…)`
   * leaves the slice nil, which `encoding/json` encodes as `"categories":null`.
   * The local path (`rows.Scan`) always populates the slice, so it is never
   * null there.
   */
  readonly categories: ReadonlyArray<string> | null;
  readonly description: string;
  readonly detail: string;
  readonly remediation: string;
  /** `*json.RawMessage` (`omitempty`): present only when the source had metadata. */
  readonly metadata?: unknown;
  readonly cacheKey: string;
}

const asString = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(asString) : [];

/**
 * Decodes a JSON value into a Go `string` / `type X string` field. Mirrors
 * `encoding/json`: an absent or `null` value is the zero value `""`; a present
 * non-string (number/bool/object/array) is an `UnmarshalTypeError` → throw. Any
 * string value is accepted (the deliberate unknown-enum tolerance). Used only on
 * the typed-API path (`json.Unmarshal`), not the local `rows.Scan` path.
 */
function requireApiString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new TypeError(`cannot unmarshal advisor ${field} into string`);
  }
  return value;
}

/**
 * Decodes a JSON value into Go's `[]string`-alias `categories`, mirroring the
 * append-onto-nil collapse in `apiResponseToLints` (`advisors.go:197-199`):
 *
 *   ```go
 *   for _, c := range l.Categories {
 *     lint.Categories = append(lint.Categories, string(c))
 *   }
 *   ```
 *
 * `append` onto a nil slice with zero iterations leaves the slice nil.
 * `encoding/json` encodes a nil `[]string` as `null` (no `omitempty` on
 * `Categories`), so the key is always present.
 *
 * Mapping:
 *   - absent / `null`           → `null`  (nil slice, encodes as `"categories":null`)
 *   - present `[]`              → `null`  (zero iterations, same nil collapse)
 *   - present `["SECURITY",…]`  → the string array
 *   - present non-array         → `UnmarshalTypeError` → throw
 *   - non-string element        → `UnmarshalTypeError` → throw
 */
function requireApiStringArray(value: unknown): ReadonlyArray<string> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError("cannot unmarshal advisor categories into []string");
  }
  if (value.length === 0) return null;
  return value.map((element) => {
    // Go's encoding/json decodes a null array element to the zero string "".
    if (element === null || element === undefined) return "";
    if (typeof element !== "string") {
      throw new TypeError("cannot unmarshal advisor categories element into string");
    }
    return element;
  });
}

/**
 * Normalises a local-query `metadata` (jsonb) cell: the `@effect/sql-pg` driver
 * returns jsonb already parsed (object), but tolerate a raw JSON string too.
 * `null` / absent ⇒ omitted, matching Go's `len(metadata) > 0` guard
 * (`advisors.go:142-145`). An empty jsonb object `{}` is preserved.
 */
function normalizeLocalMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length === 0) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Scans one local-database row into a `Lint`, porting Go's positional
 * `rows.Scan(&l.Name, …)` (`advisors.go:126-146`). The `@effect/sql-pg` driver
 * keys rows by column name; the `lints.sql` query aliases the ten columns
 * exactly as referenced here.
 */
export function scanLegacyAdvisorLintRow(row: Record<string, unknown>): LegacyAdvisorLint {
  const metadata = normalizeLocalMetadata(row["metadata"]);
  return {
    name: asString(row["name"]),
    title: asString(row["title"]),
    level: asString(row["level"]),
    facing: asString(row["facing"]),
    categories: asStringArray(row["categories"]),
    description: asString(row["description"]),
    detail: asString(row["detail"]),
    remediation: asString(row["remediation"]),
    ...(metadata !== undefined ? { metadata } : {}),
    cacheKey: asString(row["cache_key"]),
  };
}

/**
 * The six metadata fields Go's typed struct keeps, in struct-declaration order.
 *
 * Go's `metadata` is a `*struct{...}`: a JSON `null`/absent value decodes to a
 * nil pointer (omitted), an object is decoded (unknown fields ignored), and any
 * other JSON type — including a `fkey_columns` that isn't an array — is an
 * `UnmarshalTypeError`. Throw on those so a malformed body fails rather than
 * silently dropping the metadata.
 */
function projectApiMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("cannot unmarshal advisor metadata");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Go's metadata is a typed struct: each `*string` subfield decodes absent/null
  // to a nil pointer (omitted) and a present non-string to an UnmarshalTypeError.
  // Add in Go struct-declaration order: entity, fkey_columns, fkey_name, name,
  // schema, type.
  const optString = (key: string) => {
    const field = record[key];
    if (field === undefined || field === null) return;
    if (typeof field !== "string") {
      throw new TypeError(`cannot unmarshal advisor metadata.${key} into string`);
    }
    out[key] = field;
  };

  optString("entity");
  const fkeyColumns = record["fkey_columns"];
  if (fkeyColumns !== undefined && fkeyColumns !== null) {
    if (!Array.isArray(fkeyColumns)) {
      throw new TypeError("cannot unmarshal advisor metadata.fkey_columns into []float32");
    }
    const normalized: Array<number> = [];
    for (const element of fkeyColumns) {
      // Go's encoding/json decodes a JSON null array element into the zero value
      // (0) for float32, not an UnmarshalTypeError. Mirror that here.
      if (element === null || element === undefined) {
        normalized.push(0);
        continue;
      }
      if (typeof element !== "number") {
        throw new TypeError("cannot unmarshal advisor metadata.fkey_columns element into float32");
      }
      normalized.push(element);
    }
    out["fkey_columns"] = normalized;
  }
  optString("fkey_name");
  optString("name");
  optString("schema");
  optString("type");
  return out;
}

/**
 * Port of Go's `apiResponseToLints` (`advisors.go:184-210`). Reads the advisors
 * API response with plain string narrowing instead of the generated closed-enum
 * schema (which would reject advisor names / metadata types the API can add):
 * `name` / `level` / `facing` / category values pass through as raw strings,
 * exactly like Go's `type X string` aliases.
 *
 * Structurally strict, though — Go decodes the 200 body via `json.Unmarshal`
 * into a typed `V1ProjectAdvisorsResponse`, so a top-level non-object, a `lints`
 * / `categories` / `metadata` / `fkey_columns` of the wrong JSON container type,
 * or a non-object lint entry is an `UnmarshalTypeError` that surfaces as a
 * non-zero failure. **Throws** on those so a malformed 200 body fails instead of
 * being reported as "No issues found"; the caller maps the throw to the same
 * `failed to fetch … advisors` error Go produces. A top-level `null` decodes to
 * the zero value (no lints), matching Go.
 */
export function apiResponseToLegacyAdvisorLints(parsed: unknown): ReadonlyArray<LegacyAdvisorLint> {
  if (parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("cannot unmarshal advisors response");
  }
  const lintsRaw = (parsed as { lints?: unknown }).lints;
  if (lintsRaw === undefined || lintsRaw === null) return [];
  if (!Array.isArray(lintsRaw)) {
    throw new TypeError("cannot unmarshal lints into []Lint");
  }
  const lints: Array<LegacyAdvisorLint> = [];
  for (const entry of lintsRaw) {
    // Go's encoding/json decodes a null slice element to the zero-value struct
    // (all fields at their zero values), not an UnmarshalTypeError. Normalise
    // null/undefined to an empty record so the field decoders produce zero values.
    if (entry === null || entry === undefined) {
      lints.push({
        name: "",
        title: "",
        level: "",
        facing: "",
        categories: null,
        description: "",
        detail: "",
        remediation: "",
        cacheKey: "",
      });
      continue;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("cannot unmarshal lint entry into Lint");
    }
    const record = entry as Record<string, unknown>;
    const metadata = projectApiMetadata(record["metadata"]);
    lints.push({
      name: requireApiString(record["name"], "name"),
      title: requireApiString(record["title"], "title"),
      level: requireApiString(record["level"], "level"),
      facing: requireApiString(record["facing"], "facing"),
      categories: requireApiStringArray(record["categories"]),
      description: requireApiString(record["description"], "description"),
      detail: requireApiString(record["detail"], "detail"),
      remediation: requireApiString(record["remediation"], "remediation"),
      ...(metadata !== undefined ? { metadata } : {}),
      cacheKey: requireApiString(record["cache_key"], "cache_key"),
    });
  }
  return lints;
}

/** Go's `matchesType` (`advisors.go:226-239`). */
export function matchesLegacyAdvisorType(lint: LegacyAdvisorLint, advisorType: string): boolean {
  if (advisorType === "all") return true;
  for (const category of lint.categories ?? []) {
    if (advisorType === "security" && category === "SECURITY") return true;
    if (advisorType === "performance" && category === "PERFORMANCE") return true;
  }
  return false;
}

/** Go's `filterLints` (`advisors.go:212-224`): type + minimum-level filter. */
export function filterLegacyAdvisorLints(
  lints: ReadonlyArray<LegacyAdvisorLint>,
  advisorType: string,
  level: string,
): ReadonlyArray<LegacyAdvisorLint> {
  const minLevel = LEGACY_ADVISORS_LEVEL_ENUM.toEnum(level);
  return lints.filter(
    (lint) =>
      matchesLegacyAdvisorType(lint, advisorType) &&
      LEGACY_ADVISORS_LEVEL_ENUM.toEnum(lint.level) >= minLevel,
  );
}

/** Re-materialises a lint as a plain object with keys in Go struct order. */
function toEncodableLint(lint: LegacyAdvisorLint): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: lint.name,
    title: lint.title,
    level: lint.level,
    facing: lint.facing,
    categories: lint.categories,
    description: lint.description,
    detail: lint.detail,
    remediation: lint.remediation,
  };
  if (lint.metadata !== undefined) out["metadata"] = lint.metadata;
  out["cache_key"] = lint.cacheKey;
  return out;
}

/**
 * Encodes the filtered lints as Go's `outputAndCheck` does (`advisors.go:247-251`):
 * pretty 2-space JSON array, struct-order keys, trailing newline. An empty slice
 * produces no output (Go writes a stderr message instead), so the caller skips
 * emission.
 */
export function encodeLegacyAdvisorLints(lints: ReadonlyArray<LegacyAdvisorLint>): string {
  return encodeGoJsonIndented(lints.map(toEncodableLint));
}
