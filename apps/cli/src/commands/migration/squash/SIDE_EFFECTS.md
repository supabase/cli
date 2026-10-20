# `supabase migration squash`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

Squashes every local migration up to (optionally)
`--version` into the last one — diffing a natively-provisioned shadow database's
`auth`/`storage` schemas before and after applying every migration, dumping the
full schema into the target file, and deleting the merged files — then either
suggests `migration repair` (local target) or baselines the remote
migration-history table to match (hosted target, after one confirmation that comes before any
file is rewritten).

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
| `<workdir>/supabase/.temp/{project-ref,postgres-version,pooler-url}`                               | plain text                                                                            | a remote project: `project-ref` resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, `project-ref` only, to word the linked-checkout hint                                                                                                                                                                                                                                                                                                                                                      |
| `<workdir>/supabase/.temp/linked-project.json`                                                     | JSON                                                                                  | to name the project in the `Target:` banner and the linked-checkout hint, and as the parent project for `--remote=<branch>`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `~/.supabase/access-token`                                                                         | plain text                                                                            | a remote project without `--password`/`SUPABASE_ACCESS_TOKEN`, or when a branch is looked up                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `~/.docker/config.json` + Docker context store                                                     | JSON                                                                                  | resolving the Docker hostname for shadow/pg_dump containers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Files Written

| Path                                               | Format   | When                                                                                                                 |
| -------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/<target>.sql`       | SQL text | ≥2 migrations squash — **truncated** (0644) then rewritten as the full dump + separator + `auth`/`storage` line diff |
| `<workdir>/supabase/migrations/<earlier>.sql` (×N) | —        | **deleted** — every earlier merged migration; a per-file failure is non-fatal (printed, not raised)                  |
| scoped temp dir                                    | SQL      | shadow's `initSchema`/`ApplyApiPrivileges` SQL (PG≤14) — removed when the scope closes                               |
| `<workdir>/supabase/.temp/linked-project.json`     | JSON     | remote project (post-run cache, even when the command itself fails or the confirmation is declined)                  |
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

| Method      | Path                                                                          | Auth   | Purpose                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —           | —                                                                             | —      | local target or database URL: none                                                                                                                                                                             |
| GET         | `/v1/projects`                                                                | Bearer | project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, interactive terminal only                                                                                       |
| GET         | `/v1/projects/{parent}/branches`                                              | Bearer | only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| GET         | `/v1/branches/{id}`                                                           | Bearer | only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                    |
| POST        | `/v1/projects/{ref}/cli/login-role`                                           | Bearer | remote project: temp login role when no password                                                                                                                                                               |
| GET         | `/v1/projects/{ref}/config/database/pooler`                                   | Bearer | remote project: IPv4 pooler fallback (IPv6-only network), only when the ref came from `--remote=<ref>` or `--remote=<branch>`, or differs from the linked project                                              |
| POST/DELETE | `/v1/projects/{ref}/network-bans/retrieve`, `/v1/projects/{ref}/network-bans` | Bearer | remote project: unban during pooler login retry, only under `--yes`                                                                                                                                            |
| GET         | `/v1/projects/{ref}`                                                          | Bearer | remote project: linked-project cache (post-run, unconditional)                                                                                                                                                 |

## Environment Variables

`SUPABASE_YES` (shell only; confirms a hosted run), `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD` (remote project only), `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICES_HOSTNAME`,
`DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG`, `SUPABASE_NETWORK_ID`,
`SUPABASE_INTERNAL_IMAGE_REGISTRY`, `SUPABASE_USE_SLIM_IMAGES` (current-pin shadow Postgres and PG15+ realtime/storage/auth migrate-job images → slim `ghcr.io/supabase/cli`; historical pins, PG14, OrioleDB tags the catalog does not pin, flag-off `15.8.1.085` stay on docker.io), `SUPABASE_PROJECT_ID`, `SUPABASE_DEBUG`,
`SUPABASE_EXPERIMENTAL`, `SUPABASE_SHADOW_CACHE` (stack shadow baseline cache; on by default, falsy disables restore and publication).

## Exit Codes

| Code  | Condition                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | success — **including** the single-migration no-op                                                                                                                                                                                      |
| `1`   | invalid `--version`; `--version` file not found; `version not found`; migrations-dir read failure; shadow create/health/setup/apply failure; `pg_dump` non-zero exit; migration-file open/write failure; baseline connect/batch failure |
| `1`   | hosted target without `--yes` in a run that cannot prompt (`HostedMutationConsentRequiredError`); hosted confirmation declined (`context canceled`) — nothing is changed                                                                |
| `130` | SIGINT                                                                                                                                                                                                                                  |

## Output

### `--output-format text`

stderr, in order (path-dependent):

```
Target: …                                           (the resolved target; local and custom Postgres lines come from the connection)
Loading config override: [remotes.<ref>]          (only when a remote project resolves a [remotes.<ref>] block)
Confirmed by --yes: Squash local migrations and update the remote migration history table on <target>   (hosted target under --yes)
Initialising schema...
Seeding globals from roles.sql...                  (unconditional — printed even when roles.sql is absent)
Applying migration <base>...                       (once per migration applied to the shadow)
<bold path> is already the earliest migration.      (single-migration no-op)
  -- or --
Squashed local migrations to <bold path>
<removal error>                                     (per merged-file removal failure, non-fatal)
Failed to remove container: <id> <err>              (shadow cleanup failure, non-fatal)
Baselining migration history to <version>            (hosted target, after the squash — BEFORE connecting)
```

A hosted target asks (or is confirmed by `--yes`) right after the target, config override and migration list are resolved, listing the squash plan and the history reset — before the shadow database is created and before any migration file is rewritten or removed.

stdout: only `Finished supabase migration squash.` (aqua), printed inline by the
handler itself (there is no shared group-level epilogue that prints it). Local
target additionally prints `Run
supabase migration repair --status applied --remote to update your remote migration
history table.` to stderr, after the stdout line.

### `--output-format json` / `stream-json`

Progress lines stay on stderr; a hosted target needs `--yes`, since a machine-output run cannot
prompt. stdout carries
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

- The shadow database is provisioned locally whatever the target; the target only decides whether the
  remote history table is baselined.
- **Consent.** A hosted target (a remote project or a non-local database URL) needs one confirmation
  (default **NO**) because the local checkout rewrite precedes the remote history reset. A local target never prompts.
- **`--password`.** For a remote project the password resolves as flag > shell `SUPABASE_DB_PASSWORD` >
  project `.env*` > config; the env value is withheld when the target differs from `.temp/project-ref`
  (stderr
  `Not sending SUPABASE_DB_PASSWORD to <target>: this directory is linked to <linked>. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for <target>.`),
  and a temporary login role is minted instead (ADR 0032).
- The shadow gets `setupDatabase` only — **no** `CREATE DATABASE contrib_regression` (unlike
  `db diff`/`db pull`).
- `--version` is compared **lexically** against zero-padded timestamps.
- The baseline version is re-derived from the local migrations directory listing taken
  **after** the merged-file removals — so a removal that failed non-fatally causes the
  baseline to target the surviving **older** version, not the original squash target.
- A failed full-schema dump leaves the target migration truncated (not recoverable — the
  file was already truncated before the dump began).
- A declined hosted confirmation exits 1 (`context canceled`) before the shadow database is created:
  no migration file is rewritten or removed and the remote history is untouched.
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
