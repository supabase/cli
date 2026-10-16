## supabase-migration-list

Lists the migration files in `supabase/migrations` next to the migration history of the target database.

By default, it lists the migration history of your local database. Pass `--linked` (or `--project-ref`) to list the linked project instead, or set `target = "remote"` in your project config (or `SUPABASE_TARGET=remote`) to make the linked project the default. Linking requires running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

> Note that URL strings must be escaped according to [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986).

Local migrations are stored in `supabase/migrations` directory while the target database tracks applied migrations in the `supabase_migrations.schema_migrations` table. The second column is headed `Remote` for a linked project or `--db-url` database, and `Local DB` for the local database. Only the timestamps are compared to identify any differences.

In case of discrepancies between the local and remote migration history, you can resolve them using the `migration repair` command.
