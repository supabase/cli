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

`GET /v2/projects/{ref}/workers/{name}` is polled until `build_state` leaves
`building`. It is skipped entirely in two cases: under `--no-wait`, and when
the deploy response already carried a terminal `build_state`. Either way the
run reports the accepted spec the deploy response returned.

## Exit Codes

| Code | Condition                                                            |
| ---- | -------------------------------------------------------------------- |
| `0`  | success                                                              |
| `1`  | no workers named and none found in the project                       |
| `1`  | a worker's source is missing, not a directory, or empty              |
| `1`  | a worker's source directory cannot be read                           |
| `1`  | a worker's source links to a path outside itself                     |
| `1`  | build context upload failed                                          |
| `1`  | the build reached `failed`, or never left `building`                 |
| `1`  | with `--no-wait`: the deploy was answered with `build_state: failed` |
| `1`  | API error, or project not enrolled in the alpha                      |

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

Under `--no-wait` the deploy returns with the build still running, so the
follow-up hint (`workers status`) is emitted as a success trailer: stderr,
once, at the end of the run rather than between workers. **Text output
only** — like the rest of the human deploy report it sits behind
`output.format === "text"` and the `-o` check, so `--output-format json`,
`stream-json` and every legacy `-o` mode emit no hint. Machine callers read
`build_state` from the payload instead. The hint carries an explicit
`--project-ref` when the flag supplied one, since it is copy-pasted verbatim.

A multi-worker run stops at the first failure, and names the workers it never
attempted on stderr in **every** format, machine ones included — unlike the
trailer above, `reportUnattempted` has no format guard: that run is a
CI run, where nobody watched the loop and "what still needs deploying" is the
question the failure raises.

The presigned `PUT` above is the one request whose URL is itself a credential.
`--debug` logs every request URL, so `legacyHttpClientLayer` redacts query
strings that carry a signature.
