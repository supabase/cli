## supabase-start

Starts the Supabase local development stack.

Requires a project config in your current working directory: the `supabase/config.jsonc` that `supabase init` creates, or an existing `supabase/config.json` or `supabase/config.toml`.

All service containers are started by default. The `-x` flag accepts comma-separated service names or repeated occurrences.

> It is recommended to have at least 7GB of RAM to start all services.

Health checks are automatically added to verify the started containers. Use `--ignore-health-check` flag to ignore these errors.

> If the CLI is running inside a dev container with the Docker socket bind-mounted, set the `SUPABASE_SERVICES_HOSTNAME` environment variable to the hostname reachable from inside that container, such as `host.docker.internal`.
