# `supabase db pull`

Native Effect port. Pulls the remote schema into either a new timestamped
migration (diffing a throwaway shadow against the remote, native pg-delta or
migra) or declarative files (`--declarative`, native pg-delta export). The
initial-migra pull (no local migrations) seeds the migration file with a native
`pg_dump` of the remote schema (a Docker `pg_dump` container, with IPv4
transaction-pooler fallback) and then appends the migra diff. `--experimental`'s
structured-dump sub-branch (Go's `format.WriteStructuredSchemas`) stays
delegated to the bundled Go binary rather than retired or ported (CLI-1957): it
needs a TS PostgreSQL DDL AST parser with no equivalent in this repo.
`--declarative` covers the same per-object-files outcome for schema objects via
pg-delta catalog introspection, though its output tree and cluster-object
coverage differ (see Files Written below), so this mode is on a deprecation
path — the same DECISION CLI-1960 makes for `db diff --use-pg-schema` (keep
delegating, flag for removal), not the same output: Go's own `--use-pg-schema`
prints its experimental warning from inside the delegated child, so the TS
`db diff` parent stays silent; Go's `db pull --experimental` prints nothing of
the kind, so the deprecation line below is a TS-fork-only addition with no Go
counterpart. `db pull --experimental` (or `SUPABASE_EXPERIMENTAL=true`) without
`--declarative` prints that line pointing at `--declarative` to stderr and then
delegates the whole pull to Go. `--experimental --declarative` is unaffected:
Go checks `usePgDelta` before `EXPERIMENTAL`, so that combination never
delegates and just runs the declarative export normally (see the
Notes/Delegation section below).

## Files Read

| Path                                                                                                                                 | Format     | When                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`                                                                                                     | TOML       | always (db port/password, `[experimental.pgdelta]`)                                                                                              |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file                                            | dotenv     | shadow provisioning (`--declarative` and migration-style pull; not the delegated `--experimental` structured-dump path)                          |
| `api.tls.cert_path` / `api.tls.key_path` (under `<workdir>/supabase/`)                                                               | PEM        | shadow provisioning, when `api.enabled && api.tls.enabled`                                                                                       |
| `<workdir>/supabase/migrations/*.sql`                                                                                                | SQL        | history reconciliation + shadow provisioning                                                                                                     |
| `<workdir>/supabase/roles.sql`                                                                                                       | SQL        | migration-style pull only (`--declarative`'s bare shadow skips `SetupDatabase`); missing file tolerated                                          |
| `~/.supabase/access-token`                                                                                                           | plain text | linked target with no `SUPABASE_ACCESS_TOKEN`                                                                                                    |
| `<workdir>/supabase/.temp/project-ref`                                                                                               | plain text | linked ref resolution                                                                                                                            |
| `[db.migrations].schema_paths` globs / `<workdir>/supabase/database/**` (pg-delta declarative dir) / `<workdir>/supabase/schemas/**` | SQL        | migration-style pull against the local target only: 3-source declarative-schema fallback ladder, first non-empty source wins (same as `db diff`) |

## Files Written

| Path                                                             | Format | When                                                                                                                                                   |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`      | SQL    | migration-style pull (non-empty diff, or the initial-migra `pg_dump` seed)                                                                             |
| `<workdir>/supabase/database/**`                                 | SQL    | `--declarative`                                                                                                                                        |
| `<workdir>/supabase/schemas/**`, `<workdir>/supabase/cluster/**` | SQL    | `--experimental` structured dump (delegated to Go; both dirs are `RemoveAll`'d then rewritten by `format.WriteStructuredSchemas`, not just written to) |
| `~/.supabase/<workdir-hash>/linked-project.json`                 | JSON   | linked (post-run cache)                                                                                                                                |
| `~/.supabase/telemetry.json`                                     | JSON   | every invocation (post-run)                                                                                                                            |

## Docker

- Edge-runtime container (pg-delta export / pg-delta or migra diff).
- Shadow Postgres container — provisioned and torn down natively (`legacyPrepareShadowSource` in
  `legacy/commands/db/shared/legacy-shadow-source.ts` / `legacyPrepareRawShadow` in
  `legacy/shared/db-bootstrap/shadow-database.ts`, which also owns the lower-level primitives
  both build on), no longer via a Go seam.
- `supabase/migra` container — the migra OOM bash fallback only.
- `pg_dump` container — the initial-migra pull's native remote-schema dump
  (`legacyStreamPgDump`, shared with `db dump`).

## API Routes / DB

| Method | Path / SQL                                          | Auth   | Purpose                          |
| ------ | --------------------------------------------------- | ------ | -------------------------------- |
| POST   | `/v1/projects/{ref}/roles`                          | Bearer | Temp login role when no password |
| GET    | `/v1/projects/{ref}/pooler/config`                  | Bearer | IPv4 pooler fallback             |
| GET    | `/v1/projects/{ref}`                                | Bearer | Linked-project cache (post-run)  |
| SQL    | `SELECT version FROM …schema_migrations`            | —      | history reconciliation (remote)  |
| SQL    | `INSERT … ON CONFLICT … schema_migrations` (UPSERT) | —      | history update (on confirmation) |

## Environment Variables

| Variable                                                                              | Purpose                                                                                                | Required? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN`                                                               | auth for the linked target                                                                             | no        |
| `SUPABASE_DB_PASSWORD`                                                                | remote DB password (overridden by `-p`)                                                                | no        |
| `SUPABASE_DB_SHADOW_PORT`                                                             | shadow container's host port (`db.shadow_port`) — NOT `SUPABASE_DB_PORT`, which the shadow never reads | no        |
| `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | shadow container-config overrides, same as `db start`/`db reset`                                       | no        |
| `SUPABASE_PROJECT_ID`                                                                 | overrides the shadow container's project id/labels, same as `db start`/`db reset` (`utils.DbId`)       | no        |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                | forces the shadow container/network onto an existing Docker network                                    | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`                                                      | force pg-delta diff engine                                                                             | no        |
| `SUPABASE_EXPERIMENTAL`                                                               | selects the deprecated structured-dump branch (still delegates to Go, see below)                       | no        |
| `PGDELTA_NPM_REGISTRY`                                                                | scoped npm registry for edge-runtime                                                                   | no        |

## Exit Codes

| Code | Condition                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (migration written + optional history update; declarative export)                                                                                                                           |
| `1`  | target mutex; `--declarative`/`--use-pg-delta` with `--diff-engine`; migration-history conflict; **no schema changes ("No schema changes found")**; connection/shadow/engine failure; file IO error |

> Note: unlike `db diff`, an empty diff (`No schema changes found`) is a **non-zero
> exit** for `db pull` — Go returns `errInSync` as an error.

## Output

### `--output-format text` (Go CLI compatible)

Progress to stderr. Migration path: `Creating shadow database...`,
`Diffing schemas[: <list>]`, `Schema written to <path>`. Declarative path:
`Preparing declarative schema export using pg-delta...`, `Declarative schema
written to <dir>`. Plus the `--use-pg-delta` deprecation line, the
`--experimental` structured-dump deprecation line, and the history-update
prompt. On success the PostRun line `Finished supabase db pull.` is printed to
stdout.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ declarative, schemaWritten, remoteHistoryUpdated, engine }` and suppresses the
`Finished supabase db pull.` line.

## Notes / Delegation

- `--declarative` / deprecated `--use-pg-delta` are mutually exclusive with
  `--diff-engine`; `--db-url` / `--linked` (default) / `--local` are a target group.
- `--use-pg-delta` is hidden and emits the cobra deprecation line to stderr.
- The initial-migra pull (no local migrations) is native: it streams a `pg_dump` of
  the remote schema into the migration file, then appends the migra diff. An empty
  diff after a non-empty dump is swallowed (Go's `swallowInitialInSync`); an empty
  dump + empty diff is "No schema changes found".
- The `--experimental` structured-dump branch (or the `SUPABASE_EXPERIMENTAL`
  project-`.env` equivalent) still rebuilds the argv and execs the bundled Go
  binary (its side effects are Go's — see Files Written above for what that
  actually writes), because Go's `format.WriteStructuredSchemas` needs a
  PostgreSQL DDL AST parser that has no TS port yet. It is deprecated
  (CLI-1957): a TS-fork-only warning (no Go counterpart) pointing at
  `--declarative` prints to stderr before the delegated exec. The Go child's
  telemetry is disabled so the single `cli_command_executed` event comes from
  this TS command.
