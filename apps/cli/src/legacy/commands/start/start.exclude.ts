import { legacyAqua, legacyYellow } from "../../shared/legacy-colors.ts";
import { LEGACY_SERVICE_CATALOG } from "../../shared/legacy-service-catalog.ts";

/**
 * The `--exclude` values' canonical order: Gotrue, Realtime, Storage,
 * ImgProxy, Kong, Inbucket, Postgrest, Pgmeta, Studio, EdgeRuntime, Logflare,
 * Vector, Supavisor. This is NOT `LEGACY_SERVICE_CATALOG`'s stored order,
 * which is the actual container *start* sequence (Postgres first, Kong before
 * Gotrue, etc). Expressed here as `service` keys so the actual `excludeKey`
 * strings stay single-sourced from the catalog.
 */
const EXCLUDABLE_SERVICE_KEYS_IN_GO_ORDER: ReadonlyArray<string> = [
  "gotrue",
  "realtime",
  "storage",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "pgMeta",
  "studio",
  "edgeRuntime",
  "logflare",
  "vector",
  "supavisor",
];

const EXCLUDE_KEY_BY_SERVICE = new Map(
  LEGACY_SERVICE_CATALOG.map((entry) => [entry.service, entry.excludeKey]),
);

/**
 * The 13 valid `--exclude` values, in the canonical order above. Postgres has
 * no `excludeKey` (it is never excludable), so it is deliberately absent —
 * `db`/`postgres` are rejected as invalid `--exclude` values the same as any
 * other unrecognized string.
 */
export const LEGACY_START_EXCLUDABLE_KEYS: ReadonlyArray<string> =
  EXCLUDABLE_SERVICE_KEYS_IN_GO_ORDER.map((service) => EXCLUDE_KEY_BY_SERVICE.get(service) ?? "");

export interface LegacyStartExcludePartition {
  /** Raw `--exclude` values that matched a `LEGACY_START_EXCLUDABLE_KEYS` entry, in input order. */
  readonly valid: ReadonlyArray<string>;
  /** Raw `--exclude` values that matched nothing, in input order. */
  readonly invalid: ReadonlyArray<string>;
  /**
   * The stderr `WARNING:` text, present only when `invalid` is non-empty.
   */
  readonly warning?: string;
}

/**
 * Partitions raw `--exclude` values into valid and invalid. An unrecognized
 * `--exclude` value never fails the command — it prints a `WARNING:` to
 * stderr and the command proceeds regardless. The valid-options list in the
 * warning is alphabetically sorted, unlike `LEGACY_START_EXCLUDABLE_KEYS`'s
 * canonical-order sequence used for the flag's help text.
 */
export function legacyPartitionStartExcludeFlags(
  rawValues: ReadonlyArray<string>,
): LegacyStartExcludePartition {
  const validKeys = new Set(LEGACY_START_EXCLUDABLE_KEYS);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const value of rawValues) {
    if (validKeys.has(value)) valid.push(value);
    else invalid.push(value);
  }

  if (invalid.length === 0) return { valid, invalid };

  const sortedValidKeys = [...LEGACY_START_EXCLUDABLE_KEYS].sort();
  const warning =
    `${legacyYellow("WARNING:")} The following container names are not valid to exclude: ` +
    `${legacyAqua(invalid.join(", "))}\n` +
    `Valid containers to exclude are: ${legacyAqua(sortedValidKeys.join(", "))}\n`;
  return { valid, invalid, warning };
}
