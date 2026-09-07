/**
 * Pure text formatters for the Postgres container bring-up's stderr progress lines — shared by
 * `supabase start` and `db start`'s native container bootstrap. Hoisted here (was defined in
 * `commands/start/start.format.ts`, which still holds every OTHER `start`-only progress/status
 * message) once `db start`'s own bootstrap became a second caller — see
 * `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule.
 */

/**
 * Go's `fmt.Fprintln(w, "Starting database...")`
 * (`apps/cli-go/internal/db/start/start.go:165-175`) — printed right before
 * the Postgres container itself is created/started, when the pre-create
 * volume-existence check finds no existing volume (a brand-new, first-ever
 * start).
 */
export const LEGACY_START_STARTING_DATABASE_MESSAGE = "Starting database...\n";

/**
 * Go's `fmt.Fprintln(w, "Starting database from backup...")`
 * (`apps/cli-go/internal/db/start/start.go:165-175`) — printed instead of
 * {@link LEGACY_START_STARTING_DATABASE_MESSAGE} when the pre-create
 * volume-existence check finds an EXISTING volume (a restart reusing the
 * already-persisted Postgres data). Despite the wording, this has nothing to
 * do with any `--from-backup` file-restore flag — Go's own `fromBackup`
 * parameter is always empty for a plain `supabase start`, so this is the only
 * branch that command path ever reaches; `db start` DOES have a real
 * `--from-backup` flag, but this message is still only about the
 * volume-already-exists case, not that flag (see `db/start/start.handler.ts`'s
 * own message-selection logic).
 */
export const LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE =
  "Starting database from backup...\n";
