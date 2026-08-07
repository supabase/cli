# `supabase db schema declarative sync`

Diffs local migrations state against declarative schema files and writes the delta
as a new timestamped migration.

## Pg-delta implementation and compatibility

- The default pg-delta and bundled pg-topo run in-process at the versions fixed
  when the CLI is built. There is no runtime download or automatic fallback.
- `SUPABASE_USE_PG_DELTA_NEXT=false` selects the legacy catalog/edge-runtime
  implementation. `supabase/.temp/pgdelta-version`, `PGDELTA_NPM_REGISTRY`, and
  catalogs directly below `supabase/.temp/pgdelta/` are legacy-only.
- `--no-cache` bypasses legacy catalog reuse/warming. The default engine always
  extracts current state and maintains no reusable catalog cache.
- With `PGDELTA_DEBUG`, default-engine snapshots, plan, and diagnostics are
  written below `supabase/.temp/pgdelta/v2/debug/<id>/` and are not reusable.
- The default engine refuses to emit a migration when extraction or declarative
  loading reports an error or a strict coverage gap (`unmodeled_kind` or
  `unresolved_security_label`). The refusal names the diagnostic, and debug
  artifacts are saved first when capture is enabled.
- Default-engine migrations may differ byte-for-byte and may be split into
  ordered files to preserve transaction boundaries. Successful execution and an
  empty subsequent sync are the compatibility contract.

## Files Read

| Path                                                     | Format     | When                                                    |
| -------------------------------------------------------- | ---------- | ------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                         | TOML       | always — pg-delta gate, format options                  |
| `<workdir>/supabase/.temp/pgdelta-version`               | plain text | always read for compatibility; affects legacy only      |
| `<workdir>/supabase/.temp/edge-runtime-version`          | plain text | legacy opt-out only — edge-runtime image tag            |
| `<workdir>/supabase/database/**/*.sql` (declarative dir) | SQL        | always — must exist (else error)                        |
| `<workdir>/supabase/migrations/*.sql`                    | SQL        | default: applied to live shadow; legacy: catalog source |
| `<workdir>/supabase/database/.pgdelta-export.json`       | JSON       | default-engine export policy, when present              |
| `<workdir>/supabase/.temp/pgdelta/*.json`                | JSON       | legacy opt-out only: catalog cache                      |

## Files Written

| Path                                                               | Format | When                                              |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------- |
| `<workdir>/supabase/migrations/<timestamp>_<name>[_<segment>].sql` | SQL    | changes; default engine may emit ordered segments |
| `<workdir>/supabase/.temp/pgdelta/catalog-*.json`                  | JSON   | legacy opt-out only: catalog cache                |
| `<workdir>/supabase/.temp/pgdelta/v2/debug/<id>/*.json`            | JSON   | default engine with `PGDELTA_DEBUG`               |

## Subprocesses / Containers

| What                                                                                                                                                                                                 | When                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `supabase-go db __shadow` / declarative shadow seam — platform baseline plus migrations and clean declarative target                                                                                 | default engine                                                    |
| `supabase-go db schema declarative __catalog` migrations/declarative catalog seams                                                                                                                   | legacy opt-out only                                               |
| Edge-runtime container running the pg-delta diff Deno script                                                                                                                                         | legacy opt-out only                                               |
| `supabase-go db reset --local [--network-id <id>]` (seam) — only on the failed-apply recovery path; `db reset` is still Go-proxied (`wrapped`), so the reset itself shells out to the bundled binary | TTY only, apply failed, and the user confirms "reset and reapply" |

## Environment Variables

| Variable                     | Purpose                                                     | Required? |
| ---------------------------- | ----------------------------------------------------------- | --------- |
| `SUPABASE_USE_PG_DELTA_NEXT` | set to `false` for the legacy edge-runtime engine           | no        |
| `PGDELTA_NPM_REGISTRY`       | legacy opt-out only: private npm registry                   | no        |
| `PGDELTA_DEBUG`              | structured default-engine debug artifacts                   | no        |
| `SUPABASE_GO_BINARY`         | override the `supabase-go` seam binary                      | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host for the bootstrap generate (Go `GetHostname`) | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host fallback          | no        |

## Exit Codes

| Code | Condition                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | success (migration created, applied, or "No schema changes found")                                  |
| `1`  | pg-delta not enabled                                                                                |
| `1`  | conflicting `--apply`/`--no-apply` (mutually exclusive)                                             |
| `1`  | no declarative schema files found                                                                   |
| `1`  | shadow-database / selected pg-delta engine / diff failure                                           |
| `1`  | apply failure (when applied) — propagated from the native migration apply (`applyMigrationToLocal`) |

The pg-delta gate and the mutex check are both raised before any side effects run,
but the gate wins when both conditions apply simultaneously: Go's
`PersistentPreRunE` runs before `ValidateFlagGroups()`
(`cobra@v1.10.2/command.go:985,1010`), so a closed gate (missing `--experimental`)
surfaces before an `--apply`/`--no-apply` conflict is ever checked.

## Output

Text mode only. The generated SQL, the created-migration path, drop-statement
warnings, and apply status are written to stderr. The no-files bootstrap also
prints `Declarative schema written to <dir>` (the relative declarative dir, Go's
`GetDeclarativeDir()`) to stderr after generation and writing. Under the legacy
opt-out it prints after catalog warming — on both interactive and `--yes` paths.
`--no-apply` writes the migration only (never prompts/applies); `--apply` applies
without prompting; both override the global `--yes`. `--no-apply` and `--apply`
are mutually exclusive.

## Notes

- Requires `--experimental` or `[experimental.pgdelta] enabled = true`.
- The declarative directory is the complete, hand-authored desired state. An
  object omitted from it is intended to be removed, including extensions. This
  is deterministic regardless of whether the directory was generated, written
  by hand, or has a `.pgdelta-export.json` manifest.
- Projects upgrading from the legacy workflow should regenerate declarations or
  add declarations for every extension they intend to retain before syncing.
  Review the existing drop-statement warning before applying destructive changes.
- `--file` sets the migration filename stem (default `declarative_sync`); `--name`
  overrides it. In a TTY without `--name`/`--yes`, the name is prompted.
- When no declarative files exist, a TTY offers to generate them (from local) first.
- The migration apply is native (connects to the local DB and records migration
  history). On apply failure a debug bundle is written under
  `supabase/.temp/pgdelta/debug/` and, in a TTY, a reset-and-reapply is offered
  (the reset itself runs the bundled `supabase-go db reset --local`, since
  `db reset` is still `wrapped`).
- **Architecture:** the bundled `supabase-go` provisions the two shadow databases;
  the default engine applies declarative SQL and plans/renders the migration
  in-process. The opt-out preserves the hidden legacy catalog seams and Deno script.
