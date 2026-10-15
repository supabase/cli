## supabase-migration-list

Lists migration history in both local and remote databases.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.

> Note that URL strings must be escaped according to [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986).

Local migrations are stored in `supabase/migrations` directory while remote migrations are tracked in `supabase_migrations.schema_migrations` table. Only the timestamps are compared to identify any differences.

In case of discrepancies between the local and remote migration history, you can resolve them using the `migration repair` command.
