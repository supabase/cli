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
`DbConfigResolver` (`command-internal/db-config.layer.ts`); this port adds
no new config reads.

## Files Written

| Path                         | Format | When                                      |
| ---------------------------- | ------ | ----------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always, post-run (`TelemetryState.flush`) |

## API Routes (MAY fire on `--linked`, inside the resolver)

| Method   | Path                                        | Auth         | When                                                                                 |
| -------- | ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `POST`   | `/v1/projects/{ref}/cli/login-role`         | Bearer token | `--linked` with no database password, to create a temp login role                    |
| `GET`    | `/v1/projects/{ref}/config/database/pooler` | Bearer token | `--linked` with `--project-ref`, direct host unreachable, no usable saved pooler URL |
| `POST`   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer token | `--linked`, from the 3rd failed temp-role connect (list bans)                        |
| `DELETE` | `/v1/projects/{ref}/network-bans`           | Bearer token | `--linked`, only when bans are listed (clear a self-ban)                             |

## Environment Variables

| Variable                                             | Purpose                                                                                                                  | Required?                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `SUPABASE_DB_PASSWORD` / `DB_PASSWORD`               | database password (linked/local)                                                                                         | no (prompts / config fallback)                               |
| `SUPABASE_ACCESS_TOKEN`                              | Management API auth (linked only)                                                                                        | no (falls back to keyring / token file)                      |
| `SUPABASE_PROJECT_ID`                                | project ref fallback (linked), superseded by `--project-ref` when set                                                    | no (config resolution fallback)                              |
| libpq vars (`PGSSLROOTCERT`, `PGCONNECT_TIMEOUT`, …) | honored when `--db-url` is used                                                                                          | no                                                           |
| `SUPABASE_TARGET`                                    | workspace target (`local` or `remote`) used when no selector flag is given; overrides `target` in `supabase/config.toml` | no (falls back to config `target`, then the command default) |

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

## Target selection

With no `--local`, `--linked` or `--db-url` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then the project `.env*` files), then `target` in `supabase/config.toml` (or
`config.json`). `remote` targets the linked project through the existing linked path; `local`
targets the local database. An explicit selector flag always wins over the target. `--project-ref` is not a selector: a `remote` target resolves it to the linked project, while with no target or
`target = "local"` it behaves exactly as it did before the target existed. An invalid
`SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. The project `.env*` files and the config are only read for the target when no selector flag is given; an unreadable or malformed one exits `1` with `DbConfigLoadError` instead of counting as unset. `<name>` is the invoked subcommand.

When the target resolves to the linked project, the command writes one line to **stderr** naming where the
setting came from, so a config-driven target is never silent:

```
Targeting the linked project (target = "remote" from <source>)
```

`<source>` is `SUPABASE_TARGET`, the `.env*` file that set it (for example `supabase/.env.local` or `.env`), `supabase/config.toml` or `supabase/config.json`.
Nothing is written when a selector flag decides the target.

When neither is set the command keeps targeting the linked project and writes one warning to
**stderr** (every `--output-format`, never stdout), so scripts depending on today's default keep
working while the next major version moves it to the local database:

```
Warning: supabase inspect db <name> will target the local database by default in the next major version. Pass --linked to keep targeting the linked project. Setting target = "remote" in your Supabase config (or SUPABASE_TARGET=remote) also works, but applies to every database command that can run locally, including db reset.
```

No warning is written when a selector flag, `--project-ref`, `SUPABASE_TARGET` or `target` is set.

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

`total-index-size`, `total-table-sizes`, and `table-index-sizes` are removed in v3 and
emit `Command "<name>" is deprecated and will be removed in v3, use "<target>" instead.`

## Notes

- The Management API stack is built lazily, only on the `--linked` path, so `--local`
  and `--db-url` never require an access token.
- `--linked` defaults to `true`; the runner derives it
  from the absence of `--db-url` / `--local` while keeping the mutual-exclusivity check
  keyed off explicitly-set flags.
- All queries are read-only `SELECT`s; the command performs no writes to the database.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution `DbConfigResolver` performs
  (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies
  `--linked`: passing it with a resolved `--local`/`--db-url` target is a hard
  error rather than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target). Shared verbatim by every `inspect db` subcommand via
  `INSPECT_DB_FLAGS`.
