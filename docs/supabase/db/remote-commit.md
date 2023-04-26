# supabase-db-remote-commit

Pulls schema changes from a remote database and inserts a new row into the migration history table.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

If no entries exist in the migration history table, `pg_dump` will be used to capture all contents of the remote schemas you have created. After that, a new record will be inserted into the migration history table. Subsequent runs of this command will only diff schema changes against the remote database similar to `db diff --linked`.
