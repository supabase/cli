## supabase-db-query

Execute a SQL query against the local or linked database.

With no target flag the command runs against the workspace target, which is the local database unless `SUPABASE_TARGET` or `target` in `config.toml` says otherwise. Pass `--linked` for the linked project or `--db-url` for another database. The command prints a `Target:` line on stderr naming the database it resolved.

The command cannot tell a read from a write, so a hosted database (the linked project or a remote `--db-url`) asks for one confirmation (default No) before the statement is sent. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

Pass `--read-only` to run a statement that must not change anything. It skips the confirmation on a hosted database and makes the statement unable to write: a linked project runs it as a read-only query through the Management API, and the local database or a `--db-url` database runs it in a read-only transaction that is always rolled back. `--read-only` rejects, before the statement is sent or any question is asked, any statement that begins or ends a transaction (`BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ABORT`, `ROLLBACK`, `PREPARE TRANSACTION`) or changes read-only mode (`SET TRANSACTION`, `SET SESSION CHARACTERISTICS`, `SET` or `RESET` of `transaction_read_only` or `default_transaction_read_only`, `RESET ALL`). Drop `--read-only` to run one of these.

When used by an AI coding agent (auto-detected or via --agent=yes), the default
output format is JSON with an untrusted data warning envelope. When used by a
human (--agent=no or no agent detected), the default output format is table
without the envelope.
