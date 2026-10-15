# `supabase inspect db <subcommand>`

Single shared side-effect document for all 13 active `inspect db` subcommands and
their 12 deprecated aliases. Every subcommand has the same surface — it resolves the
target from `--db-url` / `--linked` / `--local` / `--project-ref` (else the workspace
`target`, local by default), runs one read-only `SELECT`, and renders the result as an
ASCII table. They differ only in the SQL run and the columns rendered (see the
per-subcommand `<name>.query.ts`). The commands are `selectable` and never ask for
hosted-mutation consent.

## Files Read

| Path                             | Format     | When                                                                                |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML       | always, for the workspace `target` when no selector flag is given; local db host/port/password |
| `<workdir>/supabase/.temp/project-ref` | plain text | linked target without `--project-ref` or `SUPABASE_PROJECT_ID`                  |
| `<workdir>/supabase/.temp/linked-project.json` | JSON | linked target, for the `Target:` banner (no API call)                          |
| `~/.supabase/access-token`       | plain text | linked target only, lazily, when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `.pgpass` / `pg_service.conf`    | libpq      | only if referenced by a `--db-url` connection string                                |
| `$PGSSLROOTCERT` CA bundle       | PEM        | only if a `--db-url` sets `sslrootcert` / `PGSSLROOTCERT`                           |

Connection resolution and all of the above are handled inside
`DbConfigResolver` (`command-internal/db-config.layer.ts`); the command adds
no new config reads.

## Files Written

| Path                         | Format | When                                      |
| ---------------------------- | ------ | ----------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always, post-run (`TelemetryState.flush`) |

## API Routes (MAY fire on a linked target, inside the resolver)

| Method   | Path                                        | Auth         | When                                                                                 |
| -------- | ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`                              | Bearer token | linked target with no ref from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, interactive terminal only (project picker) |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | linked target with no database password, to create a temp login role                  |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | linked target from `--project-ref`, direct host unreachable, no usable saved pooler URL |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | linked target, from the 3rd failed temp-role connect (list bans)                      |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | linked target, only when bans are listed and `--yes` or a shell `SUPABASE_YES` is set (clear a self-ban); otherwise the command fails with `LinkedDbNetworkBannedError` |

## Environment Variables

| Variable                                             | Purpose                                                               | Required?                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `SUPABASE_TARGET`                                    | workspace target (`local` or `remote`) when no selector flag is given | no (defaults to `local`)                |
| `SUPABASE_DB_PASSWORD` / `DB_PASSWORD`               | database password (linked/local)                                      | no (prompts / config fallback)          |
| `SUPABASE_ACCESS_TOKEN`                              | Management API auth (linked only)                                     | no (falls back to keyring / token file) |
| `SUPABASE_PROJECT_ID`                                | project ref once the target is linked, superseded by `--project-ref`  | no (config resolution fallback)         |
| `SUPABASE_YES`                                       | shell value lets a linked connection clear a network ban              | no                                      |
| libpq vars (`PGSSLROOTCERT`, `PGCONNECT_TIMEOUT`, …) | honored when `--db-url` is used                                       | no                                      |

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

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | conflicting target flags, empty `--db-url`/`--project-ref`, resolution, connection, or query failure |
| `1`  | `--project-ref` combined with `--local` or `--db-url`                    |

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

- The target comes from `resolveTarget`: a selector flag wins, then the workspace `target`
  (`SUPABASE_TARGET`, then `config.toml`), then local. `--project-ref` implies `--linked`;
  combining it with `--local` or `--db-url` is an error, as is combining two selectors. A `false`
  switch (`--linked=false`) counts as absent.
- The Management API stack is built lazily, only on a linked target, so a local or `--db-url`
  target never requires an access token.
- All queries are read-only `SELECT`s; the command performs no writes to the database.
- Shared verbatim by every `inspect db` subcommand via `INSPECT_DB_FLAGS`.
