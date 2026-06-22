# `supabase functions list`

## Files Read

| Path                           | Format     | When                                                          |
| ------------------------------ | ---------- | ------------------------------------------------------------- |
| `~/.supabase/access-token`     | plain text | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `~/.supabase/profile`          | plain text | when `--profile` and `SUPABASE_PROFILE` are both unset        |
| `<profile>.yaml`               | YAML       | when `SUPABASE_PROFILE` or `--profile` points to a file       |
| `./supabase/.temp/project-ref` | plain text | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| -    | -      | -    |

## API Routes

| Method | Path                           | Auth         | Request body | Response (used fields)                                 |
| ------ | ------------------------------ | ------------ | ------------ | ------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/functions` | Bearer token | none         | `[{id, name, slug, status, version, updated_at, ...}]` |

## Environment Variables

| Variable                | Purpose                                                        | Required?                                                |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)           | no (falls back to keyring -> `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | select a built-in profile or YAML profile file with `api_url:` | no (falls back to `~/.supabase/profile` -> `supabase`)   |
| `SUPABASE_PROJECT_ID`   | provides the project ref when `--project-ref` is unset         | no (falls back to `./supabase/.temp/project-ref`)        |
| ~~`SUPABASE_API_URL`~~  | **not honored** - Go parity. Use `SUPABASE_PROFILE` instead.   | -                                                        |

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

- Requires a linked project (`--project-ref`, `SUPABASE_PROJECT_ID`, or `./supabase/.temp/project-ref`).
- Native TypeScript port using the Management API.
- Go `--output` parity:
  - `json` emits the raw array.
  - `yaml` emits the raw array.
  - `toml` emits `{ functions = [...] }`.
  - `env` fails with `--output env flag is not supported`.
