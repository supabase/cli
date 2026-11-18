## supabase-db-advisors

Check a database for common security and performance issues, such as missing RLS policies, unindexed foreign keys, and an exposed `auth.users`. Run it before a release or in CI.

It inspects the local database by default. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
