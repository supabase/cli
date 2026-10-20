# `supabase inspect report`

Target: selectable, no consent — see [Command target](../../../../docs/command-target.md)

Runs every inspect query against the target Postgres database, writes one CSV per
query into `<output-dir>/<YYYY-MM-DD>/`, then prints a "rules" summary table
validating those CSVs.

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always — `[experimental.inspect.rules]` (custom rules) and the `[db]` subtree, with a matched `[remotes.<ref>]` block over the base for a remote project                               |
| `<workdir>/supabase/.env*` (nested)            | dotenv     | always — `env(VAR)` expansion for `[db]` and rule string fields                                                                                                                        |
| `<workdir>/supabase/.temp/pooler-url`          | plain text | remote project (pooler connection string)                                                                                                                                              |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                            |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `<output-dir>/<YYYY-MM-DD>/<name>.csv` ×14     | CSV        | read back in-memory for rule evaluation                                                                                                                                                |

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

Local targets and database URLs make none.

| Method   | Path                                        | Auth         | Request body                              | Response (used fields)                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`                              | Bearer token | none                                      | `[{id, name, organization_slug, region}]` — project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format                                                                                                                       |
| `GET`    | `/v1/projects/{parent}/branches`            | Bearer token | none                                      | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                                                                 |
| `GET`    | `/v1/branches/{id}`                         | Bearer token | none                                      | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                                                                                         |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }`                    | temporary `role` and `password` — remote project with no database password                                                                                                                                                                                                                                               |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string` — remote project on an IPv4-only network (direct host unreachable), only when there is no usable saved `.temp/pooler-url`; a ref that differs from the linked project ignores the saved URL                                                                                           |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses` — remote project, from the 3rd failed temporary-role connect                                                                                                                                                                                                                                     |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none — remote project, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clears every listed address, announced on stderr as `Removing network bans (...)`); otherwise the connect keeps retrying and fails with `LinkedDbNetworkBannedError` once the retries run out while bans are still listed |

Queries run directly against Postgres (server-side `COPY (<query>) TO STDOUT WITH
CSV HEADER`). The Management API is used lazily only for a remote project or a branch lookup, to
resolve the connection (via `DbConfigResolver`); a network ban is cleared there only under
`--yes` or a shell `SUPABASE_YES`, otherwise the command fails with `LinkedDbNetworkBannedError` once the
connect retries run out while bans are still listed.

## Environment Variables

| Variable                | Purpose                                                                           | Required?                                              |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_PROJECT_ID`   | project ref for a bare `--remote`, and the parent project for `--remote=<branch>` | no                                                     |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                              | no                                                     |
| `SUPABASE_YES`          | shell value lets a remote connection clear a network ban                          | no                                                     |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                           | no (falls back to `~/.supabase/profile` -> `supabase`) |
| `SUPABASE_DB_*`         | override `[db]` port / shadow_port / password                                     | no                                                     |
| `SUPABASE_ENV`          | selects which project `.env` files load                                           | no                                                     |

## Exit Codes

| Code | Condition                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                      |
| `1`  | mkdir failure (`failed to mkdir`)                                                            |
| `1`  | DB connection / resolution failure (not linked, invalid ref, dial failure)                   |
| `1`  | COPY failure (`failed to copy output`) / file-write failure (`failed to create output file`) |
| `1`  | malformed `config.toml`                                                                      |

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
