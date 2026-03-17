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

## Error recovery

When migration application fails (e.g. a column already exists), the command:

1. **Saves a debug bundle** to `.temp/pgdelta/debug/<timestamp>-apply-error/` containing:
   - Source and target catalog snapshots (if available)
   - The generated migration SQL
   - The error message
   - A list of local migration files

2. **In interactive mode**, offers to reset the local database and reapply all migrations (including the new one). Since the migration file has already been saved to `supabase/migrations/`, `db reset` will pick it up automatically. Local data will be lost.

3. **If reset also fails**, a second debug bundle is saved (suffixed `-after-reset`) and both debug bundle paths are printed along with instructions for reporting the issue.

4. **In non-interactive mode**, the debug bundle path and reporting instructions are printed immediately.
