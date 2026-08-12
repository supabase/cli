# `supabase functions serve`

## Files Read

| Path                                                                                                                       | Format     | When                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                                           | TOML       | on every startup / restart when the project config exists                                                                                                                                                                                                                                                                     |
| `<workdir>/supabase/{.env,.env.local,.env.<SUPABASE_ENV>,.env.<SUPABASE_ENV>.local}` and the same four at the project root | dotenv     | on every startup / restart, a SECOND, independent read from the `env()`-interpolation one below — Go-parity project dotenv (`legacyResolveProjectEnvironmentValues`) feeding the `SUPABASE_*` overrides (network-id, deno-version, registry) and the `Config.Validate` pipeline, same one `start`/`stop`/`status` already use |
| `<workdir>/supabase/<auth.signing_keys_path>`, `[api.tls]` cert/key paths, email template `content_path` — when configured | varies     | on every startup / restart, as part of the `Config.Validate` pipeline above, unconditionally, matching Go's `Config.Load` — read even though `serve` doesn't otherwise use their contents                                                                                                                                     |
| `<workdir>/supabase/.temp/edge-runtime-version`                                                                            | plain text | when present, to override the bundled edge-runtime image tag                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/functions/.env`                                                                                        | dotenv     | when `--env-file` is unset and the fallback env file exists                                                                                                                                                                                                                                                                   |
| `<env-file>`                                                                                                               | dotenv     | when `--env-file` is set; relative paths resolve from the caller cwd                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/functions/*/index.ts`                                                                                  | TypeScript | to discover filesystem-backed functions                                                                                                                                                                                                                                                                                       |
| config-declared entrypoints / import maps / static files and imports                                                       | mixed      | for each enabled function while resolving Docker bind mounts                                                                                                                                                                                                                                                                  |
| `<signing_keys_path>`                                                                                                      | JSON       | when `auth.signing_keys_path` is configured                                                                                                                                                                                                                                                                                   |
| `apps/cli/src/shared/functions/serve.main.ts` (+ `serve-main-deps.ts`)                                                     | TypeScript | only when running from source (`bun src/supabase.ts`), bundled on demand; compiled binaries embed the pre-bundled template and read nothing                                                                                                                                                                                   |

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

| Variable                                      | Purpose                                                                                                                                                                                                                                                                                 | Required?                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `SUPABASE_PROFILE`                            | resolves the legacy profile / API base URL                                                                                                                                                                                                                                              | no (defaults to `supabase`)          |
| `SUPABASE_WORKDIR`                            | overrides the project workdir                                                                                                                                                                                                                                                           | no (falls back to CLI cwd discovery) |
| `SUPABASE_PROJECT_ID`                         | legacy config-service override for project identity                                                                                                                                                                                                                                     | no                                   |
| `SUPABASE_ENV`                                | selects environment-specific dotenv files (`.env.<env>.local`, `.env.<env>`)                                                                                                                                                                                                            | no (defaults to `development`)       |
| env vars referenced by `supabase/config.toml` | config interpolation; the full ambient `process.env` is layered under the project `.env*` files and passed to config loading                                                                                                                                                            | no                                   |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`            | overrides the edge-runtime Docker registry mirror; read from the ambient shell **or** project dotenv; unset resolves ECR->GHCR->Docker-Hub candidates in order instead of a single URL                                                                                                  | no (defaults to `public.ecr.aws`)    |
| `SUPABASE_NETWORK_ID`                         | overrides the generated `supabase_network_<project>` Docker network name when `--network-id` isn't passed; read from the ambient shell or project dotenv                                                                                                                                | no                                   |
| `SUPABASE_EDGE_RUNTIME_DENO_VERSION`          | overrides `edge_runtime.deno_version` (which image tag to pull) when set, from the ambient shell or project dotenv — takes effect even with no `config.toml` on disk                                                                                                                    | no                                   |
| `BITBUCKET_CLONE_DIR`                         | when set, skips creating the named Deno-cache volume and omits its bind mount from the edge-runtime `docker run` (Bitbucket's restricted Docker environment rejects both); a project-dotenv-only value is installed into `process.env` by config loading, matching Go's `loadNestedEnv` | no                                   |

## Exit Codes

| Code | Condition                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | clean shutdown after `SIGINT`, `SIGTERM`, or stdin close                                                                                                                           |
| `1`  | local DB container is not running, or the Docker daemon is unreachable (surfaces from the DB inspect as `failed to inspect service: …` plus the Docker Desktop install suggestion) |
| `1`  | invalid inspect flag combination, or a `Config.Validate` failure anywhere in `config.toml` (not just project/auth config)                                                          |
| `1`  | env file, signing key, import map, or function bind resolution failure                                                                                                             |
| `1`  | edge-runtime container startup, log streaming, or restart loop failure                                                                                                             |

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
- Config `env()` interpolation uses a project environment resolved by the command itself (ambient `process.env` layered under `.env.<env>.local` / `.env.local` / `.env.<env>` / `.env`, matching Go) and passed into `loadProjectConfig`. The command does not move/hide any project files. One `process.env` mutation exists: the Go-parity config pipeline (`legacyLoadLocalProjectContext`, shared with `deploy`/`download`/`start`) installs a project-dotenv-only `BITBUCKET_CLONE_DIR` into `process.env`, matching Go's `loadNestedEnv` `os.Setenv` behavior.
- Before each container (re)start, resolves the edge-runtime image through the same registry-candidate pull-with-retry every native `functions` Docker path uses: `docker image inspect <candidate>` (ECR, then GHCR, then Docker Hub) to check the local cache, then `docker pull <candidate>` with 2 retries (4s/8s backoff) on a miss, after `assertLocalDbRunning` — resolving it earlier would hijack the down-daemon error message that DB-inspect step is responsible for producing.
- Runs the full `Config.Validate` pipeline (`legacyResolveLocalConfigValues`, same one `start`/`stop`/`status` use) on every startup/restart, before `assertLocalDbRunning` — an invalid config now fails `serve` up front even for fields this command never otherwise reads (e.g. a bad `db.major_version` or malformed auth hook), matching Go's `flags.LoadConfig` -> `Config.Validate`.
- A container crash terminates the command with a non-zero exit; only a watched-file change restarts the container. The Go CLI never auto-restarts a crashed container.
- The worker bootstrap template (`serve.main.ts`) is bundled into a single self-contained module with `jose` and the local path/status helpers inlined, so the edge-runtime worker boots without any network access (supabase/supabase#45570). The bundle is embedded at build time for shipped binaries and produced on demand (esbuild) when running from source.
- **Intentional divergence from Go — spec-strict import-map key matching (CLI-2179, ruled 2026-08-12):** bind mounts are computed by the functions import scanner (`walkImportPaths`/`substituteImportMapValue`, shared with `functions deploy` and `start`'s Edge Runtime bring-up), which matches import-map keys per the import-maps spec Deno/edge-runtime implement — exact match, or prefix match only for a `/`-suffixed key — instead of Go's any-key `strings.HasPrefix` (`pkg/function/deno.go:150-155`). Bind mounts may shrink vs the Go CLI for maps that relied on bare-key prefix matching; an unwalkable target (`ENOTDIR` — a value routed through a file) is skipped with a `WARN`.
