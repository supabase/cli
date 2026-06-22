# `supabase inspect report`

Runs every inspect query against the target Postgres database, writes one CSV per
query into `<output-dir>/<YYYY-MM-DD>/`, then prints a Glamour "rules" summary table
validating those CSVs. Native TypeScript port of `apps/cli-go/internal/inspect/report.go`.

## Files Read

| Path                                           | Format     | When                                                                        |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always — `[experimental.inspect.rules]` (custom rules) + `[db]` subtree     |
| `<workdir>/supabase/.env*` (nested)            | dotenv     | always — `env(VAR)` expansion for `[db]` and rule string fields             |
| `<workdir>/supabase/.temp/pooler-url`          | plain text | `--linked` path (pooler connection string)                                  |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | `--linked` path (resolve linked project ref)                                |
| `~/.supabase/access-token`                     | plain text | `--linked` path, when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14     | CSV        | read back in-memory for rule evaluation                                     |

`config.toml` policy mirrors Go: a **missing** file is fine (defaults apply); a
**malformed** file aborts the command.

## Files Written

| Path                                             | Mode | When                                                            |
| ------------------------------------------------ | ---- | --------------------------------------------------------------- |
| `<output-dir>/<YYYY-MM-DD>/` (directory)         | 0755 | always — created recursively                                    |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14       | 0644 | always — one CSV per inspect query (server-side `COPY ... CSV`) |
| `~/.supabase/telemetry.json`                     | —    | always (telemetry flush)                                        |
| `~/.supabase/<workdir-hash>/linked-project.json` | —    | `--linked` path (linked-project cache)                          |

The 14 CSV basenames (underscored, matching Go's SQL filenames — **not** the
`inspect db` command names): `bloat`, `blocking`, `calls`, `db_stats`,
`index_stats`, `locks`, `long_running_queries`, `outliers`, `replication_slots`,
`role_stats`, `table_stats`, `traffic_profile`, `unused_indexes`, `vacuum_stats`.

The date folder is **local-time** `YYYY-MM-DD`. A relative `--output-dir` resolves
against the process CWD (`utils.CurrentDirAbs`), not `--workdir`; an absolute path
is used as-is.

Re-running on the same day reuses the existing dated folder (mkdir is recursive /
idempotent) and **overwrites** the previous run's CSVs silently — no `--force`,
matching Go. If a `COPY` fails partway through, the CSVs written before the failure
remain on disk (Go writes each file before running the next query), the command
aborts with exit code 1, and the rules summary is not printed.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

Queries run directly against Postgres (server-side `COPY (<query>) TO STDOUT WITH
CSV HEADER`). The Management API is used lazily only on the `--linked` path, to
resolve the connection (via `LegacyDbConfigResolver`).

## Environment Variables

| Variable                | Purpose                                              | Required? |
| ----------------------- | ---------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no        |
| `SUPABASE_API_URL`      | override Management API base URL                     | no        |
| `SUPABASE_DB_*`         | override `[db]` port / shadow_port / password        | no        |
| `SUPABASE_ENV`          | selects which project `.env` files load              | no        |

## Exit Codes

| Code | Condition                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                      |
| `1`  | mkdir failure (`failed to mkdir`)                                                            |
| `1`  | DB connection / resolution failure (not linked, invalid ref, dial failure)                   |
| `1`  | COPY failure (`failed to copy output`) / file-write failure (`failed to create output file`) |
| `1`  | malformed `config.toml`                                                                      |
| `1`  | more than one of `--db-url` / `--linked` / `--local`                                         |

A **per-rule** csvq evaluation error does **not** fail the command — it becomes the
rule's STATUS cell, matching Go.

## Output

### `--output-format text` (Go CLI compatible)

stderr progress, in order:

```
Connecting to <local|remote> database...
Running queries...
Reports saved to <output-dir>/<date>    (path bolded when stdout is a TTY)
Loading default rules...                (only when no custom config.toml rules)
```

stdout: the Glamour `RULE | STATUS | MATCHES` summary table (byte-exact with Go's
`utils.RenderTable`, `AsciiStyle`, `WordWrap(-1)`).

When a rule's csvq query cannot be evaluated (unsupported grammar, unknown table,
or unknown column — e.g. a typo in a custom `config.toml` rule), the **error
message is shown verbatim as that rule's STATUS cell** and the command continues;
it does not fail. This matches Go, where csvq's own error string becomes the cell.
When a rule's match list is longer than 20 characters, the MATCHES cell is
summarized as `<n> matches`, where `<n>` is derived from the comma-separated match
count.

### `--output-format json` / `stream-json` (TS-extra; Go has no machine output)

The CSVs are still written. Progress lines are suppressed and no table is printed;
instead a structured result is emitted:

```json
{ "outputDir": "<abs path>", "files": [{ "name": "locks", "path": "..." }, ...], "rules": [{ "name": "...", "status": "...", "matches": "..." }, ...] }
```
