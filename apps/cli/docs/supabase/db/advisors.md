## supabase-db-advisors

`supabase db advisors` is planned for deprecation in a future release. It remains available alongside `supabase issues`. Existing flags, defaults, output, and exit behavior remain supported. An informational migration notice is written to stderr.

Inspects the database for common security and performance issues such as missing RLS policies, unindexed foreign keys, exposed auth.users, and more.

Inspects the local database by default. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
