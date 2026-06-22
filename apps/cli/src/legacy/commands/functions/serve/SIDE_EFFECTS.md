# `supabase functions serve`

## Files Read

| Path                                                                 | Format     | When                                                                 |
| -------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                     | TOML       | on every startup / restart when the project config exists            |
| `<workdir>/supabase/.temp/edge-runtime-version`                      | plain text | when present, to override the bundled edge-runtime image tag         |
| `<workdir>/supabase/functions/.env`                                  | dotenv     | when `--env-file` is unset and the fallback env file exists          |
| `<env-file>`                                                         | dotenv     | when `--env-file` is set; relative paths resolve from the caller cwd |
| `<workdir>/supabase/functions/*/index.ts`                            | TypeScript | to discover filesystem-backed functions                              |
| config-declared entrypoints / import maps / static files and imports | mixed      | for each enabled function while resolving Docker bind mounts         |
| `<signing_keys_path>`                                                | JSON       | when `auth.signing_keys_path` is configured                          |
| `apps/cli/src/shared/functions/serve.main.ts`                        | TypeScript | as the CLI-owned worker bootstrap template source                    |

## Files Written

| Path                         | Format | When                                          |
| ---------------------------- | ------ | --------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always, at command exit via `Effect.ensuring` |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| `—`    | `—`  | `—`  | `—`          | `—`                    |

## Environment Variables

| Variable                                      | Purpose                                                    | Required?                            |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `SUPABASE_PROFILE`                            | resolves the legacy profile / API base URL                 | no (defaults to `supabase`)          |
| `SUPABASE_WORKDIR`                            | overrides the project workdir                              | no (falls back to CLI cwd discovery) |
| `SUPABASE_PROJECT_ID`                         | legacy config-service override for project identity        | no                                   |
| env vars referenced by `supabase/config.toml` | config interpolation through `loadProjectEnvironment(...)` | no                                   |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`            | overrides the edge-runtime Docker registry mirror          | no (defaults to `public.ecr.aws`)    |

## Exit Codes

| Code | Condition                                                              |
| ---- | ---------------------------------------------------------------------- |
| `0`  | clean shutdown after `SIGINT`, `SIGTERM`, or stdin close               |
| `1`  | Docker unavailable / `docker info` fails                               |
| `1`  | local DB container is not running                                      |
| `1`  | invalid inspect flag combination or invalid project/auth config        |
| `1`  | env file, signing key, import map, or function bind resolution failure |
| `1`  | edge-runtime container startup, log streaming, or restart loop failure |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` (Go CLI compatible)

Writes lifecycle text to stderr / stdout while the command is running:

- `Setting up Edge Functions runtime...` before each container start
- `Skipped serving Function: <slug>` for disabled functions
- `File change detected: <path> (<op>)` when a watched file triggers a restart
- live `docker logs -f --timestamps` output from the edge-runtime container
- `Stopped serving supabase/functions` on clean shutdown

### `--output-format json`

Long-running raw log / error output only; there is no final success payload object for this command.

### `--output-format stream-json`

Long-running raw log / error events only; there is no terminal `result` event on success.

## Notes

- The hidden `--all` flag is still parsed but ignored; the native port always serves every discovered function, matching the Go command.
- Each restart re-reads config, rebuilds per-function bind mounts, recreates the `supabase_edge_runtime_<project>` container, and best-effort reloads Kong afterwards.
- The command creates or reuses Docker resources derived from the resolved project id:
  - container: `supabase_edge_runtime_<project>`
  - named volume: `supabase_edge_runtime_<project>`
  - network: `supabase_network_<project>` unless `--network-id` overrides it
- Inspector mode exposes the configured `edge_runtime.inspector_port` on the host and sets `SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=0`, matching the Go serve path.
