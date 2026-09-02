# `supabase experimental workers push [name...] (alias: deploy)`

> **No live test yet.** `workers` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Workers routes are available on that stack.

## Files Read

| Path                                     | Format     | When                                                                                                        |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`         | JSON       | always when present — preferred over `config.toml`; each worker's runtime, size, instances, source          |
| `<workdir>/supabase/config.toml`         | TOML       | always when no `config.json` exists — the same worker fields                                                |
| `<worker source>/**`                     | any        | always — packaged into the build context                                                                    |
| `<SUPABASE_HOME or ~/.supabase>/profile` | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`        |
| `<SUPABASE_PROFILE>` (YAML)              | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command |

## Files Written

| Path                                            | Format | When                                                            |
| ----------------------------------------------- | ------ | --------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                      |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after the project ref resolves, when the cache does not hold it |

## API Routes

| Method | Path                                         | Auth                                        | Request body                                        | Response (used fields)                                 |
| ------ | -------------------------------------------- | ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `POST` | `/v2/projects/{ref}/workers/{name}/uploads`  | Bearer token                                | none                                                | `data.id`, `data.attributes.url/method`                |
| `PUT`  | presigned upload URL (control-plane storage) | URL signature — **no** Supabase credentials | `.tar.gz` build context                             | status only                                            |
| `POST` | `/v2/projects/{ref}/workers/{name}/deploy`   | Bearer token                                | `{data:{type,attributes:{spec,context_upload_id}}}` | `data.attributes.build_state`                          |
| `GET`  | `/v2/projects/{ref}/workers/{name}`          | Bearer token                                | none                                                | `build_state`, `state_reason`, `image_version`, `spec` |
| `GET`  | `/v1/projects/{ref}`                         | Bearer token                                | none                                                | linked-project cache miss only — name, org, region     |

`GET` is polled until `build_state` leaves `building`.

## Exit Codes

| Code | Condition                                               |
| ---- | ------------------------------------------------------- |
| `0`  | success                                                 |
| `1`  | no workers named and none found in the project          |
| `1`  | a worker's source is missing, not a directory, or empty |
| `1`  | a worker's source directory cannot be read              |
| `1`  | a worker's source links to a path outside itself        |
| `1`  | build context upload failed                             |
| `1`  | the build reached `failed`, or never left `building`    |
| `1`  | API error, or project not enrolled in the alpha         |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)  |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                   | no (falls back to `~/.supabase`)                        |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.

## Output Formats

`-o env` is refused **before** the first deploy rather than at emit time: the
payload always carries a `workers` array, which a flat `KEY=value` list cannot
express, and discovering that at the end would fail the command with the remote
project already changed.

The presigned `PUT` above is the one request whose URL is itself a credential.
`--debug` logs every request URL, so `legacyHttpClientLayer` redacts query
strings that carry a signature.
