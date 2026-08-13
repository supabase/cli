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
| `<workdir>/supabase/.temp/pgdelta/shadow-baseline-<key>.tar`    | tar        | warm shadow-cache hit on a migrations-catalog miss — snapshot streamed into the fresh shadow container before it starts                     |
| `<workdir>/supabase/.temp/pgdelta/shadow-baseline-<key>.tar.<pid>.partial` | tar        | during a cold export's abandoned-partial sweep — enumerated and `stat`ed, and removed when older than an hour (a crashed/SIGKILLed earlier export's leftover) |

## Files Written

| Path                                                               | Format | When                                                                                            |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/migrations/<timestamp>_<name>[_<segment>].sql` | SQL    | changes; bundled engine may emit ordered segments                                               |
| `<workdir>/supabase/schemas/extension.sql`                         | SQL    | accepted legacy-extension repair                                                                |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                  | JSON   | legacy opt-out's catalog cache                                                                  |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`            | JSON   | bundled engine with `PGDELTA_DEBUG`                                                             |
| `<workdir>/supabase/.temp/pgdelta/shadow-baseline-<key>.tar`       | tar    | cache-enabled (default) COLD shadow provision on a migrations-catalog cache miss only (a catalog hit provisions no shadow; a warm hit rewrites nothing; `--no-cache` bypasses the snapshot cache entirely — neither read nor written) — the shadow's PGDATA snapshot, ~90MB, current key only |
| `<workdir>/supabase/.temp/pgdelta/shadow-baseline-<key>.tar.<pid>.partial` | tar    | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports sweep leftovers older than an hour                                                                                               |

## Subprocesses / Containers

| What                                                                                                                                                                                                                         | When                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Two natively-provisioned shadows: migrated source and declarative target                                                                                                                                                     | bundled engine                                                    |
| Natively-provisioned shadow Postgres container (`legacyCreateShadowDatabase`/`legacyPrepareShadowSource`) + native migrate; the catalog itself is exported via edge-runtime                                                  | legacy opt-out, migrations-catalog cache miss                     |
| Natively-provisioned shadow Postgres container (platform-baseline setup via one-shot auth/storage/realtime migrate jobs, then the declarative directory applied via the pg-delta edge-runtime apply script) → catalog export | legacy opt-out, declarative-catalog cache miss                    |
| Edge-runtime container running the pg-delta diff and, on a catalog cache miss, catalog-export/declarative-apply scripts                                                                                                      | legacy opt-out                                                    |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `legacyResetLocalDatabase` — only on the failed-apply recovery path         | TTY only, apply failed, and the user confirms "reset and reapply" |

## Environment Variables

| Variable                     | Purpose                                                                                                                                                                                      | Required? |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_USE_PG_DELTA_NEXT` | set to `false` for legacy edge-runtime pg-delta                                                                                                                                              | no        |
| `PGDELTA_NPM_REGISTRY`       | legacy opt-out's private npm registry                                                                                                                                                        | no        |
| `SUPABASE_SHADOW_CACHE`      | shadow baseline cache; ON by default, set to `false`/`0` to opt out — the shadow's post-baseline PGDATA is snapshotted to a tar and restored into the next run's fresh container (see Notes) | no        |
| `PGDELTA_DEBUG`              | bundled-engine debug artifacts                                                                                                                                                               | no        |
| `SUPABASE_SHADOW_DEBUG`      | opt-in (default off) shadow phase-timing diagnostics on stderr (`shadow-debug:` lines); never touches stdout/exit codes                                                                      | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for the bootstrap generate                                                                                                                                                     | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback                                                                                                                                           | no        |

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

A manifest-less legacy tree is refused by two compatibility gates — one when the
tree fails to load on the bundled engine's shadow, one when the plan's removals
reveal legacy-implicit extensions or extension-managed objects. Both render the
same message (`This <declarative-dir> tree looks like a legacy pg-delta export.`
plus an indented evidence block) and both carry the staged-upgrade recipe on the
error's suggestion, so the generic `Try rerunning the command with --debug`
footer is **not** printed. Non-interactive execution (including `--yes`) stops
there and modifies nothing; the only recommended recovery is regenerating into
`<declarative-dir>-next`, reviewing it, and adopting it.

In a TTY both gates additionally offer to generate that staged export
(recommended), and — when the gap is only `pgcrypto`, `uuid-ossp`, or `pg_net` —
to append those declarations to `<declarative-dir>/extension.sql` and re-plan, or
to continue with the removals, or cancel. The in-place repair is an advanced
choice (it may surface another gap on the next plan); it never overwrites
existing SQL or creates an export manifest.

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

### Shadow baseline cache (`SUPABASE_SHADOW_CACHE`, default ON)

The migrations-catalog shadow this command provisions on a cache miss goes through
`legacyGetMigrationsCatalogRef` -> `exportViaShadowCatalog` (`legacy-pgdelta.cache.ts`), the same
`legacyWithShadowDatabase` seam `db diff`/`db pull` use, so it inherits the whole lifecycle: ON by
default, `SUPABASE_SHADOW_CACHE=false`/`=0` opts out (honored from the ambient env AND the
project's dotenv, e.g. `supabase/.env`), and `--no-cache` bypasses it for that invocation (the
flag promises fresh shadow setup, so it disables the snapshot cache along with the catalog
cache); a warm hit skips the platform baseline and therefore the
`Initialising schema...` progress line. Artifact:
`supabase/.temp/pgdelta/shadow-baseline-<key>.tar` (~90MB), a PGDATA snapshot keyed by a hash of
every input baked into the cluster; retention keeps the current key's tar only. Container
lifecycle is identical to the uncached path except a cold run drops `--rm` (still removed on
release). A cache anomaly never fails the command — a warm-path anomaly cold-provisions instead, a
cold export failure only warns and leaves the run uncached. See `shared/db-bootstrap/
shadow-cache.ts`'s doc comment for the mechanics. The declarative-catalog shadow is NOT cached.
