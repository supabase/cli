# `supabase inspect report`

Runs every inspect query against the target Postgres database, writes one CSV per
query into `<output-dir>/<YYYY-MM-DD>/`, then prints a "rules" summary table
validating those CSVs. The target is `--db-url` / `--linked` / `--local` / `--project-ref`,
else the workspace `target` (local by default). The command is `selectable` and never asks
for hosted-mutation consent.

## Files Read

| Path                                           | Format     | When                                                                                       |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`               | TOML       | always — `[experimental.inspect.rules]` (custom rules), `[db]` subtree, workspace `target` |
| `<workdir>/supabase/.env*` (nested)            | dotenv     | always — `env(VAR)` expansion for `[db]` and rule string fields                            |
| `<workdir>/supabase/.temp/pooler-url`          | plain text | linked target (pooler connection string)                                                   |
| `<workdir>/supabase/.temp/project-ref`         | plain text | linked target, without `--project-ref` or `SUPABASE_PROJECT_ID` (linked project ref)       |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | linked target, for the `Target:` banner (no API call)                                      |
| `~/.supabase/access-token`                     | plain text | linked target, when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                  |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14     | CSV        | read back in-memory for rule evaluation                                                    |

A **missing** `config.toml` is fine (defaults apply); a
**malformed** file, an invalid value (including a non-string rule field such as `query = 123` or
`pass = true`), a single `[experimental.inspect.rules]` table (write `[[experimental.inspect.rules]]`)
or an unknown rule key aborts the command before connecting. Rules and `env(VAR)` expansion come from the shared resolved config
(flag > shell > project `.env*` > config).

## Files Written

| Path                                       | Mode | When                                                            |
| ------------------------------------------ | ---- | --------------------------------------------------------------- |
| `<output-dir>/<YYYY-MM-DD>/` (directory)   | 0755 | always — created recursively                                    |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14 | 0644 | always — one CSV per inspect query (server-side `COPY ... CSV`) |
| `~/.supabase/telemetry.json`               | —    | always (telemetry flush)                                        |

The 14 CSV basenames (underscored, matching the SQL filenames — **not** the
`inspect db` command names): `bloat`, `blocking`, `calls`, `db_stats`,
`index_stats`, `locks`, `long_running_queries`, `outliers`, `replication_slots`,
`role_stats`, `table_stats`, `traffic_profile`, `unused_indexes`, `vacuum_stats`.

The date folder is **local-time** `YYYY-MM-DD`. A relative `--output-dir` resolves
against the process CWD, not `--workdir`; an absolute path is used as-is.

Re-running on the same day reuses the existing dated folder (mkdir is recursive /
idempotent) and **overwrites** the previous run's CSVs silently — no `--force`.
If a `COPY` fails partway through, the CSVs from queries that already
completed remain on disk (each file is written before the next query runs),
the command aborts with exit code 1, and the rules summary is not printed.

**The query that was in flight when `COPY` failed:** TS buffers the `COPY` result in memory
(`session.copyToCsv`) and only calls `fs.writeFile` after it succeeds
(`report.handler.ts`) — so on a fresh run, a failed query leaves **no file at all**. On a
same-day **re-run**, TS never touches the failed query's file, so the **previous run's stale
CSV is left in place** — a user re-reading that file gets old data with no indication it
wasn't refreshed this run.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

Queries run directly against Postgres (server-side `COPY (<query>) TO STDOUT WITH
CSV HEADER`). The Management API is used lazily only on a linked target, to
resolve the connection (via `DbConfigResolver`); a network ban is cleared there only under
`--yes` or a shell `SUPABASE_YES`, otherwise the command fails with `LinkedDbNetworkBannedError` once the
connect retries run out while bans are still listed.

## Environment Variables

| Variable                | Purpose                                                               | Required?                                              |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_TARGET`       | workspace target (`local` or `remote`) when no selector flag is given | no (defaults to `local`)                               |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                  | no                                                     |
| `SUPABASE_YES`          | shell value lets a linked connection clear a network ban              | no                                                     |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                               | no (falls back to `~/.supabase/profile` -> `supabase`) |
| `SUPABASE_DB_*`         | override `[db]` port / shadow_port / password                         | no                                                     |
| `SUPABASE_ENV`          | selects which project `.env` files load                               | no                                                     |

## Exit Codes

| Code | Condition                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                        |
| `1`  | mkdir failure (`failed to mkdir`)                                                              |
| `1`  | DB connection / resolution failure (not linked, invalid ref, dial failure)                     |
| `1`  | COPY failure (`failed to copy output`) / file-write failure (`failed to create output file`)   |
| `1`  | malformed `config.toml`                                                                        |
| `1`  | more than one of `--db-url` / `--linked` / `--local`, or an empty `--db-url` / `--project-ref` |
| `1`  | `--project-ref` combined with `--local` or `--db-url`                                          |

A **per-rule** csvq evaluation error does **not** fail the command — it becomes the
rule's STATUS cell.

## Output

### `--output-format text`

stderr progress, in order:

```
Target: <resolved target>
Running queries...
Reports saved to <output-dir>/<date>    (path bolded when stdout is a TTY)
Loading default rules...                (only when no custom config.toml rules)
```

stdout: the `RULE | STATUS | MATCHES` summary table.

When a rule's csvq query cannot be evaluated (unsupported grammar, unknown table,
or unknown column — e.g. a typo in a custom `config.toml` rule), the **error
message is shown verbatim as that rule's STATUS cell** and the command continues;
it does not fail — csvq's own error string becomes the cell.
When a rule's match list is longer than 20 characters, the MATCHES cell is
summarized as `<n> matches`, where `<n>` is derived from the comma-separated match
count.

### `--output-format json` / `stream-json` (additive; there is no other machine output)

The CSVs are still written. Progress lines are suppressed and no table is printed;
instead a structured result is emitted. The stderr `Target:` banner is still printed.

```json
{ "outputDir": "<abs path>", "files": [{ "name": "locks", "path": "..." }, ...], "rules": [{ "name": "...", "status": "...", "matches": "..." }, ...], "target": { ... } }
```

## Notes

- The target comes from `resolveTarget`: a selector flag wins, then the workspace `target`
  (`SUPABASE_TARGET`, then `config.toml`), then local. `--project-ref` implies `--linked`;
  combining it with `--local` or `--db-url` is an error, as is combining two selectors. A `false`
  switch (`--linked=false`) counts as absent.
