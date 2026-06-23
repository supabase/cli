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

| Path                                                  | Format      | When                                                                                                                                |
| ----------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/telemetry.json`                          | JSON        | always, at command exit via `Effect.ensuring`                                                                                       |
| `<tmpdir>/supabase-functions-serve-env-*/docker.env`  | dotenv      | per start, when single-line container env exists; passed via `--env-file`; mode `0600`; removed after the run                       |
| `<tmpdir>/supabase-functions-serve-multiline-env-*/…` | shell + raw | per start, only when an env value contains a newline; bind-mounted read-only into the container; mode `0600`; removed after the run |

The env files hold secrets (JWT secret, anon/service-role keys, JWKS), so they are
written owner-only (`0600`) and cleaned up after the container exits. On `SIGKILL`
(which bypasses cleanup) a temp directory under `<tmpdir>` may be orphaned; the OS
temp directory is the only place affected — the project directory is never modified.

## API Routes

Management API: none. When a third-party auth provider (`auth.third_party.*`) is
enabled, two outbound HTTPS GETs are made per start to build `SUPABASE_JWKS`:

| Method | Path                                            | Auth | Request body | Response (used fields) |
| ------ | ----------------------------------------------- | ---- | ------------ | ---------------------- |
| `GET`  | `<issuer_url>/.well-known/openid-configuration` | none | `—`          | `jwks_uri`             |
| `GET`  | `<jwks_uri>` (from discovery)                   | none | `—`          | `keys`                 |

Both fetches use a 10s timeout and are best-effort: failure logs nothing and falls
back to local keys (matching the Go CLI, which ignores the error). No scheme/host
validation is performed on the discovered URLs, also matching the Go CLI.

## Environment Variables

| Variable                                      | Purpose                                                                                                                      | Required?                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `SUPABASE_PROFILE`                            | resolves the legacy profile / API base URL                                                                                   | no (defaults to `supabase`)          |
| `SUPABASE_WORKDIR`                            | overrides the project workdir                                                                                                | no (falls back to CLI cwd discovery) |
| `SUPABASE_PROJECT_ID`                         | legacy config-service override for project identity                                                                          | no                                   |
| `SUPABASE_ENV`                                | selects environment-specific dotenv files (`.env.<env>.local`, `.env.<env>`)                                                 | no (defaults to `development`)       |
| env vars referenced by `supabase/config.toml` | config interpolation; the full ambient `process.env` is layered under the project `.env*` files and passed to config loading | no                                   |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`            | overrides the edge-runtime Docker registry mirror                                                                            | no (defaults to `public.ecr.aws`)    |

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
- Config `env()` interpolation uses a project environment resolved by the command itself (ambient `process.env` layered under `.env.<env>.local` / `.env.local` / `.env.<env>` / `.env`, matching Go) and passed into `loadProjectConfig`. The command does not mutate `process.env` or move/hide any project files.
- A container crash terminates the command with a non-zero exit; only a watched-file change restarts the container. The Go CLI never auto-restarts a crashed container.
