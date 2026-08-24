# `supabase start`

This command talks directly to Docker via subprocess (`docker`/`podman`) to bring up
the local dev stack sequentially, one container at a time — it does not use Docker
Compose, and it does not go through `@supabase/stack/effect`'s orchestration model
(see the CLI-1323 plan's "Critical architectural finding" for why: that runtime is a
deliberately different local-dev product — no Kong gateway, native-binary-first,
auto-allocated ports, opaque API keys — that would break the compatibility contract
this port exists to provide).

## Scope

Edge Runtime bring-up, the fresh-volume DB schema/migration/seed setup pipeline, and
fresh-volume storage-bucket seeding are all now natively implemented (see below) — this
section previously listed them as out-of-scope follow-ups.

One piece of the old Go CLI's `start` remains explicitly **out of scope**:

1. **Linked-project version-check suggestion** — a best-effort Management API call, made
   only when a project happens to be linked _and_ the user is logged in, purely to print
   an "update available" hint. Omitted entirely — this port has zero Management API
   dependency for `start`, by design.

### Fresh-volume DB setup (`legacyStartSetupLocalDatabase`)

Runs the initial schema/migrations/seed pipeline. Gated on
`isFreshVolume` (`legacyVolumeExists` on the Postgres volume, checked BEFORE the
volume is created) — this same check also selects which of
`Starting database...`/`Starting database from backup...` prints to stderr immediately
before Postgres's container is created. Runs immediately
after Postgres's own health check passes, before "Starting containers..." prints and
before any other service starts. Opens a direct `LegacyDbConnection` session to the
host-facing Postgres address (PG<=14: execs schema/globals/API-privileges SQL over that
session; PG>=15: runs three one-shot `LegacyDockerRun` jobs instead, gated independently on
`realtime.enabled`/`storage.enabled`/`auth.enabled`). Also upserts `[db.vault]` secrets and
seeds `supabase/roles.sql`: the `Seeding globals from roles.sql...` stderr line always
prints first, whether or not the file exists — a missing file is silently tolerated (no SQL
runs), any other read/exec error still fails the run. Finally runs every pending migration +
seed — UNLESS `--experimental`/`SUPABASE_EXPERIMENTAL` is set and `[experimental.pgdelta]
enabled` is false, in which case `db.migrations.schema_paths` files are applied INSTEAD of
`migrations/*.sql`; seed still runs either way.
A failure at any step rolls back the whole `start` run (same as any other bring-up failure).

`legacyStartInitCurrentBranch` (writes `supabase/.branches/_current_branch` = `"main"` if
absent) is NOT part of this fresh-volume-gated pipeline — it runs unconditionally on every
`start`, immediately after this pipeline's gate closes (whether or not the pipeline itself
ran).

### Edge Runtime bring-up (`legacyStartEdgeRuntimeContainer`)

Reuses `shared/functions/serve.ts`'s `startEdgeRuntimeContainer` core (the same one
`functions serve` uses). Gated on `edge_runtime.enabled && !--exclude edge-runtime`,
started between ImgProxy and pg-meta in the container-start sequence. Its own
`docker create` → `docker cp` (the bundled main-service template, streamed as a stdin
tar archive) → `docker start` sequence is assembled by that shared core, not by
`legacyCreateContainer` like every other service, and it is
health-checked via an HTTP probe through Kong (`/functions/v1/_internal/health`), not a
Docker healthcheck — mirroring PostgREST's own probe shape.

### Storage bucket seeding (`legacySeedBucketsRun`)

Runs only when `isFreshVolume && Storage started`, after the bulk
health check genuinely succeeds, right before the `cli_stack_started` telemetry capture. A
seeding failure rolls back the whole `start` run, same as any other post-bring-up failure.

A second, narrower seeding path exists for the `--ignore-health-check` downgrade branch:
when the bulk health check fails but `isFreshVolume && Storage
started`, a Storage-only recheck runs and, only if Storage itself is
healthy, seeds buckets anyway before falling through to the downgrade-to-warning behavior.
Unlike the main path above, a failure on THIS path is not swallowed by
`--ignore-health-check` — it replaces the original health error, rolls back, and fails the
command.

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
| `<workdir>/supabase/<db.migrations.schema_paths entries>` (files/directories/globs)             | SQL    | on a fresh volume, INSTEAD of `migrations/*.sql`, when `--experimental`/`SUPABASE_EXPERIMENTAL` is set and `[experimental.pgdelta] enabled` is false                             |
| `<workdir>/supabase/.branches/_current_branch`                                                  | text   | on every start, existence check before writing (see "Files Written")                                                                                                             |
| `<workdir>/supabase/functions/**`                                                               | —      | when Edge Runtime starts, and independently when Studio starts (function discovery/config resolution + Docker bind mounts, regardless of whether Edge Runtime itself is enabled) |
| `<workdir>/supabase/.temp/storage-migration`                                                    | text   | always — linked-project Storage migration pin (`DB_MIGRATIONS_FREEZE_AT`), written by `supabase link`; absent/unreadable resolves to no pin                                      |
| `<workdir>/supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version` | text   | always — linked-project per-service image version pins, written by `supabase link`; absent/unreadable resolves to the embedded default image                                     |
| `~/.docker/config.json`                                                                         | JSON   | via the `docker`/`podman` CLI itself, for registry auth — never read directly by this process                                                                                    |

## Files Written

| Path                                                                                     | Format | When                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/.branches/_current_branch`                                           | text   | on every start, only if absent — writes `"main"`                                                                                                                                                                                                                                                                                           |
| `<workdir>/supabase/.temp/start-secrets/<edgeRuntimeContainerName>/{env,multiline-env}/` | varies | Edge Runtime's own JWT/service-role-key/secret env artifacts — see below                                                                                                                                                                                                                                                                   |
| `<workdir>/supabase/.temp/pgdelta/catalog-local-migrations-<hash>-<ts>.json`             | JSON   | best-effort, on a fresh volume, after `MigrateAndSeed`, when pg-delta is enabled (`[experimental.pgdelta] enabled` or `SUPABASE_EXPERIMENTAL_PG_DELTA`) AND the legacy engine is selected (`SUPABASE_USE_PG_DELTA_NEXT=false`); the default next engine skips this warmup entirely; a failure only warns on stderr and never fails `start` |

Kong's `custom_nginx.template`, Vector's `vector.yaml`, and Postgres's own bootstrap
script (`postgresql.conf`-equivalent setup) are all rendered in memory and injected
directly into each container's entrypoint (a `sh -c '... heredoc ...'` command) —
never written to the host filesystem, since none of them carries secret content.
Kong's `kong.yml`/TLS cert/TLS key, Postgres's `pgsodium_root.key`, and Supavisor's
`pooler_tenant.exs` DO carry secret content (a service-role-key-derived bearer/query
key, TLS private key material, and the DB password respectively). Since
supabase/cli#6022 these have been delivered via `docker cp` straight into the created
(not yet started) container, never as host bind mounts. As of supabase/cli#6201,
`legacyCopyStartSecretFilesIntoContainer` also avoids plaintext host files by packing all
of one container's entries into one in-memory tar archive (mode `0644` — world-readable,
since Kong (uid 100) and Postgres's post-privilege-drop `postgres` user read them back as
non-root) and streams it through `docker cp - <id>:/`, extracting every entry at the exact path its
container's entrypoint/`Cmd` expects — see `container-lifecycle.ts`'s
`legacyCopyStartSecretFilesIntoContainer` doc comment for the full rationale
(CWE-214/522: keeping secret content out of the `docker create`/`docker cp` argv the
host can see via `ps`/`/proc/<pid>/cmdline`; and why `docker cp`, unlike a bind mount,
works identically against a remote `DOCKER_HOST`/Docker-context daemon). Nothing from
this delivery persists on host disk — unlike the bind-mount approach this replaced,
these containers' `restartPolicy: "unless-stopped"` restarts need nothing re-attached,
since the content already lives inside the container's own filesystem.
Studio reads/writes SQL snippets under `<workdir>/supabase/snippets/` at its own
runtime — that's Studio's behavior, not something `start` itself writes.

Edge Runtime's own JWT/service-role-key/configured-secret env file and multiline-env
script + value files (`shared/functions/serve.ts`'s
`writeDockerEnvFile`/`writeDockerMultilineEnvScript`) are
staged on host disk under `<workdir>/supabase/.temp/start-secrets/<edgeRuntime
containerName>/{env,multiline-env}/` (directory mode `0700`, files mode `0600`) — the
env file is read client-side by `--env-file`, the multiline-env directory is
bind-mounted `:ro,Z` into the container — a deterministic, persistent path rather than
`os.tmpdir()` (which is frequently tmpfs and gets wiped on reboot) so
`legacyCleanupStartSecrets` (see the Exit Codes/rollback section below) can reclaim
them on `stop` or a failed-start rollback. Each writer removes and
recreates its own subdirectory fresh on every call (self-healing), so a
shrinking env set never leaves stale files behind. The bootstrap `index.ts` template
carries no secret content and, as of supabase/cli#6254, never touches host disk at all:
it is streamed via `docker cp` straight into the created (not yet started) Edge Runtime
container — a single-file host bind mount materializes as an empty directory on daemons
that cannot see the client's filesystem (remote `DOCKER_HOST`/Docker-context daemons,
podman machines), which broke `start` with edge-runtime's "failed to determine
entrypoint". Only the bootstrap template is daemon-independent: user function
sources under `supabase/functions/**` and the multiline-env script directory
(present only when a secret value contains a newline) still arrive by host bind
mounts and require a daemon that can see the project directory.

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

| Variable                                                                                                             | Purpose                                                                                                                                                                                                                                                           | Required? |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_*` (any dotted config field)                                                                               | Generic Viper-style `AutomaticEnv` override of any `config.toml` field (e.g. `SUPABASE_AUTH_ENABLED`, `SUPABASE_API_PORT`)                                                                                                                                        | no        |
| `SUPABASE_EXPERIMENTAL` (or `--experimental`)                                                                        | Fresh volume + no pg-delta: applies `db.migrations.schema_paths` files instead of `migrations/*.sql` (see "Fresh-volume DB setup" above)                                                                                                                          | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`                                                                                     | Enables the post-`MigrateAndSeed` migrations-catalog cache warmup when `[experimental.pgdelta].enabled` is unset                                                                                                                                                  | no        |
| `SUPABASE_USE_PG_DELTA_NEXT`                                                                                         | Selects the pg-delta implementation; `false` selects the legacy edge-runtime engine and thereby restores the migrations-catalog cache warmup (unset/unrecognized defaults to the next engine, which skips it)                                                     | no        |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                                                                   | Overrides the image registry used to resolve every service's image                                                                                                                                                                                                | no        |
| `SUPABASE_PROJECT_ID`                                                                                                | Overrides the resolved local project id (env → config.toml → workdir basename)                                                                                                                                                                                    | no        |
| `SUPABASE_WORKDIR`                                                                                                   | Resolves `LegacyCliConfig.workdir`                                                                                                                                                                                                                                | no        |
| `BITBUCKET_CLONE_DIR`                                                                                                | When non-empty, drops named volumes and `--security-opt` from every container create                                                                                                                                                                              | no        |
| `DOCKER_HOST` / `DOCKER_CONTEXT` / `DOCKER_TLS_VERIFY` / `DOCKER_CERT_PATH` / `DOCKER_API_VERSION` / `DOCKER_CONFIG` | Read (ambient shell OR a project `.env`/`.env.<env>`/`.env.local` file) to discover the Docker daemon this whole command talks to; `DOCKER_HOST` is also re-derived and set on Vector's container env so it can reach the host's Docker socket for log collection | no        |
| `KONG_NGINX_WORKER_PROCESSES`                                                                                        | Read (ambient shell or project dotenv) into Kong's own container env (defaults to `"1"` when unset)                                                                                                                                                               | no        |
| `HTTP_PROXY` / `http_proxy` / `HTTPS_PROXY` / `https_proxy` / `NO_PROXY` / `no_proxy`                                | Bun proxy settings. After project dotenv and container creation, `start` appends `localhost,127.0.0.1,[::1]` to the effective no-proxy value before local Kong probes and seeding; it never changes project/container env and ends with this CLI process.         | no        |

`docker`/`podman` must be resolvable on `PATH` — same fallback behavior as `stop`/`status`.

`--debug` tees the fresh-volume PG15+ one-shot migrate jobs' (realtime/storage/auth) own
stderr to the parent process's stderr in real time — outside `--debug` only each job's exit
code is surfaced on failure.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — every started container passed its health check                                                                                                                                                                                                                                                                                                              |
| `0`  | the stack was already running — shows status instead of restarting                                                                                                                                                                                                                                                                                                     |
| `0`  | `--ignore-health-check` set and one or more containers timed out — the failure is printed and swallowed, no rollback                                                                                                                                                                                                                                                   |
| `1`  | `--ignore-health-check` set, the fresh-volume/Storage-healthy recheck-and-seed path ran (see "Storage bucket seeding"), and that seed itself failed — rolls back despite the flag                                                                                                                                                                                      |
| `1`  | malformed CSV in an `--exclude`/`-x` value — fails during flag parsing, before the handler and telemetry, with the exact diagnostic text on stderr; the shorthand frames it with both spellings (e.g. `invalid argument "a\"b" for "-x, --exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | malformed `config.toml` / `Config.Validate` failure                                                                                                                                                                                                                                                                                                                    |
| `1`  | stopped Postgres detected but the project id sanitizes to empty — aborts before recovery removes any containers                                                                                                                                                                                                                                                        |
| `1`  | `docker`/`podman` not spawnable, or the daemon is unreachable                                                                                                                                                                                                                                                                                                          |
| `1`  | stopped-stack recovery cannot list, stop, or prune current-project containers, or prune matching networks — aborts before startup; named volumes are preserved                                                                                                                                                                                                         |
| `1`  | image pull exhausted across every registry candidate, or the Docker daemon becomes unreachable during the pre-pull — even with `--ignore-health-check` (intentional divergence from the old Go CLI's exit-0 swallow quirk; see the CLI-1987 note under "Notes")                                                                                                        |
| `1`  | network, volume, container create, or container start failure (including a port conflict) — rolls back everything created so far                                                                                                                                                                                                                                       |
| `1`  | health check timeout **without** `--ignore-health-check` — rolls back                                                                                                                                                                                                                                                                                                  |
| `1`  | Postgres itself fails to start or its own health wait times out, **without** `--ignore-health-check` — rolls back                                                                                                                                                                                                                                                      |
| `0`  | `--ignore-health-check` set and Postgres's own health wait times out — the failure is printed and swallowed, no rollback; no OTHER service is ever created (Postgres's failure is returned before any other bring-up step runs), but the command still prints "Started..." + the (config-derived) status table                                                         |
| `1`  | fresh-volume DB setup failure (schema SQL / one-shot migrate job / vault upsert / roles seed / migration-apply) — rolls back                                                                                                                                                                                                                                           |
| `1`  | fresh-volume bucket-seeding failure — rolls back                                                                                                                                                                                                                                                                                                                       |

Rollback (`legacyRollbackStart`) tears down everything created so far by Docker label,
and never masks the original failure — a rollback error
is logged to stderr and swallowed. `deleteVolumes` is
`true` only when this run's Postgres volume was freshly created (so a failed
first-ever `start` prunes its own empty volume too), `false` otherwise (never touches a
pre-existing user's data on a failed restart). Rollback also reclaims this run's own
`<workdir>/supabase/.temp/start-secrets/<containerName>` directories (via
`legacyCleanupStartSecrets`, `legacy/shared/legacy-start-secrets-cleanup.ts`) once
teardown is CONFIRMED complete — the matching containers come from
`legacyDockerRemoveAll`'s `onContainersRemoved` hook, which fires only once `docker
container prune` has actually removed them (not at the initial listing), so cleanup only
ever targets containers this failed run itself created AND actually tore down. Each
container's directory is located via its own `com.supabase.cli.workdir` label (stamped on
every container `start` creates); this run's own workdir is only the fallback for a
container missing that label. As of supabase/cli#6022 this reclaim step is a no-op for
Kong/Postgres/Supavisor (nothing under their own `<containerName>` directory anymore —
their `secretFiles` never touch host disk, see "Files Written" above); it remains
load-bearing for Edge Runtime's own still-host-persisted staging under the same tree. A
later successful `stop` reclaims the same directories for a normal (non-rollback)
teardown — see `stop`'s own `SIDE_EFFECTS.md`.

## Telemetry Events Fired

| Event                  | When                                                                                                                                                              | Notable properties / groups         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via `withLegacyCommandInstrumentation`)                                                                                             | `exit_code`, `duration_ms`, `flags` |
| `cli_stack_started`    | once, only on a genuine bulk health-check success — never fires on an `--ignore-health-check` downgrade-to-warning path, Postgres's own or the later bulk check's | no properties                       |

## Output

`start` has no `-o`/`--output` flag of its own — after orchestration (or the
already-running short-circuit, or the ignored-health-check path), it renders through the
exact same `status` value/pretty-table machinery `supabase status` uses, in all three TS
output modes.

### `--output-format text`

- stderr (conditional, `--exclude` had invalid values): a `WARNING:` line naming the
  invalid values and listing the 13 valid ones — the command still proceeds.
- stderr: already-running banner (`supabase start` in aqua) **or** the bring-up sequence:
  `Starting database...` (fresh volume) / `Starting database from backup...` (existing
  volume) → Postgres create+start+health-wait → `Starting containers...` → (image
  pre-pull) → per-container create+start → `Waiting for health checks...` → `Started
supabase local development setup.`
- stderr (conditional, health-check timeout): per unhealthy container, a
  `<container> container logs:` header and that container's `docker logs` output, then one
  `<container>: <reason>` line each. Containers are named `supabase_<service>_<project id>`
  throughout, rather than the id `docker create` returns.
- stderr (conditional, `exec format error` in those logs) — **TS-port-only, beyond the old
  Go CLI's own behavior**: a recovery `suggestion` printed after the reasons, naming each affected
  container **with** its image (they can be named after different things —
  `supabase_inbucket_*` runs `mailpit`), then a `supabase stop` / `<runtime> image rm -f` /
  `supabase start` sequence, then a closing line for the case re-pulling cannot fix. The
  runtime named is whichever of `docker`/`podman` actually answered. `supabase stop` leads
  because `--ignore-health-check` leaves the stack up, so a bare restart would hit the
  already-running short-circuit and never recreate the broken container. The sequence tells
  the reader to run it from the project directory or with the same `--workdir`, rather than
  embedding the resolved path, which would need shell quoting that differs per platform. Being a
  `suggestion` also replaces the usual "rerun with --debug" line, which cannot help here.
  Nothing is ever removed automatically, and the old Go CLI printed no such guidance.
- stdout: the `status` pretty table (rounded box, same renderer `supabase status` uses).
- stderr: the local-dev security notice block (bind-to-`0.0.0.0` / shared-default-keys /
  no-auth-on-Studio-pgMeta-analytics warning).

### `--output-format json` / `--output-format stream-json`

A single JSON object (or a `result` NDJSON event) carrying the same value shape
`supabase status --output json` produces. All the progress/warning/banner/security-notice
text above is suppressed in these modes — stdout stays payload-only. On a health-check
timeout the error payload carries the advice above as a discrete `error.suggestion` string
alongside `error.message`, so a caller can surface it without re-parsing the message. It is
prose, not structured data.

## Notes

- **`pg_net` converges with `[experimental.webhooks]` on every non-backup start** (see
  `docs/go-cli-divergences.md`): a fresh volume installs `pg_net` only when webhooks are
  enabled or migration history contains a `create extension … pg_net`; an existing volume
  additionally DROPS a `pg_net` that migration history does not own when webhooks are
  disabled. Accepted, documented edge: `pg_net` installed outside migrations (local Studio
  SQL editor / extension toggle) is dropped on the next start, and a tracked dependency on
  `net.*` (PG14+ `BEGIN ATOMIC` functions) makes the non-`CASCADE` drop — and the start —
  fail. Enable `[experimental.webhooks]` or declare the extension in a migration to opt out.
- `--exclude`/`-x` accepts container names from the verified 13-key list (`gotrue`,
  `realtime`, `storage-api`, `imgproxy`, `kong`, `mailpit`, `postgrest`, `postgres-meta`,
  `studio`, `edge-runtime`, `logflare`, `vector`, `supavisor`) — `db`/`postgres` is never
  excludable. An invalid value warns and proceeds; it never fails the command.
- `--ignore-health-check` applies uniformly to EVERY service's health wait, Postgres
  included — it downgrades whatever the run returns as a whole, not just the later bulk
  health check. It never skips rollback for a _creation_ failure,
  only for a health _timeout_. When Postgres's OWN wait times out and the flag is set, no
  other service is ever created (Postgres's failure returns before any later bring-up step
  runs), yet the command still falls through to the "Started..." tail and the
  (config-derived) status table. When it's instead the LATER bulk health
  check that times out with the flag set, and this run also freshly created the Postgres
  volume and Storage started, a narrower Storage-only recheck runs and, if Storage is
  healthy, buckets are seeded anyway — a failure in THAT seed step still rolls back and
  fails the command despite the flag (see "Storage bucket seeding" and the `Exit Codes`
  table).
- **Intentional divergence from the old Go CLI — image-pull/daemon failure under
  `--ignore-health-check` (CLI-1987, ruled 2026-07-30):** the old Go CLI's unhealthy-error
  classifier treated ANY joined error as "unhealthy", which accidentally also matched the
  image pre-pull step's joined pull errors. So in the old Go CLI, with `--ignore-health-check`
  set, a total image-pull failure — every registry candidate exhausted, or the Docker daemon
  becoming unreachable during the pre-pull — was swallowed: it printed the error, skipped
  rollback, printed `Started supabase local development setup.` + the status table + the
  security notice, and exited 0 even though no container ever started. That was an
  unintended quirk of a shape-based check, and it is deliberately NOT reproduced here —
  enforced by control flow, not by a classifier: unlike a single outer check on the whole
  run result, this port consults `legacyIsUnhealthyStartError` (`start.rollback.ts`) only
  inside its two health-wait failure branches, and the image pre-pull runs before
  bring-up, so its failure propagates out without ever reaching a downgrade branch. The
  same scenario exits 1 with no success banner and no status table, flag or no flag.
  `--ignore-health-check` downgrades health-check timeouts only. Rollback is NOT part of
  the divergence — the pre-pull runs before any container/network is created, so there
  is nothing to roll back either way; the observable delta is exit code + success
  banner + status table + security notice (the old Go CLI printed all three of the latter
  unconditionally at the end of its run; this port's failure exits before
  any of them). Note the flag's own help text ("Ignore unhealthy services and exit 0")
  over-promises in this scenario — a pre-pull failure is not an
  "unhealthy service", but a user reading only `--help` may still expect exit 0 here.
- `--preview` is a hidden, parsed-but-inert flag, inherited from the old Go CLI (never
  read by its own `start.Run`).
- The already-running check uses `docker container inspect` on the Postgres container,
  not a health check. For a verified
  stopped container outside Bitbucket Pipelines, `start` removes all current-project
  containers — including running siblings — and unused networks, preserves named volumes,
  and continues normal startup. After container removal succeeds, it deletes
  `<invoking-workdir>/supabase/.temp/start-secrets/<containerName>` only for containers
  whose workdir label matches the invoking workdir, or whose missing label uses that
  workdir as a fallback. Removed containers labeled with another workdir keep their
  `<labeled-workdir>/supabase/.temp/start-secrets/<containerName>` directory. As of
  supabase/cli#6022 this is a no-op for a removed Kong/Postgres/Supavisor container
  (nothing under its own directory anymore); it still matters for a removed Edge Runtime
  container, whose own env-file/multiline-env-script staging is
  unaffected by that change.
- Docker status `created` is not considered a recoverable stopped stack: the container and
  named volume are preserved because the volume may not have completed its first database
  initialization, and `start` reports the existing not-running status instead.
- **Intentional divergence from Go — spec-strict import-map key matching (CLI-2179, ruled
  2026-08-12):** Edge Runtime bind mounts are computed by the same functions import scanner
  as `functions deploy`/`functions serve` (`walkImportPaths`/`substituteImportMapValue`,
  shared code), which now matches import-map keys per the import-maps spec Deno/edge-runtime
  implement (exact match, or prefix match only for a `/`-suffixed key) instead of Go's
  any-key `strings.HasPrefix` (`pkg/function/deno.go:150-155`). Bind mounts may shrink vs
  the Go CLI for maps that relied on bare-key prefix matching; an unwalkable target
  (`ENOTDIR` — a value routed through a file) is skipped with a `WARN`, matching the same
  divergence documented on the `functions deploy`/`functions serve` SIDE_EFFECTS.md.
