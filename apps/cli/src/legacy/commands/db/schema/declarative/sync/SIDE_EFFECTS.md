# `supabase db schema declarative sync`

Diffs local migrations state against declarative schema files and writes the delta
as a new timestamped migration.

## Files Read

| Path                                                     | Format     | When                                               |
| -------------------------------------------------------- | ---------- | -------------------------------------------------- |
| `<workdir>/supabase/config.toml`                         | TOML       | always — pg-delta gate, format options             |
| `<workdir>/supabase/.temp/pgdelta-version`               | plain text | always — pins the `@supabase/pg-delta` npm version |
| `<workdir>/supabase/.temp/edge-runtime-version`          | plain text | always — pins the edge-runtime image tag           |
| `<workdir>/supabase/database/**/*.sql` (declarative dir) | SQL        | always — must exist (else error)                   |
| `<workdir>/supabase/migrations/*.sql`                    | SQL        | shadow-DB migrations catalog (Go seam)             |
| `<workdir>/supabase/.temp/pgdelta/*.json`                | JSON       | catalog cache (read/written by the Go seam)        |

## Files Written

| Path                                                   | Format | When                          |
| ------------------------------------------------------ | ------ | ----------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql` | SQL    | when schema changes are found |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`      | JSON   | catalog cache (Go seam)       |

## Subprocesses / Containers

| What                                                                                                                                                     | When                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `supabase-go db schema declarative __catalog --mode migrations --experimental` (seam) — shadow Postgres + `SetupDatabase` + apply migrations → catalog   | always                                                       |
| `supabase-go db schema declarative __catalog --mode declarative --experimental` (seam) — shadow Postgres + `SetupDatabase` + apply declarative → catalog | always                                                       |
| Edge-runtime container running the pg-delta diff Deno script                                                                                             | always                                                       |
| `supabase-go migration up --local`                                                                                                                       | when the migration is applied (`--apply` / prompt / `--yes`) |

## Environment Variables

| Variable                     | Purpose                                                     | Required? |
| ---------------------------- | ----------------------------------------------------------- | --------- |
| `PGDELTA_NPM_REGISTRY`       | private `@supabase` npm registry for pg-delta               | no        |
| `PGDELTA_DEBUG`              | verbose pg-delta diagnostics                                | no        |
| `SUPABASE_GO_BINARY`         | override the `supabase-go` seam binary                      | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for the bootstrap generate (Go `GetHostname`) | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback          | no        |

## Exit Codes

| Code | Condition                                                          |
| ---- | ------------------------------------------------------------------ |
| `0`  | success (migration created, applied, or "No schema changes found") |
| `1`  | conflicting `--apply`/`--no-apply` (mutually exclusive)            |
| `1`  | pg-delta not enabled                                               |
| `1`  | no declarative schema files found                                  |
| `1`  | shadow-database / edge-runtime / diff failure                      |
| `1`  | apply failure (when applied) — propagated from `migration up`      |

## Output

Text mode only. The generated SQL, the created-migration path, drop-statement
warnings, and apply status are written to stderr.
`--no-apply` writes the migration only (never prompts/applies); `--apply` applies
without prompting; both override the global `--yes`. `--no-apply` and `--apply`
are mutually exclusive.

## Notes

- Requires `--experimental` or `[experimental.pgdelta] enabled = true`.
- `--file` sets the migration filename stem (default `declarative_sync`); `--name`
  overrides it. In a TTY without `--name`/`--yes`, the name is prompted.
- When no declarative files exist, a TTY offers to generate them (from local) first.
- The migration apply is native (connects to the local DB and records migration
  history). On apply failure a debug bundle is written under
  `supabase/.temp/pgdelta/debug/` and, in a TTY, a reset-and-reapply is offered
  (the reset itself runs the bundled `supabase-go db reset --local`, since
  `db reset` is still `wrapped`).
- **Architecture:** the shadow-database platform baseline (migrations / declarative
  catalogs) is provisioned by the bundled `supabase-go` via the hidden
  `db schema declarative __catalog` seam; the diff is native pg-delta.
