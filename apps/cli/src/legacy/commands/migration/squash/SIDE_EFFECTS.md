# `supabase migration squash`

Native Effect port (CLI-1969). Squashes every local migration up to (optionally)
`--version` into the last one — diffing a natively-provisioned shadow database's
`auth`/`storage` schemas before and after applying every migration, dumping the
full schema into the target file, and deleting the merged files — then either
suggests `migration repair` (local target) or prompts to baseline the remote
migration-history table to match.

## Files Read

| Path                                                                    | Format     | When                                                                                                                                |
| ----------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                        | TOML       | always, twice: `@supabase/config` for the shadow's own spec, `legacyReadDbToml` for shadow port/password/vault/baseline             |
| `<workdir>/supabase/migrations/`                                        | directory  | always                                                                                                                              |
| `<workdir>/supabase/migrations/<version>_*.sql`                         | SQL        | each migration up to the target, applied to the shadow; the target file's own final content is read by `--version`/baseline lookups |
| `<workdir>/supabase/roles.sql`                                          | SQL        | shadow `SetupDatabase` (custom-roles seed); missing file tolerated                                                                  |
| `<workdir>/supabase/.env`, `.env.local`, `SUPABASE_ENV`-selected dotenv | dotenv     | always (`--yes`/registry/network-id overrides)                                                                                      |
| `<workdir>/supabase/.temp/{project-ref,postgres-version,pooler-url}`    | plain text | `--linked` / linked path — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                                           |
| `~/.supabase/access-token`                                              | plain text | `--linked` without `--password`/`SUPABASE_ACCESS_TOKEN`                                                                             |
| `~/.docker/config.json` + Docker context store                          | JSON       | resolving the Docker hostname for shadow/pg_dump containers                                                                         |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`           | tar        | warm shadow-cache hit — the matching snapshot is streamed into the fresh shadow (see the shadow baseline cache section below)       |

## Files Written

| Path                                                                        | Format   | When                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<target>.sql`                                | SQL text | ≥2 migrations squash — **truncated** (0644) then rewritten as the full dump + separator + `auth`/`storage` line diff                                                                                                                                        |
| `<workdir>/supabase/migrations/<earlier>.sql` (×N)                          | —        | **deleted** — every earlier merged migration; a per-file failure is non-fatal (printed, not raised)                                                                                                                                                         |
| scoped temp dir                                                             | SQL      | shadow's `initSchema`/`ApplyApiPrivileges` SQL (PG≤14) — removed when the scope closes                                                                                                                                                                      |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar`               | tar      | cache-enabled (default) COLD shadow provision creates the current key's snapshot; a warm hit `touch`es its mtime (LRU); every cache-eligible acquire may delete other keys under LRU keep-8 + 14-day mtime TTL — ~90MB (`SUPABASE_HOME` overrides the root) |
| `~/.supabase/cache/shadow-baseline/shadow-baseline-<key>.tar.<pid>.partial` | tar      | during a cold export — the in-flight temp file, `rename`d into the tar above on success and removed on failure; only a crash/SIGKILL leaves it behind, and later cold exports / warm hits sweep leftovers older than an hour                                |
| `<workdir>/supabase/.temp/linked-project.json`                              | JSON     | `--linked` (post-run cache, even when the command itself fails)                                                                                                                                                                                             |
| `~/.supabase/telemetry.json`                                                | JSON     | every invocation (post-run)                                                                                                                                                                                                                                 |

## Docker

- Network ensure (`legacyEnsureNetwork`, same as `db diff`/`db pull`).
- Shadow Postgres container: no `--name`, no network alias, `--publish <shadow_port>:5432`,
  `-c max_worker_processes=0`, `--rm`, PG≤14 tmpfs on `/docker-entrypoint-initdb.d` — created,
  started, readiness-polled, then removed (`rm -f -v`) once squash finishes, success or failure.
  Readiness is `legacyWaitForShadowReady`: each round a `container inspect` still-running check
  plus a direct Postgres connect probe — NOT the container's own Docker HEALTHCHECK, whose first
  probe only fires at t+10s.
- PG15+ one-shot realtime/storage/auth migrate jobs (`initSchema15`), dialed at the shadow
  container's own 12-char short id as `DB_HOST` (no name/alias needed — see
  `shared/db-bootstrap/shadow-database.ts`'s own header for why that host still resolves).
- **Three** one-shot `pg_dump` containers, each a fresh `docker run` on **host** networking
  (or the named `--network-id` network when set) — `["bash","-c", <dump_schema.sh>, "--"]`,
  `PGHOST=<hostname> PGPORT=<shadow_port> PGUSER=postgres PGPASSWORD=<db password> PGDATABASE=postgres`,
  the config Postgres image:
  1. before-migration `auth`/`storage` dump — `EXTRA_FLAGS=--schema=auth|storage`, `EXTRA_SED=/^--/d`
  2. after-migration `auth`/`storage` dump — identical env
  3. the final full dump (no schema filter) — `EXCLUDED_SCHEMAS=<InternalSchemas joined "|">`, `EXTRA_SED=/^--/d`, streamed straight into the truncated target file

  Unlike `db diff`/`db pull`, the shadow only ever gets `legacySetupDatabase` (platform
  baseline + roles.sql) — **no** `CREATE DATABASE contrib_regression` template database.

### Shadow baseline cache (`SUPABASE_SHADOW_CACHE`, default ON)

Squash acquires its shadow through the same `legacyWithShadowDatabase` seam as `db diff`/`db
pull` (`shared/db-bootstrap/shadow-cache.ts`), so everything documented in those commands'
`SIDE_EFFECTS.md` applies verbatim: ON by default, `SUPABASE_SHADOW_CACHE=false`/`=0` opts out
(honored from the ambient env AND the project's dotenv), the artifact is a ~90MB PGDATA snapshot
under `~/.supabase/cache/shadow-baseline/` keyed by a hash of every input baked into the cluster,
retention is LRU keep-8 + 14-day mtime TTL, a cold run drops `--rm` (still removed on release),
and a cache anomaly never fails the command.

Two squash-specific points:

- The snapshot covers the platform baseline ONLY. A warm hit skips `legacySetupDatabase` — so
  neither `Initialising schema...` nor `Seeding globals from roles.sql...` prints, and the PG15+
  one-shot realtime/storage/auth migrate jobs do not run — and then resumes at exactly the same
  seam as a cold run: the before-migration `auth`/`storage` dump, the migrations up to the target,
  the after-migration dump, and the full dump are all unchanged.
- Squash's `SetupDatabase` follows `config.toml` for Webhooks/`pg_net`, unlike `db diff`/`db
pull`'s forced-on `legacyMigrateShadowDatabase` baseline. That effective policy is part of the
  cache key, so squash keys to its own tars and can never warm-restore a `pg_net`-forced cluster.

## API Routes

| Method     | Path                               | Auth   | Purpose                                                    |
| ---------- | ---------------------------------- | ------ | ---------------------------------------------------------- |
| —          | —                                  | —      | local target: none                                         |
| POST       | `/v1/projects/{ref}/roles`         | Bearer | `--linked`: temp login role when no password               |
| GET        | `/v1/projects/{ref}/pooler/config` | Bearer | `--linked`: IPv4 pooler fallback (IPv6-only network)       |
| GET/DELETE | `/v1/projects/{ref}/network-bans`  | Bearer | `--linked`: unban during pooler login retry                |
| GET        | `/v1/projects/{ref}`               | Bearer | `--linked`: linked-project cache (post-run, unconditional) |

## Environment Variables

`SUPABASE_YES`, `DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICES_HOSTNAME`,
`DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG`, `SUPABASE_NETWORK_ID`,
`SUPABASE_INTERNAL_IMAGE_REGISTRY`, `SUPABASE_PROJECT_ID`, `SUPABASE_DEBUG`,
`SUPABASE_EXPERIMENTAL`, `SUPABASE_HOME` (root of the shadow baseline cache),
`SUPABASE_SHADOW_CACHE` (shadow baseline cache; ON by default, `false`/`0` opts out),
`SUPABASE_SHADOW_DEBUG` (opt-in shadow phase-timing diagnostics on stderr).

## Exit Codes

| Code  | Condition                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | success — **including** the single-migration no-op **and** a declined remote-baseline prompt                                                                                                                                                                  |
| `1`   | invalid `--version`; `--version` file not found; `version not found`; migrations-dir read failure; shadow create/health/setup/apply failure; `pg_dump` non-zero exit; migration-file open/write failure; baseline connect/batch failure; flag-group conflicts |
| `1`   | `--project-ref` set with a resolved target other than linked (see Notes)                                                                                                                                                                                      |
| `130` | SIGINT                                                                                                                                                                                                                                                        |

## Output

### `--output-format text`

stderr, in order (path-dependent):

```
Loading config override: [remotes.<ref>]          (only when --linked resolves a [remotes.<ref>] block)
Initialising schema...                             (cold shadow only — a warm baseline-cache hit skips it)
Seeding globals from roles.sql...                  (cold shadow only; then unconditional — printed even when roles.sql is absent)
Applying migration <base>...                       (once per migration applied to the shadow)
<bold path> is already the earliest migration.      (single-migration no-op)
  -- or --
Squashed local migrations to <bold path>
<removal error>                                     (per merged-file removal failure, non-fatal)
Failed to remove container: <id> <err>              (shadow cleanup failure, non-fatal)
Update remote migration history table? [Y/n]        (remote target only)
Baselining migration history to <version>            (remote target, prompt confirmed — BEFORE connecting)
Connecting to remote database...
```

stdout: only `Finished supabase migration squash.` (aqua), printed inline by the
handler itself (there is no shared group-level epilogue that prints it). Local
target additionally prints `Run
supabase migration repair --status applied to update your remote migration
history table.` to stderr, after the stdout line.

### `--output-format json` / `stream-json`

Progress lines stay on stderr (including the confirmation prompt, regardless of
`--output`/`--output-format`); stdout carries
`output.success("Migrations squashed", { squashedInto, removed, removeFailures,
alreadyEarliest, isLocal, baselinedVersion })` instead of the `Finished …` line
and (for the local target) the repair suggestion — both suppressed in machine
mode, matching `migration repair`/`migration up`. `removed` and `removeFailures`
partition every merged file between them: `removed` is the workdir-relative
paths that were successfully deleted, `removeFailures` is
`{ path, message }` for every merged file whose removal failed (`message` is
the same relativized text the text-mode stderr line prints) — a removal failure
is always non-fatal, so `removeFailures` being non-empty never changes the exit
code or the rest of the payload.

## Notes

- `--local` defaults **true**; `[db-url linked local]` and
  `[db-url password]` are the two mutually-exclusive flag groups.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which simply goes unused on a non-linked target).
- The shadow gets `legacySetupDatabase` only — **no** `CREATE DATABASE contrib_regression` (unlike
  `db diff`/`db pull`).
- `--version` is compared **lexically** against zero-padded timestamps.
- The baseline version is re-derived from the local migrations directory listing taken
  **after** the merged-file removals — so a removal that failed non-fatally causes the
  baseline to target the surviving **older** version, not the original squash target.
- A failed full-schema dump leaves the target migration truncated (not recoverable — the
  file was already truncated before the dump began).
- A declined "Update remote migration history table?" prompt is a **success** path (exit 0,
  no baseline query, `Finished …` still prints) — the opposite of `migration repair`/`fetch`/
  `down`, which treat a decline as a cancellation.
- **Atomicity note:** the old Go CLI sent the baseline `DELETE`/`INSERT` via a batched pipeline
  (not an explicit transaction) — a partial failure could leave the DELETE applied without the
  INSERT. The TS port wraps both statements in an explicit `BEGIN`/`COMMIT` with `ROLLBACK` on
  error (matching `migration repair`'s own equivalent divergence); the success path produces
  the same output as before.
- **Documented divergences** (neither reproduced, both judged strictly worse to replicate):
  (a) the old Go CLI's line-scanning silently truncated `lineByLineDiff`'s output when a
  single dumped line exceeded 64 KiB, with no error surfaced — not reproduced (`squash.diff.ts`);
  (b) the old Go CLI's separator-comment write discarded its error return, while the
  auth/storage diff write right after it was checked — this port combines both into one write,
  so a hypothetical failure isolated to just the separator bytes now surfaces as
  `failed to write line: …`; not realistically triggerable on a real filesystem for a single
  already-open file descriptor.
- `Initialising schema...` is printed by the shared setup prelude just before
  `legacySetupDatabase` runs rather than from inside it — inherited from CLI-1956, shared with
  `db diff`/`db pull`'s identical shadow-provisioning prelude. A warm shadow-cache hit never
  reaches that prelude, so the line (and `Seeding globals from roles.sql...`) is absent —
  progress text reflects the work actually performed.
