## supabase-db-schema-declarative-sync

Generate a new migration by diffing your declarative schema files against the current migration state.

When no declarative schema exists yet, the command offers to run `generate` first. After computing the diff, you can optionally name the migration and apply it to the local database.

Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in config.
