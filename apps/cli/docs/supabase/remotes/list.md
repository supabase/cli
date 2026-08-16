## supabase-remotes-list

Lists the named remote Supabase projects registered in `supabase/config.toml` (or `supabase/config.json`), one row per `[remotes.<name>]` block.

Each row shows the remote's name and the project ref it targets. Use a name with the global `--remote <name>` flag (or the `SUPABASE_REMOTE` environment variable) to target that project for a single invocation, without changing your linked project.

This command performs no network access — it only reads the project config.
