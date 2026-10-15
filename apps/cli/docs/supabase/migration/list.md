## supabase-migration-list

Lists migration history in both local and remote databases.

By default, it lists the migration history of your local database. Pass `--linked` (or `--project-ref`) to list the linked project instead, or set `target = "remote"` in your project config (or `SUPABASE_TARGET=remote`) to make the linked project the default. Linking requires running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

> Note that URL strings must be escaped according to [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986).

Local migrations are stored in `supabase/migrations` directory while remote migrations are tracked in `supabase_migrations.schema_migrations` table. Only the timestamps are compared to identify any differences.

In case of discrepancies between the local and remote migration history, you can resolve them using the `migration repair` command.
