## supabase-db-query

Execute a SQL query against the local or linked database.

When used by an AI coding agent (auto-detected or via --agent=yes), the default
output format is JSON with an untrusted data warning envelope. When used by a
human (--agent=no or no agent detected), the default output format is table
without the envelope.

Without `--local`, `--linked` or `--db-url`, the command targets the local database, unless the workspace target is set to `remote` with `target = "remote"` in `supabase/config.toml` or `SUPABASE_TARGET=remote`, in which case it targets the linked project like `--linked`. A selector flag always wins.
