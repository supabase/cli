# supabase-db-declarative-generate

Generate declarative schema files from a database.

This command exports schema state into files under `supabase/declarative`. It can target the linked project, local database, or a database URL.

With `--local`, if the local database is not running, the CLI starts it automatically (e.g. via `supabase start`) before generating.

By default, existing declarative files are protected behind a confirmation prompt. Use `--overwrite` to skip the prompt.

Use `--no-cache` to bypass cached pg-delta catalog snapshots and force a fresh shadow database setup.

You can filter generated output with `--schema` to include only selected schemas.
