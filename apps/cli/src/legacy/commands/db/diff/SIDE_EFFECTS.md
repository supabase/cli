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
- The default engine refuses to emit a diff when extraction reports an error or a
  strict coverage gap (`unmodeled_kind` or `unresolved_security_label`). The error
  identifies the diagnostic origin, code, subject, and message; when debug capture
  is enabled, the bundle is saved before the refusal.
- SQL text and file segmentation may differ from the legacy renderer. Applicable
  output and convergence (a subsequent diff is empty) are the compatibility contract.

## Files Read

| Path                                               | Format     | When                                                              |
| -------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                   | TOML       | always (db port/password, `[experimental.pgdelta]`, deno_version) |
| `<workdir>/supabase/migrations/*.sql`              | SQL        | shadow provisioning (applied to the shadow source)                |
| `<workdir>/supabase/database/**` (declarative dir) | SQL        | local target when declarative schemas exist                       |
| `~/.supabase/access-token`                         | plain text | `--linked` / `--db-url` with no `SUPABASE_ACCESS_TOKEN`           |
| `<workdir>/supabase/.temp/project-ref`             | plain text | `--linked` ref resolution                                         |
| `<workdir>/supabase/.temp/pgdelta-version`         | plain text | always read for compatibility; affects legacy opt-out only        |
| `<workdir>/supabase/.temp/edge-runtime-version`    | plain text | legacy opt-out only: edge-runtime image tag                       |
| `<workdir>/supabase/.temp/pgdelta/*.json`          | JSON       | legacy opt-out only: explicit `--from/--to migrations` catalog    |

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

- Edge-runtime container (migra, or pg-delta only under the legacy opt-out).
- Shadow Postgres container (provisioned + torn down via the Go `db __shadow` seam).
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
`--file` write warning). The SQL diff prints to stdout when neither `--file` nor
explicit `--output` is set.

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
