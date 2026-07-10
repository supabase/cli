# `supabase start`

Native TypeScript port of Go's `internal/start` (+ the Postgres-container half of
`internal/db/start`). Talks directly to Docker via subprocess (`docker`/`podman`),
mirroring Go's sequential per-container `DockerStart` — it does not use Docker Compose
(the one `docker/compose` import Go has is an internal, best-effort concurrent
image-pre-pull helper this port never depends on) and it does not go through
`@supabase/stack/effect`'s orchestration model (see the CLI-1323 plan's "Critical
architectural finding" for why: that runtime is a deliberately different local-dev
product — no Kong gateway, native-binary-first, auto-allocated ports, opaque API keys —
that would break the Go-parity contract this port exists to provide).

## Scope

Edge Runtime bring-up, the fresh-volume DB schema/migration/seed setup pipeline, and
fresh-volume storage-bucket seeding are all now natively implemented (see below) — this
section previously listed them as out-of-scope follow-ups.

One piece of Go's `start` remains explicitly **out of scope**, discovered during this
port's own research (not called out in Go's public docs or the original port plan) and
documented at its exact Go call site in `start.handler.ts`:

1. **Linked-project version-check suggestion** (`internal/start/start.go:61-63`, delegates
   to `internal/services.CheckVersions`) — a best-effort Management API call, made only
   when a project happens to be linked _and_ the user is logged in, purely to print an
   "update available" hint. Every error is silently swallowed in Go. Omitted entirely —
   this port has zero Management API dependency for `start`, by design.

### Fresh-volume DB setup (`legacyStartSetupLocalDatabase`)

Ported: Go's `SetupLocalDatabase` → `initSchema` →
`initRealtimeJob`/`initStorageJob`/`initAuthJob` pipeline (`internal/db/start/`). Gated on
`isFreshVolume` (`legacyStartVolumeExists` on the Postgres volume, checked BEFORE the
volume is created), matching Go's `NoBackupVolume` — this same check also selects which of
`Starting database...`/`Starting database from backup...` prints to stderr immediately
before Postgres's container is created (`db/start/start.go:165-175`). Runs immediately
after Postgres's own health check passes, before "Starting containers..." prints and
before any other service starts. Opens a direct `LegacyDbConnection` session to the
host-facing Postgres address (PG<=14: execs schema/globals/API-privileges SQL over that
session; PG>=15: runs three one-shot `LegacyDockerRun` jobs instead, gated independently on
`realtime.enabled`/`storage.enabled`/`auth.enabled`). Also upserts `[db.vault]` secrets and
seeds `supabase/roles.sql`: matching Go's own print-before-read ordering
(`pkg/migration/seed.go:88`), the `Seeding globals from roles.sql...` stderr line always
prints, whether or not the file exists — a missing file is silently tolerated (no SQL runs),
any other read/exec error still fails the run. Finally runs every pending migration + seed.
A failure at any step rolls back the whole `start` run (same as any other bring-up failure).

`legacyStartInitCurrentBranch` (writes `supabase/.branches/_current_branch` = `"main"` if
absent) is NOT part of this fresh-volume-gated pipeline — matching Go's `initCurrentBranch`
call (`db/start/start.go:189`), it runs unconditionally on every `start`, immediately after
this pipeline's gate closes (whether or not the pipeline itself ran).

### Edge Runtime bring-up (`legacyStartEdgeRuntimeContainer`)

Ported: Go's `serve.ServeFunctions()` call (`internal/functions/serve/`), reusing
`shared/functions/serve.ts`'s `startEdgeRuntimeContainer` core (the same one `functions
serve` uses). Gated on `edge_runtime.enabled && !--exclude edge-runtime`, in Go's real
container-start position (between ImgProxy and pg-meta). Unlike every other service, it's
a direct `docker run -d ...` (not `docker create`+`docker start`) and is health-checked via
an HTTP probe through Kong (`/functions/v1/_internal/health`), not a Docker healthcheck —
mirrors PostgREST's own probe shape.

### Storage bucket seeding (`legacySeedBucketsRun`)

Ported: Go's `buckets.Run(ctx, "", false, fsys)` call (`start.go:1281-1286`,
`internal/seed/buckets`). Runs only when `isFreshVolume && Storage started`, after the bulk
health check genuinely succeeds, right before the `cli_stack_started` telemetry capture. A
seeding failure rolls back the whole `start` run, same as any other post-bring-up failure.

A second, narrower seeding path exists for the `--ignore-health-check` downgrade branch
(`start.go:1272-1277`): when the bulk health check fails but `isFreshVolume && Storage
started`, Go re-checks Storage's health in isolation and, only if Storage itself is
healthy, seeds buckets anyway before falling through to the downgrade-to-warning behavior.
Unlike the main path above, a failure on THIS path is not swallowed by
`--ignore-health-check` — it replaces the original health error, rolls back, and fails the
command (Go's `return seedErr` instead of the downgraded `return err`).

## Files Read

| Path                                                                                            | Format | When                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                | TOML   | always                                                                                                                                                                           |
| `<workdir>/supabase/.env`, `.env.local`                                                         | dotenv | always (`.env.local` skipped when `SUPABASE_ENV=test`)                                                                                                                           |
| project-root / `SUPABASE_ENV`-selected dotenv file                                              | dotenv | always, same precedence chain as `stop`/`status`                                                                                                                                 |
| `auth.signing_keys_path` file                                                                   | JSON   | when configured                                                                                                                                                                  |
| `api.tls.cert_path` / `api.tls.key_path`                                                        | PEM    | when `api.tls.enabled`                                                                                                                                                           |
| `auth.email.template.*` / `auth.email.notification.*` content files                             | text   | when configured                                                                                                                                                                  |
| GCP JWT credentials file                                                                        | JSON   | when `analytics.backend = "bigquery"`                                                                                                                                            |
| `<workdir>/supabase/roles.sql`                                                                  | SQL    | on a fresh volume (custom-roles seed) — the "Seeding globals..." message always prints first; the file itself is only read if it exists, tolerating a missing file               |
| `<workdir>/supabase/migrations/*.sql`, `supabase/seed.sql`                                      | SQL    | on a fresh volume, via the standard migration-apply + seed pipeline                                                                                                              |
| `<workdir>/supabase/.branches/_current_branch`                                                  | text   | on every start, existence check before writing (see "Files Written")                                                                                                             |
| `<workdir>/supabase/functions/**`                                                               | —      | when Edge Runtime starts, and independently when Studio starts (function discovery/config resolution + Docker bind mounts, regardless of whether Edge Runtime itself is enabled) |
| `<workdir>/supabase/.temp/storage-migration`                                                    | text   | always — linked-project Storage migration pin (`DB_MIGRATIONS_FREEZE_AT`), written by `supabase link`; absent/unreadable resolves to no pin                                      |
| `<workdir>/supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version` | text   | always — linked-project per-service image version pins, written by `supabase link`; absent/unreadable resolves to the embedded default image                                     |
| `~/.docker/config.json`                                                                         | JSON   | via the `docker`/`podman` CLI itself, for registry auth — never read directly by this process                                                                                    |

## Files Written

| Path                                                                  | Format | When                                                                                                                      |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.branches/_current_branch`                        | text   | on every start, only if absent — writes `"main"`                                                                          |
| host temp files (env-file, multiline-env script, serve-main template) | —      | while Edge Runtime is starting — removed immediately after `docker run` returns (best-effort)                             |
| `<workdir>/supabase/.temp/start-secrets/<containerName>/secret-<n>`   | varies | for Kong (`kong.yml`, TLS cert, TLS key), Postgres (`pgsodium_root.key`), and Supavisor (`pooler_tenant.exs`) — see below |

Kong's `custom_nginx.template`, Vector's `vector.yaml`, and Postgres's own bootstrap
script (`postgresql.conf`-equivalent setup) are all rendered in memory and injected
directly into each container's entrypoint (a `sh -c '... heredoc ...'` command) —
never written to the host filesystem, since none of them carries secret content.
Kong's `kong.yml`/TLS cert/TLS key, Postgres's `pgsodium_root.key`, and Supavisor's
`pooler_tenant.exs` DO carry secret content (a service-role-key-derived bearer/query
key, TLS private key material, and the DB password respectively) and are instead
written to `<workdir>/supabase/.temp/start-secrets/<containerName>/` (directory mode
`0700`, files mode `0600`) and
bind-mounted `:ro` into the container at the exact path each container's
entrypoint/`Cmd` expects — see `container-lifecycle.ts`'s `legacyStageStartSecretFiles`
doc comment for the full rationale (CWE-214/522: keeping secret content out of the
`docker create` argv the host can see via `ps`/`/proc/<pid>/cmdline`) and for why this
directory is a DETERMINISTIC, PERSISTENT path under the project's own workdir rather
than an ephemeral OS temp dir — every one of these three containers runs with
`restartPolicy: "unless-stopped"`, so the files must survive a host/Docker-daemon
restart for dockerd to successfully re-attach the bind mount. The directory is
recreated fresh (any stale contents removed first) on every `start` invocation that
reaches container creation, and is cleaned up immediately if `docker create`/`docker
start` itself fails — otherwise it is left in place for the life of the container.
Studio reads/writes SQL snippets under `<workdir>/supabase/snippets/` at its own
runtime — that's Studio's behavior, not something `start` itself writes.

## API Routes

| Method   | Path                                 | Auth                  | Request body | Response (used fields)    |
| -------- | ------------------------------------ | --------------------- | ------------ | ------------------------- |
| GET      | `<api-url>/storage/v1/bucket`        | Kong service-role key | —            | existing bucket names/ids |
| POST/PUT | `<api-url>/storage/v1/bucket[/<id>]` | Kong service-role key | bucket props | created/updated bucket    |

Local-only: the Storage bucket-seeding step (fresh volume + Storage enabled) talks to the
LOCAL Storage service through Kong, never the Management API. See "Scope" above for the
one Go behavior (`CheckVersions`) that _would_ call the Management API and is deliberately
not implemented.

## Environment Variables

| Variable                               | Purpose                                                                                                                                                         | Required? |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_*` (any dotted config field) | Generic Viper-style `AutomaticEnv` override of any `config.toml` field (e.g. `SUPABASE_AUTH_ENABLED`, `SUPABASE_API_PORT`)                                      | no        |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`     | Overrides the image registry used to resolve every service's image                                                                                              | no        |
| `SUPABASE_PROJECT_ID`                  | Overrides the resolved local project id (env → config.toml → workdir basename)                                                                                  | no        |
| `SUPABASE_WORKDIR`                     | Resolves `LegacyCliConfig.workdir`                                                                                                                              | no        |
| `BITBUCKET_CLONE_DIR`                  | When non-empty, drops named volumes and `--security-opt` from every container create                                                                            | no        |
| `DOCKER_HOST`                          | Read to discover the Docker daemon's own address, then re-derived and set on Vector's container env so it can reach the host's Docker socket for log collection | no        |
| `KONG_NGINX_WORKER_PROCESSES`          | Read (ambient shell or project dotenv) into Kong's own container env (defaults to `"1"` when unset)                                                             | no        |

`docker`/`podman` must be resolvable on `PATH` — same fallback behavior as `stop`/`status`.

## Exit Codes

| Code | Condition                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — every started container passed its health check                                                                                                                                      |
| `0`  | the stack was already running — shows status instead of restarting                                                                                                                             |
| `0`  | `--ignore-health-check` set and one or more containers timed out — the failure is printed and swallowed, no rollback                                                                           |
| `1`  | `--ignore-health-check` set, the fresh-volume/Storage-healthy recheck-and-seed path ran (see "Storage bucket seeding"), and that seed itself failed — rolls back despite the flag              |
| `1`  | malformed `config.toml` / `Config.Validate` failure                                                                                                                                            |
| `1`  | `docker`/`podman` not spawnable, or the daemon is unreachable                                                                                                                                  |
| `1`  | image pull exhausted across every registry candidate                                                                                                                                           |
| `1`  | network, volume, container create, or container start failure (including a port conflict) — rolls back everything created so far                                                               |
| `1`  | health check timeout **without** `--ignore-health-check` — rolls back                                                                                                                          |
| `1`  | Postgres itself fails to start or become healthy — rolls back (no `--ignore-health-check` leniency at this stage; only the later bulk health check over the other 11 services honors the flag) |
| `1`  | fresh-volume DB setup failure (schema SQL / one-shot migrate job / vault upsert / roles seed / migration-apply) — rolls back                                                                   |
| `1`  | fresh-volume bucket-seeding failure — rolls back                                                                                                                                               |

Rollback (`legacyRollbackStart`) tears down everything created so far by Docker label,
matching Go's `DockerRemoveAll`, and never masks the original failure — a rollback error
is logged to stderr and swallowed. `deleteVolumes` mirrors Go's `utils.NoBackupVolume`
exactly: `true` only when this run's Postgres volume was freshly created (so a failed
first-ever `start` prunes its own empty volume too), `false` otherwise (never touches a
pre-existing user's data on a failed restart). Rollback also reclaims this run's own
`<workdir>/supabase/.temp/start-secrets/<containerName>` directories (via
`legacyCleanupStartSecrets`, `legacy/shared/legacy-start-secrets-cleanup.ts`) once
teardown completes — the matching container names are snapshotted immediately before
teardown runs, so cleanup only ever targets containers this failed run itself created.
A later successful `stop` reclaims the same directories for a normal (non-rollback)
teardown — see `stop`'s own `SIDE_EFFECTS.md`.

## Telemetry Events Fired

| Event                  | When                                                                                                                                                                                                   | Notable properties / groups         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via `withLegacyCommandInstrumentation`)                                                                                                                                  | `exit_code`, `duration_ms`, `flags` |
| `cli_stack_started`    | once, only on a genuine bulk health-check success — never fires on the `--ignore-health-check` downgrade-to-warning path, matching Go's capture sitting after the error-return block (`start.go:1287`) | no properties                       |

## Output

`start` has no Go `-o`/`--output` flag of its own — after orchestration (or the
already-running short-circuit, or the ignored-health-check path), it renders through the
exact same `status` value/pretty-table machinery `supabase status` uses, in all three TS
output modes.

### `--output-format text` (Go CLI compatible)

- stderr (conditional, `--exclude` had invalid values): a `WARNING:` line naming the
  invalid values and listing the 13 valid ones — the command still proceeds.
- stderr: already-running banner (`supabase start` in aqua) **or** the bring-up sequence:
  `Starting database...` (fresh volume) / `Starting database from backup...` (existing
  volume) → Postgres create+start+health-wait → `Starting containers...` → (image
  pre-pull) → per-container create+start → `Waiting for health checks...` → `Started
supabase local development setup.`
- stdout: the `status` pretty table (rounded box, same renderer `supabase status` uses).
- stderr: the local-dev security notice block (bind-to-`0.0.0.0` / shared-default-keys /
  no-auth-on-Studio-pgMeta-analytics warning).

### `--output-format json` / `--output-format stream-json`

A single JSON object (or a `result` NDJSON event) carrying the same value shape
`supabase status --output json` produces. All the progress/warning/banner/security-notice
text above is suppressed in these modes — stdout stays payload-only.

## Notes

- `--exclude`/`-x` accepts container names from the verified 13-key list (`gotrue`,
  `realtime`, `storage-api`, `imgproxy`, `kong`, `mailpit`, `postgrest`, `postgres-meta`,
  `studio`, `edge-runtime`, `logflare`, `vector`, `supavisor`) — `db`/`postgres` is never
  excludable, matching Go. An invalid value warns and proceeds; it never fails the command.
- `--ignore-health-check` only affects the final bulk health check over the 11
  non-Postgres, non-excluded services (including Edge Runtime) — it does not relax
  Postgres's own startup health wait, and it never skips rollback for a _creation_
  failure, only for a health _timeout_. On the downgrade path, if this run also freshly
  created the Postgres volume and Storage started, a narrower Storage-only recheck runs
  and, if Storage is healthy, buckets are seeded anyway — a failure in THAT seed step
  still rolls back and fails the command despite the flag (see "Storage bucket seeding"
  and the `Exit Codes` table).
- `--preview` is a hidden, parsed-but-inert flag, matching Go exactly (never read by
  Go's own `start.Run`).
- The already-running check is a plain container-existence check (`docker container
inspect` on the Postgres container), not a health check — matching Go's
  `AssertSupabaseDbIsRunning` naming despite what it actually verifies.
