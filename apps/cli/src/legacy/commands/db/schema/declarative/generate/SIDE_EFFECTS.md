# `supabase db schema declarative generate`

Generates declarative schema files from a database by diffing a platform-baseline
pg-delta catalog (source) against the target database's catalog (target).

## Files Read

| Path                                            | Format     | When                                               |
| ----------------------------------------------- | ---------- | -------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML       | always — pg-delta gate, ports, format options      |
| `<workdir>/supabase/.temp/pgdelta-version`      | plain text | always — pins the `@supabase/pg-delta` npm version |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | always — pins the edge-runtime image tag           |
| `<workdir>/supabase/.temp/postgres-version`     | plain text | shadow-DB image resolution                         |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | smart mode — detect whether migrations exist       |
| `<workdir>/supabase/.temp/pgdelta/*.json`       | JSON       | catalog cache (read/written natively)              |
| `~/.supabase/access-token`                      | plain text | `--linked` (token resolution)                      |

## Files Written

| Path                                                                                                                        | Format | When                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| `<workdir>/supabase/database/**/*.sql` (declarative dir; configurable via `[experimental.pgdelta] declarative_schema_path`) | SQL    | always — the entire dir is wiped + rewritten |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                                                                           | JSON   | catalog cache (written natively)             |

## Subprocesses / Containers

| What                                                                                                                                                                                                                                                        | When                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Natively-provisioned shadow Postgres container (create, health-wait, platform-baseline setup via one-shot auth/storage/realtime migrate jobs, then remove) — the same primitives `db diff`/`db pull` use for their own shadow, exports the baseline catalog | always                                                         |
| Edge-runtime container (`supabase/edge-runtime`) running the pg-delta declarative-export Deno script (host network, deno-cache volume `supabase_edge_runtime_<projectId>`)                                                                                  | always                                                         |
| `docker`/`podman` container recreate for the local `db` (+ satellite restarts, Kong reload) — the same primitives `db start`/`db reset` use, via `legacyResetLocalDatabase`                                                                                 | smart-mode Local choice when reset is confirmed (or `--reset`) |

## Environment Variables

| Variable                     | Purpose                                            | Required? |
| ---------------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for `--linked`                          | no        |
| `DB_PASSWORD`                | password for `--linked` / `--db-url`               | no        |
| `PGDELTA_NPM_REGISTRY`       | private `@supabase` npm registry for pg-delta      | no        |
| `PGDELTA_DEBUG`              | verbose pg-delta diagnostics                       | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for `--local`                        | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback | no        |

## Exit Codes

| Code | Condition                                                             |
| ---- | --------------------------------------------------------------------- |
| `0`  | success (files written, or skipped after a declined prompt)           |
| `1`  | pg-delta not enabled (no `--experimental` / `[experimental.pgdelta]`) |
| `1`  | conflicting `--db-url`/`--linked`/`--local` (mutually exclusive)      |
| `1`  | non-interactive mode with no explicit target                          |
| `1`  | shadow-database / edge-runtime / export failure                       |

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
- Remote Supabase targets (`--linked` / `--db-url`) get the embedded pg-delta CA
  bundle written under `supabase/.temp/pgdelta/` and the URL rewritten to
  `sslmode=verify-ca`; local / non-Supabase targets connect without it.
- **Architecture:** fully native (CLI-1970). The shadow-database platform baseline is
  provisioned in-process (create the shadow container, wait for health, run the
  auth/storage/realtime one-shot migrate jobs, export the catalog, remove the
  container) — the same primitives `db diff`/`db pull` use for their own shadow.
  Orchestration, pg-delta diff/export, file writes, and prompts are also native.
