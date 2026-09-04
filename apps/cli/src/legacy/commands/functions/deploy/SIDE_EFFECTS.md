# `supabase functions deploy [Function name]`

## Files Read

| Path                                                                                                                       | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                                                                                                 | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                                                                                                                                                                                                                                                                                              |
| `<workdir>/supabase/{.env,.env.local,.env.<SUPABASE_ENV>,.env.<SUPABASE_ENV>.local}` and the same four at the project root | dotenv     | project dotenv (`legacyResolveProjectEnvironmentValues`), merged into the `SUPABASE_*` overrides below and threaded into registry resolution                                                                                                                                                                                                                                                                                            |
| `<workdir>/supabase/config.toml`                                                                                           | TOML       | to resolve function config, project id, and local Functions — via `goConfigCompat`'s `tomlOnly: true`/`search: false` (same resolver `start`/`stop`/`status` use), so `config.json` is never read here and no ancestor directory is searched past `<workdir>`; also runs the full `Config.Validate` pipeline (`legacyResolveLocalConfigValues`), so an invalid config fails up front even for fields this command never otherwise reads |
| `<workdir>/supabase/<auth.signing_keys_path>`, `[api.tls]` cert/key paths, email template `content_path` — when configured | varies     | as part of the `Config.Validate` pipeline above, unconditionally                                                                                                                                                                                                                                                                                                                                                                        |
| `<workdir>/supabase/functions/<slug>/index.ts`                                                                             | TypeScript | function source to deploy                                                                                                                                                                                                                                                                                                                                                                                                               |
| `<workdir>/supabase/functions/**/deno.json*`                                                                               | JSON/JSONC | when resolving import maps                                                                                                                                                                                                                                                                                                                                                                                                              |
| imported modules                                                                                                           | TypeScript | when walking local import graphs for deploy uploads/bundles                                                                                                                                                                                                                                                                                                                                                                             |
| configured static files                                                                                                    | any        | when `static_files` patterns match local files                                                                                                                                                                                                                                                                                                                                                                                          |
| `package.json` next to function entrypoint                                                                                 | JSON       | Docker bundling package discovery                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/functions/import_map.json`                                                                             | JSON       | deprecated fallback import map discovery                                                                                                                                                                                                                                                                                                                                                                                                |

## Files Written

| Path                                                   | Format | When                                  |
| ------------------------------------------------------ | ------ | ------------------------------------- |
| system temporary directory                             | ESZIP  | during Docker bundling; removed after |
| linked-project cache and pending telemetry state files | JSON   | during command post-run cleanup       |

## Subprocesses

| Command                                                                                                 | When                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker info`                                                                                           | to detect whether explicitly selected local Docker bundling can run                                                                                                                                                                                                                                                                                                                                                   |
| `docker image inspect <candidate>` (ECR, then GHCR, then Docker Hub)                                    | Docker bundling: check whether the edge-runtime image is already cached locally, tried in registry order, before the network/volume ensure                                                                                                                                                                                                                                                                            |
| `docker pull <candidate>`                                                                               | Docker bundling, cache miss on a candidate: pull with 2 retries (4s/8s backoff) before falling through to the next registry candidate; the edge-runtime image at its current Dockerfile pin, not a version-pinned, slim, or `SUPABASE_INTERNAL_IMAGE_REGISTRY`-overridden one, pulls `<candidate>@<digest>` instead, with no retry once the registry rejects the digest, and is then `docker tag`ged as `<candidate>` |
| `docker run --rm ... --label com.supabase.cli.project=<id> --label com.docker.compose.project=<id> ...` | when Docker bundling is selected/available; labeled so orphaned containers can be associated with the project                                                                                                                                                                                                                                                                                                         |

Docker bundling may pull or run the configured edge-runtime image and uses the
`supabase_edge_runtime_<project_id>` Deno cache volume (mounted at
`/root/.cache/deno`).

## API Routes

| Method   | Path                                  | Auth         | Request body            | Response (used fields) |
| -------- | ------------------------------------- | ------------ | ----------------------- | ---------------------- |
| `GET`    | `/v1/projects/{ref}/functions`        | Bearer token | none                    | `[{ slug, ... }]`      |
| `POST`   | `/v1/projects/{ref}/functions/deploy` | Bearer token | multipart source upload | `{ id, slug, ... }`    |
| `POST`   | `/v1/projects/{ref}/functions`        | Bearer token | bundled function body   | `{ id, slug, ... }`    |
| `PATCH`  | `/v1/projects/{ref}/functions/{slug}` | Bearer token | bundled function body   | `{ id, slug, ... }`    |
| `PUT`    | `/v1/projects/{ref}/functions`        | Bearer token | bulk update payload     | `{ functions: [...] }` |
| `DELETE` | `/v1/projects/{ref}/functions/{slug}` | Bearer token | none                    | ignored on `200/404`   |

## Environment Variables

| Variable                             | Purpose                                                                                                                                                                                                                                                               | Required?                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`              | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`                | optional project ref fallback; also read from project dotenv now (previously ambient-shell-only)                                                                                                                                                                      | no                                                      |
| `SUPABASE_ENV`                       | selects environment-specific dotenv files (`.env.<env>.local`, `.env.<env>`)                                                                                                                                                                                          | no (defaults to `development`)                          |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY`   | selects the Functions bundler image registry; read from the ambient shell **or** project dotenv; unset resolves ECR->GHCR->Docker-Hub candidates in order instead of a single URL                                                                                     | no                                                      |
| `SUPABASE_USE_SLIM_IMAGES`           | resolves the Functions bundler image from the slim `ghcr.io/supabase/cli/edge-runtime` build (`true`/`1` enable); `deno_version = 1` and historical `.temp/edge-runtime-version` pins stay on docker.io; ambient shell only, unlike the neighboring registry override | no                                                      |
| `SUPABASE_NETWORK_ID`                | overrides the generated `supabase_network_<project>` Docker network name when `--network-id` isn't passed; read from the ambient shell or project dotenv                                                                                                              | no                                                      |
| `BITBUCKET_CLONE_DIR`                | when set, skips creating the named Deno-cache volume and omits its bind mount from the bundler `docker run` (Bitbucket's restricted Docker environment rejects both); a project-dotenv-only value is installed into `process.env` by config loading                   | no                                                      |
| `SUPABASE_EDGE_RUNTIME_DENO_VERSION` | overrides `edge_runtime.deno_version` (which bundler image tag to use) when set, from the ambient shell or project dotenv — takes effect even with no `config.toml` on disk                                                                                           | no                                                      |
| `NPM_CONFIG_REGISTRY`                | forwarded into Docker bundling when set (the only npm variable forwarded; `NPM_AUTH_TOKEN` is not)                                                                                                                                                                    | no                                                      |
| `DEBUG`                              | enables verbose Docker bundle output when `true`                                                                                                                                                                                                                      | no                                                      |

## Exit Codes

| Code | Condition                               |
| ---- | --------------------------------------- |
| `0`  | success                                 |
| `1`  | authentication / project-ref resolution |
| `1`  | API error or unexpected HTTP status     |
| `1`  | build / bundle failure                  |
| `1`  | invalid function slug or flag conflict  |
| `1`  | prune confirmation cancelled            |

## Output

### `--output-format text`

Prints progress and success messages as Functions are deployed, bundled, uploaded, or pruned.

### `--output-format json`

Emits a structured success payload with the project ref, deployed function slugs, and dashboard URL.

### `--output-format stream-json`

Emits the same structured success payload as a streamed JSON event sequence.

The `--output`/`-o` flag does not change deploy output.

## Notes

- If no function name is provided, deploys all functions found in `supabase/functions/`.
- API-based deploys anchor uploaded file names and the recorded `entrypoint_path` /
  `import_map_path` / `static_patterns` at the workdir (relative to the working
  directory, forward slashes). Imports outside the workdir but inside
  the nearest git root still upload, with `../`-relative names. The git-root
  containment boundary is a TS-only safeguard with no Go CLI equivalent — the old Go
  CLI uploaded any reachable import unbounded; #5755 widened the TS boundary from the
  workdir to the git root.
- Requires a linked project unless `--project-ref` is provided.
- Bundles locally with Docker by default (`--use-docker` defaults to true and is hidden); `--use-api` selects server-side bundling, and a stopped Docker daemon falls back to it after a `WARNING: Docker is not running`.
- Local Docker bundling mounts existing local values declared under an import map's `scopes` read-only, including targets outside the nearest Git root; each such out-of-root mount prints a `WARN` naming the host path. The mounted target itself is bound as declared; imports reached from inside an out-of-root target are not additionally bound. API source uploads retain their existing source-root restrictions.
- `--use-api`, `--use-docker`, and `--legacy-bundle` are mutually exclusive deploy modes.
- `--prune` deletes deployed Functions that are not present locally after a confirmation prompt;
  global `--yes` skips the prompt.
- **Intentional divergence from Go — spec-strict import-map key matching (CLI-2179, ruled
  2026-08-12):** the functions import scanner (`walkImportPaths`/`substituteImportMapValue`,
  shared with `functions serve` and `start`'s Edge Runtime bring-up) matches import-map keys
  per the import-maps spec Deno/edge-runtime implement — exact match, or prefix match only
  for a `/`-suffixed key — instead of Go's any-key `strings.HasPrefix`
  (`pkg/function/deno.go:150-155`). Upload sets may shrink vs the Go CLI for maps that relied
  on bare-key prefix matching; an unwalkable target (`ENOTDIR` — a value routed through a
  file) is skipped with a `WARN` instead of aborting the deploy.
