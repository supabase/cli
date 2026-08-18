# `supabase db reset`

Reinitialises a database from local migrations (plus seed). Both targets are
fully native. The **remote** path (`--linked`, or a remote `--db-url`)
drops all user schemas, upserts vault secrets, then either re-applies migrations
(the default) or, on a versionless `--experimental`/`SUPABASE_EXPERIMENTAL` reset
with pg-delta not enabled, applies the declarative `[db.migrations].schema_paths`
files instead (the `MigrateAndSeed` EXPERIMENTAL branch, CLI-1958), then
seeds. The **local** path (`--local`/default, or a `--db-url` pointing at the local
stack) is ALSO fully native (CLI-1955 removed the hidden Go `db __db-bootstrap` seam
this used to delegate to): the running check, the PG14/PG15 container-recreate
composition (`legacy/shared/db-bootstrap/recreate-local-database.ts`, reusing the
same container-bootstrap primitives `db start` uses — see that command's own
`SIDE_EFFECTS.md`), the post-recreate satellite-restart + Kong reload
(`legacy/shared/db-bootstrap/restart-services.ts`), the storage-health gate
(`legacy/shared/db-bootstrap/await-storage-ready.ts`), bucket seeding, and the
git-branch line are all native TS — including the local target's own
`--experimental` schema-files apply (`legacyMigrateAndSeed`, shared with the remote
path's branch above).

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
| `~/.supabase/<hash>/project-ref`                                                          | plain text | `--linked`, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                       |
| `~/.supabase/access-token`                                                                | plain text | `--linked`, when `SUPABASE_ACCESS_TOKEN` unset and a temp role is minted                                              |
| seed files from `--sql-paths` or `[db.seed].sql_paths`                                    | SQL        | when seeding is enabled (not `--no-seed`); `--sql-paths` overrides config                                             |
| schema files from `[db.migrations].schema_paths`                                          | SQL        | when the `--experimental` schema-files branch is taken, either target (see Notes)                                     |
| `<workdir>/supabase/buckets/`                                                             | files      | local path, when storage is up and `[storage.buckets]` configure objects                                              |
| `<workdir>/supabase/roles.sql`                                                            | SQL        | local PG15 path only, via the reused `legacyStartSetupLocalDatabase` pipeline — missing file tolerated                |
| `~/.docker/config.json`                                                                   | JSON       | via the `docker`/`podman` CLI itself, for registry auth — never read directly by this process                         |

## Files Written

| Path                                                                            | Format | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json`                                | JSON   | `--linked` (post-run cache)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `~/.supabase/telemetry.json`                                                    | JSON   | always (post-run telemetry flush)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/.temp/pgdelta/catalog-<prefix>-migrations-<hash>-<ts>.json` | JSON   | best-effort, after migrations/seeding succeed, when no `--version`/`--last` resolved a version AND pg-delta is enabled (`[experimental.pgdelta].enabled` or `SUPABASE_EXPERIMENTAL_PG_DELTA`) AND the legacy engine is selected (`SUPABASE_USE_PG_DELTA_NEXT=false`); the default next engine skips this warmup entirely; a failure only warns on stderr and never fails the reset — see Notes. Native TS on both targets: **remote path** (`<prefix>` = the project ref/URL hash) after either apply branch (schema-files or migrations); **local path** (`<prefix>` = `"local"`) PG15 only, via the reused `legacyStartSetupLocalDatabase` pipeline (`db-setup.ts`) after `MigrateAndSeed` — the PG≤14 branch never calls this at all, so a PG≤14 local project never writes this file regardless of pg-delta config |

On the local path, the native recreate additionally recreates the
`supabase_db_<project>` container/volume (PG15) or the `postgres`/`_supabase`
databases in place (PG14), and applies the initial schema (`SetupLocalDatabase`
equivalent, PG15) or `InitSchema14`/`ApplyApiPrivileges` (PG14).

## Subprocesses

| Command                                                                                                                      | When                                  | Purpose                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker container inspect supabase_db_<project>`                                                                             | local path                            | `AssertSupabaseDbIsRunning` probe (Podman fallback)                                                                                                                                                                                                       |
| `docker container rm -f supabase_db_<project>` / `docker volume rm -f <same>`                                                | local path, PG15                      | remove the existing container/volume before recreating (Podman fallback)                                                                                                                                                                                  |
| `docker network create` / `docker volume create` / `docker create` / `docker start`                                          | local path, PG15                      | recreate the Postgres container (same primitives `db start` uses)                                                                                                                                                                                         |
| `docker run --rm <realtime\|storage\|gotrue image>`                                                                          | local path, PG15, per enabled service | the one-shot `initSchema15` migrate jobs (`legacyStartSetupLocalDatabase`)                                                                                                                                                                                |
| `docker restart <db container>`                                                                                              | local path, PG14                      | `RestartDatabase` — pg_cron must restart after `pg_terminate_backend`                                                                                                                                                                                     |
| `docker restart <storage\|auth\|realtime\|pooler container>`                                                                 | local path, both PG14 and PG15        | concurrent satellite-container restart, not-found tolerated per service                                                                                                                                                                                   |
| `docker container inspect <kong container>` + `docker exec <kong> kong reload --nginx-conf /home/kong/custom_nginx.template` | local path, both PG14 and PG15        | reload Kong so it re-resolves the restarted containers' addresses (issue #6016) — the `--nginx-conf` flag is load-bearing: a bare `kong reload` regenerates nginx.conf from Kong's default template and drops the custom `email_templates` server (#6059) |
| `docker container inspect supabase_storage_<project>`                                                                        | local path                            | storage-health gate before bucket seeding                                                                                                                                                                                                                 |

No subprocess delegation remains on either target — the remote path's
`--experimental` schema-files apply (formerly delegated to a `supabase-go db reset`
child) is fully native as of CLI-1958.

## Database Mutations

### Remote path (native, in TS)

| Statement                                                                                                                                        | When                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `drop.sql` `DO` block (drops user schemas/extensions/public objects, truncates auth/migrations)                                                  | always, first                                                                                              |
| `SELECT vault.update_secret(...)` / `vault.create_secret(...)`                                                                                   | when `[db.vault]` has syncable secrets                                                                     |
| schema-file statements (no history bookkeeping, no `RESET ALL` between files)                                                                    | `--experimental` + no resolved version + pg-delta not enabled (see Notes)                                  |
| migration statements + `schema_migrations` history insert (per file, transactional; pipeline-incompatible statements run standalone — see Notes) | otherwise, when `[db.migrations].enabled`, for migrations `≤ --version`                                    |
| seed statements + `seed_files` hash upsert                                                                                                       | when `[db.seed].enabled` and not `--no-seed` (runs after either branch above)                              |
| `SET SESSION ROLE postgres`                                                                                                                      | stepped-down sessions only: after each role-reverting statement, at end of each file, before ledger writes |

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

| Variable                                                                                                   | Purpose                                                                                                                                                                                                                                                                    | Required?                                               |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                                                                                    | auth token for the `--linked` resolver path                                                                                                                                                                                                                                | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_DB_PASSWORD`                                                                                     | password for the linked/remote connection                                                                                                                                                                                                                                  | no                                                      |
| `SUPABASE_YES`                                                                                             | auto-confirm the reset prompt                                                                                                                                                                                                                                              | no (also `--yes`)                                       |
| `SUPABASE_EXPERIMENTAL`                                                                                    | selects the schema-files apply branch on either target                                                                                                                                                                                                                     | no (also `--experimental`)                              |
| `SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED`                                                                    | overrides `[experimental.pgdelta].enabled`; a truthy value flips the reset gate (`experimental && resolvedVersion === "" && !toml.pgDelta.enabled`) back to timestamped migrations even with `--experimental` set — switches between two different destructive code paths  | no                                                      |
| `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS`                                                                      | overrides `[db.migrations].schema_paths` (viper `AutomaticEnv`, beats the config-file value) for the schema-files apply branch — genuinely effective on both targets now                                                                                                   | no (no dedicated flag — config-file-only otherwise)     |
| `SUPABASE_PROJECT_ID`                                                                                      | overrides the local container id; ALSO the linked-ref resolution fallback `--project-ref` supersedes — see Notes for the narrower scope of the flag                                                                                                                        | no                                                      |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`                                                                           | enables the post-reset migrations-catalog cache (see Files Written) when `[experimental.pgdelta].enabled` is unset — distinct from `SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED` above, which switches the reset's own apply branch instead                                      | no (project `.env` or shell)                            |
| `SUPABASE_USE_PG_DELTA_NEXT`                                                                               | selects the pg-delta implementation; `false` selects the legacy edge-runtime engine and thereby restores the migrations-catalog cache (unset/unrecognized defaults to the next engine, which skips it); shell presence wins over project `.env`, even an empty shell value | no (project `.env` or shell)                            |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                                                         | overrides the pg-delta edge-runtime image registry for the migrations-catalog cache export (scoped for the whole run via `legacyApplyProjectEnv`, matching `db push`)                                                                                                      | no (project `.env` or shell)                            |
| `PGDELTA_NPM_REGISTRY`                                                                                     | overrides the pg-delta edge-runtime npm registry (`.npmrc` + `NPM_CONFIG_REGISTRY` forward) for the migrations-catalog cache export (scoped for the whole run via `legacyApplyProjectEnv`, matching `db push`)                                                             | no (project `.env` or shell)                            |
| `SUPABASE_DB_PORT` / `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | local-path container-recreate config overrides, same as `db start`                                                                                                                                                                                                         | no                                                      |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                                     | forces the recreated container/network onto an existing Docker network                                                                                                                                                                                                     | no                                                      |

## Exit Codes

| Code | Condition                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                                                                    |
| `1`  | mutually exclusive target flags (`[db-url linked local]`)                                                                                  |
| `1`  | `--version` + `--last` together (`[last version]`)                                                                                         |
| `1`  | `--version` not an integer (`invalid version number`)                                                                                      |
| `1`  | `--version` has no matching migration file                                                                                                 |
| `1`  | local: database not running (`supabase start is not running.`)                                                                             |
| `1`  | user declined the reset confirmation (`context canceled`)                                                                                  |
| `1`  | `config.toml` parse failure                                                                                                                |
| `1`  | drop / migrate / seed / vault apply failure, or connection error                                                                           |
| `1`  | no `[db.migrations].schema_paths` pattern matched anything on the `--experimental` branch, either target                                   |
| `1`  | local: container/volume remove, network/volume/container create, health-check timeout, PG14 SQL, satellite-restart, or Kong-reload failure |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes)                                                                   |

There is no remaining Go child on either target (CLI-1955 removed it for local,
CLI-1958 for remote) — every failure is a native, typed TS error surfaced as `1`.

## Output

The remote path prints `Resetting remote database…` to **stderr**, then either the
schema-files branch's apply (no per-file progress, CLI-1958) or the migrate/seed
progress (`Applying migration …`, `Seeding data from …`). There is **no**
`Connecting to … database…` line and **no** `Finished …` line on the remote path.

The local path prints `Resetting local database…` to **stderr**, then
`Recreating database...` (PG15) or nothing extra (PG14, until the restart step) /
`Restarting containers...` progress, and finally `Finished supabase db reset on
branch <branch>.` (`supabase db reset` and `<branch>` in Aqua).

### `--output-format text`

Stderr progress for both the remote and local paths, including the
silent (no-progress-line) `--experimental` schema-files apply.

### `--output-format json` / `stream-json`

stdout is payload-only; a `result` object is emitted:

```json
{ "target": "remote" | "local", "version": "<resolved version or empty>" }
```

In machine modes the remote confirmation prompt is non-interactive and takes its
default (`false`), so a remote reset is declined unless `--yes` is set. The local
path has no confirmation prompt.

## Notes

- **Target/local split** follows whether the resolved config points at the local
  stack, not the flag name: a `--db-url` pointing at the local stack is treated
  as a local reset.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution `LegacyProjectRefResolver`
  performs (flag > `SUPABASE_PROJECT_ID` > `~/.supabase/<hash>/project-ref`) —
  unlike `SUPABASE_PROJECT_ID`, it does not affect the local container id. It
  never implies `--linked`: passing it with a resolved `--local`/`--db-url`
  target is a hard error rather than a silently discarded flag (deliberately
  stricter than `SUPABASE_PROJECT_ID`, which simply goes unused on a
  non-linked target).
- **Pipeline-incompatible statements** (`CREATE INDEX CONCURRENTLY`, `VACUUM`, …) run
  standalone outside the per-file transaction batch, with the same non-atomic flush
  behaviour as `db push` — see `db push`'s SIDE_EFFECTS Notes (supabase/cli#5139,
  adopted into TS in PR supabase/cli#5671).
- `--no-seed` forces seeding off; on the
  local path it feeds `legacyResolveResetSeedConfig`, applied on top of the loaded
  `[db.seed]` config inside the recreate's own `MigrateAndSeed` step (same override
  logic on both PG14 and PG15).
- `--sql-paths` overrides `[db.seed].sql_paths` for one reset and force-enables seeding
  even when `[db.seed].enabled = false`; repeat it to seed multiple files or glob
  patterns (supabase-relative). Mutually exclusive with `--no-seed`. On the local path
  it is applied the same way as `--no-seed` above; on the remote path it seeds the
  selected database after migrations (a warning is printed when paired with
  `--linked` / `--db-url`).
- `--last n` reverts the most recent `n` migrations; if `n ≥ total`, the reset target
  version becomes `-` (revert everything). Mutually exclusive with `--version`.
- `--db-url`, `--linked`, and `--local` (default true) are mutually exclusive.
- **`--experimental` schema-files apply** (the `MigrateAndSeed` EXPERIMENTAL
  branch) is taken on
  EITHER target when `--experimental`/`SUPABASE_EXPERIMENTAL` is set, no
  `--version`/`--last` resolved a version, AND `[experimental.pgdelta].enabled` is
  NOT set. Taking this branch means timestamped
  migrations never run at all, even when `[db.migrations].schema_paths` matches
  nothing. Faithfully reproduces two undocumented quirks inherited from the old
  Go CLI: (1) the `schema_paths`
  default is `[]`, so a stock project running an experimental reset silently applies
  NOTHING (drops schemas, seeds, but replays no SQL) rather than falling back to
  migrations; (2) a partial glob failure (some patterns match, others don't) is
  silently dropped — only a TOTAL failure (no pattern matches anything) aborts the
  reset, with the joined `no files matched pattern: …` text and no suggestion.
  A per-file apply failure attaches a `See schema file: <file>` suggestion. No
  progress line is printed per file, no
  migration-history row is inserted, and no `RESET ALL` runs between files. Seeding
  still runs afterward, unconditionally, exactly as on the migrations branch. The
  local target's branch was already native before this port (`legacyMigrateAndSeed`,
  reused by both the PG14 and PG15 recreate branches, already implements this exact
  branch); CLI-1958 ports the remote target's copy of the same branch
  (`legacyApplySchemaFiles`), removing the last Go delegation on this command.
  `encrypted:` vault secrets are NOT skipped on the remote path — `legacyCheckDbToml`
  decrypts them into `toml.vault`, and `legacyUpsertVaultSecrets` upserts the
  decrypted values unconditionally, before either branch (schema-files or migrations)
  runs.
- **Migrations catalog cache**: gated on no `--version`/`--last` having resolved
  a version, pg-delta being enabled (`[experimental.pgdelta].enabled` or
  `SUPABASE_EXPERIMENTAL_PG_DELTA` — see Environment Variables), AND the legacy engine
  being selected (`SUPABASE_USE_PG_DELTA_NEXT=false`; the default next engine skips
  this warmup entirely); a versioned reset
  never refreshes the cache. A failure only warns on stderr and never fails
  the reset. Writes under `supabase/.temp/pgdelta/` (see Files
  Written), pruning older snapshots for the same prefix (retains 2). Native TS on
  BOTH paths now, on different call chains:
  - **Remote path** (ported CLI-1958): after either apply branch
    (schema-files or migrations) and seeding complete. Exports the target's pg-delta
    catalog via the edge-runtime stack. Reuses `legacyExportCatalogPgDelta` and
    `legacyTryCacheMigrationsCatalog` — the same helpers `db push` uses for its own
    post-apply cache (see that command's SIDE_EFFECTS Notes) — rather than a second
    copy.
  - **Local path** (native since CLI-1955/2062, no Go child involved): the reused
    `legacyStartSetupLocalDatabase` pipeline (`db-setup.ts`) calls the same
    `legacyTryCacheMigrationsCatalog` (with prefix `"local"`) right after
    `MigrateAndSeed` succeeds, warning the same way on failure. `reset.layers.ts`
    composes `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer` for this —
    the same pair `db start`/`db push` already compose for their own calls into the
    same function. This only happens on the **PG15** recreate branch — the
    **PG≤14** branch returns immediately after `MigrateAndSeed` and never calls
    `legacyTryCacheMigrationsCatalog` at all, so a PG≤14 local project never writes
    this file, no matter how pg-delta is configured.
- `db schema declarative`/`db schema sync`'s own local-reset paths now call
  `legacyResetLocalDatabase` in-process too (CLI-2062) — the previous scope boundary
  (those two commands shelling out to a second `supabase-go` child via the now-removed
  `LegacyDeclarativeSeam.execInherit`) is closed. That in-process call collapses to a
  single telemetry/linked-project-cache finalizer cycle (the outer `db schema
declarative`/`sync` command's own) — the removed subprocess design used to fire a
  second, independent one from the child process's own execution.
