# `supabase db pull`

Native Effect port. Pulls the remote schema into either a new timestamped
migration (diffing a throwaway shadow against the remote, native pg-delta or
migra) or declarative files (`--declarative`, native pg-delta export). The rare
`--experimental` structured-dump and initial-pull `pg_dump` (migra) sub-branches
delegate to the bundled Go binary.

## Files Read

| Path                                   | Format     | When                                                |
| -------------------------------------- | ---------- | --------------------------------------------------- |
| `<workdir>/supabase/config.toml`       | TOML       | always (db port/password, `[experimental.pgdelta]`) |
| `<workdir>/supabase/migrations/*.sql`  | SQL        | history reconciliation + shadow provisioning        |
| `~/.supabase/access-token`             | plain text | linked target with no `SUPABASE_ACCESS_TOKEN`       |
| `<workdir>/supabase/.temp/project-ref` | plain text | linked ref resolution                               |

## Files Written

| Path                                                        | Format | When                                  |
| ----------------------------------------------------------- | ------ | ------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` | SQL    | migration-style pull (non-empty diff) |
| `<workdir>/supabase/database/**`                            | SQL    | `--declarative`                       |
| `~/.supabase/<workdir-hash>/linked-project.json`            | JSON   | linked (post-run cache)               |
| `~/.supabase/telemetry.json`                                | JSON   | every invocation (post-run)           |

## Docker

- Edge-runtime container (pg-delta export / pg-delta or migra diff).
- Shadow Postgres container (provisioned + torn down via the Go `db __shadow` seam).
- `supabase/migra` container — the migra OOM bash fallback only.

## API Routes / DB

| Method | Path / SQL                                          | Auth   | Purpose                          |
| ------ | --------------------------------------------------- | ------ | -------------------------------- |
| POST   | `/v1/projects/{ref}/roles`                          | Bearer | Temp login role when no password |
| GET    | `/v1/projects/{ref}/pooler/config`                  | Bearer | IPv4 pooler fallback             |
| GET    | `/v1/projects/{ref}`                                | Bearer | Linked-project cache (post-run)  |
| SQL    | `SELECT version FROM …schema_migrations`            | —      | history reconciliation (remote)  |
| SQL    | `INSERT … ON CONFLICT … schema_migrations` (UPSERT) | —      | history update (on confirmation) |

## Environment Variables

| Variable                         | Purpose                                       | Required? |
| -------------------------------- | --------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`          | auth for the linked target                    | no        |
| `SUPABASE_DB_PASSWORD`           | remote DB password (overridden by `-p`)       | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA` | force pg-delta diff engine                    | no        |
| `SUPABASE_EXPERIMENTAL`          | structured-dump pull branch (delegates to Go) | no        |
| `PGDELTA_NPM_REGISTRY`           | scoped npm registry for edge-runtime          | no        |

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
written to <dir>`. Plus the `--use-pg-delta` deprecation line and the
history-update prompt. On success the PostRun line `Finished supabase db pull.`
is printed to stdout.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ declarative, schemaWritten, remoteHistoryUpdated, engine }` and suppresses the
`Finished supabase db pull.` line.

## Notes / Delegation

- `--declarative` / deprecated `--use-pg-delta` are mutually exclusive with
  `--diff-engine`; `--db-url` / `--linked` (default) / `--local` are a target group.
- `--use-pg-delta` is hidden and emits the cobra deprecation line to stderr.
- The `--experimental` structured-dump branch and the initial-pull `pg_dump` (migra,
  no local migrations) rebuild the argv and exec the bundled Go binary (their side
  effects are Go's); the Go child's telemetry is disabled so the single
  `cli_command_executed` event comes from this TS command.
