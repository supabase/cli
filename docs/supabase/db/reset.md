## supabase-db-reset

Resets the local database to a clean state.

Requires the local development stack to be started by running `supabase start`.

Recreates the local Postgres container and applies all local migrations found in `supabase/migrations` directory. If test data is defined in `supabase/seed.sql`, it will be seeded after the migrations are run. Any other data or schema changes made during local development will be discarded.

Note that since Postgres roles are cluster level entities, those changes will persist between resets. In order to reset custom roles, you need to restart the local development stack.
