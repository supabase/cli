## supabase-stop

Stops the Supabase local development stack.

Requires a project config in your current working directory: the `supabase/config.jsonc` that `supabase init` creates, or an existing `supabase/config.json` or `supabase/config.toml`.

All Docker resources are maintained across restarts. Use `--no-backup` flag to reset your local development data between restarts.

Use the `--all` flag to stop all local Supabase projects instances on the machine. Use with caution with `--no-backup` as it will delete all supabase local projects data.
