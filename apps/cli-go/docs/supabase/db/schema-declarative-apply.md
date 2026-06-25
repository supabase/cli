## supabase-db-schema-declarative-apply

Apply declarative schema files directly to the local database.

Reads SQL files from the configured declarative schema directory and applies them to the local database using pg-delta without creating a timestamped migration. This is intended for local or CI bootstrapping, not as a replacement for migrations in controlled schema evolution.

Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in config.
