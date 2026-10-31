# `supabase db pull`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

Pulls the remote schema into either a new timestamped
migration (diffing a throwaway shadow against the remote, bundled pg-delta or
migra) or declarative files (`--declarative`). The declarative mode runs the native
pg-delta export. The initial-migra pull (no local migrations) seeds the migration file
with a native `pg_dump` of the remote schema (a Docker `pg_dump` container,
with IPv4 transaction-pooler fallback) and then appends the migra diff.
`--use-pg-delta` and the `--experimental` structured-dump mode (`--experimental` or
`SUPABASE_EXPERIMENTAL` resolving true without `--declarative`) are removed — see
"Removed surfaces" below.

In migration mode a hosted target (a remote project or branch, or a non-local `--remote=<url>`) needs
one confirmation (default **No**) that covers writing the migration file(s) and recording them in
the remote migration history; see "Consent" below.

When `[experimental].stack` is on, each shadow is a fresh database in an invocation-owned,
unique temporary stack namespace. The command applies the catalog and project migrations as needed,
then destroys its namespace when the Effect scope closes. If its container engine is unreachable
then, the namespace is still removed and stderr lists the commands that remove its engine
resources. Stack shadows use the stack baseline
cache described below. Native artifacts
are shared through `$SUPABASE_HOME/cache/stack`; shadow state and data use the normal stack registry, so `stack list` and `stack destroy` can
find a shadow left by an abrupt CLI exit. Each shadow owns a unique temporary project root
and uses an automatically assigned port; `db.shadow_port` applies only to the legacy backend. Migra (`--diff-engine migra`) is rejected in stack mode.
A `--remote=<url>` whose host and port match the running project stack's SQL endpoint (the `DB_URL`
from `stack status --env`) is a local target and connects in plaintext, like the default local
target; a remote or multi-host URL without an explicit `sslmode` still requires TLS.

Pg-delta runs in-process. Coverage gaps warn; `--strict-coverage` makes them
fatal, while `PGDELTA_DEBUG` writes diagnostic JSON under
`supabase/.temp/pgdelta/v2/debug/<id>/` (`<SUPABASE_HOME>/tmp/pgdelta/v2/debug/<id>/` in stack mode). The engine may emit transaction-aware
file splits; applicable, convergent SQL is the contract. Its formatter
defaults to lowercase SQL at width 180; config overrides it, and JSON `null`
disables formatting without disabling safe compaction.

## Files Read

| Path                                                                                      | Format      | When                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json` or `config.toml`                                         | JSON / TOML | always, `config.json` preferred (db port/password, `[experimental.pgdelta]`)                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file | dotenv      | migration-style pull's shadow provisioning, and declarative export config/env resolution                                                                                                                                                                                                                                                           |
| `api.tls.cert_path` / `api.tls.key_path` (under `<workdir>/supabase/`)                    | PEM         | shadow provisioning, when `api.enabled && api.tls.enabled`                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/migrations/*.sql`                                                     | SQL         | history reconciliation + shadow provisioning                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/roles.sql`                                                            | SQL         | migration-style pull only (`--declarative` provisions no shadow); also hashed into the shadow-baseline cache key on every cache-eligible acquire, warm hits included (where no baseline is applied at all); missing file tolerated                                                                                                                 |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`                             | tar         | warm shadow-cache hit (migration-style pull) — the matching snapshot is streamed into the fresh shadow; every cache-eligible acquire (warm hit and successful cold export) also enumerates and `stat`s every `shadow-baseline-*.tar` for LRU keep-3 + 2-day mtime TTL and may delete other keys (`SUPABASE_HOME` overrides the `~/.supabase` root) |
| managed snapshot key `<key>`                                                              | backend     | warm stack-shadow cache hit; managed retention may evict entries and snapshots survive stack destruction                                                                                                                                                                                                                                           |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial`               | tar         | abandoned-partial sweep on every cache-eligible acquire (warm hit and cold export) — enumerated and `stat`ed, and removed when older than 5 minutes (a crashed/SIGKILLed earlier export's leftover)                                                                                                                                                |
| `~/.supabase/access-token`                                                                | plain text  | a remote project or branch with no `SUPABASE_ACCESS_TOKEN`                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/.temp/project-ref`                                                    | plain text  | bare `--remote`, ref resolution — skipped when `SUPABASE_PROJECT_ID` is set; with no selector, only to name the project in the `Target:` hint                                                                                                                                                                                                      |
| `PGSSL*` PEM, `pg_service.conf`                                                           | PEM, libpq  | remote project, when set; see `db push`                                                                                                                                                                                                                                                                                                            |

## Files Written

| Path                                                                        | Format  | When                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`                 | SQL     | migration-style pull (non-empty diff, or the initial-migra `pg_dump` seed)                                                                                                                                                                                                                                                           |
| `<workdir>/supabase/schemas/**`                                             | SQL     | `--declarative` export                                                                                                                                                                                                                                                                                                               |
| `<workdir>/supabase/schemas/.pgdelta-export.json`                           | JSON    | bundled declarative export metadata                                                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/config.toml`                                            | TOML    | declarative export updates `[db.migrations].schema_paths` only when `[experimental.pgdelta] enabled = false`; skipped when `enabled` resolves true (section absent, `enabled` omitted, or `enabled = true` — the default)                                                                                                            |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                     | JSON    | bundled engine with `PGDELTA_DEBUG`                                                                                                                                                                                                                                                                                                  |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar     | cache-enabled COLD shadow provision creates the current key's snapshot, migration-style pull only (never a declarative export, which provisions no shadow); a warm hit `touch`es its mtime (LRU); every cache-eligible acquire may delete other keys under LRU keep-3 + 2-day mtime TTL — ~90MB (`SUPABASE_HOME` overrides the root) |
| managed snapshot key `<key>`                                                | backend | stack-mode cache-enabled cold shadow provision saves the database baseline; the last completed save replaces the key                                                                                                                                                                                                                 |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar     | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports / warm hits sweep leftovers older than 5 minutes                                                                                                       |
| `<workdir>/supabase/.temp/linked-project.json`                              | JSON    | a remote project or branch (post-run cache)                                                                                                                                                                                                                                                                                          |
| `~/.supabase/telemetry.json`                                                | JSON    | every invocation (post-run)                                                                                                                                                                                                                                                                                                          |

## Docker

- Edge-runtime container (migra engine only). It mounts the `supabase_edge_runtime_<project_id>`
  Deno-cache volume, first created by `docker volume create` with the `com.supabase.cli.project`/
  `com.docker.compose.project` labels so `stop --no-backup` removes it (skipped under Bitbucket
  Pipelines, which drops the mount).
- Shadow Postgres container — provisioned and torn down natively (`prepareShadowSource` in
  `commands/db/shared/shadow-source.ts`, over the lower-level primitives in
  `command-internal/db-bootstrap/shadow-database.ts`). Torn down with
  `docker rm -f -v` on every run, cache or no cache — see the shadow baseline cache section
  below. Migration-style pulls only; `--declarative` provisions no shadow.
- `supabase/migra` container — the migra OOM bash fallback only.
- `pg_dump` container — the initial-migra pull's native remote-schema dump
  (`streamPgDumpWithClient`, shared with `db dump`). It runs on the host network unless
  `--network-id` / `SUPABASE_NETWORK_ID` names another network; on a named network a loopback
  target is rewritten to `host.docker.internal`. Stack-backed pulls skip dump seeding: they
  always use pg-delta and reject `--diff-engine migra`.

### Shadow baseline cache (`SUPABASE_SHADOW_CACHE`, default ON)

In stack mode, cache-eligible shadows use a managed snapshot keyed by `<key>`;
the key includes resolved stack artifacts, runtime/platform, enabled catalog services, settings,
credentials, overlay inputs, and `roles.sql`. Warm restores touch the entry, cold provisioning
publishes only when the roles file is unchanged, and retention keeps three entries by LRU.
A falsy `SUPABASE_SHADOW_CACHE` bypasses this cache. A failed warm restore recreates the database;
a failed cache export warns and continues with the live shadow.

On by default; setting `SUPABASE_SHADOW_CACHE` to anything that does not parse as true (`false`/`0`/empty/garbage,
honored from the ambient env AND the project's dotenv, e.g. `supabase/.env`) turns it off,
restoring the documented uncached lifecycle. A warm hit
skips the platform baseline, so the `Initialising schema...` progress line does not print —
progress text reflects the work actually performed.
Artifact: `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar` (~90MB; `SUPABASE_HOME`
overrides the root), a PGDATA snapshot keyed by a hash of every input baked into the cluster
(including the effective Webhooks/`pg_net` policy);
shared across worktrees with the same settings; retention is LRU (keep 3) + 2-day mtime TTL
(warm hits refresh mtime; sibling tars may be deleted).
Container lifecycle is identical to the uncached path except a cold run drops `--rm` (still removed
on release). A cache anomaly never fails the command — a warm-path anomaly cold-provisions instead,
a cold export failure only warns and leaves the run uncached (one exception: a shadow that
fails to come back up after the snapshot fails the run rather than reporting a false success). See `shared/db-bootstrap/
shadow-cache.ts`'s doc comment for the mechanics.
Session-semantics caveat on the cached paths: migrations run on a session opened after the
platform baseline, so role-level defaults installed by `supabase/roles.sql`
(`ALTER ROLE … SET …`) apply to migration execution; with the cache off, the single-session flow
runs migrations before those defaults take effect. Each pooler-retry attempt acquires/releases its
own shadow (a warm hit restores the same tar each time); `--declarative` provisions no shadow
at all, so nothing is cached for it.

## API Routes / DB

| Method | Path / SQL                                          | Auth   | Purpose                                                                                                                                                                           |
| ------ | --------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/projects/{ref}/cli/login-role`                 | Bearer | Temp login role when no password                                                                                                                                                  |
| GET    | `/v1/projects/{ref}/config/database/pooler`         | Bearer | IPv4 pooler fallback                                                                                                                                                              |
| POST   | `/v1/projects/{ref}/network-bans/retrieve`          | Bearer | List bans during pooler login retry                                                                                                                                               |
| DELETE | `/v1/projects/{ref}/network-bans`                   | Bearer | Unban during pooler login retry (only under `--yes`)                                                                                                                              |
| GET    | `/v1/projects/{ref}`                                | Bearer | Linked-project cache (post-run)                                                                                                                                                   |
| GET    | `/v1/projects/{parent}/branches`                    | Bearer | Branch lookup — only for `--remote=<branch>`, and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| GET    | `/v1/branches/{id}`                                 | Bearer | Branch lookup — only for `--remote=<branch UUID>` when no project is linked                                                                                                       |
| SQL    | `SELECT version FROM …schema_migrations`            | —      | history reconciliation (remote)                                                                                                                                                   |
| SQL    | `INSERT … ON CONFLICT … schema_migrations` (UPSERT) | —      | history update (after consent)                                                                                                                                                    |

## Environment Variables

| Variable                                                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Required? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN`                                                               | auth for a remote project or branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | no        |
| `SUPABASE_DB_PASSWORD`                                                                | remote DB password (overridden by `-p`); ignored for a target other than the linked project (see Notes)                                                                                                                                                                                                                                                                                                                                                                                                                  | no        |
| `SUPABASE_DB_SHADOW_PORT`                                                             | shadow container's host port (`db.shadow_port`) — NOT `SUPABASE_DB_PORT`, which the shadow never reads                                                                                                                                                                                                                                                                                                                                                                                                                   | no        |
| `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | shadow container-config overrides, same as `db start`/`db reset`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | no        |
| `SUPABASE_PROJECT_ID`                                                                 | overrides the shadow container's project id/labels, same as `db start`/`db reset` (`utils.DbId`); ALSO the linked-ref resolution fallback and the parent project `--remote=<branch>` resolves against; `--remote=<ref>` supersedes it for the ref — see Notes for the narrower scope of the flag                                                                                                                                                                                                                         | no        |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                | forces the shadow and initial-migra `pg_dump` containers onto an existing Docker network                                                                                                                                                                                                                                                                                                                                                                                                                                 | no        |
| `SUPABASE_USE_SLIM_IMAGES`                                                            | resolves the current-pin shadow Postgres, `pg_dump`, PG15+ realtime/storage/auth migrate-job images (migration-style cold shadow), and (for migra) the edge-runtime image from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB tags the catalog does not pin, flag-off `15.8.1.085`, and `deno_version = 1` stay on docker.io; a failed GHCR pull falls back to the same tag and digest on `public.ecr.aws/supabase/cli` | no        |
| `SUPABASE_HOME`                                                                       | overrides the `~/.supabase` root used for the shadow baseline cache (and other CLI state)                                                                                                                                                                                                                                                                                                                                                                                                                                | no        |
| `SUPABASE_SHADOW_CACHE`                                                               | shadow baseline cache; on by default, opt-out (`0`/`false`); the shadow's post-baseline state is saved under a managed snapshot key and restored into the next run's fresh stack database (see Notes)                                                                                                                                                                                                                                                                                                                    | no        |
| `SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED`                                               | overrides `[experimental.pgdelta].enabled` (default true; `false` selects migra for the migration-style diff unless `--diff-engine` is passed, and lets a declarative export write `schema_paths`); a value that is not a boolean fails the command                                                                                                                                                                                                                                                                      | no        |
| `SUPABASE_EXPERIMENTAL`                                                               | resolving true (shell, then project `.env`) without `--declarative` fails the command with the removed structured-dump error; `--experimental=false` overrides it for one invocation                                                                                                                                                                                                                                                                                                                                     | no        |
| `PG*` libpq                                                                           | remote-project TLS, timeout, service; see `db push`. The `pg_dump` seed gets them (see `db dump`); the migra container gets none of these `PG*` TLS settings (migra gets the CLI's own bundled CA outside its OOM fallback)                                                                                                                                                                                                                                                                                              | no        |

## Exit Codes

| Code | Condition                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (migration written and recorded in the history; declarative export)                                                                                                     |
| `1`  | `--declarative` with `--diff-engine`; migration-history conflict; **no schema changes ("No schema changes found")**; connection/shadow/engine failure; file IO error            |
| `1`  | `--use-pg-delta` passed at all (any value, including `=false`); `--experimental`/`SUPABASE_EXPERIMENTAL` resolving true without `--declarative` — removed, see Removed surfaces |
| `1`  | hosted confirmation declined (`context canceled`), or needed in a run that cannot prompt (non-interactive, JSON, stream-json, agent) without `--yes`                            |

> Note: unlike `db diff`, an empty diff (`No schema changes found`) is a **non-zero
> exit** for `db pull`. Instead of the generic
> `Try rerunning the command with --debug to troubleshoot the error.` stderr footer,
> `db pull` prints
> `The remote database is already in sync with your local migrations — nothing to pull.`

## Output

### `--output-format text`

Progress to stderr. Migration path: `Creating shadow database...`,
`Diffing schemas[: <list>]`, `Schema written to <path>`. Declarative path:
`Preparing declarative schema export using pg-delta...`, `Declarative schema
written to <dir>`. Alias deprecation warnings print first. On a hosted target the confirmation question precedes any file write. On success the PostRun line `Finished supabase db pull.` is printed to
stdout.

A configured `[db.migrations].schema_paths` also warns on the migration path
that it no longer replaces the migrations baseline.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ declarative, schemaWritten, remoteHistoryUpdated, engine }` (`remoteHistoryUpdated` is `true`
for every migration-mode pull) and suppresses the `Finished supabase db pull.` line. The
resolved `target` object is merged into the payload.

## Consent

- Declarative pulls and pulls against the local stack (the default) ask nothing.
- A migration pull against a hosted target asks `Update the remote migration history table on
<target>?` (default **No**), listing the number of migration files it will write. It is asked
  after the diff and the in-sync check, so an in-sync pull asks nothing. The initial migra pull
  asks before its `pg_dump` seed writes the file.
- Declining exits non-zero with `context canceled` before any file is written; the migration
  history is never updated without the files and the files are never written without the history
  update.

## Notes

- **Config value precedence** (ADR 0032): explicit flag > shell env > project `.env*` > config
  (`config.json` over `config.toml`) > default. The whole config is decoded up front, so an
  invalid value fails the command. A remote project or branch also applies a matching `[remotes.*]`
  block. The linked-database password env is withheld when the target differs from
  `.temp/project-ref`, with a `Not sending SUPABASE_DB_PASSWORD to <target>: ...` warning and a
  temporary login role instead.
- `--declarative` is mutually exclusive with `--diff-engine`.
- `--diff-engine` defaults to pg-delta. Without the flag, migra is selected only by
  `[experimental.pgdelta] enabled = false`; the historical
  `SUPABASE_EXPERIMENTAL_PG_DELTA` opt-in is not read.
- Unlike `SUPABASE_PROJECT_ID`, `--remote=<ref>` and `--project-ref` do not affect the shadow
  container's project id/labels.
- Migration-style pulls always compare migrations with the live target;
  declarative files and `schema_paths` do not replace that baseline.
- Bundled nontransactional files begin with
  `-- pg-delta: transaction=false`, which later migration commands honor.
- The initial-migra pull (no local migrations, Compose / non-stack only) is native:
  it streams a `pg_dump` of the remote schema into the migration file, then appends
  the migra diff. An empty diff after a non-empty dump is swallowed; an empty dump +
  empty diff is "No schema changes found". Stack-backed pulls never take this path.

### Removed surfaces

Both fail with `RemovedSurfaceError` (exit 1). Telemetry records `cli_command_executed` with
`error_fingerprint` ending in `:removed_flag`; the post-run `telemetry.json` read and write under
`SUPABASE_HOME` still happens, and `use-pg-delta` stays in the recorded `flags`.

- `--use-pg-delta` (any value, including `=false`; checked first, even alongside `--declarative`)
  fails before any work, on a runtime that needs no credentials, profile or config. Message:
  `--use-pg-delta was removed.` Suggestion: "Use --declarative to pull the declarative schema.
  The diff engine is chosen with --diff-engine or [experimental.pgdelta] enabled in config.toml."
  The flag stays parsed (hidden, bound to `[experimental.pgdelta].enabled`) only so misuse reaches
  this error. The migration diff engine is unchanged: pg-delta by default, with migra selected by
  `--diff-engine migra`, `[experimental.pgdelta] enabled = false` or its env var.
- The `--experimental` structured-dump mode is the global `--experimental` flag,
  `SUPABASE_EXPERIMENTAL` in the shell, or `SUPABASE_EXPERIMENTAL` in the project `.env` resolving
  true (flag > shell env > project `.env`) without `--declarative`. It is rejected
  before the profile or credentials load, after only the project `.env*` read from the workdir, so a
  malformed `.env` fails first, but before any config, database or network work. Message: "The --experimental structured-dump mode of db pull was
  removed." Suggestion: "Use --declarative to pull per-object schema files, or pass
  --experimental=false (or unset SUPABASE_EXPERIMENTAL) for a migration pull."
  `--experimental --declarative` runs the declarative export without an error, and an explicit
  `--experimental=false` beats the env. The check lives in the `db pull` command handler, not in
  the shared pull runner, so `supabase pull` does not reject `SUPABASE_EXPERIMENTAL`.
