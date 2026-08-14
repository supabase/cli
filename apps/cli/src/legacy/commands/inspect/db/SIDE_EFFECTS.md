# `supabase inspect db <subcommand>`

Single shared side-effect document for all 13 active `inspect db` subcommands and
their 12 deprecated aliases. Every subcommand has the same surface — it resolves a
Postgres connection from `--db-url` / `--linked` / `--local`, runs one read-only
`SELECT`, and renders the result as a Glamour ASCII table. They differ only in the
SQL run and the columns rendered (see the per-subcommand `<name>.query.ts`).

## Files Read

| Path                             | Format     | When                                                                                |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML       | `--local` (db host/port/password); `--linked` (project ref)                         |
| `~/.supabase/access-token`       | plain text | `--linked` only, lazily, when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `.pgpass` / `pg_service.conf`    | libpq      | only if referenced by a `--db-url` connection string                                |
| `$PGSSLROOTCERT` CA bundle       | PEM        | only if a `--db-url` sets `sslrootcert` / `PGSSLROOTCERT`                           |

Connection resolution and all of the above are handled inside the already-ported
`LegacyDbConfigResolver` (`legacy/shared/legacy-db-config.layer.ts`); this port adds
no new config reads.

## Files Written

| Path                         | Format | When                                            |
| ---------------------------- | ------ | ----------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always, post-run (`LegacyTelemetryState.flush`) |

## API Routes (MAY fire on `--linked`, inside the resolver)

| Method   | Path                                      | Auth         | When                                    |
| -------- | ----------------------------------------- | ------------ | --------------------------------------- |
| `POST`   | `/v1/projects/{ref}/login-role`           | Bearer token | `--linked`, to create a temp login role |
| `GET`    | pooler config endpoint                    | Bearer token | `--linked`, pooler fallback             |
| `GET`    | `/v1/projects/{ref}/network-bans`         | Bearer token | `--linked`, on pooler retry             |
| `DELETE` | `/v1/projects/{ref}/network-bans` (unban) | Bearer token | `--linked`, when a self-ban is detected |

## Environment Variables

| Variable                                             | Purpose                                                               | Required?                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `SUPABASE_DB_PASSWORD` / `DB_PASSWORD`               | database password (linked/local)                                      | no (prompts / config fallback)          |
| `SUPABASE_ACCESS_TOKEN`                              | Management API auth (linked only)                                     | no (falls back to keyring / token file) |
| `SUPABASE_PROJECT_ID`                                | project ref fallback (linked), superseded by `--project-ref` when set | no (config resolution fallback)         |
| libpq vars (`PGSSLROOTCERT`, `PGCONNECT_TIMEOUT`, …) | honored when `--db-url` is used                                       | no                                      |

## Database Queries

Each subcommand runs one read-only `SELECT` (the embedded Go `<name>.sql`). The
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
`index-usage`/`total-index-size`/`index-sizes`/`unused-indexes`/`seq-scans`/`table-record-counts`→index-stats;
`table-sizes`/`table-index-sizes`/`total-table-sizes`→table-stats;
`role-configs`/`role-connections`→role-stats. (`table-record-counts` warns
"table-stats" but runs index-stats — an inconsistency inherited from the old
Go CLI, preserved verbatim.)

## Exit Codes

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | mutually-exclusive flags, resolution, connection, or query failure       |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom telemetry events beyond `cli_command_executed`.

## Output

### `--output-format text`

A Glamour ASCII table (byte-exact using `glamour.RenderTable(..., AsciiStyle)`):
a leading blank line, a decorative line, the header row, a dashes separator, then one
row per result. Statement/query cells (locks, blocking, outliers, calls) have their
whitespace runs collapsed to single spaces (long-running-queries' query is NOT
collapsed). The "Connecting to local/remote database..." diagnostic is
written to **stderr** before the query runs.

### `--output-format json`

A single object: `{ "rows": [ <raw driver rows, snake_case keys> ] }`. Additive —
there is no other machine output for inspect.

### `--output-format stream-json`

A `result` event carrying the same `{ rows }` payload.

### Deprecated aliases

Emit one extra stderr line before the table:
`Command "<name>" is deprecated, use "<target>" instead.`

## Notes

- The Management API stack is built lazily, only on the `--linked` path, so `--local`
  and `--db-url` never require an access token.
- `--linked` defaults to `true`; the runner derives it
  from the absence of `--db-url` / `--local` while keeping the mutual-exclusivity check
  keyed off explicitly-set flags.
- All queries are read-only `SELECT`s; the command performs no writes to the database.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution `LegacyDbConfigResolver` performs
  (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies
  `--linked`: passing it with a resolved `--local`/`--db-url` target is a hard
  error rather than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target). Shared verbatim by every `inspect db` subcommand via
  `LEGACY_INSPECT_DB_FLAGS`.
