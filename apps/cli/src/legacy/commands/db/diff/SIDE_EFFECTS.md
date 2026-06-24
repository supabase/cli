# `supabase db diff`

Native Effect port. Diffs the local project's expected schema (a throwaway shadow
database) against a target database (local / linked / `--db-url`), using either
the native pg-delta or migra engine (both run inside Docker via edge-runtime). The
`--use-pgadmin` / `--use-pg-schema` engines delegate to the bundled Go binary.

## Files Read

| Path                                               | Format     | When                                                              |
| -------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                   | TOML       | always (db port/password, `[experimental.pgdelta]`, deno_version) |
| `<workdir>/supabase/migrations/*.sql`              | SQL        | shadow provisioning (applied to the shadow source)                |
| `<workdir>/supabase/database/**` (declarative dir) | SQL        | local target when declarative schemas exist                       |
| `~/.supabase/access-token`                         | plain text | `--linked` / `--db-url` with no `SUPABASE_ACCESS_TOKEN`           |
| `<workdir>/supabase/.temp/project-ref`             | plain text | `--linked` ref resolution                                         |
| `<workdir>/supabase/.temp/pgdelta/*.json`          | JSON       | explicit `--from/--to migrations` catalog (cache)                 |

## Files Written

| Path                                                        | Format | When                                            |
| ----------------------------------------------------------- | ------ | ----------------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` | SQL    | `--file <name>` and the diff is non-empty       |
| `<path>` (from `--output` / `-o`)                           | SQL    | explicit `--from/--to` mode with `--output`     |
| `<workdir>/supabase/.temp/pgdelta/*.json`                   | JSON   | explicit `--from/--to migrations` catalog cache |
| `~/.supabase/<workdir-hash>/linked-project.json`            | JSON   | `--linked` (post-run cache)                     |
| `~/.supabase/telemetry.json`                                | JSON   | every invocation (post-run)                     |

## Docker

- Edge-runtime container (pg-delta / migra diff scripts).
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

| Variable                         | Purpose                                          | Required? |
| -------------------------------- | ------------------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN`          | auth for `--linked`                              | no        |
| `SUPABASE_DB_PASSWORD`           | remote DB password (linked)                      | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA` | force pg-delta engine                            | no        |
| `PGDELTA_DEBUG`                  | pg-delta debug capture                           | no        |
| `PGDELTA_NPM_REGISTRY`           | scoped `@supabase` npm registry for edge-runtime | no        |
| `SUPABASE_SSL_DEBUG`             | migra SSL debug logging                          | no        |

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
