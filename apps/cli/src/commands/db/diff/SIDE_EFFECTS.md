# `supabase db diff`

Target: selectable, no consent — see [Command target](../../../../docs/command-target.md)

Diffs the local project's expected schema (a throwaway shadow
database) against a target database (local / a remote project or branch / `--remote=<url>`), using one of
three native engines: bundled in-process pg-delta, migra (edge-runtime), or
pgAdmin (CLI-1968 — a native `docker run` of the differ container, no
edge-runtime involved). `--use-pg-schema` is removed: the flag stays parsed
(hidden) only so using it fails with an actionable removal error instead of an
unknown-flag parse error — see "`--use-pg-schema` is removed" below.

When `[experimental].stack` is on, each shadow is a fresh database in an invocation-owned,
unique temporary stack namespace. The command applies the catalog and project migrations as needed,
then destroys its namespace when the Effect scope closes. If its container engine is unreachable
then, the namespace is still removed and stderr lists the commands that remove its engine
resources. Stack shadows use the stack baseline
cache described below. Native artifacts
are shared through `$SUPABASE_HOME/cache/stack`; shadow state and data use the normal stack registry, so `stack list` and `stack destroy` can
find a shadow left by an abrupt CLI exit. Each shadow owns a unique temporary project root
and uses an automatically assigned port; `db.shadow_port` applies only to the legacy backend. Migra, pgAdmin, and `--use-pg-schema` are rejected in stack mode.

Pg-delta runs in-process. Coverage gaps warn, while `--strict-coverage` makes
them fatal, and `PGDELTA_DEBUG` writes diagnostic JSON under
`supabase/.temp/pgdelta/v2/debug/<id>/`. The engine may emit transaction-aware
file splits; applicable, convergent SQL is the contract.
The bundled formatter defaults to lowercase SQL at width 180; config overrides
it, and JSON `null` disables formatting without disabling safe compaction.

## Files Read

| Path                                                                                                      | Format                                                                                | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json` or `config.toml`                                                         | JSON / TOML                                                                           | always, `config.json` preferred (db port/password, `[experimental.pgdelta]`, deno_version)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file                 | dotenv                                                                                | shadow provisioning (all native targets, including the explicit `--from/--to migrations` shadow)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `api.tls.cert_path` / `api.tls.key_path` (under `<workdir>/supabase/`)                                    | PEM                                                                                   | shadow provisioning, when `api.enabled && api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `auth.email.template.*` / `auth.email.notification.*` `content_path` (config-relative or absolute)        | text (existence/readability only — bytes discarded, used only to validate the config) | only when `auth.enabled`, for every configured template and every notification with `enabled = true` — via the same `readDbToml`/`checkDbToml` `Config.Validate` pipeline shared by every `db`/`migration` subcommand that loads config (`db dump`/`pull`/`reset`/`push`/`schema declarative generate`/`sync`, `migration up`/`down`/`squash` — documented once here rather than duplicated per file, CLI-2339); the resolved path is CONFINED to the project root (symlinks dereferenced with `realpathSync`) — a path resolving outside it aborts before the read |
| `<workdir>/supabase/migrations/*.sql`                                                                     | SQL                                                                                   | shadow provisioning (applied to the shadow source) — `--use-pgadmin` too, via the SAME `migrateShadowDatabase`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/roles.sql`                                                                            | SQL                                                                                   | shadow provisioning, PG14 and PG15 alike (unlike `db reset`'s PG15-only local path); also hashed into the shadow-baseline cache key on every cache-eligible acquire, warm hits included (where no baseline is applied at all); missing file tolerated                                                                                                                                                                                                                                                                                                               |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`                                             | tar                                                                                   | warm shadow-cache hit — the matching snapshot is streamed into the fresh shadow; every cache-eligible acquire (warm hit and successful cold export) also enumerates and `stat`s every `shadow-baseline-*.tar` for LRU keep-3 + 2-day mtime TTL and may delete other keys (`SUPABASE_HOME` overrides the `~/.supabase` root)                                                                                                                                                                                                                                         |
| managed snapshot key `<key>`                                                                              | backend                                                                               | warm stack-shadow cache hit; managed retention may evict entries and snapshots survive stack destruction                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial`                               | tar                                                                                   | abandoned-partial sweep on every cache-eligible acquire (warm hit and cold export) — enumerated and `stat`ed, and removed when older than 5 minutes (a crashed/SIGKILLed earlier export's leftover)                                                                                                                                                                                                                                                                                                                                                                 |
| `[db.migrations].schema_paths` globs / `<workdir>/supabase/database/**` / `<workdir>/supabase/schemas/**` | SQL                                                                                   | migra engine only, for the local-target declarative-schema fallback; pg-delta always compares the migrations baseline directly to the live target                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `~/.supabase/access-token`                                                                                | plain text                                                                            | a remote project or branch with no `SUPABASE_ACCESS_TOKEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/.temp/project-ref`                                                                    | plain text                                                                            | bare `--remote`, ref resolution — skipped when `SUPABASE_PROJECT_ID` is set; with no selector, only to name the project in the `Target:` hint                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Files Written

| Path                                                                        | Format  | When                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`                 | SQL     | non-empty `--file` diff; bundled pg-delta may emit ordered transaction-aware files, while pgAdmin always emits one                                                                                                                                                                                                                                             |
| `<path>` (from `--output` / `-o`)                                           | SQL     | explicit `--from/--to` mode with `--output`; flattened review representation, not a portable apply script                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                     | JSON    | bundled engine with `PGDELTA_DEBUG`                                                                                                                                                                                                                                                                                                                            |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar     | cache-enabled COLD shadow provision creates the current key's snapshot (native diff targets + the explicit `--from/--to migrations` shadow; never `--use-pgadmin`/`--use-pg-schema`); a warm hit `touch`es its mtime (LRU); every cache-eligible acquire may delete other keys under LRU keep-3 + 2-day mtime TTL — ~90MB (`SUPABASE_HOME` overrides the root) |
| managed snapshot key `<key>`                                                | backend | stack-mode cache-enabled cold shadow provision saves the database baseline; the last completed save replaces the key                                                                                                                                                                                                                                           |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar     | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports / warm hits sweep leftovers older than 5 minutes                                                                                                                                 |
| `<workdir>/supabase/.temp/linked-project.json`                              | JSON    | a remote project or branch (post-run cache)                                                                                                                                                                                                                                                                                                                    |
| `~/.supabase/telemetry.json`                                                | JSON    | every invocation (post-run)                                                                                                                                                                                                                                                                                                                                    |

## Docker

- Edge-runtime container (migra engine only). It and the `supabase/migra` fallback get
  loopback `SOURCE`/`TARGET` hosts rewritten to `host.docker.internal` when `--network-id`
  puts them on a named network, or when a stack-backend URL is used outside Linux host
  networking. The edge-runtime run mounts the `supabase_edge_runtime_<project_id>` Deno-cache
  volume, first created by `docker volume create` with the `com.supabase.cli.project`/
  `com.docker.compose.project` labels so `stop --no-backup` removes it (skipped under Bitbucket
  Pipelines, which drops the mount).
- Shadow Postgres container — provisioned and torn down natively (`prepareShadowSource`
  in `commands/db/shared/shadow-source.ts`, over the lower-level primitives in
  `command-internal/db-bootstrap/shadow-database.ts`). Explicit
  `--from/--to migrations` provisions its migrations shadow through the pg-delta shadow layer
  (`pgdelta-next-shadow.layer.ts`), which builds on the same shadow-baseline cache
  primitives (`acquireShadowDatabase`), with no declarative-schema-override branch.
  `--use-pgadmin` provisions its OWN shadow via a
  narrower composition — `createShadowDatabase` -> health-wait -> `migrateShadowDatabase`
  directly (`diff.handler.ts`'s pgadmin branch) — with no declarative-schema-override branch and
  no `targetUrlOverride`.
- When `[experimental].stack` / `SUPABASE_EXPERIMENTAL_STACK=1` is on, the local target inspects the
  project stack (`findStack` + `status`, database ready) instead of `supabase_db_<projectId>`,
  and shadows are temporary databases owned by the stack runtime (slim-init baseline, cache
  `--use-pg-schema`.
- `supabase/migra` container — the migra OOM bash fallback only.
- **Differ container** (`--use-pgadmin`, CLI-1968) — `supabase/pgadmin-schema-diff:cli-0.0.5`
  (`dockerfileServiceImage("differ")`). One `docker run --rm` when no `--schema` is given; one
  run per `--schema` value, in flag order. Runs on the project's Docker network (`--network-id`
  or the generated `supabase_network_<projectId>` — never the host network, unlike the migra
  bash fallback), so loopback source and shadow hosts become `host.docker.internal` unless
  `--network-id host` is set, with `--add-host host.docker.internal:host-gateway` on Linux only, and both
  `com.supabase.cli.project`/`com.docker.compose.project` labels — no env vars, bind mounts, or
  working-directory override.

## API Routes (remote project or branch, via the db-config resolver)

| Method | Path                                        | Auth   | Purpose                                                                                                                                                                                                                |
| ------ | ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/projects/{ref}/cli/login-role`         | Bearer | Temp login role when no password; also for a `--from`/`--to` value naming a project ref or branch                                                                                                                      |
| GET    | `/v1/projects/{ref}/config/database/pooler` | Bearer | IPv4 pooler fallback; also for a `--from`/`--to` value naming a project ref or branch                                                                                                                                  |
| POST   | `/v1/projects/{ref}/network-bans/retrieve`  | Bearer | List bans during pooler login retry                                                                                                                                                                                    |
| DELETE | `/v1/projects/{ref}/network-bans`           | Bearer | Unban during pooler login retry                                                                                                                                                                                        |
| GET    | `/v1/projects/{ref}`                        | Bearer | Linked-project cache (post-run)                                                                                                                                                                                        |
| GET    | `/v1/projects/{parent}/branches`            | Bearer | Branch lookup — only for `--remote=<branch>`, a bare `--remote` followed by a word that could name a branch, and a `--from`/`--to` value naming a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| GET    | `/v1/branches/{id}`                         | Bearer | Branch lookup — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                            |

`--use-pgadmin` with a remote target performs every one of these calls natively (CLI-1968), as part
of this command's own target resolve, ahead of the differ container.

## Environment Variables

| Variable                                                                              | Purpose                                                                                                                                                                                                                                                                                          | Required? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN`                                                               | auth for a remote project or branch                                                                                                                                                                                                                                                              | no        |
| `SUPABASE_DB_PASSWORD`                                                                | remote DB password (a remote project or branch); ignored for a target other than the linked project (see Notes)                                                                                                                                                                                  | no        |
| `SUPABASE_DB_SHADOW_PORT`                                                             | shadow container's host port (`db.shadow_port`) — NOT `SUPABASE_DB_PORT`, which the shadow never reads                                                                                                                                                                                           | no        |
| `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | shadow container-config overrides, same as `db start`/`db reset`                                                                                                                                                                                                                                 | no        |
| `SUPABASE_PROJECT_ID`                                                                 | overrides the shadow container's project id/labels, same as `db start`/`db reset` (`utils.DbId`); ALSO the linked-ref resolution fallback and the parent project `--remote=<branch>` resolves against; `--remote=<ref>` supersedes it for the ref — see Notes for the narrower scope of the flag | no        |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                | forces the shadow container/network onto an existing Docker network                                                                                                                                                                                                                              | no        |
| `SUPABASE_HOME`                                                                       | overrides the `~/.supabase` root used for the shadow baseline cache (and other CLI state)                                                                                                                                                                                                        | no        |
| `SUPABASE_SHADOW_CACHE`                                                               | shadow baseline cache; on by default, opt-out (`0`/`false`); the shadow's post-baseline state is saved under a managed snapshot key and restored into the next run's fresh stack database (see Notes)                                                                                            | no        |
| `SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED`                                               | overrides `[experimental.pgdelta].enabled` (default true; `false` selects migra); a value that is not a boolean fails the command                                                                                                                                                                | no        |
| `PGDELTA_DEBUG`                                                                       | pg-delta debug capture                                                                                                                                                                                                                                                                           | no        |
| `SUPABASE_SSL_DEBUG`                                                                  | migra SSL debug logging                                                                                                                                                                                                                                                                          | no        |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                                    | overrides the differ's / shadow's image registry (shell **or** project `.env`, passed to each image operation)                                                                                                                                                                                   | no        |

`SUPABASE_DB_SHADOW_PORT`/`SUPABASE_NETWORK_ID`/`--network-id`/`SUPABASE_PROJECT_ID`/
`SUPABASE_DB_HEALTH_TIMEOUT` all apply to `--use-pgadmin` too — its shadow is provisioned
through the same primitives.

`SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED` has no effect on the pgadmin path: `--use-pgadmin`
always selects the pgadmin engine. The historical `SUPABASE_EXPERIMENTAL_PG_DELTA` opt-in is
**not read**: pg-delta is the default engine, and an explicit `enabled = false` rollback is
authoritative.

`SUPABASE_INTERNAL_IMAGE_REGISTRY` applies to the differ's own image resolution too. The
docker-run layer receives the loaded project environment on each invocation. A registry
override set only in `supabase/.env`/project-root dotenv (not the ambient shell) remains
visible without mutating the process environment.

Explicitly **not** read by `--use-pgadmin`: `PGDELTA_*`, `SUPABASE_SSL_DEBUG` (both
migra/pg-delta-engine-specific).

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success; empty diff ("No schema changes found")                                                                                                                                                                                                                                                                                                             |
| `1`  | `--from` without `--to`; `--remote` combined with `--from`/`--to`; `--project-ref` with no `remote` side or naming a URL; conflicting selector flags; engine-flag mutex; unknown explicit target; connection/shadow/engine failure; file IO error; local db not running (`--use-pgadmin`); differ container non-zero exit; unparseable `--json-diff` output |
| `1`  | a `--from`/`--to` branch naming no branch of the parent project                                                                                                                                                                                                                                                                                             |
| `1`  | `--use-pg-schema` passed at all (any value, including `=false`) — removed, see Notes                                                                                                                                                                                                                                                                        |

## Output

### `--output-format text`

Progress to stderr (alias deprecation warnings, then the `Target:` line, printed
once per distinct target — then `Creating shadow database...`, `Diffing schemas[: <list>]`,
`Finished supabase db diff on branch <branch>.`, drop-statement warning, and the
`--file` write warning). A configured `[db.migrations].schema_paths` also warns
that it no longer changes the migrations baseline. The SQL diff prints to stdout
when neither `--file` nor explicit `--output` is set.

Explicit `--from`/`--to` announces every database endpoint in resolution order, `--from` first: a
URL endpoint as `Target: custom Postgres (<host>:<port>)`, never with its credentials; `local` as
`Target: local stack (<host>:<port>)`, with an IPv6 host in brackets; and a hosted endpoint as its
project or branch line. `migrations` announces nothing, and the same target on both sides prints
one line.

Explicit `--from`/`--to` mode returns before normal `--file` handling, so `-f` is
ignored. It joins the pg-delta plan files with blank lines and writes that same
flattened review representation to stdout or `--output`. File header comments
and preambles remain, but runner-enforced transaction boundaries do not:
transactional units can begin with `SET LOCAL check_function_bodies = off`,
which has no effect under plain `psql -f` without a surrounding transaction.
A plan may also mix transactional and non-transactional units, so wrapping the
whole flattened representation in one transaction is not generally safe. To
create applicable migrations, use normal target mode with `--file`; it persists
the ordered plan units separately for application through `db reset` or `db push`.

### `--output-format json` / `stream-json`

Progress strings still go to stderr; stdout carries a single structured envelope
`{ diff, file, files, schemas, engine, dropStatements, advisories? }` instead of
the raw SQL. Bundled pg-delta reports the best-effort
`DeclarativeSchemaNotUsedAsDiffBaseline` advisory when declarative files exist and
the diff passes a non-empty `--file` or targets the local database. Only `--file` runs
also print a stderr note: the `-f` baseline note for a written migration, or a note that
the files are not read when the diff is empty. Both end with next steps:
`supabase db schema declarative sync` (with `--experimental` when config disables pg-delta)
and, when migra would read that directory (local target, no `schema_paths`, and pg-delta
enabled in config or the directory is `supabase/schemas`; never on the stack backend),
`--use-migra`.

In explicit `--from`/`--to` mode, the `diff` field is the same flattened review
representation as text stdout; the machine envelope does not restore the per-unit
transaction metadata. The envelope's `target` is the first endpoint announced:
`{"kind":"local","host":"127.0.0.1","port":54322}` for `local`,
`{"kind":"db-url","host":"db.example.com","port":6543}` for a URL, or the linked identity for a
hosted endpoint. `--from migrations` announces nothing, so `--to`'s endpoint supplies it when it
announces one.

### `--use-pgadmin` (CLI-1968)

- **Status lines go to STDOUT in text mode, not stderr** — unlike the migra/pg-delta path's
  stderr diagnostics. So `db diff --use-pgadmin > out.sql` captures them. In `json`/`stream-json`
  mode these are diagnostics, not payload, so they redirect to STDERR instead — see below.
- **Progress batching**: progress is batched instead of streamed live —
  `DockerRun.runStream` only exposes an `onStdout` hook (no `onStderr` equivalent), so
  each run's stderr is buffered via `runCapture` and its status lines are filtered/emitted only once
  that run's container has already exited — one status BATCH per `--schema` run, not a
  continuous stream. That batch is processed and emitted before the exit-code
  check, so a run that goes on to exit non-zero still has its own captured statuses printed
  first, not dropped. See `pgadmin-diff.ts`'s own doc comment on `diffSchemaPgAdmin`
  for the full rationale and the possible follow-up (adding an `onStderr` hook to `runStream`).
- Order: `Creating shadow database...` → shadow setup diagnostics (stderr, shared
  with the migra/pg-delta path) → `Diffing local database with current migrations...`
  → per-schema `Diffing schema: <s>` + filtered progress statuses → the SQL /
  `No schema changes found` / the `--file` write warning.
- **No** `Finished supabase db diff on branch <x>.` line and **no** drop-statement
  warning — the pgadmin path skips both.
- `json`/`stream-json`: status lines redirect to STDERR instead of STDOUT (stdout stays
  payload-only, CLI-1546); envelope
  `{ diff, file, files, schemas, engine: "pgadmin", dropStatements: [] }` —
  `dropStatements` is always empty — this engine never performs a drop scan.

## Notes / Delegation

- **Config value precedence** (ADR 0032): explicit flag > shell env > project `.env*` > config
  (`config.json` over `config.toml`) > default. The whole config is decoded where it is loaded, so
  an invalid value fails the command; explicit `--from`/`--to` loads it lazily (see below). A remote
  project or branch also applies a matching `[remotes.*]` block. The linked-database password env is
  withheld when the target differs from `.temp/project-ref`, with a
  `Not sending SUPABASE_DB_PASSWORD to <target>: ...` warning and a temporary login role instead.
- **pg-delta selection**: `--use-pg-delta` sets `[experimental.pgdelta].enabled` at the flag tier,
  so `--use-pg-delta=false` selects migra over env and config. The default is pg-delta when the
  stack backend is active or `[experimental.pgdelta].enabled` resolves true. An explicit
  `--use-migra` or `--use-pgadmin` (a true value) always wins; `--use-migra=false` keeps pg-delta; the stack backend always uses pg-delta.
- `--use-migra`, `--use-pgadmin`, `--use-pg-delta` are a mutually-exclusive engine group
  (pg-delta is the default unless `[experimental.pgdelta] enabled = false`). `--use-pg-schema`
  is removed and rejects before this group is even checked (see Notes below), so it is never a
  live member of the group.
- `--remote=<ref>` supplies only the ref; unlike `SUPABASE_PROJECT_ID`, it does not affect the
  shadow container's project id/labels.
- **Explicit `--from`/`--to`.** Each endpoint is one of `local`, `migrations`, `remote` (the
  linked project), a project ref, a Postgres URL, or a branch name or UUID of the linked project
  (classified like a `--remote` value, so a branch named like a keyword is reached by its ref or
  UUID). A value `--remote` rejects fails and is never echoed: a keyword connection string
  (`host=… password=…`) with `--from takes local, migrations, remote, a project ref, a branch name or
a postgresql:// URL; convert a connection string to a postgresql:// URL and pass --from=<url>.`, and
  a non-postgres URL with the same first sentence (naming `--from=<ref>` for a project's own
  `https://<ref>.supabase.co` URL); `--to` likewise. In `--from`/`--to`, `remote` is the linked
  project, or the one `--project-ref` names. `--from linked` / `--to linked` still work and warn
  `--from linked is deprecated and will be removed in v4. Use --from=remote instead` (and
  `--to=remote` for `--to`). A `--remote` selector given alongside fails with
  `--remote doesn't apply with --from/--to; use --from=remote or --to=remote.` before any target
  resolves, and the default `Target:` hint is not printed. The linked project resolves once, so
  `--from remote --to remote` announces it once, and a branch or ref used on both sides shares
  one connection. A branch endpoint looks the name up in the branch list of
  `SUPABASE_PROJECT_ID`, else the linked project. `--use-pgadmin` honors the same selection
  (CLI-1968 — same target resolve);
  `--use-pg-schema` is removed and rejects before any target resolution happens (see Notes
  below).
- **Explicit `--from`/`--to` with a deprecated selector flag.** `--local`, `--linked`, `--db-url`
  and `--project-ref` are accepted. Each warns on stderr before any target resolves, names the
  value that replaces it, and never repeats a URL:
  - `--local`: `--local isn't needed (local is the default) and will be removed in v4`.
  - `--linked`: `--linked is deprecated and will be removed in v4. Use --from=remote or --to=remote instead`.
  - `--db-url`: `--db-url is deprecated and will be removed in v4. Use --from=<url> or --to=<url> instead`.
  - `--project-ref=<ref|branch>`: `--project-ref is deprecated and will be removed in v4. Use --from=<ref> or --to=<ref> instead`
    (`<branch>` for a branch name). With `--linked` the two share one warning:
    `--linked and --project-ref are deprecated and will be removed in v4. Use --from=<ref> or --to=<ref> instead`.

  `--local`, `--linked` and `--db-url` change nothing. `--project-ref` resolves every `remote` (or
  deprecated `linked`) side to the project it names, read like a `--from` value, so the `Target:`
  lines and the JSON `target` show that project. With no `remote` side it fails with
  `--project-ref only applies when --from or --to is remote; to diff another project, use --from=<ref> or --to=<ref>.`
  and a URL value fails with `--project-ref takes a project ref or a branch name, not a URL.`
  Selector flags that conflict (`--linked` with `--local`, `--project-ref` with `--db-url`), an
  empty `--project-ref` or `--db-url`, and a URL in `--project-ref` keep their usual messages; each
  suggestion names `--from`/`--to` instead of `--remote`, which this mode rejects.

- **Explicit `--from`/`--to` with a project whose database is unreachable over IPv6.** A project
  or branch endpoint falls back to the pooler URL the API returns. With none, the run fails with
  `IPv6 is not supported on your current network`. The suggestion for the linked project is
  `Run supabase link --project-ref <ref> to setup IPv4 connection.`; for any other project or
  branch it is `Pass the project's connection pooler URL as --from=<url> or --to=<url> to connect over IPv4.`

- **Explicit `--from`/`--to` config and URLs.** The config is read when the first endpoint that
  needs it resolves, not before. A hosted endpoint resolved first merges its `[remotes.<ref>]`
  block into that read, before validation and before its temporary login role is minted, so
  `--from=remote --to=migrations` honours a remote override (a `major_version` that only
  `[remotes.<ref>]` sets, for example) and a config error surfaces before that side effect. A
  `local` or `migrations` endpoint resolved first reads the base config, and the first hosted
  endpoint after it merges its block into the config the later endpoints and the diff itself see.
  A malformed URL endpoint fails as soon as it is parsed (`PgDeltaEngineError`, the URL is never
  echoed), before a later hosted endpoint mints its temporary login role.
- Explicit `--from`/`--to` mode always uses pg-delta and writes the flattened review
  representation to `--output` (or stdout). It ignores `--file`; normal mode retains
  per-unit migration files for the CLI apply paths.
- Normal mode always compares the migrations shadow to the selected live database;
  declarative files and `schema_paths` do not replace that baseline.

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
runs migrations before those defaults take effect. `--use-pgadmin` is NOT cached — its shadow keeps
the plain create/remove lifecycle.

### `--use-pgadmin` behaviour

- `source`/`target` are INVERTED relative to the migra/pg-delta path: `source` is the
  USER'S db, `target` is the SHADOW.
- The shadow `target` URL is a hardcoded template string
  (`postgresql://postgres:postgres@127.0.0.1:<port>/postgres`), not built via
  `toPostgresURL`, so it ignores `SUPABASE_SERVICES_HOSTNAME`/`[db] password`.
- `AssertSupabaseDbIsRunning` runs for a remote target too, and AFTER config load +
  target resolution — every other engine on this command never runs this check at all.
- The `NOTE: …DESKTOP mode.` prefix (`supabase/pgadmin4#24`) is trimmed from the front of
  EACH run's own stdout independently (each run is parsed on its own — see "Output parsing"
  below), not just the front of a single, first run's buffer.
- The differ's stderr is filtered by the progress-line regex and non-matching lines are
  dropped, so a differ failure surfaces only `error running container: exit <n>` — even
  under `--debug`.
- `(.*)([0-9]{2,3})%` greedy-submatch quirk (e.g. `Diffing 100%` → status `Diffing 1`,
  progress silently dropped).
- Internal-schema filtering is exact string membership, not glob expansion — a
  `group_name`/`source_schema_name` of literal `pg_catalog` is KEPT, since only the
  literal string `"pg_*"` (not a real glob) is in the list.
- JSON-parse failures are reported with the stable prefix `failed to parse schema diff output:`
  rather than the raw parser error text.

**Output parsing:** every run's own stdout is genuinely parsed
(`parsePgAdminDiffEntries`, trimming that run's own DESKTOP-mode NOTE prefix off its own
buffer), and every run's filtered DDLs are aggregated into one final diff before the header is
rendered once (`renderPgAdminDiff`). A multi-`--schema` diff where every run's own
`--json-diff` output is independently well-formed succeeds. A genuinely malformed run (or a
concatenation WITHIN a single run's own buffer — see `processPgAdminDiffOutput`'s own doc
comment, still exercised by this file's unit tests) still fails with `invalid_output`.

**Network reachability:** with the differ container on the project's default Docker network
(the compose bridge `supabase_network_<projectId>`), `127.0.0.1` inside it resolves to the
differ's OWN loopback — so both the hardcoded shadow `target` and a local `source`
(`GetHostname()` → `127.0.0.1`) are unreachable from inside the differ container. `--network-id
host` alone does NOT rescue the golden path either (see `diff.live.test.ts`): the network
override applies to every container the command starts, including the shadow, whose
`54320→5432` port publication is discarded under host networking — so the hardcoded `target`
at `127.0.0.1:<shadow_port>` stays unreachable while only the host-published `source` becomes
reachable. Reaching both databases requires `--network-id host` **plus** a `[db] shadow_port =
5432` config override — a contrived setup no default user runs. Once both are reachable, this
port reports the real diff.

### `--use-pg-schema` is removed

The flag is removed: passing it (with any value, including `--use-pg-schema=false`)
fails with a removal error and a suggestion to use the default pg-delta engine or
`--use-migra` instead. It is checked before any other engine-conflict or
target resolution, so combining it with another engine flag (e.g. `--use-pgadmin`)
still hits the removal error first, not the mutex error.

The flag definition itself stays in `diff.command.ts` (hidden from `--help`) only
so misuse produces this actionable error instead of an unknown-flag parse error.
