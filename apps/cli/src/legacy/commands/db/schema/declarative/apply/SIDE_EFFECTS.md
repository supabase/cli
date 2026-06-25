# `supabase db schema declarative apply`

Applies existing declarative schema files directly to the local database using
pg-delta. It does not create a timestamped migration file and does not update
local migration history.

## Files Read

| Path                                                                                                                        | Format     | When                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                                            | TOML       | always — pg-delta gate, local DB port/password     |
| `<workdir>/supabase/.temp/pgdelta-version`                                                                                  | plain text | always — pins the `@supabase/pg-delta` npm version |
| `<workdir>/supabase/.temp/edge-runtime-version`                                                                             | plain text | always — pins the edge-runtime image tag           |
| `<workdir>/supabase/database/**/*.sql` (declarative dir; configurable via `[experimental.pgdelta] declarative_schema_path`) | SQL        | always — must exist and is mounted read-only       |

## Files Written

| Path                         | Format | When                                            |
| ---------------------------- | ------ | ----------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always (in `Effect.ensuring`) at end of command |

This command does **not** write `supabase/migrations/*.sql` and does **not**
update migration history.

## Subprocesses / Containers

| Process                                                                                             | Condition                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `supabase-go db start` via the declarative seam                                                     | when the local database container is not running |
| Edge-runtime container (`supabase/edge-runtime`) running the pg-delta declarative-apply Deno script | always after validation                          |

## API Routes

None.

## Environment Variables

| Variable                     | Purpose                                          | Required? |
| ---------------------------- | ------------------------------------------------ | --------- |
| `PGDELTA_NPM_REGISTRY`       | private `@supabase` npm registry for pg-delta    | no        |
| `PGDELTA_DEBUG`              | verbose pg-delta diagnostics                     | no        |
| `SUPABASE_GO_BINARY`         | override the `supabase-go` seam binary           | no        |
| `SUPABASE_SERVICES_HOSTNAME` | local DB host (Go `GetHostname`)                 | no        |
| `DOCKER_HOST`                | tcp daemon host used as the local DB host backup | no        |

## Exit Codes

| Exit | Meaning                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- |
| `0`  | declarative schema applied successfully                                                           |
| `1`  | pg-delta disabled; no declarative files found; local database start failed; pg-delta apply failed |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

Text mode only; the command has no command-specific machine envelope. Global
`--output-format json` / `stream-json` error handling still emits the standard
wrapper error format on failures, but successful progress output remains stderr
text.

### `--output-format text` (Go CLI compatible)

Progress output is written to stderr:

- `Applying declarative schemas via pg-delta...`
- `Applied <n> statements in <r> round(s).`

Apply failures include pg-delta's structured status summary before returning an
error.

### `--output-format json` / `stream-json`

No success payload is emitted. Successful output remains the stderr text above.
On failure, the shared output wrapper emits its normal JSON / stream-json error.
