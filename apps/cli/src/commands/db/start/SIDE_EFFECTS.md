# `supabase db start`

Fully native — see `db reset --local`'s own `SIDE_EFFECTS.md`. This is `db start`,
**not** the top-level `supabase start`: no status table, no `cli_stack_started` event, no
`Finished` line, no `--exclude`, no `--ignore-health-check`.

The handler validates config, takes the project lifecycle lock (see Files Written; held until the
command ends), inspects the local Postgres
container (`localDbState` in `command-internal/db-bootstrap/local-db-running.ts` — a direct
Docker Engine API `GET /containers/<id>/json` over the active context's unix socket / named
pipe, falling back to a spawned `docker container inspect` whenever the Engine gives no
definitive, Engine-identified answer, so a stalled `docker` CLI binary can no longer block the
state check itself — issue #6110's silent pre-output hang; the fallback reads the inspect
stdout's `State` as well as the exit code. `db reset --local` and `db diff` use its
existence-only wrapper `isLocalDbRunning`). A running container short-circuits to "already
running". A container that exists but is not running (`created`, `exited`, …) is removed with
`docker container rm -f supabase_db_<project>` — only the db container, with the named data
volume kept and the project's other services left alone — and then brought up like an absent one;
the reused-volume data-directory probe decides whether setup runs. `--from-backup` against such a
container fails with `backup volume already exists` (step 3) before the container is removed. In Bitbucket Pipelines
(`BITBUCKET_CLONE_DIR` set) removal is skipped, since the lack of named volumes would make it
destructive: the command fails with `<container> container is not running: <state>` and a
`supabase stop` suggestion instead. The bring-up that follows an "absent" answer (or that
removal) still shells out, starting with the volume-freshness probe, so a stalled `docker` CLI
still blocks an actual bring-up. It natively brings up the container itself, reusing
`command-internal/db-bootstrap/`'s container-bootstrap primitives (the same ones `supabase
start` uses for its own Postgres bring-up, and `db reset --local`'s own recreate
composition reuses too — see that command's `SIDE_EFFECTS.md`):

1. Ensure the Docker network exists (`--network-id` override or `supabase_network_<project>`).
2. Probe whether the Postgres data volume (`supabase_db_<project>`) already exists —
   BEFORE creating it.
3. **`--from-backup` + an existing volume**: fail with `backup volume already exists`
   (suggestion: `supabase stop --no-backup`), roll back (see below), and exit — no
   container is created on this path.
4. Print `Starting database...` (fresh volume) or `Starting database from backup...`
   (existing volume — despite the wording, unrelated to `--from-backup`; see
   `command-internal/db-bootstrap/start-database.ts`).
5. Resolve the Postgres image (version-pin-aware) and create + start the container.
   `--from-backup` set: a THIRD entrypoint variant (`buildPostgresStartContainerSpec`'s
   `fromBackup` branch) — schema.sql + `_supabase.sql` (no `webhook.sql`), a
   `migrate.sh` (`templates/db-restore.sh.ts`)
   that restores roles then schema from the bind-mounted backup file, and
   `cron.launch_active_jobs = off` appended to `postgresql.conf` — applies regardless of
   `db.major_version`. The backup file itself is bind-mounted `:ro` at `/etc/backup.sql`
   (host path resolved against the CALLER's cwd when relative).
   `SUPABASE_USE_SLIM_IMAGES` rewrites the current Dockerfile pin (and majors
   13/15's published slim PG15 pin, `15.14.1.167`) to
   `ghcr.io/supabase/cli/postgres`; a historical `.temp/postgres-version` pin,
   PG14, OrioleDB tags the catalog does not pin, and flag-off majors 13/15 (`15.8.1.085`) stay on docker.io.
   A failed GHCR pull falls back to the same tag and digest on `public.ecr.aws/supabase/cli/postgres`.
   The restore entrypoint is the same on both families.
6. Wait for Postgres to accept connections (`db.health_timeout`, default `2m`): every 500ms,
   `docker container inspect` (a container that is not running fails the wait at once), then a
   short-lived host connect to the published Postgres address (2s dial cap) — Docker's health
   status is not read, because it needs `docker exec`, which nested or sandboxed Docker cannot
   do, and lags connectability by up to one 10s interval. A timeout fails the command with
   `<container> container is not ready: <connect error>` UNLESS `--from-backup` is set, in
   which case it is swallowed (a large restore can exceed the timeout) — the container-logs dump
   to stderr, and the `exec format error` recovery advice when the logs show it, still happen
   either way.
7. On a fresh volume with `--from-backup` unset: run the `SetupLocalDatabase`-equivalent
   pipeline. A volume counts as fresh when it did not exist before step 2 OR it exists but was
   never initialised: between create and start, `docker cp <container>:/var/lib/postgresql/data/PG_VERSION -`
   fails with a diagnostic reporting `PG_VERSION` missing from the container (any other probe outcome counts as
   initialised). The pipeline (`command-internal/db-bootstrap/db-setup.ts`) — initial schema (PG<=14: SQL over a
   direct `DbConnection`; PG>=15: up to three one-shot `docker run --rm` migrate jobs
   for realtime/storage/auth, each gated on its own `enabled` flag; the realtime
   one-shot runs so user migrations see the tenant), API-privilege
   revocation, `[db.vault]` secret upsert, `supabase/roles.sql` seed, and finally either every
   pending migration + seed, OR — when `--experimental`/`SUPABASE_EXPERIMENTAL` is set AND
   `[experimental.pgdelta] enabled = false` is set explicitly (it defaults to true) — every `db.migrations.schema_paths` file
   (declarative schema files) instead of migrations (with `--experimental`, pg-delta enabled,
   and non-empty `schema_paths`, a stderr warning says `schema_paths` is not applied),
   followed by seed either way
   (`MigrateAndSeed`). Skipped IN FULL when `--from-backup` is set (not merely reduced).
8. Write `supabase/.branches/_current_branch` = `"main"` if absent — runs on EVERY path
   that reaches this point (fresh volume, existing volume, and a swallowed
   `--from-backup` health-check timeout), but NOT on the already-running short-circuit or
   the `backup volume already exists` guard.
9. Wait up to 15s for Docker's first health verdict, so `supabase db start && supabase status`
   does not see `starting`: poll `docker container inspect` every 1s until the health status
   leaves `starting`, the container stops running, or Docker cannot launch its health check. Never
   fails the command, whatever the outcome, and is not covered by the rollback below.

Any failure from step 1 onward prints `Stopping containers...` to stderr and rolls back via
`rollbackDatabaseStart`, which only touches what this command creates: the db container
(`docker container rm -f`), the db volume (`docker volume rm -f supabase_db_<project>`, ONLY when
the volume was confirmed fresh this run, including a reused volume the probe found uninitialised,
even when `docker start` then fails), and unused project-labelled networks
(`docker network prune`). The project's other containers and volumes are left alone. A rollback
failure is logged to stderr and never replaces the original error.

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
| `~/.docker/config.json` + Docker context store (`contexts/meta/<sha256(context)>/meta.json`)    | JSON   | resolving the daemon endpoint for the db state probe (in-process); also read by the `docker`/`podman` CLI itself for registry auth                                           |

## Files Written

| Path                                                                  | Format           | When                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/.branches/_current_branch`                        | text             | only if absent — writes `"main"` (see the step-by-step sequence above for exactly when)                                                                                                                            |
| local Docker volume `supabase_db_<project>`                           | —                | the Postgres data volume, created on first start (or first `--from-backup` restore)                                                                                                                                |
| local Docker network `supabase_network_<project>` (or `--network-id`) | —                | created if it doesn't already exist                                                                                                                                                                                |
| `$SUPABASE_HOME/stacks/<stackId>/`                                    | JSON             | the stack definition, service identities, selected runtime, and service state on the stack backend                                                                                                                 |
| `~/.supabase/telemetry.json`                                          | JSON             | always — telemetry flush (`Effect.ensuring(telemetryState.flush)`), success and failure                                                                                                                            |
| `$SUPABASE_HOME/locks/docker-lifecycle.lock`                          | SQLite lock file | held for the whole run: shared for one project, exclusive for `stop --all`; waits up to 10 minutes for a conflicting command (skipped, with a debug line, when `$SUPABASE_HOME/locks` cannot be created or opened) |
| `$SUPABASE_HOME/locks/docker-project-<sha256(project label)>.lock`    | SQLite lock file | held for the whole run: serializes lifecycle commands for the same project; waits up to 10 minutes (skipped, with a debug line, when `$SUPABASE_HOME/locks` cannot be created or opened)                           |

## Subprocesses

Every step below shells out to `docker` (falling back to `podman`), matching every other
native container command in this codebase, except the
db state probe, which prefers a direct Engine-API request (see "API Routes") and
only spawns on fallback.

| Command                                                                                            | When                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker container inspect supabase_db_<project>`                                                   | the db state probe — only when the direct Engine-API request (active local socket/named pipe) gives no definitive answer                                   |
| `docker container rm -f supabase_db_<project>`                                                     | the db container exists but is not running, outside Bitbucket Pipelines — the data volume is kept                                                          |
| `docker network create --label ... <networkId>`                                                    | when not already running, unless `--network-id` names a built-in network                                                                                   |
| `docker volume inspect supabase_db_<project>`                                                      | when not already running — the pre-create fresh-volume probe                                                                                               |
| `docker image inspect` / `docker pull` (registry-fallback resolve)                                 | when not already running — resolves the Postgres image                                                                                                     |
| `docker volume create --label ...`                                                                 | when not already running, unless a `--from-backup` restore onto an existing volume (fails first)                                                           |
| `docker create` + optional `docker cp - <id>:/` + `docker start`                                   | when not already running — `cp` streams one in-memory tar archive containing the pgsodium root key at its exact path when the selected entrypoint needs it |
| `docker cp <id>:/var/lib/postgresql/data/PG_VERSION -`                                             | when the volume already existed, between `docker create` and `docker start` — the data-directory probe; its stdout is discarded                            |
| `docker container inspect` (repeated)                                                              | readiness polling every 500ms up to `db.health_timeout`, then health-settle polling every 1s for up to 15s                                                 |
| `docker logs <id>`                                                                                 | on a health-check timeout (either path — swallowed or not)                                                                                                 |
| `docker run --rm ...`                                                                              | fresh volume, no `--from-backup`, `db.major_version >= 15`: up to 3 one-shot migrate jobs (realtime/storage/auth)                                          |
| `docker container rm -f` / `docker volume rm -f` (fresh-volume runs only) / `docker network prune` | on ANY failure from network-ensure through `_current_branch` — the rollback                                                                                |

## API Routes

No platform (Management API) routes. The db state probe issues one Docker Engine
API request over the active context's local unix socket / named pipe:

| Method | Path                                     | Auth | Request body | Response (used fields)                                                                                                                                                                                                    |
| ------ | ---------------------------------------- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/containers/supabase_db_<project>/json` | —    | —            | `Api-Version`/`Server` identity headers + status; a 200 body must parse as a JSON object (identity-gated 200 → exists, running unless `State.Running` is `false`, 404 → absent; anything else → the spawned-CLI fallback) |

## Environment Variables

| Variable                                                                                                             | Purpose                                                                                                                                                                                                                                                                                                                                               | Required? |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_PROJECT_ID`                                                                                                | overrides the local container id                                                                                                                                                                                                                                                                                                                      | no        |
| `SUPABASE_DB_PORT`                                                                                                   | overrides `db.port` (the published host port)                                                                                                                                                                                                                                                                                                         | no        |
| `SUPABASE_DB_MAJOR_VERSION`                                                                                          | overrides `db.major_version` (image selection, schema branch)                                                                                                                                                                                                                                                                                         | no        |
| `SUPABASE_DB_HEALTH_TIMEOUT`                                                                                         | overrides `db.health_timeout`                                                                                                                                                                                                                                                                                                                         | no        |
| `SUPABASE_DB_SETTINGS_*`                                                                                             | overrides individual `[db.settings]` fields                                                                                                                                                                                                                                                                                                           | no        |
| `SUPABASE_DB_ORIOLEDB_VERSION`                                                                                       | overrides `db.orioledb_version` (image + env)                                                                                                                                                                                                                                                                                                         | no        |
| `SUPABASE_EXPERIMENTAL_S3_{HOST,REGION,ACCESS_KEY,SECRET_KEY}`                                                       | OrioleDB S3 env overrides                                                                                                                                                                                                                                                                                                                             | no        |
| `SUPABASE_REALTIME_ENABLED`                                                                                          | gates the fresh-volume realtime migrate job                                                                                                                                                                                                                                                                                                           | no        |
| `SUPABASE_REALTIME_IP_VERSION` / `_MAX_HEADER_LENGTH`                                                                | realtime migrate job env overrides                                                                                                                                                                                                                                                                                                                    | no        |
| `SUPABASE_STORAGE_ENABLED`                                                                                           | gates the fresh-volume storage migrate job                                                                                                                                                                                                                                                                                                            | no        |
| `SUPABASE_STORAGE_FILE_SIZE_LIMIT`                                                                                   | storage migrate job env override                                                                                                                                                                                                                                                                                                                      | no        |
| `SUPABASE_AUTH_ENABLED`                                                                                              | gates the fresh-volume auth migrate job                                                                                                                                                                                                                                                                                                               | no        |
| `SUPABASE_AUTH_EXTERNAL_URL` / `SUPABASE_AUTH_SITE_URL`                                                              | auth migrate job env overrides                                                                                                                                                                                                                                                                                                                        | no        |
| `SUPABASE_AUTH_JWT_EXPIRY`                                                                                           | Postgres's `JWT_EXP` env / signing                                                                                                                                                                                                                                                                                                                    | no        |
| `SUPABASE_EXPERIMENTAL` (or `--experimental`)                                                                        | fresh volume + no pg-delta: applies `db.migrations.schema_paths` files instead of `migrations/*.sql`                                                                                                                                                                                                                                                  | no        |
| `DOCKER_HOST` / `DOCKER_CONTEXT` / `DOCKER_TLS_VERIFY` / `DOCKER_CERT_PATH` / `DOCKER_API_VERSION` / `DOCKER_CONFIG` | Read from the ambient shell environment to pick the Docker daemon this whole command talks to (project dotenv files deliberately never override Docker client keys)                                                                                                                                                                                   | no        |
| `SUPABASE_USE_SLIM_IMAGES`                                                                                           | resolves the current Dockerfile pin (and majors 13/15's published slim PG15 pin, `15.14.1.167`) and PG15+ realtime/storage/auth migrate-job images from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); historical `.temp` pins, PG14, OrioleDB tags the catalog does not pin, and flag-off majors 13/15 (`15.8.1.085`) stay on docker.io | no        |

`--network-id` (a global CLI flag, not an environment variable — `command-internal/global-flags.ts`)
forces every created container/network onto that Docker network instead of the generated
`supabase_network_<project>`.

`--debug` tees each fresh-volume PG15+ one-shot migrate job's (realtime/storage/auth) own
stderr to the parent process's stderr in real time — outside `--debug` only the job's exit
code is surfaced on failure.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — database started, or already running                                                                                                                                                                                                                                |
| `0`  | `--from-backup` set and the health-check timed out (swallowed)                                                                                                                                                                                                                |
| `1`  | malformed `supabase/config.toml`                                                                                                                                                                                                                                              |
| `1`  | another lifecycle command still holds this project's lock after 10 minutes — prints `Waiting for another Supabase CLI command to finish with project <id>...` (or `...with local Supabase projects...` behind `stop --all`) to stderr first (`ProjectLifecycleLockBusyError`) |
| `1`  | Docker daemon unreachable / inspect failure                                                                                                                                                                                                                                   |
| `1`  | db container exists but is not running, in Bitbucket Pipelines (`supabase stop` suggestion)                                                                                                                                                                                   |
| `1`  | `backup volume already exists` (`--from-backup` against a non-fresh volume)                                                                                                                                                                                                   |
| `1`  | a health-check timeout with `--from-backup` unset                                                                                                                                                                                                                             |
| `1`  | any other container-bootstrap failure (network/volume/create/start/setup)                                                                                                                                                                                                     |

## Output

### `--output-format text`

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

When `[experimental].stack` is on, this command creates or resumes a postgres-only project
stack instead of a Compose container. First create runs schema init (including the
`supabase_functions` schema, which migrations must not recreate), overlay, and
migrate-and-seed. It briefly starts configured Auth, Storage, and Realtime instances while
applying the database catalog, then destroys those temporary instances. An existing cluster
applies webhooks only, first creating the `supabase_functions` schema when it is missing. Durable
state lives under `$SUPABASE_HOME/stacks/<stackId>/`, including the selected runtime and
service identities. Postgres-only first create skips analytics and
pooler artifact downloads. If first initialization fails after the database is created, the
new database is destroyed so the command can be retried after fixing the cause. If cleanup itself
fails, stderr identifies the incomplete instance and recommends `supabase stack destroy`.
Resuming a stopped database whose saved pin differs from the selected one in anything but a
slim-services revision rebinds the same instance to the selected pin before starting; its id and
data stay. Initialized data accepts only a revision of its own build, so another build, line or
major fails with advice to run `supabase stack destroy`. Auth, Storage and Realtime must not be
selected at an older upstream than one that already migrated the database (recorded in
`schema-writers.json` in the instance data directory); such a start fails with the same advice.
The database version comes from `supabase/supabase.lock`, resolved and written under the
project lease exactly as `supabase start` does (see its `SIDE_EFFECTS.md`, "Service versions and
the lock"), except that there is no `--frozen` flag: a missing or stale lock is resolved, unless
`CI` is set and a lock exists, in which case a stale lock fails. The lock covers every service,
not only the database.
The resident owner process manages the database beyond the CLI invocation. Stack mode rejects
`--from-backup` with exit code 1.

## Notes

- **`pg_net` converges with `[experimental.webhooks]` on every non-backup start** (shared
  `startDatabase` behavior — see `supabase start`'s SIDE_EFFECTS.md note): fresh volumes
  install it only when webhooks are enabled or migration history owns it; existing volumes
  with webhooks disabled DROP a `pg_net` that
  migration history does not own. `pg_net` installed outside migrations (Studio SQL editor)
  is dropped on the next start — accepted, documented edge.
- `--from-backup` restores the database from a logical backup file on start; a readiness-wait
  timeout is swallowed (not failed) for backups — a large restore can exceed
  `db.health_timeout`.
- No `cli_stack_started` telemetry — that event belongs to `supabase start`, not
  `db start`. The only event is the standard `cli_command_executed`.
- `db reset --local` (a different command) is ALSO fully native now (CLI-1955) — it
  reuses this same `command-internal/db-bootstrap/` primitive set, but through its own
  composition (`command-internal/db-bootstrap/recreate-local-database.ts`), not through
  `startDatabase`/this command's own handler — see that command's `SIDE_EFFECTS.md`.
