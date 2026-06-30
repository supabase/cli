import { Data } from "effect";

/**
 * Listing or reading migrations failed for a reason other than the directory
 * being absent. Byte-matches Go's `migration.ListLocalMigrations`
 * (`apps/cli-go/pkg/migration/list.go:34-37`), which returns
 * `"failed to read directory: " + err` for anything but `os.ErrNotExist` rather
 * than treating an unreadable `supabase/migrations` as "no migrations".
 *
 * Lives in `legacy/shared/` (not the `db`-command-scoped `legacy-pgdelta.errors`)
 * because it is raised by the shared migration-history module and consumed by
 * both the `db` and `migration` command families.
 */
export class LegacyMigrationsReadError extends Data.TaggedError("LegacyMigrationsReadError")<{
  readonly message: string;
}> {}
