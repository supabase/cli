# `supabase db schema declarative sync`

Diffs declarative schema files against either local migrations state or, with
`--transient`, the running local database. Durable sync writes timestamped
migrations; transient sync executes the plan directly without migration files or
migration-history rows.

Pg-delta runs in-process and uses two scoped shadow databases for durable sync,
or one declarative shadow when the running database is the transient source. Coverage gaps
warn; `--strict-coverage` makes
them fatal, while `PGDELTA_DEBUG` writes diagnostic JSON under
`supabase/.temp/pgdelta/v2/debug/<id>/`. The engine may emit ordered
transaction-aware files; applicable, convergent SQL is the contract. `--no-cache`
bypasses the engine's shadow baseline cache. The bundled formatter defaults to
lowercase SQL
at width 180; config overrides it, and JSON `null` disables formatting without
disabling safe compaction.

## Files Read

| Path                                                                        | Format | When                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                            | TOML   | always — pg-delta gate, format options                                                                                                                                                                                                                                                             |
| `<workdir>/supabase/schemas/**/*.sql` (default declarative dir)             | SQL    | always — must exist (else error)                                                                                                                                                                                                                                                                   |
| `<workdir>/supabase/migrations/*.sql`                                       | SQL    | durable sync only — applied to the live migrations shadow                                                                                                                                                                                                                                          |
| `<workdir>/supabase/roles.sql`                                              | SQL    | hashed into the shadow-baseline cache key on every cache-eligible acquire, warm hits included, and applied to a cold shadow's baseline; missing file tolerated (hashed as empty)                                                                                                                   |
| `<workdir>/supabase/schemas/.pgdelta-export.json`                           | JSON   | export metadata, when present                                                                                                                                                                                                                                                                      |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar    | warm shadow-cache hit (migrations/declarative shadows); every cache-eligible acquire (warm hit and successful cold export) also enumerates and `stat`s every `shadow-baseline-*.tar` for LRU keep-3 + 2-day mtime TTL and may delete other keys (`SUPABASE_HOME` overrides the `~/.supabase` root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar    | abandoned-partial sweep on every cache-eligible acquire (warm hit and cold export) — enumerated and `stat`ed, and removed when older than 5 minutes (a crashed/SIGKILLed earlier export's leftover)                                                                                                |

## Files Written

| Path                                                                        | Format | When                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>[_<segment>].sql`          | SQL    | durable changes only; bundled engine may emit ordered segments. Never written by `--transient`                                                                                                                                                                                                                                                                   |
| `<workdir>/supabase/schemas/extension.sql`                                  | SQL    | accepted legacy-extension repair                                                                                                                                                                                                                                                                                                                                 |
| `<workdir>/supabase/.temp/pgdelta/debug/<id>/`                              | dir    | durable apply or image-preflight failure, and transient execution failure; warns and omits the path when the directory cannot be created                                                                                                                                                                                                                         |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                     | JSON   | bundled engine with `PGDELTA_DEBUG`                                                                                                                                                                                                                                                                                                                              |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar    | cache-enabled COLD shadow provision creates the current key's snapshot — migrations/declarative shadows (`--no-cache` bypasses the snapshot cache entirely — neither read nor written); a warm hit `touch`es its mtime (LRU); every cache-eligible acquire may delete other keys under LRU keep-3 + 2-day mtime TTL — ~90MB (`SUPABASE_HOME` overrides the root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar    | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports / warm hits sweep leftovers older than 5 minutes                                                                                                                                   |

## Subprocesses / Containers

| What                                                                                                                                                                                                           | When                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Natively-provisioned shadows via `acquireShadowDatabase` — migrated source + declarative target for durable sync, declarative target only for `--transient`; ephemeral host ports, settings-keyed cache        | always                                                                                                                                |
| Direct SQL execution on the running local database, preserving each rendered unit's transaction mode and omitting migration-history/reset SQL                                                                  | `--transient`, after confirmation or `--yes`; the local `db` container must already be running — `--transient` never calls `db start` |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `resetLocalDatabase` — only on the failed-apply recovery path | TTY only, apply failed, and the user confirms "reset and reapply"                                                                     |

## Environment Variables

| Variable                     | Purpose                                                                                                                                                                                                                                                                                       | Required? |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_HOME`              | overrides the `~/.supabase` root used for the shadow baseline cache (and other CLI state)                                                                                                                                                                                                     | no        |
| `SUPABASE_SHADOW_CACHE`      | shadow baseline cache; on by default, opt-out (`0`/`false`); the shadow's post-baseline PGDATA is snapshotted to a tar and restored into the next run's fresh container (see Notes)                                                                                                           | no        |
| `PGDELTA_DEBUG`              | bundled-engine debug artifacts                                                                                                                                                                                                                                                                | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for the bootstrap generate                                                                                                                                                                                                                                                      | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback                                                                                                                                                                                                                                            | no        |
| `SUPABASE_USE_SLIM_IMAGES`   | resolves the current-pin shadow Postgres and PG15+ realtime/storage/auth migrate-job images from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB, and flag-off `15.8.1.085` stay on docker.io | no        |

## Exit Codes

| Code | Condition                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| `0`  | success (migration created, applied, or "No schema changes found")                                           |
| `1`  | pg-delta not enabled                                                                                         |
| `1`  | conflicting flags, including `--transient` with `--no-apply`, `--file`, `--name`, or `--apply=false`         |
| `1`  | `--transient` when the local database container is not already running                                       |
| `1`  | `--transient` without `--yes` when no TTY is available or machine output is selected                         |
| `1`  | no declarative schema files found                                                                            |
| `1`  | shadow-database / selected pg-delta engine / diff failure                                                    |
| `1`  | apply or image-preflight failure — native local apply (`applyMigrationToLocal` or `applyRenderedSqlToLocal`) |
| `1`  | repairable legacy extension omissions in non-interactive mode                                                |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: the gate check runs
first, so a closed gate (missing `--experimental`) surfaces before an
`--apply`/`--no-apply` conflict is ever checked.

## Output

Durable text mode writes generated SQL, created-migration paths, drop-statement
warnings, and apply status to stderr. Transient text mode writes the exact
ordered SQL to stdout before confirmation and again after successful execution;
diagnostics and warnings stay on stderr. JSON and stream-json transient results
include `changed`, `applied`, `migration_written`, `history_recorded`,
flattened `sql`, and ordered `units` with name, transaction mode, and SQL.
Failures after planning attach the same plan to the structured error envelope.
The no-files bootstrap also
prints `Declarative schema written to <dir>` (the relative declarative dir) to
stderr after generating and writing — on both interactive and `--yes` paths.
`--no-apply` writes the migration only (never prompts/applies); `--apply` applies
without prompting; both override the global `--yes`. `--no-apply` and `--apply`
are mutually exclusive.
`--transient` is local-only, requires an already-running local database, a text-mode TTY confirmation or `--yes`, and never
bootstraps a missing declarative tree. Redundant `--apply=true` is accepted but
does not provide consent. A stopped local database is refused (`supabase start is not running`) rather than auto-started.

A manifest-less CLI tree is refused by two compatibility gates — one when the
tree fails to load on the bundled engine's shadow, one when the plan drops an
extension the tree no longer declares (removing or renaming a `pg_cron` job or
`pgmq` queue declaration is an ordinary change and is never refused). Both
render the same message (`This <declarative-dir> tree looks like a legacy
pg-delta export.` plus an indented evidence block) and both carry the
staged-upgrade recipe on the error's suggestion, so the generic `Try rerunning
the command with --debug` footer is **not** printed. Non-interactive execution (including `--yes`) stops
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
  overrides it. Stems cannot contain either path separator or a case-insensitive
  `.sql` suffix. In a TTY without `--name`/`--yes`, the name is prompted and
  invalid input is re-prompted.
- When no declarative files exist, a TTY offers to generate them (from local) first.
- The declarative directory is the complete desired state: omitted objects,
  including extensions, are removals. Use `generate --output-dir <staging-dir>`
  to review a next-compatible tree without changing config or activating it.
- The interactive staged export announces that it snapshots the RUNNING local
  database (not the migrations state) and offers the same
  "Reset local database to match migrations first?" prompt as the smart-target
  local path before exporting. The printed staged-upgrade/adoption commands are
  rendered for the host platform: POSIX shells get `rm -rf`/`mv`, Windows gets
  single-line PowerShell (`Remove-Item`/`Move-Item`).
- When `declarative_schema_path` is unset, the new `supabase/schemas` default is
  empty, and the former `supabase/database` default still contains `.sql` files
  or an export manifest, a WARNING on stderr explains the default move and how
  to keep the existing tree. Read-only probe; never changes behavior or exit
  codes (a non-interactive run still fails with "no declarative schema found").
- Durable migration apply is native (connects to the local DB and records migration
  history). On apply or image-preflight failure a debug bundle is written under
  `supabase/.temp/pgdelta/debug/`. Generated migration files from this invocation
  are kept. Image-preflight failures use a distinct preflight message. In a TTY, a
  reset-and-reapply is offered after image preflight succeeds and local apply is
  attempted, including connection failures before SQL execution (the reset itself is
  native too — `resetLocalDatabase` — run in-process, sharing this command's own
  telemetry/linked-project-cache finalizer cycle rather than firing a second one from
  a child process).
- A transient execution failure saves the planned SQL, warns that earlier or
  nontransactional units may have applied, and requires rerunning to re-plan.
  Reset-and-replay is never offered because no durable migration exists.
- **Architecture:** the engine plans and renders in-process from two live shadows
  for durable sync and from the running local database plus one declarative shadow
  for transient sync.
- **Stale local-container guard.** Before diffing against the running local `db`
  target, the running container's actual image is inspected and compared
  against the currently-configured/resolved one. Same-major tag and slim/docker.io
  family changes use data-preserving `supabase stop` then `supabase start`. A proven
  Postgres-major upgrade **or** a standard↔OrioleDB storage-engine change uses
  `supabase stop --all --no-backup` then `supabase start` and explicitly warns that
  local data will be deleted.

### Shadow baseline cache (`SUPABASE_SHADOW_CACHE`, default ON)

The bundled (pg-delta next) engine provisions both plan shadows through
`acquireShadowDatabase` (`pgdelta-next-shadow.layer.ts`): on by default, off when
`SUPABASE_SHADOW_CACHE` is set to anything not viper-true (ambient env or project dotenv); `--no-cache`
bypasses restore and publish for that invocation. Next allocates an ephemeral host port per
shadow; the cache key hashes the cluster recipe (including the effective Webhooks/`pg_net`
policy), not the published port, so worktrees and repeated syncs with the same settings share
a warm hit. The migrations shadow follows project config; the declarative shadow forces
`pg_net` off — those are distinct keys when Webhooks are enabled. A warm hit skips the
platform baseline on both shadows (`migrateNextShadowDatabase` /
`setupShadowDatabase` are baseline-state-aware). When both snapshots are
already published they restore concurrently; a first-run pair that shares a
cache key builds the baseline once and hands it off; otherwise the two shadows
stay sequential so progress lines never interleave. Artifact:
`~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar` (~90MB; `SUPABASE_HOME` overrides
the root), keyed by a hash of every input baked into the cluster (including the effective
Webhooks/`pg_net` policy); shared across worktrees with the same settings; retention is LRU
(keep 3) + 2-day mtime TTL (warm hits refresh mtime; sibling tars may be deleted). Container
lifecycle is identical to the uncached path
except a cold run drops `--rm` (still removed on release). A cache anomaly never fails the
command — a warm-path anomaly cold-provisions instead, a cold export failure only warns and
leaves the run uncached (one exception: a shadow that fails to come back up after the snapshot
fails the run rather than reporting a false success). See `shared/db-bootstrap/shadow-cache.ts`.
Session-semantics caveat on the cached paths: migrations run on a session opened after the
platform baseline, so role-level defaults installed by `supabase/roles.sql`
(`ALTER ROLE … SET …`) apply to migration execution; with the cache off, the single-session flow
runs migrations before those defaults take effect.
