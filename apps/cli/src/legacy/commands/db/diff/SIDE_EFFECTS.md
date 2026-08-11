# `supabase db diff`

Native Effect port. Diffs the local project's expected schema (a throwaway shadow
database) against a target database (local / linked / `--db-url`), using either
the native pg-delta or migra engine (both run inside Docker via edge-runtime). The
`--use-pgadmin` / `--use-pg-schema` engines delegate to the bundled Go binary.

## Files Read

| Path                                                                                                                                 | Format     | When                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                                                     | TOML       | always (db port/password, `[experimental.pgdelta]`, deno_version)                                           |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file                                            | dotenv     | shadow provisioning (all native targets, and the explicit `--from/--to migrations` cache miss)              |
| `api.tls.cert_path` / `api.tls.key_path` (under `<workdir>/supabase/`)                                                               | PEM        | shadow provisioning, when `api.enabled && api.tls.enabled`                                                  |
| `<workdir>/supabase/migrations/*.sql`                                                                                                | SQL        | shadow provisioning (applied to the shadow source)                                                          |
| `<workdir>/supabase/roles.sql`                                                                                                       | SQL        | shadow provisioning, PG14 and PG15 alike (unlike `db reset`'s PG15-only local path); missing file tolerated |
| `[db.migrations].schema_paths` globs / `<workdir>/supabase/database/**` (pg-delta declarative dir) / `<workdir>/supabase/schemas/**` | SQL        | local target: 3-source declarative-schema fallback ladder, first non-empty source wins                      |
| `~/.supabase/access-token`                                                                                                           | plain text | `--linked` / `--db-url` with no `SUPABASE_ACCESS_TOKEN`                                                     |
| `<workdir>/supabase/.temp/project-ref`                                                                                               | plain text | `--linked` ref resolution — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                  |
| `<workdir>/supabase/.temp/pgdelta/*.json`                                                                                            | JSON       | explicit `--from/--to migrations` catalog (cache)                                                           |

## Files Written

| Path                                                        | Format | When                                            |
| ----------------------------------------------------------- | ------ | ----------------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` | SQL    | `--file <name>` and the diff is non-empty       |
| `<path>` (from `--output` / `-o`)                           | SQL    | explicit `--from/--to` mode with `--output`     |
| `<workdir>/supabase/.temp/pgdelta/*.json`                   | JSON   | explicit `--from/--to migrations` catalog cache |
| `~/.supabase/<workdir-hash>/linked-project.json`            | JSON   | `--linked` (post-run cache)                     |
| `~/.supabase/telemetry.json`                                | JSON   | every invocation (post-run)                     |

## Docker

- Edge-runtime container (pg-delta / migra diff scripts; also the declarative
  pg-delta apply script for the local-target branch, and runs the pg-delta
  catalog-export script for explicit `--from/--to migrations` on a cache miss —
  CLI-1959, native, no longer the hidden Go `__catalog` seam).
- Shadow Postgres container — provisioned and torn down natively (`legacyPrepareShadowSource`
  in `legacy/commands/db/shared/legacy-shadow-source.ts`, over the lower-level primitives in
  `legacy/shared/db-bootstrap/shadow-database.ts`), no longer via a Go seam. Explicit
  `--from/--to migrations` reuses the SAME native primitives on a cache miss
  (`legacyResolveMigrationsCatalogRef` -> `exportViaShadowCatalog`, `legacy-pgdelta.cache.ts`),
  called with `targetLocal: false`/`usePgDelta: false` to skip the declarative-schema-override
  branch — not a second, `__catalog`-specific shadow, and not a shared `mode: "diff"` parameter
  (that seam-era concept no longer exists).
- `supabase/migra` container — the migra OOM bash fallback only.

## API Routes (linked path, via the db-config resolver)

| Method     | Path                               | Auth   | Purpose                          |
| ---------- | ---------------------------------- | ------ | -------------------------------- |
| POST       | `/v1/projects/{ref}/roles`         | Bearer | Temp login role when no password |
| GET        | `/v1/projects/{ref}/pooler/config` | Bearer | IPv4 pooler fallback             |
| GET/DELETE | `/v1/projects/{ref}/network-bans`  | Bearer | Unban during pooler login retry  |
| GET        | `/v1/projects/{ref}`               | Bearer | Linked-project cache (post-run)  |

## Environment Variables

| Variable                                                                              | Purpose                                                                                                                                                                                                             | Required? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`                                                               | auth for `--linked`                                                                                                                                                                                                 | no        |
| `SUPABASE_DB_PASSWORD`                                                                | remote DB password (linked)                                                                                                                                                                                         | no        |
| `SUPABASE_DB_SHADOW_PORT`                                                             | shadow container's host port (`db.shadow_port`) — NOT `SUPABASE_DB_PORT`, which the shadow never reads                                                                                                              | no        |
| `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | shadow container-config overrides, same as `db start`/`db reset`                                                                                                                                                    | no        |
| `SUPABASE_PROJECT_ID`                                                                 | overrides the shadow container's project id/labels, same as `db start`/`db reset` (`utils.DbId`); ALSO the linked-ref resolution fallback `--project-ref` supersedes — see Notes for the narrower scope of the flag | no        |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                | forces the shadow container/network onto an existing Docker network                                                                                                                                                 | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`                                                      | force pg-delta engine                                                                                                                                                                                               | no        |
| `PGDELTA_DEBUG`                                                                       | pg-delta debug capture                                                                                                                                                                                              | no        |
| `PGDELTA_NPM_REGISTRY`                                                                | scoped `@supabase` npm registry for edge-runtime                                                                                                                                                                    | no        |
| `SUPABASE_SSL_DEBUG`                                                                  | migra SSL debug logging                                                                                                                                                                                             | no        |

## Exit Codes

| Code | Condition                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success; empty diff ("No schema changes found")                                                                                          |
| `1`  | `--from` without `--to`; engine-flag mutex; target mutex; unknown explicit target; connection/shadow/engine failure; file IO error       |
| `1`  | `--project-ref` set with a resolved target other than linked, and (in explicit mode) neither `--from` nor `--to` is `linked` (see Notes) |

## Output

### `--output-format text` (Go CLI compatible)

Progress to stderr (`Creating shadow database...`, `Diffing schemas[: <list>]`,
`Finished supabase db diff on branch <branch>.`, drop-statement warning, and the
`--file` write warning). The SQL diff prints to stdout when neither `--file` nor
explicit `--output` is set.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ diff, file, schemas, engine, dropStatements }` instead of the raw SQL.

## Notes / Delegation

- `--use-migra` (default), `--use-pgadmin`, `--use-pg-schema`, `--use-pg-delta` are a
  mutually-exclusive engine group; `--db-url` / `--linked` / `--local` are a
  mutually-exclusive target group (default `--local`).
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution `LegacyProjectRefResolver`
  performs (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`) — unlike
  `SUPABASE_PROJECT_ID`, it does not affect the shadow container's project
  id/labels. It never implies `--linked`: passing it with a resolved
  `--local`/`--db-url` target (native mode) is a hard error, as is a plain
  `--project-ref` with no `--from`/`--to` (defaults to `--local`). The one
  exception is explicit mode with `--from linked` / `--to linked` — that
  resolves a linked ref without any target flag at all, so the guard does not
  fire there; it still fires for e.g. `--from local --to migrations
--project-ref X`, where the flag would otherwise go silently unused
  (deliberately stricter than `SUPABASE_PROJECT_ID`, which Go's equivalent env
  var simply leaves unused on a non-linked target).
- `--use-pgadmin` and `--use-pg-schema` rebuild the argv and exec the bundled Go
  binary (their side effects are Go's); the Go child's telemetry is disabled so the
  single `cli_command_executed` event comes from this TS command.
- Explicit `--from`/`--to` mode always uses pg-delta and writes to `--output` (or stdout).
- The explicit `migrations` target resolves natively (CLI-1959): a bare
  migrations-content hash cache lookup (`<workdir>/supabase/.temp/pgdelta/catalog-local-migrations-<hash>-<ts>.json`,
  shared with `db push`'s post-apply cache write), and on a miss, a natively-provisioned
  shadow database (CLI-1956 — `legacyCreateShadowDatabase`/`legacyPrepareShadowSource`,
  no longer the `db __shadow` seam) plus a native pg-delta catalog export. No hidden Go
  `db schema declarative __catalog` subprocess runs for this path any more.

### `--use-pg-schema` is deprecated (CLI-1960) — keep-in-Go exception

`--use-pg-schema` wraps the in-process Go library `stripe/pg-schema-diff`
(`apps/cli-go/internal/db/diff/pgschema.go`). It is a keep-in-Go exception rather
than a pending port because:

- it runs **in-process** inside the Go binary, with no container/binary boundary
  to re-invoke from TS — unlike `--use-pgadmin`, which shells out to a
  container/binary path that could in principle be called from TS;
- no TS binding and no WASM build of the library exists, or is reasonably
  buildable, within the M9 "Final Cleanup — Go Removal" milestone's scope;
- this specific exception (`db diff --use-pg-schema`) was pre-named when the M9
  milestone was scoped.

The decision record is Linear issue CLI-1960 and the pull request that introduced
this deprecation notice; re-open only if a TS/WASM binding for
`stripe/pg-schema-diff` ships. It will become the CLI's sole remaining Go delegation
once `--use-pgadmin`'s delegation and the rest of the M9 milestone's in-flight issues
are done — it is not there yet (the sibling `db __db-bootstrap` seam was already
removed outright by CLI-1955, and the `db __shadow` seam by CLI-1956).

Given that, the flag is now deprecated rather than ported:

- A TS-only stderr deprecation warning is printed immediately before delegating
  (both text and machine `--output-format` modes — diagnostics stay stderr-only,
  the CLI-1546 rule): `"--use-pg-schema" is deprecated. Use the pg-delta engine ([experimental.pgdelta] enabled = true / --use-pg-delta) or the default migra engine instead.`
  The warning text intentionally does not promise a removal timeline.
- This is **additive** to (printed before) Go's own pre-existing "experimental"
  warning (`cmd/db.go:121`, unchanged): `--use-pg-schema flag is experimental and may not include all entities, such as views and grants.` The delegated child
  still prints its own warning; the TS wrapper does not suppress or replace it.
- `--help` for the flag now also carries a `Deprecated: …` suffix pointing at the
  same migration path.
- Actual flag removal and any PostHog usage-telemetry gate for that removal are
  explicitly out of scope for CLI-1960 — this is a documentation/deprecation-notice
  change only, tracked as a follow-up decision outside this milestone, with no
  owning issue yet.
