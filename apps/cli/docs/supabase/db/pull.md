# supabase-db-pull

Pulls schema changes from a remote database. A new migration file will be created under `supabase/migrations` directory.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

> Note this command requires Docker Desktop (or a running Docker daemon), as it starts a local Postgres container to diff your remote schema.

Optionally, a new row can be inserted into the migration history table to reflect the current state of the remote database.

If no entries exist in the migration history table, pg-delta (the default diff engine) produces the full migration from the shadow diff alone; with `--diff-engine migra`, the initial pull instead uses `pg_dump` to capture all contents of the remote schemas you have created. Otherwise, this command will only diff schema changes against the remote database, similar to running `db diff --linked`.

Pass `--declarative` to switch to the declarative pg-delta export workflow instead of writing a migration file.

pg-delta plans are execution-aware: when a plan crosses a transaction boundary — for example `ALTER TYPE ... ADD VALUE` followed by a statement that uses the new enum value, which cannot run in the same transaction — `db pull` writes one ordered migration file per plan unit instead of a single file (for example `<ts>_remote_schema_schema_changes.sql` and `<ts+1s>_remote_schema_after_enum_values.sql`), each recorded in the migration history. The common case (a single unit) still produces exactly one `<ts>_remote_schema.sql` file.

By default the emitted SQL is formatted with the same settings the declarative export uses (uppercase keywords, wrapped at a max width of 180, indented and column-aligned). Configure overrides with `[experimental.pgdelta] format_options` in `config.toml`, or set `format_options = "null"` to opt out and emit raw, unformatted statements.

pg-delta is the default diff engine: the migration-file `db pull` workflow uses pg-delta for the shadow diff step unless configured otherwise; it does not switch to declarative output. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]` in `config.toml`, or pass `--diff-engine migra` for a single run.

When pulling from a remote database with `--db-url`, prefer a direct connection (`db.<project-ref>.supabase.co:5432`) over the connection pooler so pg-delta can introspect the full catalog reliably.

## Debugging empty pg-delta pulls

If `db pull --diff-engine pg-delta` reports `No schema changes found` but you expect schema output, set `PGDELTA_DEBUG=1` before running the command. Unlike `--debug`, this keeps SSL enabled for remote Supabase connections.

```sh
PGDELTA_DEBUG=1 supabase db pull --db-url "$DATABASE_URL" --diff-engine pg-delta
```

When pg-delta returns zero statements, the CLI writes a debug bundle under `supabase/.temp/pgdelta/v2/debug/<timestamp>-diff/` containing the source/desired catalog snapshots, the plan, and coverage diagnostics. Catalog files are not written during normal `db pull` runs.

For TLS tracing without disabling SSL, use `SUPABASE_SSL_DEBUG=true` alongside `PGDELTA_DEBUG=1`.
