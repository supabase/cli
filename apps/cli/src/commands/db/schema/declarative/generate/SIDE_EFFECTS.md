# `supabase db schema declarative generate`

Generates declarative schema files from a database using pg-delta's managed
platform view.

Pg-delta runs in-process.
Coverage gaps warn; `--strict-coverage` makes them fatal, and `PGDELTA_DEBUG`
writes diagnostic JSON under `supabase/.temp/pgdelta/v2/debug/<id>/`.
The command is `selectable` and never asks for hosted-mutation consent: the target is `--remote`
(the linked project), `--remote=<ref>`, `--remote=<branch>` (a branch of the linked project, by name
or UUID) or `--remote=<url>`, else the local database; in a linked checkout the default `Target:`
line adds `default; pass --remote for <project>`. It never asks which database to use.
A local target checks the local Postgres image, starts a stopped local database,
and resets it first only with `--reset`. When `[experimental].stack` is on, the local target
connects to the running primary database in the project stack's composition. It does not launch a
stopped database or choose a standalone shadow database.

`--no-cache` (a flag shared across the `declarative` group) has no effect on
`generate` — the export connects directly to the target and provisions no
shadow. The bundled formatter defaults to
lowercase SQL at width 180; config overrides it, and JSON `null` disables
formatting without disabling safe compaction.

## Files Read

| Path                                           | Format     | When                                                                                                            |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always — pg-delta gate, ports, format options                                                                   |
| `<workdir>/supabase/.temp/postgres-version`    | plain text | a local target — the local Postgres image-currency check's version-pin lookup                                   |
| `<workdir>/supabase/.temp/project-ref`         | plain text | bare `--remote` with no `SUPABASE_PROJECT_ID`; with no selector, only to name the project in the `Target:` hint |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | a remote project, for the `Target:` banner (no API call)                                                        |
| `~/.supabase/access-token`                     | plain text | a remote project or branch (token resolution)                                                                   |

## Files Written

| Path                                                                                            | Format | When                                                         |
| ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `<workdir>/supabase/schemas/**/*.sql` (default declarative dir, or invocation-local `--output`) | SQL    | selected destination is wiped + rewritten after confirmation |
| `<selected-output>/.pgdelta-export.json`                                                        | JSON   | export metadata                                              |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                                         | JSON   | with `PGDELTA_DEBUG`                                         |

## Subprocesses / Containers

| What                                                                                                                                                                  | When                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `resetLocalDatabase` | a local target with `--reset` |

## Environment Variables

| Variable                     | Purpose                                                                                                                                                                                                                                                                                              | Required? |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for a remote project or branch                                                                                                                                                                                                                                                            | no        |
| `SUPABASE_DB_PASSWORD`       | remote database password for a remote project or branch (`--password`/`-p` overrides)                                                                                                                                                                                                                |
| `SUPABASE_PROJECT_ID`        | the project ref of a bare `--remote` target, and the parent that `--remote=<branch>` is resolved against                                                                                                                                                                                             |
| `SUPABASE_HOME`              | overrides the `~/.supabase` root (access token and other CLI state)                                                                                                                                                                                                                                  | no        |
| `PGDELTA_DEBUG`              | bundled-engine debug artifacts                                                                                                                                                                                                                                                                       | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for a local target                                                                                                                                                                                                                                                                     | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback                                                                                                                                                                                                                                                   | no        |
| `SUPABASE_USE_SLIM_IMAGES`   | resolves the expected local `db` image for the stale-container guard from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB tags the catalog does not pin, and flag-off `15.8.1.085` stay on docker.io | no        |

## Exit Codes

| Code | Condition                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (files written, or skipped after a declined prompt)                                                                                        |
| `1`  | pg-delta disabled (`[experimental.pgdelta] enabled = false` and no `--experimental`)                                                               |
| `1`  | conflicting target flags (`--remote`, `--linked`, `--db-url`, `--local`), or `--project-ref` combined with `--local`/`--db-url`/`--remote=<value>` |
| `1`  | `--password` combined with `--remote=<url>` or the local default                                                                                   |
| `1`  | `--remote=<branch>` naming no branch of the linked project                                                                                         |
| `1`  | local-database bring-up / pg-delta engine / export failure                                                                                         |

The pg-delta gate and the selector checks are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: the gate check runs
first, so a closed gate (`enabled = false` and no `--experimental`) surfaces before a
target-flag conflict is ever checked. `--password` with a local target is rejected after the
local Postgres image check and database start.

## Output

Diagnostics (alias deprecation warnings, the `Target: …` banner, prompts, `Declarative schema written to <dir>`)
always go to stderr, in every `--output-format`. On success:

- `text` mode prints `Finished supabase db schema declarative generate.` to
  stdout.
- `json`/`stream-json` mode instead emits a structured success envelope
  (`output.success("Finished supabase db schema declarative generate.")`) so
  the machine stdout payload isn't corrupted by a bare human line
  (`generate.command.ts:74-90`, CLI-1546 invariant).

## Notes

- Open by default. The gate closes only when `[experimental.pgdelta] enabled = false`
  and `--experimental` is omitted.
- The target comes from `resolveTarget`: `--remote` or one of its forms wins, else local. With no
  selector the command exports the local database; it neither prompts for a target nor fails in
  non-interactive mode.
- **Target selection.** `--remote` is read as the linked project (bare), a project ref (20
  lowercase letters), a Postgres URL, or else a branch of the linked project by name or UUID;
  `--remote=false` and `--remote=` fail with `Leave out --remote to target the local database.` A
  bare `--remote` followed by a word that is a branch of the linked project fails with a
  `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- **Deprecated aliases.** `--linked`, `--project-ref=<ref>`, `--db-url=<url>` and `--local` still
  work and print a deprecation warning on stderr naming the `--remote` replacement (`--local`
  warns that local is the default). They are mutually exclusive with each other and with
  `--remote`; a `false` switch counts as absent. `--project-ref` with `--local`, `--db-url` or
  `--remote=<value>` is a hard error.
- `--reset` recreates the local database from the migrations before exporting; it has no effect
  on a remote project, branch or `--remote=<url>` target.
- Existing declarative files are overwritten only after the export succeeds: without
  `--overwrite`, a non-empty destination asks `Overwrite declarative schema? Existing files may be
deleted.` (default no); a decline, or no answer, prints `Skipped writing declarative schema.`
  and exits `0`. `--yes` and `SUPABASE_YES` answer it.
- A remote project or branch caches the project in `supabase/.temp/linked-project.json` on success and
  failure, like other commands that target a remote project.
- `--output-dir <dir>` selects a destination for this invocation without changing
  config or activating it for later syncs (deliberately not `--output`/`-o`, which
  the root command reserves for the global machine-format flag).
- When `declarative_schema_path` is unset, the new `supabase/schemas` default is
  empty, and the former `supabase/database` default still contains `.sql` files
  or an export manifest, a WARNING on stderr explains the default move and how
  to keep the existing tree. Read-only probe; never changes behavior or exit
  codes.
- Remote Supabase targets use the shared connection/TLS behavior. `--remote=<branch>`, and a bare
  `--remote` followed by a word that could name a branch, call
  `GET /v1/projects/{parent}/branches` to find the branch's project (`{parent}` is
  `SUPABASE_PROJECT_ID`, else the linked project); the connection may also mint a temporary login
  role through the Management API.
- **Architecture:** the engine extracts and renders the target in-process.
- **Stale local-container guard.** A local target inspects
  the running local `db` container's actual image and compares it against the
  currently-configured/resolved one before reading from it. A same-tag family
  mismatch (slim vs docker.io, e.g. after toggling `SUPABASE_USE_SLIM_IMAGES`
  without restarting) fails with a suggestion to `supabase stop` then
  `supabase start` with the same flag. A real version/tag mismatch still
  suggests `supabase stop --all --no-backup` then `supabase start`.
