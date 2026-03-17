# supabase-db-declarative-generate

Generate declarative schema files from a database.

This command exports schema state into files under `supabase/declarative`. It can target the linked project, local database, or a database URL.

When run without explicit target flags (`--local`, `--linked`, `--db-url`), the command enters smart detection mode:
- Prompts before overwriting existing declarative files
- If migrations exist, presents a choice menu to generate from local database, linked project, or custom URL
- If no migrations exist, defaults to generating from local database

With `--local`, if the local database is not running, the CLI starts it automatically (e.g. via `supabase start`) before generating. Use `--reset` to reset the local database to match migrations before generating.

By default, existing declarative files are protected behind a confirmation prompt. Use `--overwrite` to skip the prompt.

In non-interactive mode (CI), you must specify an explicit target: `--local`, `--linked`, or `--db-url`.

Use `--no-cache` to bypass cached pg-delta catalog snapshots and force a fresh shadow database setup.

You can filter generated output with `--schema` to include only selected schemas.
