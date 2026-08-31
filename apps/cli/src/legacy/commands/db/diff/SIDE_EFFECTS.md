# `supabase db diff`

Native Effect port. Diffs the local project's expected schema (a throwaway shadow
database) against a target database (local / linked / `--db-url`), using one of
three native engines: bundled in-process pg-delta, migra (edge-runtime), or
pgAdmin (CLI-1968 — a native `docker run` of the differ container, no
edge-runtime involved). `--use-pg-schema` is the CLI's sole remaining Go
delegation on this command — a documented keep-in-Go exception (CLI-1960), not a
pending port.

Set `SUPABASE_USE_PG_DELTA_NEXT=false` to use the legacy edge-runtime pg-delta
implementation and its runtime package/catalog cache. The bundled engine has no
automatic fallback; coverage gaps warn, while `--strict-coverage` makes them fatal,
and `PGDELTA_DEBUG` writes diagnostic JSON under
`supabase/.temp/pgdelta/v2/debug/<id>/`. Its SQL and transaction-aware file
splits may differ from legacy output; applicable, convergent SQL is the contract.
The bundled formatter defaults to lowercase SQL at width 180; config overrides
it, and JSON `null` disables formatting without disabling safe compaction.

## Files Read

| Path                                                                                                      | Format     | When                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                          | TOML       | always (db port/password, `[experimental.pgdelta]`, deno_version)                                                                                                                                                                                                                                                           |
| `<workdir>/supabase/.env`, `.env.local`, project-root/`SUPABASE_ENV`-selected dotenv file                 | dotenv     | shadow provisioning (all native targets, and the explicit `--from/--to migrations` cache miss)                                                                                                                                                                                                                              |
| `api.tls.cert_path` / `api.tls.key_path` (under `<workdir>/supabase/`)                                    | PEM        | shadow provisioning, when `api.enabled && api.tls.enabled`                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/migrations/*.sql`                                                                     | SQL        | shadow provisioning (applied to the shadow source) — `--use-pgadmin` too, via the SAME `legacyMigrateShadowDatabase`                                                                                                                                                                                                        |
| `<workdir>/supabase/roles.sql`                                                                            | SQL        | shadow provisioning, PG14 and PG15 alike (unlike `db reset`'s PG15-only local path); also hashed into the shadow-baseline cache key on every cache-eligible acquire, warm hits included (where no baseline is applied at all); missing file tolerated                                                                       |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`                                             | tar        | warm shadow-cache hit — the matching snapshot is streamed into the fresh shadow; every cache-eligible acquire (warm hit and successful cold export) also enumerates and `stat`s every `shadow-baseline-*.tar` for LRU keep-3 + 2-day mtime TTL and may delete other keys (`SUPABASE_HOME` overrides the `~/.supabase` root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial`                               | tar        | abandoned-partial sweep on every cache-eligible acquire (warm hit and cold export) — enumerated and `stat`ed, and removed when older than 5 minutes (a crashed/SIGKILLed earlier export's leftover)                                                                                                                         |
| `[db.migrations].schema_paths` globs / `<workdir>/supabase/database/**` / `<workdir>/supabase/schemas/**` | SQL        | legacy engines only, for the local-target declarative-schema fallback; pg-delta next always compares the migrations baseline directly to the live target                                                                                                                                                                    |
| `~/.supabase/access-token`                                                                                | plain text | `--linked` / `--db-url` with no `SUPABASE_ACCESS_TOKEN`                                                                                                                                                                                                                                                                     |
| `<workdir>/supabase/.temp/project-ref`                                                                    | plain text | `--linked` ref resolution — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                                                                                                                                                                                                                                  |
| `<workdir>/supabase/.temp/{pgdelta-version,edge-runtime-version}`                                         | plain text | legacy pg-delta opt-out only                                                                                                                                                                                                                                                                                                |
| `<workdir>/supabase/.temp/pgdelta/*.json`                                                                 | JSON       | legacy opt-out's explicit `--from/--to migrations` catalog cache                                                                                                                                                                                                                                                            |

## Files Written

| Path                                                                        | Format | When                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`                 | SQL    | non-empty `--file` diff; bundled pg-delta may emit ordered transaction-aware files, while pgAdmin always emits one                                                                                                                                                                                                                                                   |
| `<path>` (from `--output` / `-o`)                                           | SQL    | explicit `--from/--to` mode with `--output`; flattened review representation, not a portable apply script                                                                                                                                                                                                                                                            |
| `<workdir>/supabase/.temp/pgdelta/*.json`                                   | JSON   | legacy opt-out's explicit migrations catalog                                                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/.temp/pgdelta/pgdelta-target-ca.crt`                    | PEM    | legacy opt-out, for a Supabase TLS target                                                                                                                                                                                                                                                                                                                            |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                     | JSON   | bundled engine with `PGDELTA_DEBUG`                                                                                                                                                                                                                                                                                                                                  |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar    | cache-enabled COLD shadow provision creates the current key's snapshot (native diff targets + the explicit `--from/--to migrations` catalog miss; never `--use-pgadmin`/`--use-pg-schema`); a warm hit `touch`es its mtime (LRU); every cache-eligible acquire may delete other keys under LRU keep-3 + 2-day mtime TTL — ~90MB (`SUPABASE_HOME` overrides the root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar    | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports / warm hits sweep leftovers older than 5 minutes                                                                                                                                       |
| `~/.supabase/<workdir-hash>/linked-project.json`                            | JSON   | `--linked` (post-run cache)                                                                                                                                                                                                                                                                                                                                          |
| `~/.supabase/telemetry.json`                                                | JSON   | every invocation (post-run)                                                                                                                                                                                                                                                                                                                                          |

## Docker

- Edge-runtime container (migra, or pg-delta under the legacy opt-out; also runs the legacy
  declarative apply script and the pg-delta
  catalog-export script for explicit `--from/--to migrations` on a cache miss —
  CLI-1959, native, no longer the hidden Go `__catalog` seam).
- Shadow Postgres container — provisioned and torn down natively (`legacyPrepareShadowSource`
  in `legacy/commands/db/shared/legacy-shadow-source.ts`, over the lower-level primitives in
  `legacy/shared/db-bootstrap/shadow-database.ts`), no longer via a Go seam. Explicit
  `--from/--to migrations` reuses the SAME native primitives on a cache miss
  (`legacyResolveMigrationsCatalogRef` -> `exportViaShadowCatalog`, `legacy-pgdelta.cache.ts`),
  called with `targetLocal: false`/`usePgDelta: false` to skip the declarative-schema-override
  branch — not a second, `__catalog`-specific shadow, and not a shared `mode: "diff"` parameter
  (that seam-era concept no longer exists). `--use-pgadmin` provisions its OWN shadow via a
  narrower composition — `legacyCreateShadowDatabase` -> health-wait -> `legacyMigrateShadowDatabase`
  directly (`diff.handler.ts`'s pgadmin branch) — with no declarative-schema-override branch and
  no `targetUrlOverride`.
- `supabase/migra` container — the migra OOM bash fallback only.
- **Differ container** (`--use-pgadmin`, CLI-1968) — `supabase/pgadmin-schema-diff:cli-0.0.5`
  (`dockerfileServiceImage("differ")`). One `docker run --rm` when no `--schema` is given; one
  run per `--schema` value, in flag order. Runs on the project's Docker network (`--network-id`
  or the generated `supabase_network_<projectId>` — never the host network, unlike the migra
  bash fallback), with `--add-host host.docker.internal:host-gateway` on Linux only, and both
  `com.supabase.cli.project`/`com.docker.compose.project` labels — no env vars, bind mounts, or
  working-directory override.

## API Routes (linked path, via the db-config resolver)

| Method     | Path                               | Auth   | Purpose                          |
| ---------- | ---------------------------------- | ------ | -------------------------------- |
| POST       | `/v1/projects/{ref}/roles`         | Bearer | Temp login role when no password |
| GET        | `/v1/projects/{ref}/pooler/config` | Bearer | IPv4 pooler fallback             |
| GET/DELETE | `/v1/projects/{ref}/network-bans`  | Bearer | Unban during pooler login retry  |
| GET        | `/v1/projects/{ref}`               | Bearer | Linked-project cache (post-run)  |

`--use-pgadmin --linked` performs every one of these calls natively (CLI-1968), as part
of this command's own target resolve, ahead of the differ container.

## Environment Variables

| Variable                                                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Required? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `SUPABASE_ACCESS_TOKEN`                                                               | auth for `--linked`                                                                                                                                                                                                                                                                                                                                                                                                                                          | no        |
| `SUPABASE_DB_PASSWORD`                                                                | remote DB password (linked)                                                                                                                                                                                                                                                                                                                                                                                                                                  | no        |
| `SUPABASE_DB_SHADOW_PORT`                                                             | shadow container's host port (`db.shadow_port`) — NOT `SUPABASE_DB_PORT`, which the shadow never reads                                                                                                                                                                                                                                                                                                                                                       | no        |
| `SUPABASE_DB_MAJOR_VERSION` / `SUPABASE_DB_HEALTH_TIMEOUT` / `SUPABASE_DB_SETTINGS_*` | shadow container-config overrides, same as `db start`/`db reset`                                                                                                                                                                                                                                                                                                                                                                                             | no        |
| `SUPABASE_PROJECT_ID`                                                                 | overrides the shadow container's project id/labels, same as `db start`/`db reset` (`utils.DbId`); ALSO the linked-ref resolution fallback `--project-ref` supersedes — see Notes for the narrower scope of the flag                                                                                                                                                                                                                                          | no        |
| `SUPABASE_NETWORK_ID` (`--network-id`)                                                | forces the shadow container/network onto an existing Docker network                                                                                                                                                                                                                                                                                                                                                                                          | no        |
| `SUPABASE_HOME`                                                                       | overrides the `~/.supabase` root used for the shadow baseline cache (and other CLI state)                                                                                                                                                                                                                                                                                                                                                                    | no        |
| `SUPABASE_SHADOW_CACHE`                                                               | shadow baseline cache; opt-in (`1`/`true`); the shadow's post-baseline PGDATA is snapshotted to a tar and restored into the next run's fresh container (see Notes)                                                                                                                                                                                                                                                                                           | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`                                                      | force pg-delta engine                                                                                                                                                                                                                                                                                                                                                                                                                                        | no        |
| `PGDELTA_DEBUG`                                                                       | pg-delta debug capture                                                                                                                                                                                                                                                                                                                                                                                                                                       | no        |
| `SUPABASE_USE_PG_DELTA_NEXT`                                                          | set to `false` for legacy edge-runtime pg-delta                                                                                                                                                                                                                                                                                                                                                                                                              | no        |
| `PGDELTA_NPM_REGISTRY`                                                                | legacy opt-out's scoped npm registry                                                                                                                                                                                                                                                                                                                                                                                                                         | no        |
| `SUPABASE_SSL_DEBUG`                                                                  | migra SSL debug logging                                                                                                                                                                                                                                                                                                                                                                                                                                      | no        |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`                                                    | overrides the differ's / shadow's image registry (shell **or** project `.env`, applied for the run via `legacyApplyProjectEnv`, matching `db push`/`db pull`/`db dump`)                                                                                                                                                                                                                                                                                      | no        |
| `SUPABASE_USE_SLIM_IMAGES`                                                            | resolves the current-pin shadow Postgres image, PG15+ realtime/storage/auth migrate-job images (cold shadow), and (for migra / legacy pg-delta) the edge-runtime image from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; the differ image, historical pins, PG14, OrioleDB, flag-off `15.8.1.085`, `deno_version = 1`, and historical `.temp/edge-runtime-version` pins stay on docker.io | no        |

`SUPABASE_DB_SHADOW_PORT`/`SUPABASE_NETWORK_ID`/`--network-id`/`SUPABASE_PROJECT_ID`/
`SUPABASE_DB_HEALTH_TIMEOUT` all apply to `--use-pgadmin` too — its shadow is provisioned
through the same primitives.

`SUPABASE_EXPERIMENTAL_PG_DELTA` is **read, no effect** on the pgadmin path: the pg-delta
engine-selection lookup (`legacyShouldUsePgDelta`) runs unconditionally, before the
`--use-pgadmin` branch, but the pgadmin branch is chosen first and never consults the
resulting `useDelta` value.

`SUPABASE_INTERNAL_IMAGE_REGISTRY` applies to the differ's own image resolution too. The
docker-run layer's resolver (`legacy-docker-run.layer.ts`) is built once, statically, with
no `projectEnvValues` in scope, so it falls back to reading `process.env` directly at
`runCapture` call time — the handler's own `legacyApplyProjectEnv(cfg.projectEnv)` call
(right after the config load) is what makes a registry override set only in
`supabase/.env`/project-root dotenv (not the ambient shell) visible to it by then.

Explicitly **not** read by `--use-pgadmin`: `PGDELTA_*`, `SUPABASE_SSL_DEBUG` (both
migra/pg-delta-engine-specific).

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success; empty diff ("No schema changes found")                                                                                                                                                                                              |
| `1`  | `--from` without `--to`; engine-flag mutex; target mutex; unknown explicit target; connection/shadow/engine failure; file IO error; local db not running (`--use-pgadmin`); differ container non-zero exit; unparseable `--json-diff` output |
| `1`  | `--project-ref` set with a resolved target other than linked; (in explicit mode) `--project-ref` with `--linked` unchanged and neither `--from` nor `--to` being `linked`; `--project-ref` combined with `--use-pg-schema` (see Notes)       |

## Output

### `--output-format text`

Progress to stderr (`Creating shadow database...`, `Diffing schemas[: <list>]`,
`Finished supabase db diff on branch <branch>.`, drop-statement warning, and the
`--file` write warning). A configured `[db.migrations].schema_paths` also warns
that it no longer changes the migrations baseline. The SQL diff prints to stdout
when neither `--file` nor explicit `--output` is set.

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
`DeclarativeSchemaNotUsedAsDiffBaseline` advisory for a non-empty `--file` diff
when declarative files exist.

In explicit `--from`/`--to` mode, the `diff` field is the same flattened review
representation as text stdout; the machine envelope does not restore the per-unit
transaction metadata.

### `--use-pgadmin` (CLI-1968)

- **Status lines go to STDOUT in text mode, not stderr** — unlike the migra/pg-delta path's
  stderr diagnostics. So `db diff --use-pgadmin > out.sql` captures them. In `json`/`stream-json`
  mode these are diagnostics, not payload, so they redirect to STDERR instead — see below.
- **Progress-streaming UX delta**: this port batches progress instead of streaming it live —
  `LegacyDockerRun.runStream` only exposes an `onStdout` hook (no `onStderr` equivalent), so this
  port buffers each run's stderr via `runCapture` and only filters/emits its status lines once
  that run's container has already exited — one status BATCH per `--schema` run, not a
  continuous stream. That batch is processed and emitted before this port's own exit-code
  check, so a run that goes on to exit non-zero still has its own captured statuses printed
  first, not dropped. See `legacy-pgadmin-diff.ts`'s own doc comment on `legacyDiffSchemaPgAdmin`
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

- `--use-migra` (default), `--use-pgadmin`, `--use-pg-schema`, `--use-pg-delta` are a
  mutually-exclusive engine group; `--db-url` / `--linked` / `--local` are a
  mutually-exclusive target group (default `--local`).
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing `db`
  command) overrides ONLY the linked-ref resolution `LegacyProjectRefResolver`
  performs (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`) — unlike
  `SUPABASE_PROJECT_ID`, it does not affect the shadow container's project
  id/labels. It never implies `--linked`: passing it with a resolved
  `--local`/`--db-url` target (native mode) is a hard error, as is a plain
  `--project-ref` with no `--from`/`--to` (defaults to `--local`). Two
  exceptions apply in explicit mode: `--from linked` / `--to linked` resolves a
  linked ref without any target flag at all, so the guard does not fire there;
  and a changed `--linked` (even `--linked=false`) genuinely consumes
  `--project-ref` via the preflight, so the guard does not fire whenever
  `--linked` was explicitly set either. It still fires for e.g. `--from local
--to migrations --project-ref X` (explicit mode, `--linked` unchanged, and
  neither side `linked`), where the flag would otherwise go silently unused
  (deliberately stricter than `SUPABASE_PROJECT_ID`, which Go's equivalent env
  var simply leaves unused on a non-linked target). `--use-pgadmin --linked`
  honors the flag like every other native engine (CLI-1968 — same target
  resolve); `--use-pg-schema` rejects it up front, since the delegated Go child
  never registered `--project-ref` and the flag would otherwise be silently
  dropped.
- `--use-pg-schema` rebuilds the argv and exec's the bundled Go binary (its side
  effects are Go's); the Go child's telemetry is disabled so the single
  `cli_command_executed` event comes from this TS command.
- Explicit `--from`/`--to` mode always uses pg-delta and writes the flattened review
  representation to `--output` (or stdout). It ignores `--file`; normal mode retains
  per-unit migration files for the CLI apply paths.
- Normal mode always compares the migrations shadow to the selected live database;
  declarative files and `schema_paths` do not replace that baseline.
- Under the legacy opt-out, the explicit `migrations` target resolves natively (CLI-1959): a bare
  migrations-content hash cache lookup (`<workdir>/supabase/.temp/pgdelta/catalog-local-migrations-<hash>-<ts>.json`,
  shared with `db push`'s post-apply cache write), and on a miss, a natively-provisioned
  shadow database (CLI-1956 — `legacyCreateShadowDatabase`/`legacyPrepareShadowSource`,
  no longer the `db __shadow` seam) plus a native pg-delta catalog export. No hidden Go
  `db schema declarative __catalog` subprocess runs for this path any more.

### Shadow baseline cache (`SUPABASE_SHADOW_CACHE`, default OFF)

Off unless `SUPABASE_SHADOW_CACHE` is set; `false`/`0` keep it off (honored from the ambient env AND the
project's dotenv, e.g. `supabase/.env`), restoring the documented uncached lifecycle. A warm hit
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

### `--use-pgadmin` parity quirks and deliberate divergence (CLI-1968)

- `source`/`target` are INVERTED relative to the migra/pg-delta path: `source` is the
  USER'S db, `target` is the SHADOW.
- The shadow `target` URL is a hardcoded template string
  (`postgresql://postgres:postgres@127.0.0.1:<port>/postgres`), not built via
  `legacyToPostgresURL`, so it ignores `SUPABASE_SERVICES_HOSTNAME`/`[db] password`.
- `AssertSupabaseDbIsRunning` runs for `--linked`/`--db-url` too, and AFTER config load +
  target resolution — every other engine on this command never runs this check at all.
- The `NOTE: …DESKTOP mode.` prefix (`supabase/pgadmin4#24`) is trimmed from the front of
  EACH run's own stdout independently (each run is parsed on its own — see the "Deliberate
  divergence" entry below), not just the front of a single, first run's buffer.
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

**Deliberate divergence:** every run's own stdout is genuinely parsed
(`legacyParsePgAdminDiffEntries`, trimming that run's own DESKTOP-mode NOTE prefix off its own
buffer), and every run's filtered DDLs are aggregated into one final diff before the header is
rendered once (`legacyRenderPgAdminDiff`). A multi-`--schema` diff where every run's own
`--json-diff` output is independently well-formed succeeds. A genuinely malformed run (or a
concatenation WITHIN a single run's own buffer — see `legacyProcessPgAdminDiffOutput`'s own doc
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

### `--use-pg-schema` is deprecated (CLI-1960) — keep-in-Go exception

`--use-pg-schema` wraps the in-process Go library `stripe/pg-schema-diff`
(`apps/cli-go/internal/db/diff/pgschema.go`). It is a keep-in-Go exception rather
than a pending port because:

- it runs **in-process** inside the Go binary, with no container/binary boundary
  to re-invoke from TS — unlike `--use-pgadmin` (now native, CLI-1968), which shelled
  out to a container/binary path that could in principle be called from TS;
- no TS binding and no WASM build of the library exists, or is reasonably
  buildable, within the M9 "Final Cleanup — Go Removal" milestone's scope;
- this specific exception (`db diff --use-pg-schema`) was pre-named when the M9
  milestone was scoped.

The decision record is Linear issue CLI-1960 and the pull request that introduced
this deprecation notice; re-open only if a TS/WASM binding for
`stripe/pg-schema-diff` ships. It **is** the CLI's sole remaining Go delegation on
`db diff` now that `--use-pgadmin`'s delegation is gone (CLI-1968) — the sibling
`db __db-bootstrap` seam was already removed outright by CLI-1955, and the
`db __shadow` seam by CLI-1956.

Given that, the flag is now deprecated rather than ported:

- A TS-only stderr deprecation warning is printed immediately before delegating
  (both text and machine `--output-format` modes — diagnostics stay stderr-only,
  the CLI-1546 rule): `"--use-pg-schema" is deprecated. Use the pg-delta engine ([experimental.pgdelta] enabled = true / --use-pg-delta) or the default migra engine instead.`
  The warning text intentionally does not promise a removal timeline.
- This is **additive** to (printed before) Go's own pre-existing "experimental"
  warning (`cmd/db.go:121`, unchanged): `--use-pg-schema flag is experimental and may not include all entities, such as views and grants.` The delegated child
  still prints its own warning; the TS wrapper does not suppress or replace it.
- `--help` for the flag now also carries a `Deprecated: …` suffix pointing at the
  same migration path.
- Actual flag removal and any PostHog usage-telemetry gate for that removal are
  explicitly out of scope for CLI-1960 — this is a documentation/deprecation-notice
  change only, tracked as a follow-up decision outside this milestone, with no
  owning issue yet.
