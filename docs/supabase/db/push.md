## supabase-db-push

Pushes all local migrations to a remote database.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

The first time this command is run, a migration history table will be created under `supabase_migrations.schema_migrations`. After successfully applying a migration, a new row will be inserted into the migration history table with timestamp as its unique id. Subsequent pushes will skip migrations that have already been applied.

If you need to mutate the migration history table, such as deleting existing entries or inserting new entries without actually running the migration, use the `migration repair` command.

Use the `--dry-run` flag to view the list of changes before applying.
