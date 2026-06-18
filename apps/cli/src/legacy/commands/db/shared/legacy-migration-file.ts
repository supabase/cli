import type { Path } from "effect";

/**
 * Go's `GetCurrentTimestamp` (`apps/cli-go/internal/utils/misc.go:130`): the
 * current time formatted UTC as `YYYYMMDDHHMMSS` (Go's `layoutVersion`
 * `20060102150405`). Takes the epoch millis (from `Clock.currentTimeMillis`) so
 * it stays deterministic under test.
 */
export function legacyFormatMigrationTimestamp(millis: number): string {
  return new Date(millis).toISOString().replace(/\D/gu, "").slice(0, 14);
}

/**
 * Go's `new.GetMigrationPath` (`apps/cli-go/internal/migration/new/new.go:31`):
 * `<workdir>/supabase/migrations/<timestamp>_<name>.sql`. Returned absolute so
 * callers can write it regardless of the process CWD (Go chdir's into the workdir
 * in its persistent pre-run; the native shell resolves against it explicitly).
 */
export function legacyGetMigrationPath(
  path: Path.Path,
  workdir: string,
  timestamp: string,
  name: string,
): string {
  return path.join(workdir, "supabase", "migrations", `${timestamp}_${name}.sql`);
}
