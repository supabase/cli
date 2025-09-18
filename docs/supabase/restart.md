## supabase-restart

Restarts the Supabase local development stack.

Requires `supabase/config.toml` to be created in your current working directory by running `supabase init`.

This command uses Docker's native restart functionality to efficiently restart running containers without fully stopping and starting them. This approach is faster and maintains container state better than separate stop/start operations.

Use the `--all` flag to stop all local Supabase projects instances on the machine.
