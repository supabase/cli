# supabase-test-db

Executes pgTAP tests against the local database.

Requires the local development stack to be started by running `supabase start`.

With no target flag the command tests the workspace target, which is the local database unless `SUPABASE_TARGET` or `target` in `config.toml` says otherwise. Pass `--linked` for the linked project or `--db-url` for another database. The command prints a `Target:` line on stderr naming the database it resolved.

Running the tests enables the pgTAP extension and drops it again afterwards, so a hosted database (the linked project or a remote `--db-url`) asks for one confirmation (default No) before anything runs. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

Runs `pg_prove` in a container with unit test files volume mounted from `supabase/tests` directory. The test file can be suffixed by either `.sql` or `.pg` extension.

Since each test is wrapped in its own transaction, it will be individually rolled back regardless of success or failure.
