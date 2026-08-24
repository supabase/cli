/**
 * Pure helpers for `db advisors`.
 *
 * The `Lint` shape's JSON key names and declaration order are an established
 * output contract, so the encoder reproduces the pretty-printed output
 * byte-for-byte. The only `omitempty` field is `metadata`.
 */

import { encodeGoJsonIndented } from "../../../shared/legacy-go-json.ts";
import { makeLegacyLevelEnum } from "../../../shared/legacy-fail-on.ts";

/** Lowest severity first. */
const LEGACY_ADVISORS_ALLOWED_LEVELS = ["info", "warn", "error"] as const;

/** Exact, case-insensitive level switch. */
export const LEGACY_ADVISORS_LEVEL_ENUM = makeLegacyLevelEnum(
  LEGACY_ADVISORS_ALLOWED_LEVELS,
  "exact-ci",
);

/** A single advisor lint — fields in the established output-contract order. */
export interface LegacyAdvisorLint {
  readonly name: string;
  readonly title: string;
  readonly level: string;
  readonly facing: string;
  /**
   * `null` on the API path when there are zero categories: an empty or absent
   * `categories` array collapses to `null` rather than `[]`, matching the
   * established output contract. The local path (`rows.Scan`) always
   * populates the slice, so it is never null there.
   */
  readonly categories: ReadonlyArray<string> | null;
  readonly description: string;
  readonly detail: string;
  readonly remediation: string;
  /** `omitempty`: present only when the source had metadata. */
  readonly metadata?: unknown;
  readonly cacheKey: string;
}

const asString = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") return value.toString();
  return Object.prototype.toString.call(value);
};

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(asString) : [];

/**
 * Decodes a JSON value into a plain string field: an absent or `null` value is
 * the zero value `""`; a present non-string (number/bool/object/array) throws.
 * Any string value is accepted (the deliberate unknown-enum tolerance). Used
 * only on the typed-API path, not the local `rows.Scan` path.
 */
function requireApiString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new TypeError(`cannot unmarshal advisor ${field} into string`);
  }
  return value;
}

/**
 * Decodes a JSON value into the `categories` string array, matching the
 * established output contract: an empty result collapses to `null` rather
 * than `[]`, and the key is always present (no `omitempty`).
 *
 * Mapping:
 *   - absent / `null`           → `null`  (encodes as `"categories":null`)
 *   - present `[]`              → `null`  (same collapse)
 *   - present `["SECURITY",…]`  → the string array
 *   - present non-array         → throw
 *   - non-string element        → throw
 */
function requireApiStringArray(value: unknown): ReadonlyArray<string> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError("cannot unmarshal advisor categories into []string");
  }
  if (value.length === 0) return null;
  return value.map((element) => {
    // A null array element decodes to the zero string "".
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
 * `null` / absent ⇒ omitted. An empty jsonb object `{}` is preserved.
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
 * Scans one local-database row into a `Lint`. The `@effect/sql-pg` driver
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
 * The six metadata fields kept, in the established output-contract order.
 *
 * A JSON `null`/absent `metadata` value is omitted, an object is decoded
 * (unknown fields ignored), and any other JSON type — including a
 * `fkey_columns` that isn't an array — throws, so a malformed body fails
 * rather than silently dropping the metadata.
 */
function projectApiMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("cannot unmarshal advisor metadata");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Each string subfield decodes absent/null to omitted and a present
  // non-string throws. Add in the established output-contract order: entity,
  // fkey_columns, fkey_name, name, schema, type.
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
      // A null array element decodes to the zero value (0), not a throw.
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
 * Reads the advisors API response with plain string narrowing instead of the
 * generated closed-enum schema (which would reject advisor names / metadata
 * types the API can add): `name` / `level` / `facing` / category values pass
 * through as raw strings.
 *
 * Structurally strict, though — a top-level non-object, a `lints` /
 * `categories` / `metadata` / `fkey_columns` of the wrong JSON container type,
 * or a non-object lint entry throws rather than surfacing as a non-zero
 * failure. **Throws** on those so a malformed 200 body fails instead of being
 * reported as "No issues found"; the caller maps the throw to the same
 * `failed to fetch … advisors` error. A top-level `null` decodes to the zero
 * value (no lints).
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
    // A null slice element decodes to the zero-value struct (all fields at
    // their zero values), not a throw. Normalise null/undefined to an empty
    // record so the field decoders produce zero values.
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

/** Advisor-type match: `all` matches every lint, otherwise checks categories. */
export function matchesLegacyAdvisorType(lint: LegacyAdvisorLint, advisorType: string): boolean {
  if (advisorType === "all") return true;
  for (const category of lint.categories ?? []) {
    if (advisorType === "security" && category === "SECURITY") return true;
    if (advisorType === "performance" && category === "PERFORMANCE") return true;
  }
  return false;
}

/** Type + minimum-level filter. */
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

/** Re-materialises a lint as a plain object with keys in output-contract order. */
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
 * Encodes the filtered lints as the established output contract: pretty
 * 2-space JSON array, struct-order keys, trailing newline. An empty slice
 * produces no output (a stderr message is written instead), so the caller
 * skips emission.
 */
export function encodeLegacyAdvisorLints(lints: ReadonlyArray<LegacyAdvisorLint>): string {
  return encodeGoJsonIndented(lints.map(toEncodableLint));
}
