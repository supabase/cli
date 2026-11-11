## supabase-db-reset

Recreate a database from your local migrations and seed it, discarding any other data or schema changes. Use it to get a clean database during development.

It resets the local database by default, which requires the local development stack to be started by running `supabase start`. The command recreates the local Postgres container and applies all migrations in `supabase/migrations`. If test data is defined in `supabase/seed.sql`, it is seeded afterwards.

Pass `--remote` to reset the linked project, or `--remote=<ref|branch|url>` to reset another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

## Seeding

Use `--no-seed` to skip seeding entirely. To override `[db.seed].sql_paths` for a single reset, pass one or more `--sql-paths` flags, which accept the same file paths and glob patterns as `sql_paths`, relative to the `supabase` directory. Passing `--sql-paths` enables seeding for that reset even when `[db.seed].enabled = false`.

If you combine `--sql-paths` with `--remote`, the override seed files are applied to the selected remote database after migrations. Use this only when you intend to seed that remote target.

## Resetting a remote database

A remote reset runs a SQL script that drops all user-created entities in the database. Postgres roles are cluster-level entities, so custom roles created through the dashboard or `supabase/roles.sql` are not deleted.

The command asks for one confirmation (default No) after it has worked out what it will do and before anything is dropped. The question lists dropping every user schema, any vault secrets it will upsert, the migrations or schema files it will apply, and the seed files it will run. Declining stops the command without changing the database.

Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell. A `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.
