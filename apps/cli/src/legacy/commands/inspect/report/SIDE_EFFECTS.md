# `supabase inspect report`

Runs every inspect query against the target Postgres database, writes one CSV per
query into `<output-dir>/<YYYY-MM-DD>/`, then prints a Glamour "rules" summary table
validating those CSVs.

## Files Read

| Path                                           | Format     | When                                                                        |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always — `[experimental.inspect.rules]` (custom rules) + `[db]` subtree     |
| `<workdir>/supabase/.env*` (nested)            | dotenv     | always — `env(VAR)` expansion for `[db]` and rule string fields             |
| `<workdir>/supabase/.temp/pooler-url`          | plain text | `--linked` path (pooler connection string)                                  |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | `--linked` path (resolve linked project ref)                                |
| `~/.supabase/access-token`                     | plain text | `--linked` path, when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14     | CSV        | read back in-memory for rule evaluation                                     |

A **missing** `config.toml` is fine (defaults apply); a
**malformed** file aborts the command.

## Files Written

| Path                                             | Mode | When                                                            |
| ------------------------------------------------ | ---- | --------------------------------------------------------------- |
| `<output-dir>/<YYYY-MM-DD>/` (directory)         | 0755 | always — created recursively                                    |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14       | 0644 | always — one CSV per inspect query (server-side `COPY ... CSV`) |
| `~/.supabase/telemetry.json`                     | —    | always (telemetry flush)                                        |
| `~/.supabase/<workdir-hash>/linked-project.json` | —    | `--linked` path (linked-project cache)                          |

The 14 CSV basenames (underscored, matching the SQL filenames — **not** the
`inspect db` command names): `bloat`, `blocking`, `calls`, `db_stats`,
`index_stats`, `locks`, `long_running_queries`, `outliers`, `replication_slots`,
`role_stats`, `table_stats`, `traffic_profile`, `unused_indexes`, `vacuum_stats`.

The date folder is **local-time** `YYYY-MM-DD`. A relative `--output-dir` resolves
against the process CWD, not `--workdir`; an absolute path is used as-is.

Re-running on the same day reuses the existing dated folder (mkdir is recursive /
idempotent) and **overwrites** the previous run's CSVs silently — no `--force`.
If a `COPY` fails partway through, the CSVs from queries that already
completed remain on disk (both sides write each file before running the next query),
the command aborts with exit code 1, and the rules summary is not printed.

**Divergence on the query that was in flight when `COPY` failed:** the old Go
CLI's `copyToCSV` opened the output file
with `O_TRUNC` _before_ running the query, then streamed `COPY ... TO STDOUT` directly
into it — so a failing/erroring `COPY` still left that query's `<name>.csv` on disk,
empty or partially written. TS buffers the `COPY` result in memory
(`session.copyToCsv`) and only calls `fs.writeFile` after it succeeds
(`report.handler.ts`) — so on a fresh run, TS leaves **no file at all** for the query
that failed, where the old CLI left an empty (or partial) one. On a same-day
**re-run**, the difference is the opposite way round: the old CLI's `O_TRUNC`
destroyed that query's previous CSV (leaving it empty), while TS never touches
the file at all, so the **previous run's stale CSV is left in place** — a user
re-reading that file gets old data with no indication it wasn't refreshed this
run, where the old CLI at least made the failure visible as an empty file.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

Queries run directly against Postgres (server-side `COPY (<query>) TO STDOUT WITH
CSV HEADER`). The Management API is used lazily only on the `--linked` path, to
resolve the connection (via `LegacyDbConfigResolver`).

## Environment Variables

| Variable                | Purpose                                              | Required?                                              |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no                                                     |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`) |
| `SUPABASE_DB_*`         | override `[db]` port / shadow_port / password        | no                                                     |
| `SUPABASE_ENV`          | selects which project `.env` files load              | no                                                     |

## Exit Codes

| Code | Condition                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                      |
| `1`  | mkdir failure (`failed to mkdir`)                                                            |
| `1`  | DB connection / resolution failure (not linked, invalid ref, dial failure)                   |
| `1`  | COPY failure (`failed to copy output`) / file-write failure (`failed to create output file`) |
| `1`  | malformed `config.toml`                                                                      |
| `1`  | more than one of `--db-url` / `--linked` / `--local`                                         |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes)                     |

A **per-rule** csvq evaluation error does **not** fail the command — it becomes the
rule's STATUS cell.

## Output

### `--output-format text`

stderr progress, in order:

```
Connecting to <local|remote> database...
Running queries...
Reports saved to <output-dir>/<date>    (path bolded when stdout is a TTY)
Loading default rules...                (only when no custom config.toml rules)
```

stdout: the Glamour `RULE | STATUS | MATCHES` summary table (byte-exact using
`utils.RenderTable`, `AsciiStyle`, `WordWrap(-1)`).

When a rule's csvq query cannot be evaluated (unsupported grammar, unknown table,
or unknown column — e.g. a typo in a custom `config.toml` rule), the **error
message is shown verbatim as that rule's STATUS cell** and the command continues;
it does not fail — csvq's own error string becomes the cell.
When a rule's match list is longer than 20 characters, the MATCHES cell is
summarized as `<n> matches`, where `<n>` is derived from the comma-separated match
count.

### `--output-format json` / `stream-json` (additive; there is no other machine output)

The CSVs are still written. Progress lines are suppressed and no table is printed;
instead a structured result is emitted:

```json
{ "outputDir": "<abs path>", "files": [{ "name": "locks", "path": "..." }, ...], "rules": [{ "name": "...", "status": "...", "matches": "..." }, ...] }
```

## Notes

- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution `LegacyDbConfigResolver` performs
  (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies
  `--linked`: passing it with a resolved `--local`/`--db-url` target is a hard
  error rather than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target).
