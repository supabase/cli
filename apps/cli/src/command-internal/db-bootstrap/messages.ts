/**
 * Stderr progress messages for the Postgres container bootstrap, shared by `supabase start` and
 * `db start`.
 */

/** Printed when no existing volume is found (a brand-new, first-ever start). */
export const START_STARTING_DATABASE_MESSAGE = "Starting database...\n";

/**
 * Printed instead of {@link START_STARTING_DATABASE_MESSAGE} when an existing volume is reused.
 * Despite the wording, this is unrelated to the `--from-backup` flag; it only reflects that the
 * volume already exists.
 */
export const START_STARTING_DATABASE_FROM_BACKUP_MESSAGE = "Starting database from backup...\n";
