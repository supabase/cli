# `supabase db pull`

Native Effect port. Pulls the remote schema into either a new timestamped
migration (diffing a throwaway shadow against the remote, bundled pg-delta or
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

Pg-delta runs in-process. Coverage gaps warn; `--strict-coverage` makes them
fatal, while `PGDELTA_DEBUG` writes diagnostic JSON under
`supabase/.temp/pgdelta/v2/debug/<id>/`. The engine may emit transaction-aware
file splits; applicable, convergent SQL is the contract. Its formatter
defaults to lowercase SQL at width 180; config overrides it, and JSON `null`
disables formatting without disabling safe compaction.

## Files Read

| Path                                                                                      | Format     | When                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                          | TOML       | always (db port/password, `[experimental.pgdelta]`)                                                                                                                                                                                                                                                                                                |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file | dotenv     | migration-style pull's shadow provisioning, and `--declarative`'s config/env resolution (not the delegated `--experimental` structured-dump path)                                                                                                                                                                                                  |
| `api.tls.cert_path` / `api.tls.key_path` (under `<workdir>/supabase/`)                    | PEM        | shadow provisioning, when `api.enabled && api.tls.enabled`                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/migrations/*.sql`                                                     | SQL        | history reconciliation + shadow provisioning                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/roles.sql`                                                            | SQL        | migration-style pull only (`--declarative` provisions no shadow); also hashed into the shadow-baseline cache key on every cache-eligible acquire, warm hits included (where no baseline is applied at all); missing file tolerated                                                                                                                 |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`                             | tar        | warm shadow-cache hit (migration-style pull) — the matching snapshot is streamed into the fresh shadow; every cache-eligible acquire (warm hit and successful cold export) also enumerates and `stat`s every `shadow-baseline-*.tar` for LRU keep-3 + 2-day mtime TTL and may delete other keys (`SUPABASE_HOME` overrides the `~/.supabase` root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial`               | tar        | abandoned-partial sweep on every cache-eligible acquire (warm hit and cold export) — enumerated and `stat`ed, and removed when older than 5 minutes (a crashed/SIGKILLed earlier export's leftover)                                                                                                                                                |
| `~/.supabase/access-token`                                                                | plain text | linked target with no `SUPABASE_ACCESS_TOKEN`                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/.temp/project-ref`                                                    | plain text | linked ref resolution — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                                                                                                                                                                                                                                                             |

## Files Written

| Path                                                                        | Format | When                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`                 | SQL    | migration-style pull (non-empty diff, or the initial-migra `pg_dump` seed)                                                                                                                                                                                                                                                                                              |
| `<workdir>/supabase/schemas/**`                                             | SQL    | `--declarative`                                                                                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/schemas/.pgdelta-export.json`                           | JSON   | bundled `--declarative` export metadata                                                                                                                                                                                                                                                                                                                                 |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                     | JSON   | bundled engine with `PGDELTA_DEBUG`                                                                                                                                                                                                                                                                                                                                     |
| `<workdir>/supabase/schemas/**`, `<workdir>/supabase/cluster/**`            | SQL    | `--experimental` structured dump (delegated to Go; both dirs are `RemoveAll`'d then rewritten by `format.WriteStructuredSchemas`, not just written to)                                                                                                                                                                                                                  |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar    | cache-enabled COLD shadow provision creates the current key's snapshot, migration-style pull only (never `--declarative`, which provisions no shadow, or the delegated `--experimental` path); a warm hit `touch`es its mtime (LRU); every cache-eligible acquire may delete other keys under LRU keep-3 + 2-day mtime TTL — ~90MB (`SUPABASE_HOME` overrides the root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar    | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports / warm hits sweep leftovers older than 5 minutes                                                                                                                                          |
| `~/.supabase/<workdir-hash>/linked-project.json`                            | JSON   | linked (post-run cache)                                                                                                                                                                                                                                                                                                                                                 |
| `~/.supabase/telemetry.json`                                                | JSON   | every invocation (post-run)                                                                                                                                                                                                                                                                                                                                             |

## Docker

- Edge-runtime container (migra engine only).
- Shadow Postgres container — provisioned and torn down natively (`legacyPrepareShadowSource` in
  `legacy/commands/db/shared/legacy-shadow-source.ts`, over the lower-level primitives in
  `legacy/shared/db-bootstrap/shadow-database.ts`), no longer via a Go seam. Torn down with
  `docker rm -f -v` on every run, cache or no cache — see the shadow baseline cache section
  below. Migration-style pulls only; `--declarative` provisions no shadow.
- `supabase/migra` container — the migra OOM bash fallback only.
- `pg_dump` container — the initial-migra pull's native remote-schema dump
  (`legacyStreamPgDump`, shared with `db dump`).

### Shadow baseline cache (`SUPABASE_SHADOW_CACHE`, default OFF)

Off unless `SUPABASE_SHADOW_CACHE` is set; `false`/`0` keep it off (honored from the ambient env AND the
project's dotenv, e.g. `supabase/.env`), restoring the documented uncached lifecycle. A warm hit
skips the platform baseline, so the `Initialising schema...` progress line does not print —
progress text reflects the work actually performed.
Artifact: `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar` (~90MB; `SUPABASE_HOME`
overrides the root), a PGDATA snapshot keyed by a hash of every input baked into the cluster
(including the effective Webhooks/`pg_net` policy);
shared across worktrees with the same settings; retention is LRU (keep 3) + 2-day mtime TTL
(warm hits refresh mtime; sibling tars may be deleted).
Container lifecycle is identical to the uncached path except a cold run drops `--rm` (still removed
on release). A cache anomaly never fails the command — a warm-path anomaly cold-provisions instead,
a cold export failure only warns and leaves the run uncached (one exception: a shadow that
fails to come back up after the snapshot fails the run rather than reporting a false success). See `shared/db-bootstrap/
shadow-cache.ts`'s doc comment for the mechanics.
Session-semantics caveat on the cached paths: migrations run on a session opened after the
platform baseline, so role-level defaults installed by `supabase/roles.sql`
(`ALTER ROLE … SET …`) apply to migration execution; with the cache off, the single-session flow
runs migrations before those defaults take effect. Each pooler-retry attempt acquires/releases its
own shadow (a warm hit restores the same tar each time); `--declarative` provisions no shadow
at all, so nothing is cached for it.

## API Routes / DB

| Method | Path / SQL                                          | Auth   | Purpose                          |
| ------ | --------------------------------------------------- | ------ | -------------------------------- |
| POST   | `/v1/projects/{ref}/roles`                          | Bearer | Temp login role when no password |
| GET    | `/v1/projects/{ref}/pooler/config`                  | Bearer | IPv4 pooler fallback             |
| GET    | `/v1/projects/{ref}`                                | Bearer | Linked-project cache (post-run)  |
| SQL    | `SELECT version FROM …schema_migrations`            | —      | history reconciliation (remote)  |
| SQL    | `INSERT … ON CONFLICT … schema_migrations` (UPSERT) | —      | history update (on confirmation) |

## Environment Variables

| Variable                                                                              | Purpose                                                                                                                                                                                                             | Required? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`                                                               | auth for the linked target                                                                                                                                                                                          | no        |
| `SUPABASE_DB_PASSWORD`                                                                | remote DB password (overridden by `-p`)                                                                                                                                                                             | no        |
| `SUPABASE_DB_SHADOW_PORT`                                                             | shadow container's host port (`db.shadow_port`) — NOT `SUPABASE_DB_PORT`, which the shadow never reads                                                                                                              | no        |
| `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | shadow container-config overrides, same as `db start`/`db reset`                                                                                                                                                    | no        |
| `SUPABASE_PROJECT_ID`                                                                 | overrides the shadow container's project id/labels, same as `db start`/`db reset` (`utils.DbId`); ALSO the linked-ref resolution fallback `--project-ref` supersedes — see Notes for the narrower scope of the flag | no        |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                | forces the shadow container/network onto an existing Docker network                                                                                                                                                 | no        |
| `SUPABASE_HOME`                                                                       | overrides the `~/.supabase` root used for the shadow baseline cache (and other CLI state)                                                                                                                           | no        |
| `SUPABASE_SHADOW_CACHE`                                                               | shadow baseline cache; opt-in (`1`/`true`); the shadow's post-baseline PGDATA is snapshotted to a tar and restored into the next run's fresh container (see Notes)                                                  | no        |
| `SUPABASE_EXPERIMENTAL`                                                               | selects the deprecated structured-dump branch (still delegates to Go, see below)                                                                                                                                    | no        |

## Exit Codes

| Code | Condition                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (migration written + optional history update; declarative export)                                                                                                                           |
| `1`  | target mutex; `--declarative`/`--use-pg-delta` with `--diff-engine`; migration-history conflict; **no schema changes ("No schema changes found")**; connection/shadow/engine failure; file IO error |
| `1`  | `--project-ref` set with a resolved target other than linked; `--project-ref` combined with the `--experimental` structured-dump pull (see Notes)                                                   |

> Note: unlike `db diff`, an empty diff (`No schema changes found`) is a **non-zero
> exit** for `db pull`. The message and exit code match Go, but the stderr footer
> does not: instead of Go's generic
> `Try rerunning the command with --debug to troubleshoot the error.`, `db pull`
> prints
> `The remote database is already in sync with your local migrations — nothing to pull.`
> (deliberate divergence — see `docs/go-cli-divergences.md`).

## Output

### `--output-format text`

Progress to stderr. Migration path: `Creating shadow database...`,
`Diffing schemas[: <list>]`, `Schema written to <path>`. Declarative path:
`Preparing declarative schema export using pg-delta...`, `Declarative schema
written to <dir>`. Plus the `--use-pg-delta` deprecation line, the
`--experimental` structured-dump deprecation line, and the history-update
prompt. On success the PostRun line `Finished supabase db pull.` is printed to
stdout.

A configured `[db.migrations].schema_paths` also warns on the migration path
that it no longer replaces the migrations baseline.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ declarative, schemaWritten, remoteHistoryUpdated, engine }` and suppresses the
`Finished supabase db pull.` line.

## Notes / Delegation

- `--declarative` / deprecated `--use-pg-delta` are mutually exclusive with
  `--diff-engine`; `--db-url` / `--linked` (default) / `--local` are a target group.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution `LegacyProjectRefResolver`
  performs (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`) — unlike
  `SUPABASE_PROJECT_ID`, it does not affect the shadow container's project
  id/labels. It never implies `--linked`: passing it with a resolved
  `--local`/`--db-url` target is a hard error rather than a silently discarded
  flag (deliberately stricter than `SUPABASE_PROJECT_ID`, which Go's equivalent
  env var simply leaves unused on a non-linked target). It is also rejected up
  front when combined with the delegated `--experimental` structured-dump pull
  (see below) — `rebuildDelegateArgs` never forwards `--project-ref` to the
  delegated Go child, which would otherwise silently re-resolve the workdir's
  own linked ref instead.
- `--use-pg-delta` is hidden and emits the cobra deprecation line to stderr.
- Migration-style pulls always compare migrations with the live target;
  declarative files and `schema_paths` do not replace that baseline.
- Bundled nontransactional files begin with
  `-- pg-delta: transaction=false`, which later migration commands honor.
- The initial-migra pull (no local migrations) is native: it streams a `pg_dump` of
  the remote schema into the migration file, then appends the migra diff. An empty
  diff after a non-empty dump is swallowed; an empty dump + empty diff is "No schema
  changes found".
- The `--experimental` structured-dump branch (or the `SUPABASE_EXPERIMENTAL`
  project-`.env` equivalent) still rebuilds the argv and execs the bundled Go
  binary (its side effects are Go's — see Files Written above for what that
  actually writes), because Go's `format.WriteStructuredSchemas` needs a
  PostgreSQL DDL AST parser that has no TS port yet. It is deprecated
  (CLI-1957): a TS-fork-only warning (no Go counterpart) pointing at
  `--declarative` prints to stderr before the delegated exec. The Go child's
  telemetry is disabled so the single `cli_command_executed` event comes from
  this TS command. `--project-ref` combined with this mode is rejected up
  front instead of silently dropped or forwarded via `SUPABASE_PROJECT_ID`:
  the latter was considered and rejected because it also overrides the
  delegated child's own `Config.ProjectId` (and therefore its shadow/
  edge-runtime container labels) — a coupling `--project-ref` deliberately
  avoids. Mirrors `db diff --use-pg-schema`'s identical guard.
