## supabase-db-schema-declarative-sync

Generate a new migration by diffing your declarative schema files against the current migration state.

When no declarative schema exists yet, the command offers to run `generate` first, exporting from the local database. To start from a linked project or a database URL, run `generate --remote` or `generate --remote=<url>` yourself first. After computing the diff, you can optionally name the migration and apply it to the local database.

Enabled by default. When `[experimental.pgdelta] enabled = false` is set in config, pass the `--experimental` flag to run it.
