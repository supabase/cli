# `supabase db schema declarative generate`

Generates declarative schema files from a database using pg-delta's managed
platform view.

## Pg-delta implementation and compatibility

- The default pg-delta engine runs in-process. Pg-delta and pg-topo are bundled
  into the CLI binary at build time, so the installed CLI fixes their version and
  performs no runtime package download or automatic legacy fallback.
- `SUPABASE_USE_PG_DELTA_NEXT=false` selects the legacy catalog/edge-runtime
  implementation. Only that opt-out uses `supabase/.temp/pgdelta-version`,
  `PGDELTA_NPM_REGISTRY`, edge-runtime, or legacy catalogs directly below
  `supabase/.temp/pgdelta/`.
- `--no-cache` bypasses legacy catalog reuse/warming. The default engine already
  extracts live state and has no reusable catalog cache, so the flag does not
  change its extraction behavior.
- With `PGDELTA_DEBUG`, default-engine export diagnostics are written below
  `supabase/.temp/pgdelta/v2/debug/<id>/`; they are never reused as catalogs.
- The default engine refuses an export when extraction reports an error or a
  strict coverage gap (`unmodeled_kind` or `unresolved_security_label`). The
  refusal names the diagnostic, and debug artifacts are saved first when capture
  is enabled.
- Generated SQL bytes and grouping may differ between engines. Reloading the
  export to the same managed state is the compatibility contract.

## Files Read

| Path                                            | Format     | When                                               |
| ----------------------------------------------- | ---------- | -------------------------------------------------- |
| `<workdir>/supabase/config.toml`                | TOML       | always — pg-delta gate, ports, format options      |
| `<workdir>/supabase/.temp/pgdelta-version`      | plain text | always read for compatibility; affects legacy only |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | legacy opt-out only — edge-runtime image tag       |
| `<workdir>/supabase/.temp/postgres-version`     | plain text | shadow-DB image resolution (Go seam)               |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | smart mode — detect whether migrations exist       |
| `<workdir>/supabase/.temp/pgdelta/*.json`       | JSON       | legacy opt-out only: catalog cache                 |
| `~/.supabase/access-token`                      | plain text | `--linked` (token resolution)                      |

## Files Written

| Path                                                                                                                        | Format | When                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| `<workdir>/supabase/database/**/*.sql` (declarative dir; configurable via `[experimental.pgdelta] declarative_schema_path`) | SQL    | always — the entire dir is wiped + rewritten |
| `<workdir>/supabase/database/.pgdelta-export.json`                                                                          | JSON   | default-engine export policy/manifest        |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                                                                           | JSON   | legacy opt-out only: catalog cache           |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`                                                                     | JSON   | default engine with `PGDELTA_DEBUG`          |

## Subprocesses / Containers

| What                                                                                                                              | When                                                           |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `supabase-go db schema declarative __catalog --mode baseline --experimental` — provisions and exports the legacy baseline catalog | legacy opt-out only                                            |
| Edge-runtime container running the pg-delta declarative-export Deno script                                                        | legacy opt-out only                                            |
| `supabase-go db reset --local`                                                                                                    | smart-mode Local choice when reset is confirmed (or `--reset`) |

## Environment Variables

| Variable                     | Purpose                                            | Required? |
| ---------------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_ACCESS_TOKEN`      | auth token for `--linked`                          | no        |
| `DB_PASSWORD`                | password for `--linked` / `--db-url`               | no        |
| `SUPABASE_USE_PG_DELTA_NEXT` | set to `false` for the legacy edge-runtime engine  | no        |
| `PGDELTA_NPM_REGISTRY`       | legacy opt-out only: private npm registry          | no        |
| `PGDELTA_DEBUG`              | structured default-engine debug artifacts          | no        |
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
- The default engine preserves the shared direct/pooler, DNS, TLS, and client
  certificate connection behavior. The legacy opt-out retains its embedded CA
  file and `sslmode=verify-ca` URL rewrite.
- **Architecture:** the default engine extracts the target directly using the
  bundled Supabase management profile, then renders and writes the export
  in-process. Under the opt-out, Go provisions/exports a legacy baseline catalog
  and edge-runtime runs the Deno script.
