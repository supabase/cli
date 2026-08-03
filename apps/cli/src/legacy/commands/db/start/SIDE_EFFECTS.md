# `supabase db start`

Fully native TypeScript port of `apps/cli-go/internal/db/start/start.go`'s `Run` +
`StartDatabase` (CLI-1954 removed the last Go delegation — the hidden `db __db-bootstrap
--mode start` case no longer exists; CLI-1955 removed the REST of that hidden command too
— see `db reset --local`'s own `SIDE_EFFECTS.md`). This is `db start`, **not** the
top-level `supabase start`: no status table, no `cli_stack_started` event, no `Finished`
line, no `--exclude`, no `--ignore-health-check`.

The handler validates config, checks whether the local Postgres container is already
running (`legacyIsLocalDbRunning` — a native `docker container inspect`, hoisted to
`legacy/shared/db-bootstrap/local-db-running.ts` and shared with `db reset --local`'s
own running-check), and otherwise natively brings up the container itself, reusing
`legacy/shared/db-bootstrap/`'s container-bootstrap primitives (the same ones `supabase
start` uses for its own Postgres bring-up, and `db reset --local`'s own recreate
composition reuses too — see that command's `SIDE_EFFECTS.md`):

1. Ensure the Docker network exists (`--network-id` override or `supabase_network_<project>`).
2. Probe whether the Postgres data volume (`supabase_db_<project>`) already exists —
   BEFORE creating it, matching Go's `NoBackupVolume` check ordering.
3. **`--from-backup` + an existing volume**: fail with `backup volume already exists`
   (suggestion: `supabase stop --no-backup`), roll back (see below), and exit — no
   container is created on this path.
4. Print `Starting database...` (fresh volume) or `Starting database from backup...`
   (existing volume — despite the wording, unrelated to `--from-backup`; see
   `legacy/shared/db-bootstrap/messages.ts`).
5. Resolve the Postgres image (version-pin-aware) and create + start the container.
   `--from-backup` set: a THIRD entrypoint variant (`legacyBuildPostgresStartContainerSpec`'s
   `fromBackup` branch) — schema.sql + `_supabase.sql` (no `webhook.sql`), a ported
   `migrate.sh` (`templates/db-restore.sh.ts`, transcribed from Go's `templates/restore.sh`)
   that restores roles then schema from the bind-mounted backup file, and
   `cron.launch_active_jobs = off` appended to `postgresql.conf` — applies regardless of
   `db.major_version`. The backup file itself is bind-mounted `:ro` at `/etc/backup.sql`
   (host path resolved against the CALLER's cwd when relative, matching Go's
   `CurrentDirAbs`).
6. Wait for the container to become healthy (`db.health_timeout`, default `2m`). A timeout
   fails the command UNLESS `--from-backup` is set, in which case it is swallowed (a large
   restore can exceed the timeout) — the container-logs dump to stderr still happens
   either way.
7. On a fresh volume with `--from-backup` unset: run the `SetupLocalDatabase`-equivalent
   pipeline (`legacy/shared/db-bootstrap/db-setup.ts`) — initial schema (PG<=14: SQL over a
   direct `LegacyDbConnection`; PG>=15: up to three one-shot `docker run --rm` migrate jobs
   for realtime/storage/auth, each gated on its own `enabled` flag), API-privilege
   revocation, `[db.vault]` secret upsert, `supabase/roles.sql` seed, and finally either every
   pending migration + seed, OR — when `--experimental`/`SUPABASE_EXPERIMENTAL` is set AND
   `[experimental.pgdelta] enabled` is false — every `db.migrations.schema_paths` file
   (declarative schema files) instead of migrations, followed by seed either way (Go's
   `apply.MigrateAndSeed`). Skipped IN FULL when `--from-backup` is set (not merely reduced).
8. Write `supabase/.branches/_current_branch` = `"main"` if absent — runs on EVERY path
   that reaches this point (fresh volume, existing volume, and a swallowed
   `--from-backup` health-check timeout), but NOT on the already-running short-circuit or
   the `backup volume already exists` guard.

Any failure from step 1 onward rolls back via `legacyRollbackStart` (stop + prune every
container/network this project's label matches; volumes are pruned too, but ONLY when the
volume was confirmed fresh this run) — matching Go's `Run`, which calls `DockerRemoveAll`
on any `StartDatabase` failure.

## Files Read

| Path                                                                                            | Format | When                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                | TOML   | always — parsed up front; a malformed config aborts before any container work                                                                                                |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file       | dotenv | always                                                                                                                                                                       |
| `auth.signing_keys_path` file                                                                   | JSON   | when configured                                                                                                                                                              |
| `<path>` (from `--from-backup`)                                                                 | binary | when `--from-backup` is set — read by Postgres's own entrypoint inside the container, not by this process                                                                    |
| `<workdir>/supabase/.temp/storage-migration`                                                    | text   | always — linked-project Storage migration pin (`DB_MIGRATIONS_FREEZE_AT`); absent/unreadable resolves to ""                                                                  |
| `<workdir>/supabase/.temp/postgres-version`                                                     | text   | when `db.major_version > 14` — linked-project Postgres version pin                                                                                                           |
| `<workdir>/supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version` | text   | always read; only the `gotrue`/`storage`/`realtime` pins are actually consulted (the fresh-volume setup jobs' images)                                                        |
| `<workdir>/supabase/roles.sql`                                                                  | SQL    | on a fresh volume with no `--from-backup` — the "Seeding globals..." message always prints first; a missing file is tolerated                                                |
| `<workdir>/supabase/migrations/*.sql`, `supabase/seed.sql`                                      | SQL    | on a fresh volume with no `--from-backup`, via the standard migration-apply + seed pipeline                                                                                  |
| `<workdir>/supabase/<db.migrations.schema_paths entries>` (files/directories/globs)             | SQL    | on a fresh volume with no `--from-backup`, INSTEAD of `migrations/*.sql`, when `--experimental`/`SUPABASE_EXPERIMENTAL` is set and `[experimental.pgdelta] enabled` is false |
| `<workdir>/supabase/.branches/_current_branch`                                                  | text   | always, existence check before writing (see "Files Written")                                                                                                                 |
| `~/.docker/config.json`                                                                         | JSON   | via the `docker`/`podman` CLI itself, for registry auth — never read directly by this process                                                                                |

## Files Written

| Path                                                                  | Format | When                                                                                                                                      |
| --------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.branches/_current_branch`                        | text   | only if absent — writes `"main"` (see the step-by-step sequence above for exactly when)                                                   |
| `<workdir>/supabase/.temp/start-secrets/<dbContainerName>/secret-0`   | binary | Postgres's pgsodium root key (mode `0644`, directory mode `0700`) — every entrypoint variant except the PG<=14 no-backup one carries this |
| local Docker volume `supabase_db_<project>`                           | —      | the Postgres data volume, created on first start (or first `--from-backup` restore)                                                       |
| local Docker network `supabase_network_<project>` (or `--network-id`) | —      | created if it doesn't already exist                                                                                                       |
| `~/.supabase/telemetry.json`                                          | JSON   | always — telemetry flush (`Effect.ensuring(telemetryState.flush)`), success and failure                                                   |

## Subprocesses

Every step below shells out to `docker` (falling back to `podman`), matching every other
native container command in this codebase — never `supabase-go`.

| Command                                                                                                                          | When                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docker container inspect supabase_db_<project>`                                                                                 | always — the already-running probe                                                                                |
| `docker network create --label ... <networkId>`                                                                                  | when not already running, unless `--network-id` names a built-in network                                          |
| `docker volume inspect supabase_db_<project>`                                                                                    | when not already running — the pre-create fresh-volume probe                                                      |
| `docker image inspect` / `docker pull` (registry-fallback resolve)                                                               | when not already running — resolves the Postgres image                                                            |
| `docker volume create --label ...`                                                                                               | when not already running, unless a `--from-backup` restore onto an existing volume (fails first)                  |
| `docker create` + `docker start`                                                                                                 | when not already running                                                                                          |
| `docker container inspect` (repeated)                                                                                            | health-wait polling, 1s constant backoff up to `db.health_timeout`                                                |
| `docker logs <id>`                                                                                                               | on a health-check timeout (either path — swallowed or not)                                                        |
| `docker run --rm ...`                                                                                                            | fresh volume, no `--from-backup`, `db.major_version >= 15`: up to 3 one-shot migrate jobs (realtime/storage/auth) |
| `docker ps` / `docker stop` / `docker container prune` / `docker volume prune` (fresh-volume runs only) / `docker network prune` | on ANY failure from network-ensure through `_current_branch` — the rollback                                       |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                                                                                                             | Purpose                                                                                                                                                                                                                                 | Required? |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_PROJECT_ID`                                                                                                | overrides the local container id (`utils.DbId`)                                                                                                                                                                                         | no        |
| `SUPABASE_DB_PORT`                                                                                                   | overrides `db.port` (the published host port)                                                                                                                                                                                           | no        |
| `SUPABASE_DB_MAJOR_VERSION`                                                                                          | overrides `db.major_version` (image selection, schema branch)                                                                                                                                                                           | no        |
| `SUPABASE_DB_HEALTH_TIMEOUT`                                                                                         | overrides `db.health_timeout`                                                                                                                                                                                                           | no        |
| `SUPABASE_DB_SETTINGS_*`                                                                                             | overrides individual `[db.settings]` fields                                                                                                                                                                                             | no        |
| `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION`                                                                             | overrides `experimental.orioledb_version` (image + env)                                                                                                                                                                                 | no        |
| `SUPABASE_EXPERIMENTAL_S3_{HOST,REGION,ACCESS_KEY,SECRET_KEY}`                                                       | OrioleDB S3 env overrides                                                                                                                                                                                                               | no        |
| `SUPABASE_REALTIME_ENABLED`                                                                                          | gates the fresh-volume realtime migrate job                                                                                                                                                                                             | no        |
| `SUPABASE_REALTIME_IP_VERSION` / `_MAX_HEADER_LENGTH`                                                                | realtime migrate job env overrides                                                                                                                                                                                                      | no        |
| `SUPABASE_STORAGE_ENABLED`                                                                                           | gates the fresh-volume storage migrate job                                                                                                                                                                                              | no        |
| `SUPABASE_STORAGE_FILE_SIZE_LIMIT`                                                                                   | storage migrate job env override                                                                                                                                                                                                        | no        |
| `SUPABASE_AUTH_ENABLED`                                                                                              | gates the fresh-volume auth migrate job                                                                                                                                                                                                 | no        |
| `SUPABASE_AUTH_EXTERNAL_URL` / `SUPABASE_AUTH_SITE_URL`                                                              | auth migrate job env overrides                                                                                                                                                                                                          | no        |
| `SUPABASE_AUTH_JWT_EXPIRY`                                                                                           | Postgres's `JWT_EXP` env / signing                                                                                                                                                                                                      | no        |
| `SUPABASE_EXPERIMENTAL` (or `--experimental`)                                                                        | fresh volume + no pg-delta: applies `db.migrations.schema_paths` files instead of `migrations/*.sql`                                                                                                                                    | no        |
| `DOCKER_HOST` / `DOCKER_CONTEXT` / `DOCKER_TLS_VERIFY` / `DOCKER_CERT_PATH` / `DOCKER_API_VERSION` / `DOCKER_CONFIG` | Read (ambient shell OR a project `.env`/`.env.<env>`/`.env.local` file — matching Go's `godotenv.Load`, which installs these into the process environment before any Docker work) to pick the Docker daemon this whole command talks to | no        |

`--network-id` (a global CLI flag, not an environment variable — `shared/legacy/global-flags.ts`)
forces every created container/network onto that Docker network instead of the generated
`supabase_network_<project>`.

`--debug` tees each fresh-volume PG15+ one-shot migrate job's (realtime/storage/auth) own
stderr to the parent process's stderr in real time, matching Go's `utils.GetDebugLogger()`
(`os.Stderr` under `--debug`, else discarded) — outside `--debug` only the job's exit code is
surfaced on failure.

## Exit Codes

| Code | Condition                                                                   |
| ---- | --------------------------------------------------------------------------- |
| `0`  | success — database started, or already running                              |
| `0`  | `--from-backup` set and the health-check timed out (swallowed)              |
| `1`  | malformed `supabase/config.toml`                                            |
| `1`  | Docker daemon unreachable / inspect failure                                 |
| `1`  | `backup volume already exists` (`--from-backup` against a non-fresh volume) |
| `1`  | a health-check timeout with `--from-backup` unset                           |
| `1`  | any other container-bootstrap failure (network/volume/create/start/setup)   |

## Output

### `--output-format text` (Go CLI compatible)

- Already running → `Postgres database is already running.` on **stderr**, exit 0.
- Starting → `Starting database...` / `Starting database from backup...`, then (fresh
  volume, no `--from-backup`) `Initialising schema...` and `Seeding globals from
roles.sql...`, all on **stderr**. No stdout output, no `Finished` line.
- `backup volume already exists` → the message on **stderr**, followed by the
  `supabase stop --no-backup` suggestion (aqua-colored).

### `--output-format json`

Emits a single result object to stdout: `{ status: "already-running" }` or
`{ status: "started" }`. Progress stays on stderr.

### `--output-format stream-json`

Same result object as the terminal `result` event; progress on stderr.

## Notes

- `--from-backup` restores the database from a logical backup file on start; the health
  check is skipped (not failed) for backups — a large restore can exceed
  `db.health_timeout`.
- No `cli_stack_started` telemetry — that event belongs to `supabase start`, not
  `db start`. The only event is the standard `cli_command_executed`.
- `db reset --local` (a different command) is ALSO fully native now (CLI-1955) — it
  reuses this same `legacy/shared/db-bootstrap/` primitive set, but through its own
  composition (`legacy/shared/db-bootstrap/recreate-local-database.ts`), not through
  `legacyStartDatabase`/this command's own handler — see that command's `SIDE_EFFECTS.md`.
