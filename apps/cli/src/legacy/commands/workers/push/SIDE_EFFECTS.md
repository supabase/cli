# `supabase workers push [name...] (alias: deploy)`

> **No live test yet.** `workers` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Workers routes are available on that stack.

## Files Read

| Path                                                 | Format     | When                                                                                                                  |
| ---------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                     | TOML       | always, for each worker's runtime, size, source                                                                       |
| `<worker source>/**`                                 | any        | always — packaged into the build context                                                                              |
| `<SUPABASE_HOME or ~/.supabase>/profile`             | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                  |
| `<SUPABASE_PROFILE>` (YAML)                          | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command           |
| `<workdir>/supabase/.temp/workers/<ref>/<name>.json` | JSON       | before each deploy — the fingerprint and image of the last deploy this CLI made; missing or unreadable means "deploy" |

## Files Written

| Path                                                 | Format | When                                                                                                                                      |
| ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`      | JSON   | always — flushed on success and on failure                                                                                                |
| `<workdir>/supabase/.temp/linked-project.json`       | JSON   | after the project ref resolves, when the cache does not hold it                                                                           |
| `<workdir>/supabase/.temp/workers/<ref>/<name>.json` | JSON   | after a deploy settles — `{worker, project_ref, fingerprint, image_version, spec}`; best-effort, a write failure does not fail the deploy |

## API Routes

| Method | Path                                         | Auth                                        | Request body                                        | Response (used fields)                                                      |
| ------ | -------------------------------------------- | ------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/v2/projects/{ref}/workers/{name}`          | Bearer token                                | none                                                | read before uploading, for the unchanged check; a failure here is swallowed |
| `POST` | `/v2/projects/{ref}/workers/{name}/uploads`  | Bearer token                                | none                                                | `data.id`, `data.attributes.url/method`                                     |
| `PUT`  | presigned upload URL (control-plane storage) | URL signature — **no** Supabase credentials | `.tar.gz` build context                             | status only                                                                 |
| `POST` | `/v2/projects/{ref}/workers/{name}/deploy`   | Bearer token                                | `{data:{type,attributes:{spec,context_upload_id}}}` | `data.attributes.build_state`                                               |
| `GET`  | `/v2/projects/{ref}/workers/{name}`          | Bearer token                                | none                                                | `build_state`, `state_reason`, `image_version`, `spec`                      |
| `GET`  | `/v1/projects/{ref}`                         | Bearer token                                | none                                                | linked-project cache miss only — name, org, region                          |

`GET` is polled until `build_state` leaves `building`.

An unchanged deploy makes none of the requests below the first `GET`. The
packaged tree is fingerprinted — entry paths, executable bits and contents or
link targets, deliberately not mtimes, which `git checkout` rewrites without
changing what the image would hold — together with the spec that would be sent.
The deploy is skipped only when all of this agrees:

- the fingerprint matches the one recorded for this worker at this project ref;
- the API reports the worker `active`, not deleting, on exactly the recorded
  `image_version`;
- the `size`, `exposure` and `instances` the API reports are the ones this
  deploy would send, so a rescale made elsewhere is still a change to apply.

Then `push` writes `No change found in Worker: <name>` to stderr and reports the
running worker with `skipped: true` in machine output. `--force` skips the check
and deploys regardless. The recorded state is a cache and never the verdict on
its own: it is checked against the API every time, and a missing, stale or
unreadable record only ever costs a redeploy.

## Exit Codes

| Code | Condition                                            |
| ---- | ---------------------------------------------------- |
| `0`  | success                                              |
| `1`  | no workers named and none found in the project       |
| `1`  | a worker's source directory is missing or empty      |
| `1`  | build context upload failed                          |
| `1`  | the build reached `failed`, or never left `building` |
| `1`  | API error, or project not enrolled in the alpha      |

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
