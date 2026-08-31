# `supabase db schema declarative generate`

Generates declarative schema files from a database using pg-delta's managed
platform view.

Pg-delta runs in-process.
Coverage gaps warn; `--strict-coverage` makes them fatal, and `PGDELTA_DEBUG`
writes diagnostic JSON under `supabase/.temp/pgdelta/v2/debug/<id>/`.
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

| What                                                                                                                                                                        | When                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `legacyResetLocalDatabase` | smart-mode Local choice when reset is confirmed (or `--reset`) |

## Environment Variables

| Variable                     | Purpose                                                             | Required? |
| ---------------------------- | ------------------------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for `--linked`                                           | no        |
| `DB_PASSWORD`                | password for `--linked` / `--db-url`                                | no        |
| `SUPABASE_HOME`              | overrides the `~/.supabase` root (access token and other CLI state) | no        |
| `PGDELTA_DEBUG`              | bundled-engine debug artifacts                                      | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for `--local`                                         | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback                  | no        |

## Exit Codes

| Code | Condition                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | success (files written, or skipped after a declined prompt)                          |
| `1`  | pg-delta disabled (`[experimental.pgdelta] enabled = false` and no `--experimental`) |
| `1`  | conflicting `--db-url`/`--linked`/`--local` (mutually exclusive)                     |
| `1`  | non-interactive mode with no explicit target                                         |
| `1`  | local-database bring-up / pg-delta engine / export failure                           |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: the gate check runs
first, so a closed gate (`enabled = false` and no `--experimental`) surfaces before a
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

- pg-delta is on by default. The gate closes only when
  `[experimental.pgdelta] enabled = false` and `--experimental` is omitted.
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
