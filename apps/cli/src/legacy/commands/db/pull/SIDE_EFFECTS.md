# `supabase db pull`

Native Effect port. Pulls the remote schema into either a new timestamped
migration (diffing a throwaway shadow against the remote, native pg-delta or
migra) or declarative files (`--declarative`, native pg-delta export). The
migration-style path always compares migrations with the selected live database;
declarative files and `[db.migrations].schema_paths` cannot replace its target.
initial-migra pull (no local migrations) seeds the migration file with a native
`pg_dump` of the remote schema (a Docker `pg_dump` container, with IPv4
transaction-pooler fallback) and then appends the migra diff. `--experimental`'s
structured-dump sub-branch (Go's `format.WriteStructuredSchemas`) stays
delegated to the bundled Go binary rather than retired or ported (CLI-1957): it
needs a TS PostgreSQL DDL AST parser with no equivalent in this repo.
`--declarative` covers the same per-object-files outcome for schema objects via
pg-delta managed-state extraction, though its output tree and cluster-object
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

## Pg-delta implementation and compatibility

- Pg-delta diff and declarative export use the in-process engine bundled into the
  CLI binary by default. Pg-topo is bundled with it and the version is fixed at
  CLI build time; the command never downloads it or falls back automatically.
- `SUPABASE_USE_PG_DELTA_NEXT=false` selects the legacy edge-runtime path.
  `PGDELTA_NPM_REGISTRY`, `supabase/.temp/pgdelta-version`, and legacy catalogs
  directly below `supabase/.temp/pgdelta/` apply only to that opt-out.
- With `PGDELTA_DEBUG`, default-engine diagnostic data is stored under
  `supabase/.temp/pgdelta/v2/debug/<id>/` as `metadata.json` plus available
  snapshot, plan, and diagnostics JSON files. These artifacts are never catalog
  cache inputs.
- The default engine always refuses extraction errors. Coverage gaps
  (`unmodeled_kind` or `unresolved_security_label`) warn and remain unmanaged by
  default; `--strict-coverage` turns them into a refusal. Declarative warnings make
  clear that unsupported objects are absent from the exported files. Debug
  artifacts are saved before policy evaluation when capture is enabled.
- New-engine SQL bytes and transaction-split filenames may differ. Successful
  execution and convergence on a subsequent pull/diff are the contract.
- Default-engine migration and declarative SQL retains pg-delta's safe compaction
  and uses its human-facing formatter (lowercase keywords, max width 180). A JSON
  object in `[experimental.pgdelta].format_options` partially overrides the
  preset; the JSON literal `null` disables formatting without disabling
  compaction.

## Files Read

| Path                                            | Format     | When                                                |
| ----------------------------------------------- | ---------- | --------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML       | always (db port/password, `[experimental.pgdelta]`) |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | history reconciliation + shadow provisioning        |
| `~/.supabase/access-token`                      | plain text | linked target with no `SUPABASE_ACCESS_TOKEN`       |
| `<workdir>/supabase/.temp/project-ref`          | plain text | linked ref resolution                               |
| `<workdir>/supabase/.temp/pgdelta-version`      | plain text | always read for compatibility; affects legacy only  |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | legacy opt-out only: edge-runtime image tag         |
| `<workdir>/supabase/.temp/pgdelta/*.json`       | JSON       | legacy opt-out only: migrations/baseline catalogs   |

## Files Written

| Path                                                             | Format | When                                                                                                                                                   |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`      | SQL    | migration-style pull (non-empty diff, or the initial-migra `pg_dump` seed)                                                                             |
| `<workdir>/supabase/database/**`                                 | SQL    | `--declarative`                                                                                                                                        |
| `<workdir>/supabase/database/.pgdelta-export.json`               | JSON   | default-engine `--declarative` export metadata                                                                                                         |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                | JSON   | legacy opt-out only: catalog snapshots                                                                                                                 |
| `<workdir>/supabase/.temp/pgdelta/pgdelta-target-ca.crt`         | PEM    | legacy opt-out only: Supabase TLS target                                                                                                               |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`          | JSON   | default pg-delta engine with `PGDELTA_DEBUG`                                                                                                           |
| `<workdir>/supabase/schemas/**`, `<workdir>/supabase/cluster/**` | SQL    | `--experimental` structured dump (delegated to Go; both dirs are `RemoveAll`'d then rewritten by `format.WriteStructuredSchemas`, not just written to) |
| `~/.supabase/<workdir-hash>/linked-project.json`                 | JSON   | linked (post-run cache)                                                                                                                                |
| `~/.supabase/telemetry.json`                                     | JSON   | every invocation (post-run)                                                                                                                            |

## Docker

- Edge-runtime container (migra, or pg-delta only under the legacy opt-out).
- Shadow Postgres container (provisioned + torn down via the Go `db __shadow` seam).
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

| Variable                         | Purpose                                                                          | Required? |
| -------------------------------- | -------------------------------------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`          | auth for the linked target                                                       | no        |
| `SUPABASE_DB_PASSWORD`           | remote DB password (overridden by `-p`)                                          | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA` | force pg-delta diff engine                                                       | no        |
| `SUPABASE_EXPERIMENTAL`          | selects the deprecated structured-dump branch (still delegates to Go, see below) | no        |
| `SUPABASE_USE_PG_DELTA_NEXT`     | set to `false` for the legacy edge-runtime engine                                | no        |
| `PGDELTA_NPM_REGISTRY`           | legacy opt-out only: scoped npm registry for edge-runtime                        | no        |

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

A configured `[db.migrations].schema_paths` prints a transition warning on the
migration path directing users to `supabase db schema declarative sync`.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ declarative, schemaWritten, remoteHistoryUpdated, engine }` and suppresses the
`Finished supabase db pull.` line.

## Notes / Delegation

- `--declarative` / deprecated `--use-pg-delta` are mutually exclusive with
  `--diff-engine`; `--db-url` / `--linked` (default) / `--local` are a target group.
- `--use-pg-delta` is hidden and emits the cobra deprecation line to stderr.
- `--strict-coverage` applies to bundled pg-delta diff and declarative-export paths;
  it refuses output when pg-delta encounters schema objects it cannot manage.
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
