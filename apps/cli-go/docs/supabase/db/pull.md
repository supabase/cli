# supabase-db-pull

Pulls schema changes from a remote database. A new migration file will be created under `supabase/migrations` directory.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

> Note this command requires Docker Desktop (or a running Docker daemon), as it starts a local Postgres container to diff your remote schema.

Optionally, a new row can be inserted into the migration history table to reflect the current state of the remote database.

If no entries exist in the migration history table, the default diff engine uses `pg_dump` to capture all contents of the remote schemas you have created. Otherwise, this command will only diff schema changes against the remote database, similar to running `db diff --linked`.

Pass `--diff-engine pg-delta` to keep the migration-file `db pull` workflow while using pg-delta for the shadow diff step. On initial pull, pg-delta replaces `pg_dump` and produces the full migration from the shadow diff alone. Pass `--use-pg-delta` to switch to the declarative pg-delta export workflow instead.

When `[experimental.pgdelta] enabled = true` is set in `config.toml`, `db pull` defaults to the declarative export path. Explicit `--diff-engine pg-delta` still selects the migration-file workflow.

When pulling from a remote database with `--db-url`, prefer a direct connection (`db.<project-ref>.supabase.co:5432`) over the connection pooler so pg-delta can introspect the full catalog reliably.

## Debugging empty pg-delta pulls

If `db pull --diff-engine pg-delta` reports `No schema changes found` but you expect schema output, set `PGDELTA_DEBUG=1` before running the command. Unlike `--debug`, this keeps SSL enabled for remote Supabase connections.

```sh
PGDELTA_DEBUG=1 supabase db pull --db-url "$DATABASE_URL" --diff-engine pg-delta
```

When pg-delta returns zero statements, the CLI writes a debug bundle under `supabase/.temp/pgdelta/debug/<timestamp>/`:

- `source-catalog.json` — shadow database baseline pg-delta extracted
- `target-catalog.json` — remote database pg-delta extracted
- `pgdelta-stderr.txt` — pg-delta script diagnostics (statement count, schemas)
- `connection.txt` — redacted connection metadata
- `error.txt` — error summary

Catalog files are not written during normal `db pull` runs. The `.temp/pgdelta` directory is also used by migration catalog caching (`db push`, local `db start`) when `[experimental.pgdelta] enabled = true`.

For TLS tracing without disabling SSL, use `SUPABASE_SSL_DEBUG=true` alongside `PGDELTA_DEBUG=1`.
