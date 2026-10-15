## supabase-db-advisors

Inspects the database for common security and performance issues such as missing RLS policies, unindexed foreign keys, exposed auth.users, and more.

With no target flag the command inspects the workspace target, which is the local database unless `SUPABASE_TARGET` or `target` in `config.toml` says otherwise. Pass `--linked` for the linked project or `--db-url` for another database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.
