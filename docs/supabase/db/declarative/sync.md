# supabase-db-declarative-sync

Sync between migrations and declarative schema.

This command supports two explicit directions:

- `--from-migrations`: render declarative files from local migration history.
- `--to-migrations`: generate a new migration file to match the current declarative schema.

You must choose exactly one direction. Using both flags together is invalid, and omitting both flags is also invalid.

When syncing to migrations (`--to-migrations`), the migration file name is determined by: `--name` if set, else `--file` if set, else the default `declarative_sync`.

Use `--no-cache` to disable cached catalog snapshots and force fresh shadow database setup.
