# `supabase db start`

Native TS port of `apps/cli-go/internal/db/start/start.go` `Run`. The handler
validates config, checks whether the local Postgres container is already running,
and otherwise delegates the container bootstrap to the bundled Go binary's hidden
`db __db-bootstrap --mode start` seam (the container-lifecycle primitives are not
ported). This is `db start`, **not** the top-level `supabase start`: no status
table, no `cli_stack_started` event, no `Finished` line.

## Files Read

| Path                             | Format | When                                                            |
| -------------------------------- | ------ | --------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always — parsed up front; a malformed config aborts before work |
| `<path>` (from `--from-backup`)  | binary | when `--from-backup` is set (read by the Go seam on start)      |

## Files Written

| Path                                           | Format | When                                                                        |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `<workdir>/supabase/.branches/_current_branch` | text   | by the Go seam (`initCurrentBranch`) when starting; writes `main` if absent |
| local Docker volume `supabase_db_<project>`    | —      | by the Go seam — the Postgres data volume created on first start            |
| `~/.supabase/telemetry.json`                   | JSON   | always (telemetry flush, success and failure)                               |

## Subprocesses

| Command                                                          | When                             | Purpose                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker container inspect supabase_db_<project>`                 | always                           | `AssertSupabaseDbIsRunning` probe (Podman fallback)                                                                                                                       |
| `supabase-go db __db-bootstrap --mode start [--from-backup <p>]` | when the database is not running | create container + health check + initial schema/roles/migrations/seed + `_current_branch`; telemetry disabled (`SUPABASE_TELEMETRY_DISABLED=1`), progress teed to stderr |

`--network-id` and a flag-selected `--profile` are forwarded to the seam.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

(The Go seam may call Auth's JWKS endpoint while applying service migrations on a
fresh PG15 volume; that is internal to the seam, not the TS handler.)

## Environment Variables

| Variable                      | Purpose                                              | Required?  |
| ----------------------------- | ---------------------------------------------------- | ---------- |
| `SUPABASE_PROJECT_ID`         | overrides the local container id (`utils.DbId`)      | no         |
| `SUPABASE_TELEMETRY_DISABLED` | set on the seam subprocess so it never double-counts | (internal) |

## Exit Codes

| Code | Condition                                                             |
| ---- | --------------------------------------------------------------------- |
| `0`  | success — database started, or already running                        |
| `1`  | malformed `supabase/config.toml`                                      |
| `1`  | Docker daemon unreachable / inspect failure                           |
| `1`  | container bootstrap failed (the seam cleans up via `DockerRemoveAll`) |

## Output

### `--output-format text` (Go CLI compatible)

- Already running → `Postgres database is already running.` on **stderr**, exit 0.
- Starting → the Go seam tees `Starting database...` / `Initialising schema...` to
  **stderr**. No stdout output, no `Finished` line.

### `--output-format json`

Emits a single result object to stdout: `{ status: "already-running" }` or
`{ status: "started" }`. Progress stays on stderr.

### `--output-format stream-json`

Same result object as the terminal `result` event; progress on stderr.

## Notes

- `--from-backup` restores the database from a logical backup file on start; the
  health check is skipped for backups (a large restore can exceed the timeout).
- No `cli_stack_started` telemetry — that event belongs to `supabase start`, not
  `db start`. The only event is the standard `cli_command_executed`.
