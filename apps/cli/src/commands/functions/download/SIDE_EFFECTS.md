# `supabase functions download [Function name]`

## Files Read

| Path                                                                                                                       | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/access-token`                                                                              | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `<SUPABASE_HOME or ~/.supabase>/profile`                                                                                   | plain text | when `--profile` and `SUPABASE_PROFILE` are both unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `<profile>.yaml`                                                                                                           | YAML       | when `SUPABASE_PROFILE` or `--profile` points to a file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `<workdir>/supabase/.temp/project-ref`                                                                                     | plain text | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `<workdir>/supabase/.temp/edge-runtime-version`                                                                            | plain text | Read unconditionally by `resolveEdgeRuntimeVersionPin()` in the handler, before the shared downloader chooses `--use-api` vs Docker — only affects the resolved edge-runtime image tag on the Docker-unbundle path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/{.env,.env.local,.env.<SUPABASE_ENV>,.env.<SUPABASE_ENV>.local}` and the same four at the project root | dotenv     | Docker-unbundle path only, before resolving config.toml — project dotenv (`resolveProjectEnvironmentValues`), merged into the `SUPABASE_*` overrides below and threaded into registry resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `<workdir>/supabase/config.toml`                                                                                           | TOML       | Read unconditionally after resolving the project ref, before checking `--use-api`/`--use-docker` or whether Docker is running — resolves `edge_runtime.deno_version` and `project_id` (`loadCliConfig`) for the Docker-unbundle path. `goViperCompat`'s `tomlOnly: true` means `config.json` is never read here, unlike other `loadCliConfig` callers. A malformed config fails here even on the `--use-api` invocation. Also runs the full `Config.Validate` pipeline (`resolveLocalConfigValues`, same one `start`/`stop`/`status` already use) — an invalid config (bad `db.major_version`, malformed auth hook, etc.) now fails the Docker-unbundle path up front, even for fields this command never otherwise reads. |
| `<workdir>/supabase/<auth.signing_keys_path>`, `[api.tls]` cert/key paths, email template `content_path` — when configured | varies     | Docker-unbundle path only, as part of the `Config.Validate` pipeline above — read even though this command never uses their contents; a `content_path` resolved path is CONFINED to the project root (symlinks dereferenced with `realpathSync`) before it is read, aborting with `resolves outside the project root` before any other work                                                                                                                                                                                                                                                                                                                                                                                |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`                                                                            | JSON       | when present, before post-run telemetry state is refreshed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Files Written

| Path                                                | Format | When                                                                                                                                                                              |
| --------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/functions/<slug>/<remote path>` | bytes  | for each source file returned by the API (`--use-api`, or the Docker-unbundle fallback when Docker isn't running)                                                                 |
| `<workdir>/supabase/.temp/output_<slug>.eszip`      | bytes  | Docker-unbundle path (default): downloaded eszip, extracted into `supabase/functions/<slug>/...` by the edge-runtime container; removed after the attempt unless `--debug` is set |
| `<workdir>/supabase/.temp/linked-project.json`      | JSON   | after resolving a project ref, cached on both success and failure paths                                                                                                           |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`     | JSON   | after command completion, flushed on both success and failure paths                                                                                                               |

## API Routes

| Method | Path                                       | Auth         | Request body | Response (used fields)                                                                                                                                                                                          |
| ------ | ------------------------------------------ | ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/functions`             | Bearer token | none         | function slugs, when downloading all                                                                                                                                                                            |
| `GET`  | `/v1/projects/{ref}/functions/{slug}`      | Bearer token | none         | entrypoint path, when absent from multipart metadata (`--use-api` path only)                                                                                                                                    |
| `GET`  | `/v1/projects/{ref}/functions/{slug}/body` | Bearer token | none         | `--use-api`: multipart function source (`Accept: multipart/form-data`). Docker-unbundle: raw eszip bytes; a `Content-Encoding: br` response is decoded transparently by the HTTP transport, not by this command |
| `GET`  | `/v1/projects`                             | Bearer token | none         | project picker options when no ref is supplied in TTY                                                                                                                                                           |
| `GET`  | `/v1/projects/{ref}`                       | Bearer token | none         | linked project metadata used by the post-run cache                                                                                                                                                              |

## Subprocesses

| Command                                                                                                                                                    | When                                            | Purpose                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker info`                                                                                                                                              | `--use-docker` (default), unless `--use-api`    | check whether Docker is running before choosing the Docker-unbundle downloader                                                                                                                                    |
| `docker image inspect <candidate>` (ECR, then GHCR, then Docker Hub)                                                                                       | Docker-unbundle path, when Docker is running    | check whether the edge-runtime image is already cached locally, tried in registry order, before the network/volume ensure                                                                                         |
| `docker pull <candidate>`                                                                                                                                  | Docker-unbundle path, cache miss on a candidate | pull with 2 retries (4s/8s backoff) before falling through to the next registry candidate                                                                                                                         |
| `docker network inspect` / `network create` / `volume create`                                                                                              | Docker-unbundle path, when Docker is running    | ensure the shared per-project network/named volume exist (same primitives as `functions deploy`'s Docker bundler); the Deno-cache volume is `supabase_edge_runtime_<project_id>` (mounted at `/root/.cache/deno`) |
| `docker run --rm ... --label com.supabase.cli.project=<id> --label com.docker.compose.project=<id> <edge-runtime image> unbundle --eszip ... --output ...` | Docker-unbundle path                            | extract the downloaded eszip into `supabase/functions/<slug>/...`; labeled so orphaned containers can be associated with the project                                                                              |

The Docker-unbundle path's own container stdout is routed to the real stdout
in text mode, to stderr in machine-output modes (CLI-1546).

## Environment Variables

| Variable                             | Purpose                                                                                                                                                                                                                                                                                                                                   | Required?                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`              | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                                                                      | no (falls back to keyring → `<SUPABASE_HOME or ~/.supabase>/access-token`)            |
| `SUPABASE_HOME`                      | overrides where `telemetry.json` and `profile` are read/written                                                                                                                                                                                                                                                                           | no (defaults to `~/.supabase`)                                                        |
| `SUPABASE_NO_KEYRING`                | disables the OS keyring, forcing the access-token file fallback                                                                                                                                                                                                                                                                           | no                                                                                    |
| `SUPABASE_PROFILE`                   | select a built-in profile or YAML profile file with `api_url:`                                                                                                                                                                                                                                                                            | no (falls back to `~/.supabase/profile` -> `supabase`)                                |
| `SUPABASE_PROJECT_ID`                | provides the project ref when `--project-ref` is unset; Docker-unbundle path: also read from project dotenv now (previously ambient-shell-only), overriding `project_id` for Docker network/volume/label naming and `Config.Validate`                                                                                                     | no (falls back to `<workdir>/supabase/.temp/project-ref`)                             |
| `SUPABASE_WORKDIR`                   | sets `<workdir>` for local Supabase temp files                                                                                                                                                                                                                                                                                            | no (falls back to `--workdir` -> nearest ancestor with `supabase/config.toml` -> cwd) |
| `SUPABASE_ENV`                       | Docker-unbundle path: selects environment-specific dotenv files (`.env.<env>.local`, `.env.<env>`)                                                                                                                                                                                                                                        | no (defaults to `development`)                                                        |
| `BITBUCKET_CLONE_DIR`                | Docker-unbundle path: when defined (including an empty value), skips creating the named Deno-cache volume and omits its bind mount from the `docker run` command (Bitbucket's restricted Docker environment rejects both)                                                                                                                 | no                                                                                    |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`   | selects the registry the edge-runtime unbundle image is pulled from (`getRegistryImageUrl`); read from the ambient shell **or** project dotenv (Docker-unbundle path); unset resolves ECR->GHCR->Docker-Hub candidates in order instead of a single URL — also consumed on the `--use-api` invocation even though it never pulls an image | no (defaults to `public.ecr.aws`)                                                     |
| `SUPABASE_USE_SLIM_IMAGES`           | Docker-unbundle path: resolves the edge-runtime unbundle image from the slim `ghcr.io/supabase/cli/edge-runtime` build (`true`/`1` enable); `deno_version = 1` and historical `.temp/edge-runtime-version` pins stay on docker.io                                                                                                         | no                                                                                    |
| `SUPABASE_NETWORK_ID`                | Docker-unbundle path: overrides the generated `supabase_network_<project>` Docker network name when `--network-id` isn't passed; read from the ambient shell or project dotenv                                                                                                                                                            | no                                                                                    |
| `SUPABASE_EDGE_RUNTIME_DENO_VERSION` | Docker-unbundle path: overrides `edge_runtime.deno_version` (which image tag to pull) when set, from the ambient shell or project dotenv — takes effect even with no `config.toml` on disk                                                                                                                                                | no                                                                                    |

## Exit Codes

| Code | Condition                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                           |
| `1`  | API error (non-2xx response)                                                                                      |
| `1`  | authentication error (no token found)                                                                             |
| `1`  | network / connection failure                                                                                      |
| `1`  | invalid function slug or flag conflict                                                                            |
| `1`  | Docker-unbundle container exited non-zero (suggests retrying with `--use-api`, or redeploying if that also fails) |
| `1`  | `--legacy-bundle` passed at all (any value, including `=false`) — removed, see Notes                              |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`project-ref` recorded verbatim, matching `functions list`/`delete`; `use-api`/`use-docker`/`legacy-bundle` also recorded verbatim since they are boolean flags; no flag on this command is currently redacted); a rejected `--legacy-bundle` fails with `error_fingerprint` ending in `:removed_flag` (`RemovedSurfaceError`) |

## Output

### `--output-format text`

Prints progress and success messages as functions are downloaded. The Docker-unbundle path prints
`Downloading function: <slug>` (lowercase "function", unlike the `--use-api` path's "Downloading
Function:") and does **not** print a final "Downloaded Function ... from project ..." line — that
line only appears on the `--use-api` path.

### `--output-format json`

Prints a structured success result with the downloaded function slugs and project ref. On the
Docker-unbundle path, the `unbundle` container's own stdout is routed to stderr instead of stdout
so it can't corrupt the envelope.

### `--output-format stream-json`

Same envelope as `json` above (including on the Docker-unbundle path).

## Notes

- If no function name is provided, downloads all functions.
- Requires a linked project (`--project-ref` or linked project config).
- The `--use-api` path rejects path traversal and symlink escapes before writing source files
  (`resolveDownloadDestination`/`ensureContainedPath`) — the Docker-unbundle path has no equivalent
  check of its own; it delegates the actual file writes to the `unbundle` subcommand running inside
  the edge-runtime container, through the `supabase/functions` bind mount — this is a pre-existing
  gap, not one introduced by this port. Slugs sourced from the Management API's function
  list (downloading-all) are validated against the same pattern as user-supplied slugs, on both
  paths, before any per-slug download runs (CLI-1891).
- `--use-docker` is a hidden flag but runs natively.
- `--use-docker` and `--use-api` are mutually exclusive.
- `--use-docker` defaults to `true`, so a bare `supabase functions download` runs the
  native Docker-unbundle downloader unless `--use-api` resolves to `true`, which forces the native
  server-side download path instead (the resolved flag value is what's checked, not presence —
  `--use-api=false` still runs Docker-unbundle).
- If Docker is not running, this command itself prints `WARNING: Docker is not running` to stderr
  and falls back to the native server-side unbundler — the command still exits `0` without Docker
  installed or running.
- The mutual-exclusivity check only counts flags the user explicitly passed on the command line,
  not `--use-docker`'s default value — so `--use-api` alone never trips the "mutually exclusive"
  error.
- Refreshes the linked-project telemetry cache and flushes telemetry state after resolving a
  project ref.

### `--legacy-bundle` is removed

The flag is removed: passing it (with any value, including `--legacy-bundle=false`) fails
with a removal error before any download, Docker, or API work runs. The suggestion reads:

```
Retry with `supabase functions download --use-api <slug>` to unbundle server-side without Docker.
```

It is checked before `--use-api`/`--use-docker` mutual-exclusivity validation, so combining
it with either still hits the removal error first.

The flag definition itself stays in `download.command.ts` (hidden from `--help`) only so
misuse produces this actionable error, with `error_fingerprint` ending in `:removed_flag`
(`RemovedSurfaceError`), instead of an unknown-flag parse error with no telemetry at all.

### Docker-extraction failure suggestion

Any Docker-unbundle failure (network/volume creation, container create/start, log
streaming, or a non-zero container exit) prints a suggestion leading with the
Docker-avoiding retry:

```
Retry with supabase functions download --use-api <slug> to unbundle server-side. If that also fails and the Function was deployed with a CLI older than 1.120.0, redeploy it with the current CLI.
```
