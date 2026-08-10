# `supabase db schema declarative sync`

Diffs local migrations state against declarative schema files and writes the delta
as a new timestamped migration.

## Files Read

| Path                                                     | Format     | When                                                                                                                                               |
| -------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                         | TOML       | always — pg-delta gate, format options                                                                                                             |
| `<workdir>/supabase/.temp/pgdelta-version`               | plain text | always — pins the `@supabase/pg-delta` npm version                                                                                                 |
| `<workdir>/supabase/.temp/edge-runtime-version`          | plain text | always — pins the edge-runtime image tag                                                                                                           |
| `<workdir>/supabase/database/**/*.sql` (declarative dir) | SQL        | always — must exist (else error)                                                                                                                   |
| `<workdir>/supabase/migrations/*.sql`                    | SQL        | migrations-catalog resolution (native, CLI-1959) — hashed for the cache key and, on a miss, replayed onto the shadow via `db __shadow --mode diff` |
| `<workdir>/supabase/roles.sql`                           | SQL        | native migrations-catalog cache key (setup-inputs token; empty when absent)                                                                        |
| `<workdir>/supabase/.temp/pgdelta/*.json`                | JSON       | migrations catalog cache (native, CLI-1959); declarative catalog cache (still the Go seam)                                                         |

## Files Written

| Path                                                            | Format | When                                                |
| --------------------------------------------------------------- | ------ | --------------------------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>.sql`          | SQL    | when schema changes are found                       |
| `<workdir>/supabase/.temp/pgdelta/catalog-*-migrations-*.json`  | JSON   | migrations catalog cache write (native, CLI-1959)   |
| `<workdir>/supabase/.temp/pgdelta/catalog-*-declarative-*.json` | JSON   | declarative catalog cache write (still the Go seam) |

## Subprocesses / Containers

| What                                                                                                                                                                                                                                                                      | When                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `supabase-go db __shadow --mode diff` (seam, unchanged) — shadow Postgres + `SetupDatabase` + apply migrations; the catalog itself is exported natively via edge-runtime (CLI-1959 — no longer the hidden `db schema declarative __catalog --mode migrations` subprocess) | migrations-catalog cache miss only                                |
| `supabase-go db schema declarative __catalog --mode declarative --experimental` (seam) — shadow Postgres + `SetupDatabase` + apply declarative → catalog                                                                                                                  | always                                                            |
| Edge-runtime container running the pg-delta diff Deno script, and (on a migrations-catalog cache miss) the pg-delta catalog-export Deno script                                                                                                                            | always / cache miss                                               |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `legacyResetLocalDatabase` (CLI-2062: in-process, no `supabase-go` child) — only on the failed-apply recovery path       | TTY only, apply failed, and the user confirms "reset and reapply" |

## Environment Variables

| Variable                     | Purpose                                                     | Required? |
| ---------------------------- | ----------------------------------------------------------- | --------- |
| `PGDELTA_NPM_REGISTRY`       | private `@supabase` npm registry for pg-delta               | no        |
| `PGDELTA_DEBUG`              | verbose pg-delta diagnostics                                | no        |
| `SUPABASE_GO_BINARY`         | override the `supabase-go` seam binary                      | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for the bootstrap generate (Go `GetHostname`) | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback          | no        |

## Exit Codes

| Code | Condition                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | success (migration created, applied, or "No schema changes found")                                  |
| `1`  | pg-delta not enabled                                                                                |
| `1`  | conflicting `--apply`/`--no-apply` (mutually exclusive)                                             |
| `1`  | no declarative schema files found                                                                   |
| `1`  | shadow-database / edge-runtime / diff failure                                                       |
| `1`  | apply failure (when applied) — propagated from the native migration apply (`applyMigrationToLocal`) |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: Go's
`PersistentPreRunE` runs before `ValidateFlagGroups()`
(`cobra@v1.10.2/command.go:985,1010`), so a closed gate (missing `--experimental`)
surfaces before an `--apply`/`--no-apply` conflict is ever checked.

## Output

Text mode only. The generated SQL, the created-migration path, drop-statement
warnings, and apply status are written to stderr. The no-files bootstrap also
prints `Declarative schema written to <dir>` (the relative declarative dir, Go's
`GetDeclarativeDir()`) to stderr after generating, writing, and warming the
catalog cache — on both the interactive-accept and `--yes` paths.
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
  (the reset itself is native too — `legacyResetLocalDatabase`, CLI-2062 — run
  in-process, sharing this command's own telemetry/linked-project-cache finalizer
  cycle rather than firing a second one from a `supabase-go` child).
- **Architecture:** the migrations-catalog diff source resolves natively (CLI-1959):
  the setup-inputs-folded cache key, the zero-local-migrations → platform-baseline
  reuse, and the pg-delta catalog export are all native TS; only the shadow-database
  platform-baseline provisioning + migrations apply still runs via the bundled
  `supabase-go`, reusing the SAME `db __shadow --mode diff` seam call `db diff`
  uses (not a `__catalog`-specific shadow). The declarative-catalog diff target
  still provisions its shadow-database platform baseline (and applies declarative
  files) via the hidden `db schema declarative __catalog --mode declarative` seam,
  since neither a baseline-only shadow nor `pgdelta.ApplyDeclarative` has a native
  TS port yet (tracked by CLI-1956/CLI-1823). The diff itself is native pg-delta
  either way.
