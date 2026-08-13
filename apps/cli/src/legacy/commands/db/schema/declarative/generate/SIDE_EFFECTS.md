# `supabase db schema declarative generate`

Generates declarative schema files from a database using pg-delta's managed
platform view.

Pg-delta runs in-process by default. Set `SUPABASE_USE_PG_DELTA_NEXT=false` for
the legacy catalog/edge-runtime implementation; there is no automatic fallback.
Coverage gaps warn; `--strict-coverage` makes them fatal, and `PGDELTA_DEBUG`
writes diagnostic JSON under `supabase/.temp/pgdelta/v2/debug/<id>/`.
`--no-cache` affects only the legacy opt-out. The bundled formatter defaults to
lowercase SQL at width 180; config overrides it, and JSON `null` disables
formatting without disabling safe compaction.

## Files Read

| Path                                            | Format     | When                                          |
| ----------------------------------------------- | ---------- | --------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML       | always — pg-delta gate, ports, format options |
| `<workdir>/supabase/.temp/pgdelta-version`      | plain text | loaded for compatibility; legacy opt-out only |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | legacy opt-out's edge-runtime image tag       |
| `<workdir>/supabase/.temp/postgres-version`     | plain text | shadow-DB image resolution (Go seam)          |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | smart mode — detect whether migrations exist  |
| `<workdir>/supabase/.temp/pgdelta/*.json`       | JSON       | legacy opt-out's catalog cache                |
| `~/.supabase/access-token`                      | plain text | `--linked` (token resolution)                 |

## Files Written

| Path                                                                                                | Format | When                                                         |
| --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `<workdir>/supabase/database/**/*.sql` (configured declarative dir, or invocation-local `--output`) | SQL    | selected destination is wiped + rewritten after confirmation |
| `<selected-output>/.pgdelta-export.json`                                                            | JSON   | bundled-engine export metadata                               |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                                                   | JSON   | legacy opt-out's catalog cache                               |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                                             | JSON   | bundled engine with `PGDELTA_DEBUG`                          |

## Subprocesses / Containers

| What                                                                                                                                                                            | When                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `supabase-go db schema declarative __catalog --mode baseline --experimental` (hidden seam) — provisions a shadow Postgres + `start.SetupDatabase`, exports the baseline catalog | legacy opt-out only                                            |
| Edge-runtime container (`supabase/edge-runtime`) running the pg-delta declarative-export Deno script (host network, deno-cache volume `supabase_edge_runtime_<projectId>`)      | legacy opt-out only                                            |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `legacyResetLocalDatabase`     | smart-mode Local choice when reset is confirmed (or `--reset`) |

## Environment Variables

| Variable                     | Purpose                                            | Required? |
| ---------------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for `--linked`                          | no        |
| `DB_PASSWORD`                | password for `--linked` / `--db-url`               | no        |
| `SUPABASE_USE_PG_DELTA_NEXT` | set to `false` for legacy edge-runtime pg-delta    | no        |
| `PGDELTA_NPM_REGISTRY`       | legacy opt-out's private npm registry              | no        |
| `PGDELTA_DEBUG`              | bundled-engine debug artifacts                     | no        |
| `SUPABASE_GO_BINARY`         | override the `supabase-go` seam binary             | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for `--local` (Go `GetHostname`)     | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback | no        |

## Exit Codes

| Code | Condition                                                             |
| ---- | --------------------------------------------------------------------- |
| `0`  | success (files written, or skipped after a declined prompt)           |
| `1`  | pg-delta not enabled (no `--experimental` / `[experimental.pgdelta]`) |
| `1`  | conflicting `--db-url`/`--linked`/`--local` (mutually exclusive)      |
| `1`  | non-interactive mode with no explicit target                          |
| `1`  | shadow-database / selected pg-delta engine / export failure           |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: Go's
`PersistentPreRunE` runs before `ValidateFlagGroups()`
(`cobra@v1.10.2/command.go:985,1010`), so a closed gate (missing `--experimental`)
surfaces before a `--db-url`/`--linked`/`--local` conflict is ever checked.

## Output

Diagnostics (target resolution, prompts, `Declarative schema written to <dir>`)
always go to stderr, in every `--output-format`. On success:

- `text` mode prints `Finished supabase db schema declarative generate.` to
  stdout (matches Go's PostRun `fmt.Println`, `cmd/db_schema_declarative.go:116-118`).
- `json`/`stream-json` mode instead emits a structured success envelope
  (`output.success("Finished supabase db schema declarative generate.")`) so
  the machine stdout payload isn't corrupted by a bare human line
  (`generate.command.ts:74-90`, CLI-1546 invariant).

## Notes

- Requires `--experimental` or `[experimental.pgdelta] enabled = true`.
- `--db-url` / `--linked` / `--local` are mutually exclusive; absent all three,
  smart mode prompts (existing-files overwrite → Local/Custom choice + reset offer).
- `--output <dir>` selects a destination for this invocation without changing
  config or activating it for later syncs.
- Under the legacy opt-out, remote Supabase targets get the embedded pg-delta CA
  bundle written under `supabase/.temp/pgdelta/` and the URL rewritten to
  `sslmode=verify-ca`; the bundled engine uses the shared connection/TLS behavior.
- **Architecture:** under the legacy opt-out, the platform baseline is provisioned by the
  bundled `supabase-go` via the hidden `db schema declarative __catalog` command
  (it runs `start.SetupDatabase`'s auth/storage/realtime service migrations). The
  bundled engine extracts and renders the target in-process.
