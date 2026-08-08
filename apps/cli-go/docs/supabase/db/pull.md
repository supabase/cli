# supabase-db-pull

Pulls schema changes from a remote database. A new migration file will be created under `supabase/migrations` directory.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

> Note this command requires Docker Desktop (or a running Docker daemon), as it starts a local Postgres container to diff your remote schema.

Optionally, a new row can be inserted into the migration history table to reflect the current state of the remote database.

If no entries exist in the migration history table, the default diff engine uses `pg_dump` to capture all contents of the remote schemas you have created. Otherwise, this command will only diff schema changes against the remote database, similar to running `db diff --linked`.

Pass `--diff-engine pg-delta` to keep the migration-file `db pull` workflow while using pg-delta for the shadow diff step. On initial pull, pg-delta replaces `pg_dump` and produces the full migration from the shadow diff alone. Pass `--declarative` to switch to the declarative pg-delta export workflow instead.

Migration-style pull always compares the local migrations shadow with the selected live database. Declarative files and `[db.migrations].schema_paths` do not replace that target; use `db schema declarative sync` for declarative comparison.

Pg-delta runs in-process by default and is bundled with pg-topo at CLI build time. Set `SUPABASE_USE_PG_DELTA_NEXT=false` to temporarily use the legacy edge-runtime implementation. `PGDELTA_NPM_REGISTRY`, `supabase/.temp/pgdelta-version`, and legacy catalogs directly under `supabase/.temp/pgdelta/` affect only that opt-out; the CLI never falls back automatically.

pg-delta plans are execution-aware: when a plan crosses a transaction boundary — for example `ALTER TYPE ... ADD VALUE` followed by a statement that uses the new enum value, which cannot run in the same transaction — `db pull` writes one ordered migration file per plan unit instead of a single file (for example `<ts>_remote_schema_schema_changes.sql` and `<ts+1s>_remote_schema_after_enum_values.sql`), each recorded in the migration history. The common case (a single unit) still produces exactly one `<ts>_remote_schema.sql` file.

By default the emitted SQL is compacted and formatted with pg-delta's human-facing settings (lowercase keywords, wrapped at a max width of 180, indented and column-aligned). Configure partial overrides with `[experimental.pgdelta] format_options` in `config.toml`, or set `format_options = "null"` to opt out and emit raw, unformatted statements. Compaction remains enabled in raw mode because it is a separate, semantics-preserving planning step.

When `[experimental.pgdelta] enabled = true` (the default for projects created by a recent `supabase init`), the migration-file `db pull` workflow uses pg-delta for the shadow diff step by default; it does not switch to declarative output. Existing projects without the section are unaffected and keep using migra. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]`, or pass `--diff-engine migra` for a single run.

When pulling from a remote database with `--db-url`, prefer a direct connection (`db.<project-ref>.supabase.co:5432`) over the connection pooler so pg-delta can introspect the full catalog reliably.

## Debugging empty pg-delta pulls

If `db pull --diff-engine pg-delta` reports `No schema changes found` but you expect schema output, set `PGDELTA_DEBUG=1` before running the command. Unlike `--debug`, this keeps SSL enabled for remote Supabase connections.

```sh
PGDELTA_DEBUG=1 supabase db pull --db-url "$DATABASE_URL" --diff-engine pg-delta
```

The bundled engine writes a debug bundle under `supabase/.temp/pgdelta/v2/debug/<id>/` and includes its path in the empty-pull error. It contains `metadata.json` and, when available:

- `source-snapshot.json` — serialized shadow database state
- `desired-snapshot.json` — serialized remote database state
- `plan.json` — serialized pg-delta plan
- `diagnostics.json` — extraction/planning diagnostics

These files are diagnostic artifacts and are never reused as catalogs. New-engine SQL bytes and transaction-split filenames may differ from the legacy renderer; successful execution and an empty subsequent pull/diff are the contract.

Under `SUPABASE_USE_PG_DELTA_NEXT=false`, the CLI instead writes the legacy debug bundle under `supabase/.temp/pgdelta/debug/<timestamp>/`:

- `source-catalog.json` — shadow database baseline pg-delta extracted
- `target-catalog.json` — remote database pg-delta extracted
- `pgdelta-stderr.txt` — pg-delta script diagnostics (statement count, schemas)
- `connection.txt` — redacted connection metadata
- `error.txt` — error summary

Legacy catalog files are not written during normal default-engine `db pull` runs. The `.temp/pgdelta` root is used only by legacy compatibility paths; default-engine artifacts are generation-separated under `.temp/pgdelta/v2/`.

For TLS tracing without disabling SSL, use `SUPABASE_SSL_DEBUG=true` alongside `PGDELTA_DEBUG=1`.
