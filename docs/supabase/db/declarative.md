# supabase-db-declarative

Manage declarative database schemas.

Declarative workflows let you work with structured SQL files under `supabase/declarative` instead of only timestamped migration files.

Use this command group to generate declarative files from a database and sync between migration history and declarative schema files.

This command group is experimental and requires enabling experimental features. You can enable pg-delta either by setting `SUPABASE_EXPERIMENTAL_PG_DELTA=1` or by adding `[experimental.pgdelta]` in `supabase/config.toml` (e.g. `enabled = true`, optional `declarative_schema_path`, `format_options`). When enabled, pg-delta is used for supported schema flows.

When pg-delta is enabled, the CLI caches a migration catalog after applying migrations (e.g. after `supabase start`, `db reset`, `db push`). Later declarative generate/sync and diff can reuse this cache to avoid creating a shadow database when the migration set is unchanged; use `--no-cache` to force a fresh run.
