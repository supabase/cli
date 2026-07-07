# `supabase functions delete <Function name>`

## Files Read

| Path                                            | Format     | When                                                          |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/access-token`   | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `<SUPABASE_HOME or ~/.supabase>/profile`        | plain text | when `--profile` and `SUPABASE_PROFILE` are both unset        |
| `<profile>.yaml`                                | YAML       | when `SUPABASE_PROFILE` or `--profile` points to a file       |
| `<workdir>/supabase/.temp/project-ref`          | plain text | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON       | when present, before post-run telemetry state is refreshed    |

## Files Written

| Path                                            | Format | When                                                                    |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after resolving a project ref, cached on both success and failure paths |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | after command completion, flushed on both success and failure paths     |

## API Routes

| Method   | Path                                  | Auth         | Request body | Response (used fields)                                |
| -------- | ------------------------------------- | ------------ | ------------ | ----------------------------------------------------- |
| `DELETE` | `/v1/projects/{ref}/functions/{slug}` | Bearer token | none         | none                                                  |
| `GET`    | `/v1/projects`                        | Bearer token | none         | project picker options when no ref is supplied in TTY |
| `GET`    | `/v1/projects/{ref}`                  | Bearer token | none         | linked project metadata used by the post-run cache    |

## Environment Variables

| Variable                | Purpose                                                         | Required?                                                                             |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)            | no (falls back to keyring → `<SUPABASE_HOME or ~/.supabase>/access-token`)            |
| `SUPABASE_HOME`         | overrides where `telemetry.json` and `profile` are read/written | no (defaults to `~/.supabase`)                                                        |
| `SUPABASE_NO_KEYRING`   | disables the OS keyring, forcing the access-token file fallback | no                                                                                    |
| `SUPABASE_PROFILE`      | select a built-in profile or YAML profile file with `api_url:`  | no (falls back to `~/.supabase/profile` -> `supabase`)                                |
| `SUPABASE_PROJECT_ID`   | provides the project ref when `--project-ref` is unset          | no (falls back to `<workdir>/supabase/.temp/project-ref`)                             |
| `SUPABASE_WORKDIR`      | sets `<workdir>` for local Supabase temp files                  | no (falls back to `--workdir` -> nearest ancestor with `supabase/config.toml` -> cwd) |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | network / connection failure          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                 |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`project-ref` recorded verbatim, matching `functions list`; every other flag redacted) |

## Output

### `--output-format text` (Go CLI compatible)

Prints a success message after the function is deleted.

### `--output-format json`

Prints a structured success result with the function slug and project ref.

### `--output-format stream-json`

Prints a structured success result with the function slug and project ref.

## Notes

- Requires exactly one argument: the function slug/name.
- Does NOT remove the function from the local filesystem.
- Requires a linked project (`--project-ref` or linked project config).
- Runs natively in TypeScript through the Management API.
- Refreshes the linked-project telemetry cache and flushes telemetry state after resolving a project ref.
