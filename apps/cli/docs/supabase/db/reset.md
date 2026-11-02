## supabase-db-reset

Resets a database to a clean state.

Requires the local development stack to be started by running `supabase start`.

Recreates the local Postgres container and applies all local migrations found in `supabase/migrations` directory. If test data is defined in `supabase/seed.sql`, it will be seeded after the migrations are run. Any other data or schema changes made during local development will be discarded.

Use the `--no-seed` flag to skip seeding entirely. To override `[db.seed].sql_paths` for a single reset, pass one or more `--sql-paths` flags. Each value accepts the same file path or glob pattern syntax as `sql_paths`, relative to the `supabase` directory. Passing `--sql-paths` force-enables seeding for that reset even when `[db.seed].enabled = false`.

Resets the local database by default. Pass `--remote` to reset the linked project, or `--remote=<ref|branch|url>` to reset another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

When running db reset with `--remote`, a SQL script is executed to identify and drop all user created entities in the remote database. Since Postgres roles are cluster level entities, any custom roles created through the dashboard or `supabase/roles.sql` will not be deleted by remote reset.

A remote reset asks for one confirmation (default No) after it has worked out what it will do and before anything is dropped. The question lists dropping every user schema, any vault secrets it will upsert, the migrations or schema files it will apply, and the seed files it will run. Declining stops the command without changing the database. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

If you combine `--sql-paths` with `--remote`, the override seed files are applied to the selected remote database after migrations. Use this only when you intend to seed that remote target.
