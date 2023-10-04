# supabase-db-pull

Pulls schema changes from a remote database. A new migration file will be created under `supabase/migrations` directory.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

Optionally, a new row can be inserted into the migration history table to reflect the current state of the remote database.

If no entries exist in the migration history table, `pg_dump` will be used to capture all contents of the remote schemas you have created. Otherwise, this command will only diff schema changes against the remote database, similar to running `db diff --linked`.
