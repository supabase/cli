# supabase-test-db

Executes pgTAP tests against the local database.

Requires the local development stack to be started by running `supabase start`.

Runs `pg_prove` in a container with unit test files volume mounted from `supabase/tests` directory. The test file can be suffixed by either `.sql` or `.pg` extension.

Since each test is wrapped in its own transaction, it will be individually rolled back regardless of success or failure.

## Running tests against a shadow database

Pass `--use-shadow-db` to run tests against an ephemeral shadow database instead of the local dev database. When this flag is set, the CLI:

1. Spins up a temporary Postgres container
2. Replays all local migrations from `supabase/migrations`
3. Runs the pgTAP tests against this clean database
4. Destroys the container when finished

Your local dev database is never touched, making this ideal for CI pipelines and ensuring tests always run against a clean, migration-defined schema.

The shadow database uses the `shadow_port` configured in `config.toml` (default `54320`) — the same port used by `db diff`. Because they share this port, you cannot run `db diff` and `db test --use-shadow-db` simultaneously.
