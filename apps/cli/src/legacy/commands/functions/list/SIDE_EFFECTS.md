# `supabase functions list`

## Files Read

| Path                                            | Format     | When                                                          |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `~/.supabase/access-token`                      | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `~/.supabase/profile`                           | plain text | when `--profile` and `SUPABASE_PROFILE` are both unset        |
| `<profile>.yaml`                                | YAML       | when `SUPABASE_PROFILE` or `--profile` points to a file       |
| `<workdir>/supabase/.temp/project-ref`          | plain text | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON       | when present, before post-run telemetry state is refreshed    |

## Files Written

| Path                                            | Format | When                                                                    |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | after resolving a project ref, cached on both success and failure paths |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | after command completion, flushed on both success and failure paths     |

## API Routes

| Method | Path                           | Auth         | Request body | Response (used fields)                                 |
| ------ | ------------------------------ | ------------ | ------------ | ------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/functions` | Bearer token | none         | `[{id, name, slug, status, version, updated_at, ...}]` |
| `GET`  | `/v1/projects`                 | Bearer token | none         | project picker options when no ref is supplied in TTY  |
| `GET`  | `/v1/projects/{ref}`           | Bearer token | none         | linked project metadata used by the post-run cache     |

## Environment Variables

| Variable                | Purpose                                                        | Required?                                                 |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)           | no (falls back to keyring -> `~/.supabase/access-token`)  |
| `SUPABASE_HOME`         | overrides where `telemetry.json` is read and written           | no (defaults to `~/.supabase`)                            |
| `SUPABASE_PROFILE`      | select a built-in profile or YAML profile file with `api_url:` | no (falls back to `~/.supabase/profile` -> `supabase`)    |
| `SUPABASE_PROJECT_ID`   | provides the project ref when `--project-ref` is unset         | no (falls back to `<workdir>/supabase/.temp/project-ref`) |
| `SUPABASE_WORKDIR`      | sets `<workdir>` for local Supabase temp files                 | no (falls back to `--workdir` -> current working dir)     |
| ~~`SUPABASE_API_URL`~~  | **not honored** - Go parity. Use `SUPABASE_PROFILE` instead.   | -                                                         |

## Exit Codes

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | network / connection failure          |
| `1`  | unsupported Go output mode (`env`)    |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` (Go CLI compatible)

Prints a Glamour-style ASCII table with columns `ID`, `NAME`, `SLUG`, `STATUS`, `VERSION`, and `UPDATED_AT (UTC)`.

### `--output-format json`

Prints a structured success result shaped as `{ "functions": [...] }`.

### `--output-format stream-json`

Prints a structured success result shaped as `{ "functions": [...] }`.

## Notes

- Requires a linked project (`--project-ref`, `SUPABASE_PROJECT_ID`, or `<workdir>/supabase/.temp/project-ref`).
- Native TypeScript port using the Management API.
- Go `--output` parity:
  - `json` emits the raw array.
  - `yaml` emits the raw array.
  - `toml` emits `{ functions = [...] }`.
  - `env` fails with `--output env flag is not supported`.
