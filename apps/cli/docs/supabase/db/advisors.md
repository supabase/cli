## supabase-db-advisors

Inspects the database for common security and performance issues such as missing RLS policies, unindexed foreign keys, exposed auth.users, and more.

Without `--local`, `--linked` or `--db-url`, the command targets the local database, unless the workspace target is set to `remote` with `target = "remote"` in `supabase/config.toml` or `SUPABASE_TARGET=remote`, in which case it targets the linked project like `--linked` (including with `--project-ref`) and prints `Targeting the linked project (target = "remote" from <source>)` on stderr. A selector flag always wins.
