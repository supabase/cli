## supabase-stop

Stops the containers of the local development stack. Requires a `supabase/config.toml`, which `supabase init` creates.

Docker volumes are kept, so your data survives a restart. Pass `--no-backup` to delete them and reset your local data.

Pass `--all` to stop every local Supabase project on the machine. Take care combining it with `--no-backup`, which deletes the data of all of them.
