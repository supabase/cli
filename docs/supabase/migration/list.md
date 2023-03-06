## supabase-migration-list

Lists migrations in both local and remote database.

Local migrations are stored in `supabase/migrations` directory while remote migrations are tracked in `supabase_migrations.schema_migrations` table. Only the timestamps are compared to identify any differences.

You can resolve any discrepancies between local and remote using the `migration repair` command.
