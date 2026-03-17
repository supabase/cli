# supabase-db-declarative-sync

Generate a new migration from declarative schema.

This command diffs your declarative schema files against local migration state and produces a new migration file capturing the delta.

The migration file name is determined by: `--name` if set, else `--file` if set, else the default `declarative_sync`.

In interactive mode (TTY), the command will:
- Prompt to generate declarative files if none exist
- Prompt for a migration name
- Prompt to apply the migration to the local database

Use `--name` to set the migration name without prompting. Use `--apply` to automatically apply the generated migration.

Use `--no-cache` to disable cached catalog snapshots and force fresh shadow database setup.

To regenerate declarative schema from migrations, use `supabase db reset && supabase db declarative generate --local`.
