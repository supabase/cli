# `supabase inspect db <subcommand>`

Single shared side-effect document for all 13 active `inspect db` subcommands and
their 12 deprecated aliases. Every subcommand has the same surface — it resolves the
target from `--remote` (or a deprecated alias; local by default), runs one read-only
`SELECT`, and renders the result as an ASCII table. They differ only in the SQL run and
the columns rendered (see the per-subcommand `<name>.query.ts`). The commands are
`selectable` and never ask for hosted-mutation consent.

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                   |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always, for the `[db]` settings, with a matched `[remotes.<ref>]` block over the base for a remote project (flag > shell env > project `.env*` > config)                               |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                            |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project (or a branch is looked up)                                                                                       |
| `.pgpass` / `pg_service.conf`                  | libpq      | only if referenced by a database URL (`--remote=<db-url>`)                                                                                                                             |
| `$PGSSLROOTCERT` CA bundle                     | PEM        | only if a database URL sets `sslrootcert` / `PGSSLROOTCERT`                                                                                                                            |

Connection resolution and all of the above are handled inside
`DbConfigResolver` (`command-internal/db-config.layer.ts`); the command adds
no new config reads.

## Files Written

| Path                         | Format | When                                      |
| ---------------------------- | ------ | ----------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always, post-run (`TelemetryState.flush`) |

## API Routes (MAY fire on a remote project, inside the resolver)

Local targets and database URLs make none.

| Method   | Path                                        | Auth         | Request body                              | Response (used fields)                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`                              | Bearer token | none                                      | `[{id, name, organization_slug, region}]` — project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format                                                                                                                       |
| `GET`    | `/v1/projects/{parent}/branches`            | Bearer token | none                                      | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                                                                 |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `{ read_only: false }`                    | temporary `role` and `password` — remote project with no database password                                                                                                                                                                                                                                               |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | none                                      | primary pooler `connection_string` — remote project on an IPv4-only network (direct host unreachable), only when the ref came from `--remote=<ref>` or `--remote=<branch>`, or differs from the linked project; a differing ref ignores the saved `.temp/pooler-url`                                                     |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | none                                      | `banned_ipv4_addresses` — remote project, from the 3rd failed temporary-role connect                                                                                                                                                                                                                                     |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `{ ipv4_addresses, requester_ip: false }` | none — remote project, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clears every listed address, announced on stderr as `Removing network bans (...)`); otherwise the connect keeps retrying and fails with `LinkedDbNetworkBannedError` once the retries run out while bans are still listed |

## Environment Variables

| Variable                                             | Purpose                                                                           | Required?                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| `SUPABASE_DB_PASSWORD` / `DB_PASSWORD`               | database password (linked/local)                                                  | no (prompts / config fallback)          |
| `SUPABASE_ACCESS_TOKEN`                              | Management API auth (remote project only)                                         | no (falls back to keyring / token file) |
| `SUPABASE_PROJECT_ID`                                | project ref for a bare `--remote`, and the parent project for `--remote=<branch>` | no (config resolution fallback)         |
| `SUPABASE_YES`                                       | shell value lets a remote connection clear a network ban                          | no                                      |
| libpq vars (`PGSSLROOTCERT`, `PGCONNECT_TIMEOUT`, …) | honored when a database URL is used                                               | no                                      |

## Database Queries

Each subcommand runs one read-only `SELECT` (the embedded `<name>.sql`). The
5 schema-filtered queries take `$1` = the LIKE-escaped internal-schema list;
`db-stats` additionally takes `$2` = the database name.

| Subcommand           | SQL file                 | InternalSchemas param?      |
| -------------------- | ------------------------ | --------------------------- |
| db-stats             | db_stats.sql             | yes (`$1`) + db name (`$2`) |
| index-stats          | index_stats.sql          | yes (`$1`)                  |
| bloat                | bloat.sql                | yes (`$1`)                  |
| vacuum-stats         | vacuum_stats.sql         | yes (`$1`)                  |
| table-stats          | table_stats.sql          | yes (`$1`)                  |
| replication-slots    | replication_slots.sql    | no                          |
| locks                | locks.sql                | no                          |
| blocking             | blocking.sql             | no                          |
| outliers             | outliers.sql             | no                          |
| calls                | calls.sql                | no                          |
| long-running-queries | long_running_queries.sql | no                          |
| role-stats           | role_stats.sql           | no                          |
| traffic-profile      | traffic_profile.sql      | no                          |

Deprecated aliases run an active subcommand's query: `cache-hit`→db-stats;
`index-usage`/`index-sizes`/`unused-indexes`/`seq-scans`/`table-record-counts`→index-stats;
`table-sizes`→table-stats;
`role-configs`/`role-connections`→role-stats. (`table-record-counts` warns
"table-stats" but runs index-stats — an inconsistency that is preserved.)

`total-index-size` (→ `index-stats`), `total-table-sizes` and `table-index-sizes`
(→ `table-stats`) are removed and unlisted. They still accept the `inspect`
flags, run no query and open no connection, and exit 1 with
`supabase inspect db <name> was removed.` plus the replacement suggestion
(`RemovedSurfaceError`, `error_fingerprint` ending in `:removed_command`).

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                |
| `1`  | conflicting target selectors, empty `--db-url`/`--project-ref`, resolution, connection, or query failure               |
| `1`  | `--project-ref` combined with `--local`, `--db-url` or `--remote=<value>`                                              |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom telemetry events beyond `cli_command_executed`.

## Output

### `--output-format text`

An ASCII table:
a leading blank line, a decorative line, the header row, a dashes separator, then one
row per result. Statement/query cells (locks, blocking, outliers, calls) have their
whitespace runs collapsed to single spaces (long-running-queries' query is NOT
collapsed). One `Target: …` banner naming the resolved target is written to
**stderr** before the query runs.

### `--output-format json`

A single object: `{ "rows": [ <raw driver rows, snake_case keys> ], "target": { … } }`,
where `target` describes the resolved target. The stderr banner is still printed.

### `--output-format stream-json`

A `result` event carrying the same `{ rows }` payload.

### Deprecated aliases

Emit one extra stderr line before the table:
`Command "<name>" is deprecated, use "<target>" instead.`

## Notes

- **Target.** With no selector the command runs against the local database; when the directory is
  linked the local `Target:` banner ends with `· default; pass --remote for <project>`. `--remote`
  targets the linked project (`SUPABASE_PROJECT_ID`, else `.temp/project-ref`). `--remote=<value>`
  is read as a project ref (20 lowercase letters), a database URL (`postgres://` or
  `postgresql://`), `true|yes|on|1` (the linked project), or otherwise the name of a branch of the
  linked project, which resolves to that branch's own project. `false|no|off|0`, `--no-remote` and
  an empty value fail with `Leave out --remote to target the local database.` A bare `--remote`
  followed by a word that is a branch of the linked project fails with a
  `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value. The
  resolved target is announced on stderr (`Target: …`) in every output format and, in JSON results,
  as a `target` object.
- **Deprecated selectors.** `--linked`, `--project-ref`, `--db-url` and `--local` are hidden aliases
  that still select their target and print a warning on stderr naming the replacement, for example
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase inspect db locks --remote`
  and
  `--local isn't needed (local is the default) and will be removed in v4: supabase inspect db locks`;
  a database URL is never echoed. Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` cannot
  be combined with `--local`, `--db-url` or `--remote=<value>`, an empty `--db-url` or
  `--project-ref` is rejected, and `--linked=false` selects nothing.
- The Management API stack is built lazily, only for a remote project or a branch lookup, so a
  local or database-URL target never requires an access token.
- All queries are read-only `SELECT`s; the command performs no writes to the database.
- Shared verbatim by every `inspect db` subcommand via `INSPECT_DB_FLAGS`.
