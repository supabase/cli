/**
 * Parses a `YYYYMMDDHHMMSS` migration version and reformats it as `YYYY-MM-DD HH:MM:SS`.
 * Returns the input unchanged when it isn't a valid timestamp (non-numeric, wrong length,
 * or an impossible calendar date).
 */
export function formatTimestampVersion(version: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u.exec(version);
  if (match === null) return version;
  // The regex matched, so groups 1-6 are present.
  const yyyy = match[1]!;
  const mm = match[2]!;
  const dd = match[3]!;
  const hh = match[4]!;
  const min = match[5]!;
  const ss = match[6]!;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(min);
  const second = Number(ss);
  // Reject out-of-range fields, then round-trip through Date.UTC so impossible dates
  // (e.g. Feb 30) fall back to passthrough instead of silently normalizing overflow.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return version;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return version;
  }
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/** Int64 max; the sentinel for the exhausted side of a migration-version merge. */
export const MIGRATION_VERSION_MAX = 9223372036854775807n;

/** Int64 min: the lower bound accepted for a migration version. */
const MIGRATION_VERSION_MIN = -9223372036854775808n;

/**
 * Parses a migration version as a signed base-10 integer within the int64 range; returns
 * `undefined` for anything else. Uses `BigInt`, since `Number` loses precision above
 * `Number.MAX_SAFE_INTEGER` and would mis-order large version numbers.
 */
export const parseMigrationVersion = (value: string): bigint | undefined => {
  if (!/^[+-]?\d+$/u.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed > MIGRATION_VERSION_MAX || parsed < MIGRATION_VERSION_MIN ? undefined : parsed;
};

/** Lexical version order, shared by every version sorter so the walks cannot drift apart. */
export const compareMigrationVersions = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Orders bare version strings the way Postgres's `ORDER BY version` does: lexically, so a
 * version string's extension always sorts after its prefix.
 */
export function sortMigrationVersions(versions: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...versions].sort(compareMigrationVersions);
}
