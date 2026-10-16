# supabase-test-db

Executes pgTAP tests against the local database.

Requires the local development stack to be started by running `supabase start`.

Runs `pg_prove` in a container with unit test files volume mounted from `supabase/tests` directory. The test file can be suffixed by either `.sql` or `.pg` extension.

Since each test is wrapped in its own transaction, it will be individually rolled back regardless of success or failure.
