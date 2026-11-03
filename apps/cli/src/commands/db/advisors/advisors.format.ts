/**
 * Pure helpers for `db advisors`.
 *
 * The `Lint` shape's JSON key names and declaration order are an established
 * output contract, so the encoder reproduces the pretty-printed output
 * byte-for-byte. The only `omitempty` field is `metadata`.
 */

import { encodeHtmlSafeJsonIndented } from "../../../command-internal/html-safe-json.ts";
import { makeLevelEnum } from "../../../command-internal/fail-on.ts";

/** Lowest severity first. */
const ADVISORS_ALLOWED_LEVELS = ["info", "warn", "error"] as const;

/** Exact, case-insensitive level switch. */
export const ADVISORS_LEVEL_ENUM = makeLevelEnum(ADVISORS_ALLOWED_LEVELS, "exact-ci");

/** A single advisor lint — fields in the established output-contract order. */
export interface AdvisorLint {
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

const asString = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(asString) : [];

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
export function scanAdvisorLintRow(row: Record<string, unknown>): AdvisorLint {
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

/** The lint shape both advisors endpoints decode to; open enums arrive as plain strings. */
interface ApiLint {
  readonly name: string;
  readonly title: string;
  readonly level: string;
  readonly facing: string;
  readonly categories: ReadonlyArray<string>;
  readonly description: string;
  readonly detail: string;
  readonly remediation: string;
  readonly metadata?: {
    readonly schema?: string;
    readonly name?: string;
    readonly entity?: string;
    readonly type?: string;
    readonly fkey_name?: string;
    readonly fkey_columns?: ReadonlyArray<number>;
  };
  readonly cache_key: string;
}

/**
 * Maps decoded API lints to the output shape: metadata keeps its six fields in the established
 * order and an empty `categories` collapses to `null`.
 */
export function apiLintsToAdvisorLints(lints: ReadonlyArray<ApiLint>): ReadonlyArray<AdvisorLint> {
  return lints.map((lint) => {
    const m = lint.metadata;
    const metadata =
      m === undefined
        ? undefined
        : {
            ...(m.entity !== undefined ? { entity: m.entity } : {}),
            ...(m.fkey_columns !== undefined ? { fkey_columns: m.fkey_columns } : {}),
            ...(m.fkey_name !== undefined ? { fkey_name: m.fkey_name } : {}),
            ...(m.name !== undefined ? { name: m.name } : {}),
            ...(m.schema !== undefined ? { schema: m.schema } : {}),
            ...(m.type !== undefined ? { type: m.type } : {}),
          };
    return {
      name: lint.name,
      title: lint.title,
      level: lint.level,
      facing: lint.facing,
      categories: lint.categories.length === 0 ? null : lint.categories,
      description: lint.description,
      detail: lint.detail,
      remediation: lint.remediation,
      ...(metadata !== undefined ? { metadata } : {}),
      cacheKey: lint.cache_key,
    };
  });
}

/** Advisor-type match: `all` matches every lint, otherwise checks categories. */
export function matchesAdvisorType(lint: AdvisorLint, advisorType: string): boolean {
  if (advisorType === "all") return true;
  for (const category of lint.categories ?? []) {
    if (advisorType === "security" && category === "SECURITY") return true;
    if (advisorType === "performance" && category === "PERFORMANCE") return true;
  }
  return false;
}

/** Type + minimum-level filter. */
export function filterAdvisorLints(
  lints: ReadonlyArray<AdvisorLint>,
  advisorType: string,
  level: string,
): ReadonlyArray<AdvisorLint> {
  const minLevel = ADVISORS_LEVEL_ENUM.toEnum(level);
  return lints.filter(
    (lint) =>
      matchesAdvisorType(lint, advisorType) && ADVISORS_LEVEL_ENUM.toEnum(lint.level) >= minLevel,
  );
}

/** Re-materialises a lint as a plain object with keys in output-contract order. */
function toEncodableLint(lint: AdvisorLint): Record<string, unknown> {
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
export function encodeAdvisorLints(lints: ReadonlyArray<AdvisorLint>): string {
  return encodeHtmlSafeJsonIndented(lints.map(toEncodableLint));
}
