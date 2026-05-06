## supabase-db-schema-declarative-generate

Generate declarative schema files from a database.

Exports the schema of a live database (local, linked, or custom URL) into SQL files under the declarative schema directory. This is the entrypoint for bootstrapping declarative mode.

Requires `--experimental` flag or `[experimental.pgdelta] enabled = true` in config.
