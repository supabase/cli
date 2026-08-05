# `supabase functions deploy [Function name]`

## Files Read

| Path                                           | Format     | When                                                        |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable  |
| `<workdir>/supabase/config.toml`               | TOML       | to resolve function config, project id, and local Functions |
| `<workdir>/supabase/functions/<slug>/index.ts` | TypeScript | function source to deploy                                   |
| `<workdir>/supabase/functions/**/deno.json*`   | JSON/JSONC | when resolving import maps                                  |
| imported modules                               | TypeScript | when walking local import graphs for deploy uploads/bundles |
| configured static files                        | any        | when `static_files` patterns match local files              |
| `package.json` next to function entrypoint     | JSON       | Docker bundling package discovery                           |
| `<workdir>/supabase/functions/import_map.json` | JSON       | deprecated fallback import map discovery                    |

## Files Written

| Path                                                   | Format | When                                  |
| ------------------------------------------------------ | ------ | ------------------------------------- |
| system temporary directory                             | ESZIP  | during Docker bundling; removed after |
| linked-project cache and pending telemetry state files | JSON   | during command post-run cleanup       |

## Subprocesses

| Command       | When                                                                |
| ------------- | ------------------------------------------------------------------- |
| `docker info` | to detect whether explicitly selected local Docker bundling can run |
| `docker run`  | when Docker bundling is selected/available                          |

Docker bundling may pull or run the configured edge-runtime image and uses the
`supabase_edge_runtime_<project_id>` Deno cache volume.

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

| Variable                           | Purpose                                                                                                         | Required?                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`            | auth token (bypasses credential file/keyring lookup)                                                            | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROJECT_ID`              | optional project ref fallback                                                                                   | no                                                      |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | selects the Functions bundler image registry                                                                    | no                                                      |
| `NPM_CONFIG_REGISTRY`              | forwarded into Docker bundling when set (the only npm variable forwarded, matching Go; `NPM_AUTH_TOKEN` is not) | no                                                      |
| `DEBUG`                            | enables verbose Docker bundle output when `true`                                                                | no                                                      |

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

Legacy `--output` / `-o` does not change deploy output, matching the Go command.

## Notes

- If no function name is provided, deploys all functions found in `supabase/functions/`.
- API-based deploys anchor uploaded file names and the recorded `entrypoint_path` /
  `import_map_path` / `static_patterns` at the workdir, matching Go's `toRelPath`
  (relative to `os.Getwd()`, forward slashes). Imports outside the workdir but inside
  the nearest git root still upload, with `../`-relative names. The git-root
  containment boundary is a TS-only safeguard with no Go equivalent — Go uploads any
  reachable import unbounded; #5755 widened the TS boundary from the workdir to the
  git root. The boundary additionally admits the real (symlink-resolved) directories
  of `supabase/functions` and each function's entrypoint, so function sources whose
  symlink targets lie outside the git root still upload with their workdir-anchored
  names, matching Go's symlink-following walker (INC-699 follow-up: skipping them
  produced deploys with no file parts, rejected by the API with 400 "Entrypoint path
  does not exist").
- Requires a linked project unless `--project-ref` is provided.
- Uses API/server-side bundling by default; `--use-docker` and `--legacy-bundle` select local bundling.
- `--use-api`, `--use-docker`, and `--legacy-bundle` are mutually exclusive deploy modes.
- `--prune` deletes deployed Functions that are not present locally after a confirmation prompt;
  global `--yes` skips the prompt.
