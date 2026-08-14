# `supabase db schema declarative sync`

Diffs local migrations state against declarative schema files and writes the delta
as a new timestamped migration.

Pg-delta runs in-process by default and uses two scoped shadow databases. Set
`SUPABASE_USE_PG_DELTA_NEXT=false` for the legacy catalog/edge-runtime path;
there is no automatic fallback. Coverage gaps warn; `--strict-coverage` makes
them fatal, while `PGDELTA_DEBUG` writes diagnostic JSON under
`supabase/.temp/pgdelta/v2/debug/<id>/`. Bundled output may use different SQL
and ordered transaction-aware files but must apply and converge. `--no-cache`
affects only the legacy opt-out. The bundled formatter defaults to lowercase SQL
at width 180; config overrides it, and JSON `null` disables formatting without
disabling safe compaction.

## Files Read

| Path                                                            | Format     | When                                                                                       |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`                                | TOML       | always — pg-delta gate, format options                                                     |
| `<workdir>/supabase/.temp/pgdelta-version`                      | plain text | loaded for compatibility; legacy opt-out only                                              |
| `<workdir>/supabase/.temp/edge-runtime-version`                 | plain text | legacy opt-out's edge-runtime image tag                                                    |
| `<workdir>/supabase/schemas/**/*.sql` (default declarative dir) | SQL        | always — must exist (else error)                                                           |
| `<workdir>/supabase/migrations/*.sql`                           | SQL        | bundled engine applies them to a live shadow; legacy opt-out resolves a migrations catalog |
| `<workdir>/supabase/roles.sql`                                  | SQL        | legacy migrations-catalog cache key (empty when absent)                                    |
| `<workdir>/supabase/schemas/.pgdelta-export.json`               | JSON       | bundled export metadata, when present                                                      |
| `<workdir>/supabase/.temp/pgdelta/*.json`                       | JSON       | legacy opt-out's migrations/declarative catalog cache                                      |

## Files Written

| Path                                                               | Format | When                                              |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>[_<segment>].sql` | SQL    | changes; bundled engine may emit ordered segments |
| `<workdir>/supabase/schemas/extension.sql`                         | SQL    | accepted legacy-extension repair                  |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                  | JSON   | legacy opt-out's catalog cache                    |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`            | JSON   | bundled engine with `PGDELTA_DEBUG`               |

## Subprocesses / Containers

| What                                                                                                                                                                                                                         | When                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Two natively-provisioned shadows: migrated source and declarative target                                                                                                                                                     | bundled engine                                                    |
| Natively-provisioned shadow Postgres container (`legacyCreateShadowDatabase`/`legacyPrepareShadowSource`) + native migrate; the catalog itself is exported via edge-runtime                                                  | legacy opt-out, migrations-catalog cache miss                     |
| Natively-provisioned shadow Postgres container (platform-baseline setup via one-shot auth/storage/realtime migrate jobs, then the declarative directory applied via the pg-delta edge-runtime apply script) → catalog export | legacy opt-out, declarative-catalog cache miss                    |
| Edge-runtime container running the pg-delta diff and, on a catalog cache miss, catalog-export/declarative-apply scripts                                                                                                      | legacy opt-out                                                    |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `legacyResetLocalDatabase` — only on the failed-apply recovery path         | TTY only, apply failed, and the user confirms "reset and reapply" |

## Environment Variables

| Variable                     | Purpose                                            | Required? |
| ---------------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_USE_PG_DELTA_NEXT` | set to `false` for legacy edge-runtime pg-delta    | no        |
| `PGDELTA_NPM_REGISTRY`       | legacy opt-out's private npm registry              | no        |
| `PGDELTA_DEBUG`              | bundled-engine debug artifacts                     | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for the bootstrap generate           | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback | no        |

## Exit Codes

| Code | Condition                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | success (migration created, applied, or "No schema changes found")                                  |
| `1`  | pg-delta not enabled                                                                                |
| `1`  | conflicting `--apply`/`--no-apply` (mutually exclusive)                                             |
| `1`  | no declarative schema files found                                                                   |
| `1`  | shadow-database / selected pg-delta engine / diff failure                                           |
| `1`  | apply failure (when applied) — propagated from the native migration apply (`applyMigrationToLocal`) |
| `1`  | repairable legacy extension omissions in non-interactive mode                                       |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: the gate check runs
first, so a closed gate (missing `--experimental`) surfaces before an
`--apply`/`--no-apply` conflict is ever checked.

## Output

Text mode only. The generated SQL, the created-migration path, drop-statement
warnings, and apply status are written to stderr. The no-files bootstrap also
prints `Declarative schema written to <dir>` (the relative declarative dir) to
stderr after generating and writing (and, under the
legacy opt-out, warming the catalog cache) — on both interactive and `--yes` paths.
`--no-apply` writes the migration only (never prompts/applies); `--apply` applies
without prompting; both override the global `--yes`. `--no-apply` and `--apply`
are mutually exclusive.

Before writing a bundled-engine migration, a manifest-less legacy tree that
would remove only `pgcrypto`, `uuid-ossp`, or `pg_net` offers to append their
declarations to `extension.sql` and re-plan, continue, or cancel. Non-interactive
execution (including `--yes`) stops and prints the SQL instead of modifying the
tree. The repair never overwrites existing SQL or creates an export manifest.

## Notes

- Requires `--experimental` or `[experimental.pgdelta] enabled = true`.
- `--file` sets the migration filename stem (default `declarative_sync`); `--name`
  overrides it. In a TTY without `--name`/`--yes`, the name is prompted.
- When no declarative files exist, a TTY offers to generate them (from local) first.
- The declarative directory is the complete desired state: omitted objects,
  including extensions, are removals. Use `generate --output <staging-dir>` to
  review a next-compatible tree without changing config or activating it.
- The migration apply is native (connects to the local DB and records migration
  history). On apply failure a debug bundle is written under
  `supabase/.temp/pgdelta/debug/` and, in a TTY, a reset-and-reapply is offered
  (the reset itself is native too — `legacyResetLocalDatabase` — run in-process,
  sharing this command's own telemetry/linked-project-cache finalizer cycle
  rather than firing a second one from a child process).
- **Architecture:** the bundled engine plans and renders in-process from two live
  shadows. Under the legacy opt-out, both catalog shadows are provisioned
  in-process using the same primitives as `db diff`; catalog export,
  declarative apply, and diff run through the edge-runtime pg-delta scripts.
