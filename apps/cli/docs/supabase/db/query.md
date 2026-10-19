## supabase-db-query

Execute a SQL query against a database.

Runs against the local database by default. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

The command cannot tell a read from a write, so a hosted database (the linked project or a remote database URL) asks for one confirmation (default No) before the statement is sent. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

Pass `--read-only` to run a statement that must not change anything. It skips the confirmation on a hosted database. Before the statement is sent or any question is asked, every statement must start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` or a parenthesised query (after whitespace and comments). Any other statement (`COMMIT`, `SET`, `CALL`, `DO`, `COPY`, `LOCK` and so on), input that ends inside a comment, quote or dollar quote, and input containing `BEGIN ATOMIC` is rejected. Drop `--read-only` to run one of these.

The local database or a database URL then runs the statement in a read-only transaction that is always rolled back, with a 5 second `lock_timeout` so the read cannot wait on heavy locks; Postgres rejects writes inside it. A linked project runs it through the Management API's `read_only` mode, and the API enforces it.

`--read-only` does not stop a read statement from calling a function that has side effects, such as `pg_terminate_backend` or `dblink_exec`; those still run.

When used by an AI coding agent (auto-detected or via --agent=yes), the default
output format is JSON with an untrusted data warning envelope. When used by a
human (--agent=no or no agent detected), the default output format is table
without the envelope.
