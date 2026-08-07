# `supabase db reset`

Native TypeScript port of `apps/cli-go/internal/db/reset/reset.go`. Reinitialises a
database from local migrations (plus seed). The **remote** path (`--linked`, or a
remote `--db-url`) is native: drop all user schemas, upsert vault secrets, then
re-apply migrations and seed. The **local** path (`--local`/default, or a `--db-url`
pointing at the local stack) is ALSO fully native (CLI-1955 removed the hidden Go
`db __db-bootstrap` seam this used to delegate to): the running check, the PG14/PG15
container-recreate composition (`legacy/shared/db-bootstrap/recreate-local-database.ts`,
reusing the same container-bootstrap primitives `db start` uses — see that command's
own `SIDE_EFFECTS.md`), the post-recreate satellite-restart + Kong reload
(`legacy/shared/db-bootstrap/restart-services.ts`), the storage-health gate
(`legacy/shared/db-bootstrap/await-storage-ready.ts`), bucket seeding, and the
git-branch line are all native TS. Only the niche **`--experimental`** schema-files
path with no resolved version still delegates to the Go binary, and only for the
**remote** target — the local target's `--experimental` path is fully native (see
"Notes").

The whole local-reset composition is hoisted into `legacy/shared/db-bootstrap/
reset-local-database.ts`'s `legacyResetLocalDatabase` (CLI-2062), which this
handler's own `cfg.isLocal` branch calls as a thin wrapper (keeping only version/
seed-flags resolution and the JSON envelope, which are specific to this top-level
command). `db schema declarative`'s smart-target local-reset prompt and `db schema
sync`'s failed-apply recovery reset both call the SAME function in-process now,
instead of shelling out to a second `supabase-go` child through the previously
removed `LegacyDeclarativeSeam.execInherit` seam — see those commands' own
`SIDE_EFFECTS.md`.

## Files Read

| Path                                                                                      | Format     | When                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`                                                          | directory  | to validate `--version` / resolve `--last`, and to load migrations                                                    |
| `<workdir>/supabase/config.toml`                                                          | TOML       | always, parsed up front before any destructive work (embedded defaults when absent); re-read for local bucket seeding |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file | dotenv     | always, resolved before the local prelude (config values, bootstrap config)                                           |
| `<workdir>/.git/HEAD` (walked upward)                                                     | plain text | local path, for the `Finished … on branch <branch>.` line                                                             |
| `~/.supabase/<hash>/project-ref`                                                          | plain text | `--linked`, to resolve the ref                                                                                        |
| `~/.supabase/access-token`                                                                | plain text | `--linked`, when `SUPABASE_ACCESS_TOKEN` unset and a temp role is minted                                              |
| seed files from `--sql-paths` or `[db.seed].sql_paths`                                    | SQL        | when seeding is enabled (not `--no-seed`); `--sql-paths` overrides config                                             |
| `<workdir>/supabase/buckets/`                                                             | files      | local path, when storage is up and `[storage.buckets]` configure objects                                              |
| `<workdir>/supabase/roles.sql`                                                            | SQL        | local PG15 path only, via the reused `legacyStartSetupLocalDatabase` pipeline — missing file tolerated                |
| `~/.docker/config.json`                                                                   | JSON       | via the `docker`/`podman` CLI itself, for registry auth — never read directly by this process                         |

## Files Written

| Path                                             | Format | When                              |
| ------------------------------------------------ | ------ | --------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | `--linked` (post-run cache)       |
| `~/.supabase/telemetry.json`                     | JSON   | always (post-run telemetry flush) |

On the local path, the native recreate additionally recreates the
`supabase_db_<project>` container/volume (PG15) or the `postgres`/`_supabase`
databases in place (PG14), and applies the initial schema (`SetupLocalDatabase`
equivalent, PG15) or `InitSchema14`/`ApplyApiPrivileges` (PG14); the `--experimental`
remote path produces whatever the delegated Go binary writes.

## Subprocesses

| Command                                                                             | When                                  | Purpose                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `docker container inspect supabase_db_<project>`                                    | local path                            | `AssertSupabaseDbIsRunning` probe (Podman fallback)                             |
| `docker container rm -f supabase_db_<project>` / `docker volume rm -f <same>`       | local path, PG15                      | remove the existing container/volume before recreating (Podman fallback)        |
| `docker network create` / `docker volume create` / `docker create` / `docker start` | local path, PG15                      | recreate the Postgres container (same primitives `db start` uses)               |
| `docker run --rm <realtime\|storage\|gotrue image>`                                 | local path, PG15, per enabled service | the one-shot `initSchema15` migrate jobs (`legacyStartSetupLocalDatabase`)      |
| `docker restart <db container>`                                                     | local path, PG14                      | `RestartDatabase` — pg_cron must restart after `pg_terminate_backend`           |
| `docker restart <storage\|auth\|realtime\|pooler container>`                        | local path, both PG14 and PG15        | concurrent satellite-container restart, not-found tolerated per service         |
| `docker container inspect <kong container>` + `docker exec <kong> kong reload`      | local path, both PG14 and PG15        | reload Kong so it re-resolves the restarted containers' addresses (issue #6016) |
| `docker container inspect supabase_storage_<project>`                               | local path                            | storage-health gate before bucket seeding                                       |
| `supabase-go db reset --linked\|--db-url … [--no-seed]`                             | `--experimental` remote, no version   | the un-ported experimental schema-files apply path (telemetry disabled)         |

## Database Mutations

### Remote path (native, in TS)

| Statement                                                                                                                                        | When                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `drop.sql` `DO` block (drops user schemas/extensions/public objects, truncates auth/migrations)                                                  | always, first                                                |
| `SELECT vault.update_secret(...)` / `vault.create_secret(...)`                                                                                   | when `[db.vault]` has syncable secrets                       |
| migration statements + `schema_migrations` history insert (per file, transactional; pipeline-incompatible statements run standalone — see Notes) | when `[db.migrations].enabled`, for migrations `≤ --version` |
| seed statements + `seed_files` hash upsert                                                                                                       | when `[db.seed].enabled` and not `--no-seed`                 |

### Local path (native, in TS)

**PG15+:** the container/volume are removed and recreated (see "Subprocesses"), then
the reused `legacyStartSetupLocalDatabase` pipeline runs the initial schema (as
one-shot Docker jobs, not SQL over a session), `ApplyApiPrivileges`, a vault upsert,
a `roles.sql` seed, and `MigrateAndSeed` (migrations `≤ --version`, seed unless
`--no-seed`) — over a fresh host-facing Postgres connection.

**PG14:** connects as `supabase_admin` to `template1` and disconnects other clients
(`ALTER DATABASE ... ALLOW_CONNECTIONS false` ×2, `pg_terminate_backend`, then polls
`pg_replication_slots` on a 1-second backoff up to 10 times — a failure here is
swallowed unless it's a PgError whose code isn't `3D000`/`invalid_catalog_name`), then
runs four unwrapped statements: `DROP`/`CREATE DATABASE postgres`, `DROP`/`CREATE
DATABASE _supabase`. Reconnects as `supabase_admin` to `postgres` for the schema SQL
(`InitSchema14`, no `globals.sql` — deliberately different from `db start`'s own PG14
path) + `ApplyApiPrivileges`. After the container itself is restarted (see below),
reconnects as `postgres`/`postgres` for `MigrateAndSeed` (migrations `≤ --version`,
seed unless `--no-seed`).

**Both branches** then restart the storage/auth/realtime/pooler containers
concurrently (per-service "not found" tolerated, no health wait afterward — "those
services may be excluded from starting"), then reload Kong (`docker exec <kong> kong
reload`; skipped, not failed, when the gateway is absent or stopped) so its nginx
re-resolves the restarted containers' addresses — otherwise routes to a moved
container keep returning 502 after the reset succeeds (issue #6016). **A Kong reload
failure fails the WHOLE command** (unlike `functions serve`'s best-effort reload),
with an actionable `Suggestion:` line (`docker restart <kong>` / `docker logs <kong>`).
Bucket objects are then seeded over the Storage gateway (reusing the `seed buckets`
local path), gated on a native storage-health check: absent (any inspect error, not
just "not found") skips buckets without failing; present-but-unhealthy waits up to a
**hardcoded 30 seconds** (independent of `db.health_timeout`) and, on timeout, **fails
the whole reset** (not just "skip buckets").

## API Routes

| Method | Path | Auth | Request body | Response (used fields)                                                                                                                                             |
| ------ | ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —      | —    | —    | —            | Connects to Postgres directly. The `--linked` resolver may call the Management API to mint a temporary login role; local bucket seeding calls the Storage gateway. |

## Environment Variables

| Variable                                                                                                   | Purpose                                                                                                                                                      | Required?                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                                                                                    | auth token for the `--linked` resolver path                                                                                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`                                                                                     | password for the linked/remote connection                                                                                                                    | no                                                      |
| `SUPABASE_YES`                                                                                             | auto-confirm the reset prompt                                                                                                                                | no (also `--yes`)                                       |
| `SUPABASE_EXPERIMENTAL`                                                                                    | routes the remote experimental schema-files path to Go; on the local path, applies `db.migrations.schema_paths` files instead of `migrations/*.sql` (native) | no (also `--experimental`)                              |
| `SUPABASE_PROJECT_ID`                                                                                      | overrides the local container id (`utils.DbId`)                                                                                                              | no                                                      |
| `SUPABASE_DB_PORT` / `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | local-path container-recreate config overrides, same as `db start`                                                                                           | no                                                      |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                                     | forces the recreated container/network onto an existing Docker network                                                                                       | no                                                      |

## Exit Codes

| Code                 | Condition                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`                  | success                                                                                                                                    |
| `1`                  | mutually exclusive target flags (`[db-url linked local]`)                                                                                  |
| `1`                  | `--version` + `--last` together (`[last version]`)                                                                                         |
| `1`                  | `--version` not an integer (`invalid version number`)                                                                                      |
| `1`                  | `--version` has no matching migration file                                                                                                 |
| `1`                  | local: database not running (`supabase start is not running.`)                                                                             |
| `1`                  | user declined the reset confirmation (`context canceled`)                                                                                  |
| `1`                  | `config.toml` parse failure                                                                                                                |
| `1`                  | drop / migrate / seed / vault apply failure, or connection error                                                                           |
| `1`                  | local: container/volume remove, network/volume/container create, health-check timeout, PG14 SQL, satellite-restart, or Kong-reload failure |
| child's exact code\* | `--experimental`/`--linked` remote delegate (proxy) child exit                                                                             |

\* The `--experimental` remote delegate propagates the spawned `supabase-go` child's
real exit code (e.g. `130` after a Ctrl-C) instead of collapsing every failure to `1`
— in every `--output-format` (CLI-1879). The local path has no Go child at all
anymore (CLI-1955) — every local failure is a native, typed TS error.

## Output

The remote path prints `Resetting remote database…` to **stderr**, then the
drop/migrate/seed progress (`Applying migration …`, `Seeding data from …`). Go
connects with `io.Discard`, so there is **no** `Connecting to … database…` line and
**no** `Finished …` line on the remote path.

The local path prints `Resetting local database…` to **stderr**, then
`Recreating database...` (PG15) or nothing extra (PG14, until the restart step) /
`Restarting containers...` progress, and finally `Finished supabase db reset on
branch <branch>.` (`supabase db reset` and `<branch>` in Aqua).

### `--output-format text` (Go CLI compatible)

Byte-matches Go's stderr progress for both the remote and local paths. The
`--experimental` remote path passes the delegated Go binary's output through
unchanged.

### `--output-format json` / `stream-json`

stdout is payload-only; a `result` object is emitted:

```json
{ "target": "remote" | "local", "version": "<resolved version or empty>" }
```

In machine modes the remote confirmation prompt is non-interactive and takes its
default (`false`), so a remote reset is declined unless `--yes` is set. The local
path has no confirmation prompt.

## Notes

- **Target/local split** follows Go's `IsLocalDatabase(resolved config)`, not the
  flag name: a `--db-url` pointing at the local stack is treated as a local reset.
- **Pipeline-incompatible statements** (`CREATE INDEX CONCURRENTLY`, `VACUUM`, …) run
  standalone outside the per-file transaction batch, with the same non-atomic flush
  behaviour as `db push` — see `db push`'s SIDE_EFFECTS Notes (supabase/cli#5139,
  closed Go PR supabase/cli#5156, CLI-1989 parity ruling).
- `--no-seed` forces seeding off (Go sets `Config.Db.Seed.Enabled = false`); on the
  local path it feeds `legacyResolveResetSeedConfig`, applied on top of the loaded
  `[db.seed]` config inside the recreate's own `MigrateAndSeed` step (same override
  logic on both PG14 and PG15).
- `--sql-paths` overrides `[db.seed].sql_paths` for one reset and force-enables seeding
  even when `[db.seed].enabled = false`; repeat it to seed multiple files or glob
  patterns (supabase-relative). Mutually exclusive with `--no-seed`. On the local path
  it is applied the same way as `--no-seed` above; on the remote path it seeds the
  selected database after migrations (Go warns when paired with `--linked` / `--db-url`).
- `--last n` reverts the most recent `n` migrations; if `n ≥ total`, the reset target
  version becomes `-` (revert everything). Mutually exclusive with `--version`.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- The local target's `--experimental` schema-files path (no resolved version, no
  pg-delta) is fully native: it was never actually delegated even before this port
  (the removed seam forwarded `--experimental` straight through to its own Go child),
  and `legacyMigrateAndSeed` (reused by both PG14 and PG15) already implements Go's
  `apply.MigrateAndSeed` declarative-schema-files branch.
- The best-effort pg-delta migrations-catalog cache write
  (`pgcache.TryCacheMigrationsCatalog`, reachable from the PG15 recreate via
  `SetupLocalDatabase`) IS reached on the local PG15 path, same as `db start` —
  `reset.layers.ts` composes `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer`
  for it (see `db-setup.ts`'s own header for the exact gate). The write is silent on
  success; a failure only warns on stderr and never fails the reset, matching Go.
- `encrypted:` vault secrets are skipped on the remote path.
- `db schema declarative`/`db schema sync`'s own local-reset paths now call
  `legacyResetLocalDatabase` in-process too (CLI-2062) — the previous scope boundary
  (those two commands shelling out to a second `supabase-go` child via the now-removed
  `LegacyDeclarativeSeam.execInherit`) is closed. That in-process call collapses to a
  single telemetry/linked-project-cache finalizer cycle (the outer `db schema
declarative`/`sync` command's own), matching Go's single-process `reset.Run` call —
  the removed subprocess design used to fire a second, independent one from the child
  process's own `Execute()`.
