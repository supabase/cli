# supabase-db-pull

Pulls schema changes from a database. A new migration file will be created under `supabase/migrations` directory.

Pulls from the local database by default. Pass `--remote` to pull from the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to pull from another project, a branch of the linked project, or a database URL such as a self-hosted database. In a linked checkout, a run without `--remote` prints a hint naming the linked project. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

> Note this command requires Docker Desktop (or a running Docker daemon), as it starts a local Postgres container to diff the schema you pull.

After the migration file is written, a new row is inserted into the migration history table to reflect the current state of the database. A hosted database asks for one confirmation first (default No), after the diff and before any file is written; declining stops the command without writing anything. Non-interactive, JSON and agent runs need `--yes` (or `SUPABASE_YES` in the shell environment, not in `supabase/.env`). A pull from the local database and `--declarative` ask nothing.

If no entries exist in the migration history table, pg-delta (the default diff engine) produces the full migration from the shadow diff alone; with `--diff-engine migra`, the initial pull instead uses `pg_dump` to capture all contents of the schemas you have created. Otherwise, this command will only diff schema changes against the target database, similar to running `db diff --remote`.

Pass `--declarative` to switch to the declarative pg-delta export workflow instead of writing a migration file. The tree lives in `supabase/schemas` by default. Change the location with `experimental.pgdelta.declarative_schema_path`.

On a project that falls back to the legacy migra engine, don't use `--declarative`. The export also points `[db.migrations].schema_paths` at the tree it writes. The next local `db diff` applies those files in lexicographic order without resolving dependencies between them, so it fails when a file sorts before an object it depends on. If you've already run it, re-enable pg-delta, or undo both changes:

1. Delete the files the export wrote to the declarative directory (`supabase/schemas/` by default). Files that were already there are left in place.
2. Restore `[db.migrations].schema_paths` in `config.toml` to its previous value, or remove it if the export added it.

pg-delta plans are execution-aware: when a plan crosses a transaction boundary — for example `ALTER TYPE ... ADD VALUE` followed by a statement that uses the new enum value, which cannot run in the same transaction — `db pull` writes one ordered migration file per plan unit instead of a single file (for example `<ts>_remote_schema_schema_changes.sql` and `<ts+1s>_remote_schema_after_enum_values.sql`), each recorded in the migration history. The common case (a single unit) still produces exactly one `<ts>_remote_schema.sql` file.

By default the emitted SQL is formatted with the same settings the declarative export uses (uppercase keywords, wrapped at a max width of 180, indented and column-aligned). Configure overrides with `[experimental.pgdelta] format_options` in `config.toml`, or set `format_options = "null"` to opt out and emit raw, unformatted statements.

pg-delta is the default diff engine: the migration-file `db pull` workflow uses pg-delta for the shadow diff step unless configured otherwise; it does not switch to declarative output. With pg-delta, `[db.migrations] schema_paths` does not affect this workflow (migra still reads it, for local targets only); use `supabase db schema declarative sync` for declarative schema files. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]` in `config.toml`, or pass `--diff-engine migra` for a single run.

Under the pg-delta engine, the pull captures your own customizations in Supabase-managed schemas automatically. Examples are triggers on managed tables like `auth.users` and RLS policies on `storage.objects` and `storage.buckets`. Under the legacy migra engine, the initial pull's `pg_dump` skips managed schemas. The diff pass that follows appends your trigger and RLS policy changes there to the same migration. If an older CLI reports that `auth` and `storage` were excluded, capture existing customizations there with `--schema auth,storage`.

When pulling with `--remote=<url>`, prefer a direct connection (`db.<project-ref>.supabase.co:5432`) over the connection pooler so pg-delta can introspect the full catalog reliably.

## Debugging empty pg-delta pulls

If `db pull` reports `No schema changes found` but you expect schema output, set `PGDELTA_DEBUG=1` before running the command. Unlike `--debug`, this keeps SSL enabled for hosted Supabase connections.

```sh
PGDELTA_DEBUG=1 supabase db pull --remote="$DATABASE_URL"
```

When pg-delta returns zero statements, the CLI writes a debug bundle under `supabase/.temp/pgdelta/v2/debug/<timestamp>-diff/` containing the source/desired catalog snapshots, the plan, and coverage diagnostics. Catalog files are not written during normal `db pull` runs.

For TLS tracing without disabling SSL, use `SUPABASE_SSL_DEBUG=true` alongside `PGDELTA_DEBUG=1`.
