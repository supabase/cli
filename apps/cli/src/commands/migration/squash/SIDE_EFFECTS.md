# `supabase migration squash`

Squashes every local migration up to (optionally)
`--version` into the last one — diffing a natively-provisioned shadow database's
`auth`/`storage` schemas before and after applying every migration, dumping the
full schema into the target file, and deleting the merged files — then either
suggests `migration repair` (local target) or prompts to baseline the remote
migration-history table to match.

When `[experimental].stack` is on, each shadow is a fresh database in an invocation-owned,
unique temporary stack namespace. The command applies the catalog and project migrations as needed,
then destroys its namespace when the Effect scope closes. If its container engine is unreachable
then, the namespace is still removed and stderr lists the commands that remove its engine
resources. Stack shadows use the stack baseline
cache described below. Native artifacts
are shared through `$SUPABASE_HOME/cache/stack`; shadow state and data use the normal stack registry, so `stack list` and `stack destroy` can
find a shadow left by an abrupt CLI exit. Each shadow owns a unique temporary project root
and uses an automatically assigned port; `db.shadow_port` applies only to the legacy backend. Schema dumps use the namespace's catalog `pg_dump` tool and runtime database address.

## Files Read

| Path                                                                                               | Format                                                                                | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`                                                                   | TOML                                                                                  | always, twice: `@supabase/config` for the shadow's own spec, `readDbToml` for shadow port/password/vault/baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `auth.email.template.*` / `auth.email.notification.*` `content_path` (config-relative or absolute) | text (existence/readability only — bytes discarded, used only to validate the config) | only when `auth.enabled`, for every configured template and every notification with `enabled = true` — via the same `readDbToml` `Config.Validate` pipeline shared by `migration up`/`down` and every `db` subcommand that loads config (`dump`/`pull`/`reset`/`diff`/`push`/`schema declarative generate`/`sync` — documented on `db diff`'s `SIDE_EFFECTS.md` and here, rather than duplicated per file, CLI-2339); the resolved path is CONFINED to the project root (symlinks dereferenced with `realpathSync`) — a path resolving outside it aborts before the read |
| `<workdir>/supabase/migrations/`                                                                   | directory                                                                             | always                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `<workdir>/supabase/migrations/<version>_*.sql`                                                    | SQL                                                                                   | each migration up to the target, applied to the shadow; the target file's own final content is read by `--version`/baseline lookups                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/roles.sql`                                                                     | SQL                                                                                   | shadow `SetupDatabase` (custom-roles seed); missing file tolerated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| managed snapshot key `<key>`                                                                       | backend                                                                               | warm stack-shadow baseline; managed retention may evict entries and snapshots survive stack destruction                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/.env`, `.env.local`, `SUPABASE_ENV`-selected dotenv                            | dotenv                                                                                | always (`--yes`/registry/network-id overrides)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `<workdir>/supabase/.temp/{project-ref,postgres-version,pooler-url}`                               | plain text                                                                            | `--linked` / linked path — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `~/.supabase/access-token`                                                                         | plain text                                                                            | `--linked` without `--password`/`SUPABASE_ACCESS_TOKEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `~/.docker/config.json` + Docker context store                                                     | JSON                                                                                  | resolving the Docker hostname for shadow/pg_dump containers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Files Written

| Path                                               | Format   | When                                                                                                                 |
| -------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<target>.sql`       | SQL text | ≥2 migrations squash — **truncated** (0644) then rewritten as the full dump + separator + `auth`/`storage` line diff |
| `<workdir>/supabase/migrations/<earlier>.sql` (×N) | —        | **deleted** — every earlier merged migration; a per-file failure is non-fatal (printed, not raised)                  |
| scoped temp dir                                    | SQL      | shadow's `initSchema`/`ApplyApiPrivileges` SQL (PG≤14) — removed when the scope closes                               |
| `<workdir>/supabase/.temp/linked-project.json`     | JSON     | `--linked` (post-run cache, even when the command itself fails)                                                      |
| managed snapshot key `<key>`                       | backend  | stack-mode cold shadow baseline; managed retention may evict entries and snapshots survive stack destruction         |
| `~/.supabase/telemetry.json`                       | JSON     | every invocation (post-run)                                                                                          |

### Stack shadow baseline cache

Stack mode uses the managed snapshot backend by default and keys each
baseline from the resolved stack artifacts, runtime/platform, enabled catalog services, settings,
credentials, overlay inputs, and `roles.sql`. Set `SUPABASE_SHADOW_CACHE` to a falsy value to opt
out. Warm restore failures recreate the shadow database; failed publication warns and leaves the
live shadow available.

## Docker

- Network ensure (`ensureNetwork`, same as `db diff`/`db pull`).
- Shadow Postgres container: no `--name`, no network alias, `--publish <shadow_port>:5432`,
  `-c max_worker_processes=0`, `--rm`, PG≤14 tmpfs on `/docker-entrypoint-initdb.d` — created,
  started, health-polled (`container inspect`), then removed (`rm -f -v`) once squash finishes,
  success or failure.
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

  Unlike `db diff`/`db pull`, the shadow only ever gets `setupDatabase` (platform
  baseline + roles.sql) — **no** `CREATE DATABASE contrib_regression` template database.

## API Routes

| Method     | Path                               | Auth   | Purpose                                                    |
| ---------- | ---------------------------------- | ------ | ---------------------------------------------------------- |
| —          | —                                  | —      | local target: none                                         |
| POST       | `/v1/projects/{ref}/roles`         | Bearer | `--linked`: temp login role when no password               |
| GET        | `/v1/projects/{ref}/pooler/config` | Bearer | `--linked`: IPv4 pooler fallback (IPv6-only network)       |
| GET/DELETE | `/v1/projects/{ref}/network-bans`  | Bearer | `--linked`: unban during pooler login retry                |
| GET        | `/v1/projects/{ref}`               | Bearer | `--linked`: linked-project cache (post-run, unconditional) |

## Environment Variables

`SUPABASE_YES`, `SUPABASE_DB_PASSWORD` (`--linked` only), `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICES_HOSTNAME`,
`DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG`, `SUPABASE_NETWORK_ID`,
`SUPABASE_INTERNAL_IMAGE_REGISTRY`, `SUPABASE_USE_SLIM_IMAGES` (current-pin shadow Postgres and PG15+ realtime/storage/auth migrate-job images → slim `ghcr.io/supabase/cli`; historical pins, PG14, OrioleDB, flag-off `15.8.1.085` stay on docker.io), `SUPABASE_PROJECT_ID`, `SUPABASE_DEBUG`,
`SUPABASE_EXPERIMENTAL`, `SUPABASE_SHADOW_CACHE` (stack shadow baseline cache; on by default, falsy disables restore and publication).

## Exit Codes

| Code  | Condition                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | success — **including** the single-migration no-op **and** a declined remote-baseline prompt                                                                                                                                                                  |
| `1`   | invalid `--version`; `--version` file not found; `version not found`; migrations-dir read failure; shadow create/health/setup/apply failure; `pg_dump` non-zero exit; migration-file open/write failure; baseline connect/batch failure; flag-group conflicts |
| `1`   | `--project-ref` set with a resolved target other than linked (see Notes)                                                                                                                                                                                      |
| `1`   | `--password` with `--db-url` or `--local`                                                                                                                                                                                                                     |
| `130` | SIGINT                                                                                                                                                                                                                                                        |

## Output

### `--output-format text`

stderr, in order (path-dependent):

```
Loading config override: [remotes.<ref>]          (only when --linked resolves a [remotes.<ref>] block)
Initialising schema...
Seeding globals from roles.sql...                  (unconditional — printed even when roles.sql is absent)
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

- `--local` defaults **true**; `[db-url linked local]` is the mutually-exclusive target group.
- **`--password`** is rejected with `--db-url` (`--password can't be used with --db-url. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres`), with `--local` (`--password can't be used with --local. The local database uses [db].password from supabase/config.toml.`), and when the target defaulted to local (`migration squash targets the local database unless you pass --linked, and --password only applies to a linked project. Pass --linked, or drop --password.`),
  exit 1. For `--linked` the password resolves as flag > shell `SUPABASE_DB_PASSWORD` > project
  `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`), and a
  temporary login role is minted instead (ADR 0031).
- **`--project-ref`** overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which simply goes unused on a non-linked target).
- The shadow gets `setupDatabase` only — **no** `CREATE DATABASE contrib_regression` (unlike
  `db diff`/`db pull`).
- `--version` is compared **lexically** against zero-padded timestamps.
- The baseline version is re-derived from the local migrations directory listing taken
  **after** the merged-file removals — so a removal that failed non-fatally causes the
  baseline to target the surviving **older** version, not the original squash target.
- A failed full-schema dump leaves the target migration truncated (not recoverable — the
  file was already truncated before the dump began).
- A declined "Update remote migration history table?" prompt (`n`, or any unrecognised
  answer) is a **success** path (exit 0,
  no baseline query, `Finished …` still prints) — the opposite of `migration repair`/`fetch`/
  `down`, which treat a decline as a cancellation.
- **Atomicity note:** the baseline `DELETE`/`INSERT` run in an explicit `BEGIN`/`COMMIT` with
  `ROLLBACK` on error, so a partial failure cannot leave the DELETE applied without the INSERT
  (as in `migration repair`).
- **Diff output handling:** (a) a dumped line longer than 64 KiB is written in full, not
  truncated (`squash.diff.ts`); (b) the separator comment and the auth/storage diff are
  combined into one write, so a failure isolated to just the separator bytes surfaces as
  `failed to write line: …`; this is not realistically triggerable on a real filesystem for a
  single already-open file descriptor.
- `Initialising schema...` is printed by the shared setup prelude just before
  `setupDatabase` runs rather than from inside it — inherited from CLI-1956, shared with
  `db diff`/`db pull`'s identical shadow-provisioning prelude.
