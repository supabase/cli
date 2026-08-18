# `supabase workers push [name...] (alias: deploy)`

> **TS-only command.** `supabase workers` has no Go counterpart — there is no
> `apps/cli-go/internal/workers` to match, and nothing is proxied. See
> `docs/go-cli-divergences.md`.

## Files Read

| Path                             | Format | When                                                                |
| -------------------------------- | ------ | ------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, for each worker's runtime, size, source                     |
| `<worker source>/**`             | any    | always except `--runtime sandbox` — packaged into the build context |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                         | Auth                                        | Request body                                        | Response (used fields)                                 |
| ------ | -------------------------------------------- | ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `POST` | `/v2/projects/{ref}/workers/{name}/uploads`  | Bearer token                                | none                                                | `data.id`, `data.attributes.url/method`                |
| `PUT`  | presigned upload URL (control-plane storage) | URL signature — **no** Supabase credentials | `.tar.gz` build context                             | status only                                            |
| `POST` | `/v2/projects/{ref}/workers/{name}/deploy`   | Bearer token                                | `{data:{type,attributes:{spec,context_upload_id}}}` | `data.attributes.build_state`                          |
| `GET`  | `/v2/projects/{ref}/workers/{name}`          | Bearer token                                | none                                                | `build_state`, `state_reason`, `image_version`, `spec` |

`GET` is polled until `build_state` leaves `building`.

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

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events. `workers` has no Go counterpart, so there is no
`phtelemetry.*` call to reproduce.
