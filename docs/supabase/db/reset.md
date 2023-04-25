## supabase-db-reset

Resets the local database to a clean state.

Requires the local development stack to be started by running `supabase start`.

Recreates the local Postgres container and applies all local migrations found in `supabase/migrations` directory. If test data is defined in `supabase/seed.sql`, it will be seeded after the migrations are run. Any other data or schema changes made during local development will be discarded.
