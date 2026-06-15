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
  readonly categories: ReadonlyArray<string>;
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
export function scanAdvisorLintRow(row: Record<string, unknown>): LegacyAdvisorLint {
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

/** The six metadata fields Go's typed struct keeps, in struct-declaration order. */
function projectApiMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof record["entity"] === "string") out["entity"] = record["entity"];
  if (Array.isArray(record["fkey_columns"])) {
    out["fkey_columns"] = record["fkey_columns"].filter((n) => typeof n === "number");
  }
  if (typeof record["fkey_name"] === "string") out["fkey_name"] = record["fkey_name"];
  if (typeof record["name"] === "string") out["name"] = record["name"];
  if (typeof record["schema"] === "string") out["schema"] = record["schema"];
  if (typeof record["type"] === "string") out["type"] = record["type"];
  return out;
}

/**
 * Tolerant port of Go's `apiResponseToLints` (`advisors.go:184-210`). Reads the
 * advisors API response with plain string narrowing instead of the generated
 * closed-enum schema (which would reject advisor names / metadata types the API
 * can add). `name` / `level` / `facing` / category values pass through as raw
 * strings, exactly like Go's `type X string` aliases.
 */
export function apiResponseToLints(parsed: unknown): ReadonlyArray<LegacyAdvisorLint> {
  if (typeof parsed !== "object" || parsed === null) return [];
  const lintsRaw = (parsed as { lints?: unknown }).lints;
  if (!Array.isArray(lintsRaw)) return [];
  const lints: Array<LegacyAdvisorLint> = [];
  for (const entry of lintsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const metadata = projectApiMetadata(record["metadata"]);
    lints.push({
      name: asString(record["name"]),
      title: asString(record["title"]),
      level: asString(record["level"]),
      facing: asString(record["facing"]),
      categories: asStringArray(record["categories"]),
      description: asString(record["description"]),
      detail: asString(record["detail"]),
      remediation: asString(record["remediation"]),
      ...(metadata !== undefined ? { metadata } : {}),
      cacheKey: asString(record["cache_key"]),
    });
  }
  return lints;
}

/** Go's `matchesType` (`advisors.go:226-239`). */
export function matchesAdvisorType(lint: LegacyAdvisorLint, advisorType: string): boolean {
  if (advisorType === "all") return true;
  for (const category of lint.categories) {
    if (advisorType === "security" && category === "SECURITY") return true;
    if (advisorType === "performance" && category === "PERFORMANCE") return true;
  }
  return false;
}

/** Go's `filterLints` (`advisors.go:212-224`): type + minimum-level filter. */
export function filterAdvisorLints(
  lints: ReadonlyArray<LegacyAdvisorLint>,
  advisorType: string,
  level: string,
): ReadonlyArray<LegacyAdvisorLint> {
  const minLevel = LEGACY_ADVISORS_LEVEL_ENUM.toEnum(level);
  return lints.filter(
    (lint) =>
      matchesAdvisorType(lint, advisorType) &&
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
export function encodeAdvisorLints(lints: ReadonlyArray<LegacyAdvisorLint>): string {
  return encodeGoJsonIndented(lints.map(toEncodableLint));
}
