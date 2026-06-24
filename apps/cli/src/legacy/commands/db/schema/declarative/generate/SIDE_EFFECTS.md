# `supabase db schema declarative generate`

Generates declarative schema files from a database by diffing a platform-baseline
pg-delta catalog (source) against the target database's catalog (target).

## Files Read

| Path                                            | Format     | When                                               |
| ----------------------------------------------- | ---------- | -------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML       | always — pg-delta gate, ports, format options      |
| `<workdir>/supabase/.temp/pgdelta-version`      | plain text | always — pins the `@supabase/pg-delta` npm version |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | always — pins the edge-runtime image tag           |
| `<workdir>/supabase/.temp/postgres-version`     | plain text | shadow-DB image resolution (Go seam)               |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | smart mode — detect whether migrations exist       |
| `<workdir>/supabase/.temp/pgdelta/*.json`       | JSON       | catalog cache (read/written by the Go seam)        |
| `~/.supabase/access-token`                      | plain text | `--linked` (token resolution)                      |

## Files Written

| Path                                                                                                                        | Format | When                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| `<workdir>/supabase/database/**/*.sql` (declarative dir; configurable via `[experimental.pgdelta] declarative_schema_path`) | SQL    | always — the entire dir is wiped + rewritten |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                                                                           | JSON   | catalog cache (written by the Go seam)       |

## Subprocesses / Containers

| What                                                                                                                                                                            | When                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `supabase-go db schema declarative __catalog --mode baseline --experimental` (hidden seam) — provisions a shadow Postgres + `start.SetupDatabase`, exports the baseline catalog | always                                                         |
| Edge-runtime container (`supabase/edge-runtime`) running the pg-delta declarative-export Deno script (host network, deno-cache volume `supabase_edge_runtime_<projectId>`)      | always                                                         |
| `supabase-go db reset --local`                                                                                                                                                  | smart-mode Local choice when reset is confirmed (or `--reset`) |

## Environment Variables

| Variable                     | Purpose                                            | Required? |
| ---------------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for `--linked`                          | no        |
| `DB_PASSWORD`                | password for `--linked` / `--db-url`               | no        |
| `PGDELTA_NPM_REGISTRY`       | private `@supabase` npm registry for pg-delta      | no        |
| `PGDELTA_DEBUG`              | verbose pg-delta diagnostics                       | no        |
| `SUPABASE_GO_BINARY`         | override the `supabase-go` seam binary             | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for `--local` (Go `GetHostname`)     | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback | no        |

## Exit Codes

| Code | Condition                                                             |
| ---- | --------------------------------------------------------------------- |
| `0`  | success (files written, or skipped after a declined prompt)           |
| `1`  | conflicting `--db-url`/`--linked`/`--local` (mutually exclusive)      |
| `1`  | pg-delta not enabled (no `--experimental` / `[experimental.pgdelta]`) |
| `1`  | non-interactive mode with no explicit target                          |
| `1`  | shadow-database / edge-runtime / export failure                       |

## Output

Text mode only (no machine envelope). Diagnostics + the final
`Declarative schema written to <dir>` go to stderr; the PostRun prints
`Finished supabase db schema declarative generate.` to stdout on success.

## Notes

- Requires `--experimental` or `[experimental.pgdelta] enabled = true`.
- `--db-url` / `--linked` / `--local` are mutually exclusive; absent all three,
  smart mode prompts (existing-files overwrite → Local/Custom choice + reset offer).
- Remote Supabase targets (`--linked` / `--db-url`) get the embedded pg-delta CA
  bundle written under `supabase/.temp/pgdelta/` and the URL rewritten to
  `sslmode=verify-ca`; local / non-Supabase targets connect without it.
- **Architecture:** the shadow-database platform baseline is provisioned by the
  bundled `supabase-go` via the hidden `db schema declarative __catalog` command
  (it runs `start.SetupDatabase`'s auth/storage/realtime service migrations). The
  rest — orchestration, pg-delta diff/export, file writes, prompts — is native.
