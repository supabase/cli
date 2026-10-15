# `supabase db schema declarative generate`

Generates declarative schema files from a database using pg-delta's managed
platform view.

Pg-delta runs in-process.
Coverage gaps warn; `--strict-coverage` makes them fatal, and `PGDELTA_DEBUG`
writes diagnostic JSON under `supabase/.temp/pgdelta/v2/debug/<id>/`.
When `[experimental].stack` is on, `--local` connects to the running primary database in the
project stack's composition. It does not launch a stopped database or choose a standalone
shadow database.

`--no-cache` (a flag shared across the `declarative` group) has no effect on
`generate` — the export connects directly to the target and provisions no
shadow. The bundled formatter defaults to
lowercase SQL at width 180; config overrides it, and JSON `null` disables
formatting without disabling safe compaction.

## Files Read

| Path                                        | Format     | When                                                                                 |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`            | TOML       | always — pg-delta gate, ports, format options                                        |
| `<workdir>/supabase/.temp/postgres-version` | plain text | smart-mode Local flow — the local Postgres image-currency check's version-pin lookup |
| `<workdir>/supabase/migrations/*.sql`       | SQL        | smart mode — detect whether migrations exist                                         |
| `~/.supabase/access-token`                  | plain text | `--linked` (token resolution)                                                        |

## Files Written

| Path                                                                                            | Format | When                                                         |
| ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `<workdir>/supabase/schemas/**/*.sql` (default declarative dir, or invocation-local `--output`) | SQL    | selected destination is wiped + rewritten after confirmation |
| `<selected-output>/.pgdelta-export.json`                                                        | JSON   | export metadata                                              |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                                         | JSON   | with `PGDELTA_DEBUG`                                         |

## Subprocesses / Containers

| What                                                                                                                                                                  | When                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `resetLocalDatabase` | smart-mode Local choice when reset is confirmed (or `--reset`) |

## Environment Variables

| Variable                                 | Purpose                                                                                                                                                                                                                                                                                              | Required?                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN`                  | auth token for `--linked`                                                                                                                                                                                                                                                                            | no                                                           |
| `DB_PASSWORD`                            | password for `--linked` / `--db-url`                                                                                                                                                                                                                                                                 | no                                                           |
| `SUPABASE_HOME`                          | overrides the `~/.supabase` root (access token and other CLI state)                                                                                                                                                                                                                                  | no                                                           |
| `PGDELTA_DEBUG`                          | bundled-engine debug artifacts                                                                                                                                                                                                                                                                       | no                                                           |
| `SUPABASE_SERVICES_HOSTNAME`             | local DB host for `--local`                                                                                                                                                                                                                                                                          | no                                                           |
| `DOCKER_HOST`                            | tcp daemon host used as the local DB host fallback                                                                                                                                                                                                                                                   | no                                                           |
| `SUPABASE_USE_SLIM_IMAGES`               | resolves the expected local `db` image for the stale-container guard from the slim `ghcr.io/supabase/cli` builds (`true`/`1` enable); majors 13/15 use `15.14.1.167` when the flag is on; historical pins, PG14, OrioleDB tags the catalog does not pin, and flag-off `15.8.1.085` stay on docker.io | no                                                           |
| `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION` | deprecated alias of `SUPABASE_DB_ORIOLEDB_VERSION`, used only while that is unset; when set, stderr gets `WARN: SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION is deprecated and will be removed in v3, use SUPABASE_DB_ORIOLEDB_VERSION instead.`                                                           | no                                                           |
| `SUPABASE_TARGET`                        | workspace target (`local` or `remote`) used when no selector flag is given; overrides `target` in `supabase/config.toml`                                                                                                                                                                             | no (falls back to config `target`, then the command default) |

## Target selection

With no `--local`, `--linked` or `--db-url` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then `supabase/.env*`), then `target` in `supabase/config.toml` (or
`config.json`), then the local default. `remote` targets the linked project through the existing
linked path (same prompts and checks as `--linked`). An explicit selector flag always wins over the
target. `--project-ref` is not a selector: a `remote` target resolves it to the linked project, while with no target or
`target = "local"` it behaves exactly as it did before the target existed. An invalid `SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. Config
is only read for the target when no selector flag is given; an unreadable config counts as unset.
No deprecation warning is written: the local default is unchanged. When the target is set the no-flag target prompt is skipped; when it is unset the smart prompt is unchanged.

When the target resolves to the linked project, the command writes one line to **stderr** naming where the
setting came from, so a config-driven target is never silent:

```
Targeting the linked project (target = "remote" from <source>)
```

`<source>` is `SUPABASE_TARGET`, the `.env*` file that set it (for example `supabase/.env.local` or `.env`), `supabase/config.toml` or `supabase/config.json`.
Nothing is written when a selector flag decides the target.

## Exit Codes

| Code | Condition                                                             |
| ---- | --------------------------------------------------------------------- |
| `0`  | success (files written, or skipped after a declined prompt)           |
| `1`  | pg-delta not enabled (no `--experimental` / `[experimental.pgdelta]`) |
| `1`  | conflicting `--db-url`/`--linked`/`--local` (mutually exclusive)      |
| `1`  | non-interactive mode with no explicit target                          |
| `1`  | local-database bring-up / pg-delta engine / export failure            |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: the gate check runs
first, so a closed gate (missing `--experimental`) surfaces before a
`--db-url`/`--linked`/`--local` conflict is ever checked.

## Output

Diagnostics (target resolution, prompts, `Declarative schema written to <dir>`)
always go to stderr, in every `--output-format`. On success:

- `text` mode prints `Finished supabase db schema declarative generate.` to
  stdout.
- `json`/`stream-json` mode instead emits a structured success envelope
  (`output.success("Finished supabase db schema declarative generate.")`) so
  the machine stdout payload isn't corrupted by a bare human line
  (`generate.command.ts:74-90`, CLI-1546 invariant).

## Notes

- Requires `--experimental` or `[experimental.pgdelta] enabled = true`.
- `--db-url` / `--linked` / `--local` are mutually exclusive; absent all three,
  smart mode prompts (existing-files overwrite → Local/Custom choice + reset offer).
- `--output-dir <dir>` selects a destination for this invocation without changing
  config or activating it for later syncs (TS-only; deliberately not
  `--output`/`-o`, which the legacy root reserves for the global machine-format
  flag — see `docs/go-cli-divergences.md`).
- When `declarative_schema_path` is unset, the new `supabase/schemas` default is
  empty, and the former `supabase/database` default still contains `.sql` files
  or an export manifest, a WARNING on stderr explains the default move and how
  to keep the existing tree. Read-only probe; never changes behavior or exit
  codes.
- Remote Supabase targets use the shared connection/TLS behavior.
- **Architecture:** the engine extracts and renders the target in-process.
- **Stale local-container guard.** `--local`/smart-mode's Local target inspects
  the running local `db` container's actual image and compares it against the
  currently-configured/resolved one before reading from it. A same-tag family
  mismatch (slim vs docker.io, e.g. after toggling `SUPABASE_USE_SLIM_IMAGES`
  without restarting) fails with a suggestion to `supabase stop` then
  `supabase start` with the same flag. A real version/tag mismatch still
  suggests `supabase stop --all --no-backup` then `supabase start`.
