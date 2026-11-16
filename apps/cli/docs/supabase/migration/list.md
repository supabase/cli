## supabase-migration-list

Lists the migration files in `supabase/migrations` next to the migration history of the target database.

By default, it lists the migration history of your local database. Pass `--remote` to list the linked project instead, which requires running `supabase link`. Pass `--remote=<ref|branch|url>` to list another project, a branch of the linked project, or a database URL such as a self-hosted database.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

> Note that URL strings must be escaped according to [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986).

Local migrations are stored in `supabase/migrations` directory while the target database tracks applied migrations in the `supabase_migrations.schema_migrations` table. The second column is headed `Remote` for a project or database URL passed with `--remote`, and `Local DB` for the local database. Only the timestamps are compared to identify any differences.

In case of discrepancies between the local and remote migration history, you can resolve them using the `migration repair` command.
