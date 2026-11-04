## supabase-start

Runs the Supabase local development stack (Postgres, Auth, Storage, Studio, and more) in Docker. Requires a `supabase/config.toml`, which `supabase init` creates.

All service containers start by default. Skip the ones you don't need with `-x`, either as a comma-separated list such as `-x gotrue,imgproxy` or by repeating the flag.

> Starting all services needs at least 7GB of RAM.

The CLI health-checks the started containers. Pass `--ignore-health-check` to continue past unhealthy services.

> If the CLI runs inside a dev container with the Docker socket bind-mounted, set `SUPABASE_SERVICES_HOSTNAME` to a hostname reachable from inside that container, such as `host.docker.internal`.
