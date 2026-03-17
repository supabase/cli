# supabase-db-pull

Pulls schema changes from a remote database. A new migration file will be created under `supabase/migrations` directory.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

> Note this command requires Docker Desktop (or a running Docker daemon), as it starts a local Postgres container to diff your remote schema.

Optionally, a new row can be inserted into the migration history table to reflect the current state of the remote database.

If no entries exist in the migration history table, `pg_dump` will be used to capture all contents of the remote schemas you have created. Otherwise, this command will only diff schema changes against the remote database, similar to running `db diff --linked`.

When `--use-pg-delta` is enabled (with experimental mode), `db pull` can export declarative schema files instead of creating a migration file. In this mode, schema output is written under `supabase/declarative`, and schema paths in project config are updated to point at declarative SQL files.

The same mode can be enabled branch-wide by setting `SUPABASE_EXPERIMENTAL_PG_DELTA=1` and enabling experimental features, or by adding `[experimental.pgdelta] enabled = true` in `supabase/config.toml`.
