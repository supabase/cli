# `supabase db diff`

Native Effect port. Diffs the local project's expected schema (a throwaway shadow
database) against a target database (local / linked / `--db-url`), using either
pg-delta or migra. Pg-delta runs in-process by default; migra still runs in Docker
via edge-runtime. The `--use-pgadmin` / `--use-pg-schema` engines delegate to the
bundled Go binary.

## Pg-delta implementation and compatibility

- The default implementation is the in-process pg-delta engine bundled into the
  CLI binary together with pg-topo. Its version is fixed when the CLI is built;
  there is no runtime package download or automatic fallback to the legacy engine.
- `SUPABASE_USE_PG_DELTA_NEXT=false` selects the legacy edge-runtime implementation.
  Only that opt-out reads legacy catalogs under `supabase/.temp/pgdelta/`,
  `supabase/.temp/pgdelta-version`, or `PGDELTA_NPM_REGISTRY`.
- With `PGDELTA_DEBUG`, default-engine snapshots, plans, and diagnostics are written
  under `supabase/.temp/pgdelta/v2/debug/<id>/`. The directory contains
  `metadata.json` and, when available, `source-snapshot.json`,
  `desired-snapshot.json`, `plan.json`, and `diagnostics.json`. These are diagnostic
  artifacts, not reusable catalogs.
- The default engine always refuses extraction errors. Coverage gaps
  (`unmodeled_kind` or `unresolved_security_label`) warn and remain unmanaged by
  default; `--strict-coverage` turns them into a refusal. Warnings identify the
  diagnostic origin and explain that unsupported changes are absent from the diff;
  when debug capture is enabled, the bundle is saved before policy evaluation.
- SQL text and file segmentation may differ from the legacy renderer. Applicable
  output and convergence (a subsequent diff is empty) are the compatibility contract.

## Files Read

| Path                                            | Format     | When                                                              |
| ----------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML       | always (db port/password, `[experimental.pgdelta]`, deno_version) |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | shadow provisioning (applied to the shadow source)                |
| `~/.supabase/access-token`                      | plain text | `--linked` / `--db-url` with no `SUPABASE_ACCESS_TOKEN`           |
| `<workdir>/supabase/.temp/project-ref`          | plain text | `--linked` ref resolution                                         |
| `<workdir>/supabase/.temp/pgdelta-version`      | plain text | always read for compatibility; affects legacy opt-out only        |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | legacy opt-out only: edge-runtime image tag                       |
| `<workdir>/supabase/.temp/pgdelta/*.json`       | JSON       | legacy opt-out only: explicit `--from/--to migrations` catalog    |

## Files Written

| Path                                                        | Format | When                                        |
| ----------------------------------------------------------- | ------ | ------------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` | SQL    | `--file <name>` and the diff is non-empty   |
| `<path>` (from `--output` / `-o`)                           | SQL    | explicit `--from/--to` mode with `--output` |
| `<workdir>/supabase/.temp/pgdelta/*.json`                   | JSON   | legacy opt-out only: migrations catalog     |
| `<workdir>/supabase/.temp/pgdelta/pgdelta-target-ca.crt`    | PEM    | legacy opt-out only: Supabase TLS target    |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`     | JSON   | default engine with `PGDELTA_DEBUG`         |
| `~/.supabase/<workdir-hash>/linked-project.json`            | JSON   | `--linked` (post-run cache)                 |
| `~/.supabase/telemetry.json`                                | JSON   | every invocation (post-run)                 |

## Docker

- Edge-runtime container (migra, or pg-delta only under the legacy opt-out). The
  legacy explicit `--from/--to migrations` path also runs the native pg-delta
  catalog-export script there on a cache miss (CLI-1959; no hidden `__catalog`
  subprocess).
- Shadow Postgres container(s), provisioned through the Go `db __shadow` seam.
  The default engine uses isolated migrations and declarative shadows. The legacy
  opt-out provisions a single `mode: "diff"` shadow, including on an explicit
  migrations-catalog cache miss, and tears it down after export.
- `supabase/migra` container — the migra OOM bash fallback only.

## API Routes (linked path, via the db-config resolver)

| Method     | Path                               | Auth   | Purpose                          |
| ---------- | ---------------------------------- | ------ | -------------------------------- |
| POST       | `/v1/projects/{ref}/roles`         | Bearer | Temp login role when no password |
| GET        | `/v1/projects/{ref}/pooler/config` | Bearer | IPv4 pooler fallback             |
| GET/DELETE | `/v1/projects/{ref}/network-bans`  | Bearer | Unban during pooler login retry  |
| GET        | `/v1/projects/{ref}`               | Bearer | Linked-project cache (post-run)  |

## Environment Variables

| Variable                         | Purpose                                           | Required? |
| -------------------------------- | ------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`          | auth for `--linked`                               | no        |
| `SUPABASE_DB_PASSWORD`           | remote DB password (linked)                       | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA` | force pg-delta engine                             | no        |
| `PGDELTA_DEBUG`                  | pg-delta debug capture                            | no        |
| `SUPABASE_USE_PG_DELTA_NEXT`     | set to `false` for the legacy edge-runtime engine | no        |
| `PGDELTA_NPM_REGISTRY`           | legacy opt-out only: scoped npm registry          | no        |
| `SUPABASE_SSL_DEBUG`             | migra SSL debug logging                           | no        |

## Exit Codes

| Code | Condition                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success; empty diff ("No schema changes found")                                                                                    |
| `1`  | `--from` without `--to`; engine-flag mutex; target mutex; unknown explicit target; connection/shadow/engine failure; file IO error |

## Output

### `--output-format text` (Go CLI compatible)

Progress to stderr (`Creating shadow database...`, `Diffing schemas[: <list>]`,
`Finished supabase db diff on branch <branch>.`, drop-statement warning, and the
`--file` write warning). A configured `[db.migrations].schema_paths` also prints a
transition warning because it no longer changes the diff target. The SQL diff
prints to stdout when neither `--file` nor explicit `--output` is set.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ diff, file, schemas, engine, dropStatements }` instead of the raw SQL.

## Notes / Delegation

- `--use-migra` (default), `--use-pgadmin`, `--use-pg-schema`, `--use-pg-delta` are a
  mutually-exclusive engine group; `--db-url` / `--linked` / `--local` are a
  mutually-exclusive target group (default `--local`).
- `--use-pgadmin` and `--use-pg-schema` rebuild the argv and exec the bundled Go
  binary (their side effects are Go's); the Go child's telemetry is disabled so the
  single `cli_command_executed` event comes from this TS command.
- Explicit `--from`/`--to` mode always uses pg-delta and writes to `--output` (or stdout).
- `--strict-coverage` applies to the bundled pg-delta engine and refuses output when
  it encounters schema objects it cannot manage.
- Normal mode always compares the migrations shadow with the selected live
  database. Declarative files and `schema_paths` never replace that target; use
  `supabase db schema declarative sync` for declarative comparison.
- Under the legacy opt-out, the explicit `migrations` target resolves natively
  (CLI-1959): a bare
  migrations-content hash cache lookup (`<workdir>/supabase/.temp/pgdelta/catalog-local-migrations-<hash>-<ts>.json`,
  shared with `db push`'s post-apply cache write), and on a miss, the existing
  `db __shadow --mode diff` seam call plus a native pg-delta catalog export. No hidden Go
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
once `--use-pgadmin`'s delegation, the `db __shadow` seam (the sibling `db
__db-bootstrap` seam was already removed outright by CLI-1955), and the rest of
the M9 milestone's in-flight issues are done — it is not there yet.

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
